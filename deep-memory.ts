/**
*	deep-memory.ts
*
*	OpenCode plugin — persistent long-term memory via SQLite FTS5.
*	Stores conversation records, recalls relevant context on each record.
*
*	Install: cp deep-memory.ts ~/.config/opencode/plugins/deep-memory.ts
*	Storage: ~/.config/opencode/storage/deep-memory.db
*	Config:  ~/.config/opencode/deep-memory.jsonc
*	Log:     ~/.config/opencode/deep-memory.log
*
*	@example ~/.config/opencode/deep-memory.jsonc
*	{
*		"enabled": true,            // master switch
*		"max_results": 20,          // max FTS results returned per search call
*		"search_max_days": 600,     // 0 = all, max days of records to consider
*		"max_tokens_memory": 2000,  // max tokens consumed by memory recall block
*		"max_snippet_chars": 3000,  // max chars per memory snippet in recall output
*		"data_keep_days": 1000,     // 0 = forever, prune records older than this on startup
*		"log_level": "info"         // "silent" | "error" | "info" | "debug"
*	}
*
*	@name deep-memory
*	@version 1.1.24
*	@author Alejandro Carraretto
*	@assistant DeepSeek-V4
*	@license MIT
 *	@compatibility OpenCode v1
*/

import { type Plugin, type PluginInput, tool } from "@opencode-ai/plugin" ;
import { Database } from "bun:sqlite" ;
import { createHash } from "node:crypto" ;
import { mkdirSync, existsSync, appendFileSync, readFileSync } from "node:fs" ;
import { homedir } from "node:os" ;
import { join } from "node:path" ;

// ─── Paths ─────────────────────────────────────────────────────────────────

const CONFIG_DIR  = join( homedir(), ".config", "opencode" ) ;
const CONFIG_FILE = join( CONFIG_DIR, "deep-memory.jsonc" ) ;
const LOG_FILE    = join( CONFIG_DIR, "deep-memory.log" ) ;
const STORAGE_DIR = join( CONFIG_DIR, "storage" ) ;
const DB_PATH     = join( STORAGE_DIR, "deep-memory.db" ) ;

// ─── Constants ─────────────────────────────────────────────────────────────

const CONFIG =
{
	enabled: true,             // master switch
	max_results: 20,           // max FTS results returned per search call
	search_max_days: 600,      // 0 = all, max days of records to consider
	max_tokens_memory: 2000,   // max tokens consumed by memory recall block
	max_snippet_chars: 3000,   // max chars per memory snippet in recall output
	data_keep_days: 1000,      // 0 = forever, prune records older than this on startup
	log_level: "info" as "silent" | "error" | "info" | "debug",
};

const LOG_LEVEL =
{
	SILENT : 0,
	ERROR  : 1,
	INFO   : 2,
	DEBUG  : 3,
} as const ;

// Optional/additional chat content filter. (empty by default)
const FILTER_PATTERNS =
[
	// Reference: https://github.com/Opencode-DCP/opencode-dynamic-context-pruning/blob/master/lib/messages/utils.ts
	/<dcp[^>]*>[\s\S]*?<\/dcp[^>]*>/gi,
	/<\/?dcp[^>]*>/gi,
	/\[Tool output truncated/gi,
	/\[Old tool result/gi,
	/▣\s*(?:DCP|Compression)[\s\S]*/gi,
	/\[Compressed[\s\S]*/gi,
];

const SEARCH_DESC = [
	"Search long-term memory using full-text search.",
	"Use this when you need to recall past conversation records,",
	"decisions, or facts stored across all sessions.",
].join( " " ) ;

const SEARCH_QUERY_DESC = [
	"The search query — natural language text",
	"describing what to find in memory",
].join( " " ) ;

const SEARCH_MAX_RESULTS_DESC = [
	"Maximum number of results to return",
	"(default: max_results config)",
].join( " " ) ;

const STATS_DESC = [
	"Return storage statistics: record count, size, oldest/newest records,",
	"and dedup skip count.",
].join( " " ) ;

const STORE_DESC = [
	"Store a fact, decision, or piece of information in long-term memory.",
	"Use this when you want to persist something specific that should be",
	"retrievable by memory_search in future sessions.",
].join( " " ) ;

const STORE_ROLE_DESC = [
	"Role for the stored record",
	"(determines how it appears in search results)",
].join( " " ) ;

const STORE_CONTENT_DESC = [
	"The content to store — a fact, decision, or piece of information",
].join( " " ) ;

const SYSTEM_PROMPT = [
	"<deep-memory>",
	"You have access to memory_search().",
	"Call it at session start to recall past context.",
	"Call it when the user references previous work or asks about history.",
	"Answer from memory when results match.",
	"</deep-memory>",
].join( "\n" ) ;

// ─── Interfaces ────────────────────────────────────────────────────────────

interface MemoryHit
{
	id : string ;
	role : "user" | "assistant" ;
	content : string ;
	created : string ;
}

interface MessageLike
{
	info : { role: "user" | "assistant"; id? : string; sessionID? : string } ;
	parts : Array<{ type : string; text? : string; synthetic? : boolean; ignored? : boolean }> ;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// Current local datetime as ISO-like string: "2026-07-06T20:30:26"
function timestamp() : string
{
	const utc    = new Date() ;
	const offset = utc.getTimezoneOffset() ;
	const local  = new Date( utc.getTime() - offset * 60 * 1000 ) ;

	return local.toISOString().slice( 0, 19 ) ;
}

// Load config from ~/.config/opencode/deep-memory.jsonc, fall back to defaults
function loadConfig() : typeof CONFIG
{
	let file: Record<string, unknown> = {} ;
	try
	{
		file = Bun.JSONC.parse( readFileSync( CONFIG_FILE, "utf8" ) ) ;
	}
	catch
	{
		log( LOG_LEVEL.ERROR, `Config not found or parse error at ${ CONFIG_FILE }` ) ;
	}

	CONFIG.enabled            = file.enabled                           ?? CONFIG.enabled ;
	CONFIG.max_results        = Math.max( 1,   file.max_results        ?? CONFIG.max_results ) ;
	CONFIG.search_max_days    = Math.max( 0,   file.search_max_days    ?? CONFIG.search_max_days ) ;
	CONFIG.max_tokens_memory  = Math.max( 100, file.max_tokens_memory  ?? CONFIG.max_tokens_memory ) ;
	CONFIG.max_snippet_chars  = Math.max( 50,  file.max_snippet_chars  ?? CONFIG.max_snippet_chars ) ;
	CONFIG.data_keep_days     = Math.max( 0,   file.data_keep_days     ?? CONFIG.data_keep_days ) ;
	CONFIG.log_level          = file.log_level                         ?? CONFIG.log_level ;

	log( LOG_LEVEL.INFO, "Config loaded" ) ;

	return CONFIG ;
}

// Append timestamped entry to ~/.config/opencode/deep-memory.log
function log( level : number, message : string ) : void
{
	const min = LOG_LEVEL[ ( CONFIG.log_level ?? "info" ).toUpperCase() ] ?? LOG_LEVEL.ERROR ;

	if ( level > min ) return ;

	const label = Object.keys( LOG_LEVEL )[ level ] ?? "" ;

	try
	{
		appendFileSync( LOG_FILE, `[${ timestamp() }] [${ label }]: ${ message }\n` ) ;
	}
	catch {}
}

// ─── DeepMemory ────────────────────────────────────────────────────────────

class DeepMemory
{
	private config : typeof CONFIG ;
	private db : Database ;
	private stmtInsert : ReturnType<Database[ "prepare" ]> ;
	private stmtSearch : ReturnType<Database[ "prepare" ]> ;
	private stmtRecent : ReturnType<Database[ "prepare" ]> ;
	private seen : Set<string> = new Set() ;
	private dedupSkipped : number = 0 ;
	private client : PluginInput[ "client" ] ;
	private sessionID : string | null = null ;

	constructor( config : typeof CONFIG, client : PluginInput[ "client" ] )
	{
		this.config = config ;
		this.client = client ;

		if ( ! existsSync( STORAGE_DIR ) )
			mkdirSync( STORAGE_DIR, { recursive : true } ) ;

		this.db = new Database( DB_PATH ) ;

		this.db.exec(
			`PRAGMA synchronous          = NORMAL ;
			 PRAGMA temp_store           = MEMORY ;
			 PRAGMA page_size            = 8192 ;
			 PRAGMA cache_size           = 25000 ;
			 PRAGMA cache_spill          = ON ;
			 PRAGMA journal_mode         = WAL ;
			 PRAGMA journal_size_limit   = 0 ;
			 PRAGMA wal_autocheckpoint   = 1000 ;
			 PRAGMA automatic_index      = ON ;
			 PRAGMA recursive_triggers   = ON ;
			 PRAGMA foreign_keys         = ON ;
			 PRAGMA defer_foreign_keys   = OFF ;
			 PRAGMA auto_vacuum          = OFF ;
			 PRAGMA threads              = 4 ;
			 PRAGMA busy_timeout         = 5000 ;`
		);

		this.db.exec(
			`CREATE TABLE IF NOT EXISTS records (
				id       TEXT   PRIMARY KEY,
				role     TEXT   NOT NULL CHECK( role IN ( 'user','assistant' ) ),
				content  TEXT   NOT NULL,
				created  TEXT   DEFAULT ( datetime( 'now' ) )
			 );
			 CREATE INDEX IF NOT EXISTS idx_records_created
				ON records( created )
			 ;
			 CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
				role UNINDEXED,
				content,
				content='records',
				tokenize="unicode61 remove_diacritics 1"
			 );
			 CREATE TRIGGER IF NOT EXISTS records_ai AFTER INSERT ON records BEGIN
				INSERT INTO records_fts( rowid, role, content ) VALUES ( NEW.rowid, NEW.role, NEW.content );
			 END
			 ;
			 CREATE TRIGGER IF NOT EXISTS records_ad AFTER DELETE ON records BEGIN
				INSERT INTO records_fts( records_fts, rowid ) VALUES( 'delete', OLD.rowid );
			 END
			 ;
			 CREATE TRIGGER IF NOT EXISTS records_au AFTER UPDATE ON records BEGIN
				INSERT INTO records_fts( records_fts, rowid ) VALUES( 'delete', OLD.rowid );
				INSERT INTO records_fts( rowid, role, content ) VALUES ( NEW.rowid, NEW.role, NEW.content );
			 END
			 ;`
		);

		this.stmtInsert = this.db.prepare(
			"INSERT OR IGNORE INTO records ( id, role, content ) VALUES ( ?, ?, ? )"
		) ;

		this.stmtSearch = this.db.prepare(
			`SELECT t.id, t.role, t.content, t.created
			 FROM records_fts JOIN records AS t ON records_fts.rowid = t.rowid
			 WHERE records_fts MATCH ?
			   AND ( ? = 0 OR julianday( 'now' ) - julianday( t.created ) <= ? )
			 ORDER BY bm25( records_fts )
			 LIMIT ?`
		);

		this.stmtRecent = this.db.prepare(
			"SELECT content FROM records ORDER BY created DESC LIMIT ?"
		);

		const pruned = this.prune( this.config.data_keep_days ) ;
		if ( pruned > 0 ) log( LOG_LEVEL.INFO, `Pruned: ${pruned} records` ) ;
	}

	// ── Internal helpers ───────────────────────────────────────────────

	// Delete records older than keepDays; relies on triggers to sync FTS5 index. 0 = noop
	protected prune( keepDays : number ) : number
	{
		if ( keepDays <= 0 ) return 0 ;

		const result = this.db.run(
			"DELETE FROM records WHERE julianday( 'now' ) - julianday( created ) > ?",
			[ keepDays ]
		) ;

		return result.changes ?? 0 ;
	}

	// MD5 hex of role + content — record ID and dedup key (lowercased hash for case-insensitive dedup)
	protected hashContent( role : string, content : string ) : string
	{
		return createHash( "md5" ).update( role + ":" + content.toLowerCase() ).digest( "hex" ) ;
	}

	// Strip DCP/system/thinking/tool tags (preserves original case)
	protected normalizeContent( text : string | undefined ) : string
	{
		if ( ! text ) return "" ;

		for ( const pattern of FILTER_PATTERNS )
			text = text.replace( pattern, "" ) ;

		return text.replace( /\s+/g, " " ).trim() ;
	}

	// Convert free-form text into a safe FTS5 OR-query (splits on non-alphanumeric into word tokens, keeps >1-char terms)
	protected sanitizeQuery( input : string ) : string
	{
		if ( ! input || typeof input !== "string" ) return "" ;

		const cleaned = input.toLowerCase().replace( /[^\p{L}\p{N}]+/gu, " " ) ;
		const raw     = cleaned.split( /\s+/ ) ;

		const terms : string[] = [] ;

		for ( const t of raw )
			if ( t.length > 1 ) terms.push( t ) ;

		if ( ! terms.length ) return "" ;

		return terms.map( t => `"${t}"*` ).join( " OR " ) ;
	}

	// Only valid role
	protected isValidRole( role : string ) : boolean
	{
		return [ "user", "assistant" ].includes( role ) ;
	}

	// Generic Jaccard similarity over two sets
	// Returns 0 for sets with fewer than 3 elements to avoid spurious matches
	protected jaccard<T>( setA : Set<T>, setB : Set<T> ) : number
	{
		if ( setA.size < 3 || setB.size < 3 ) return 0 ;

		const [ smaller, larger ] = setA.size <= setB.size
			? [ setA, setB ] : [ setB, setA ] ;

		let inter = 0 ;
		for ( const x of smaller )
			if ( larger.has( x ) ) inter++ ;

		const union = setA.size + setB.size - inter ;

		return union === 0 ? 0 : inter / union ;
	}

	// Jaccard similarity over word tokens — used for dedup in compressMemories
	protected contentOverlap( a : string, b : string ) : number
	{
		const setA = new Set( a.toLowerCase().split( /[\s-]+/ ).filter( w => w.length > 2 ) ) ;
		const setB = new Set( b.toLowerCase().split( /[\s-]+/ ).filter( w => w.length > 2 ) ) ;

		return this.jaccard( setA, setB ) ;
	}

	// Extract character 3-gram shingles from normalized text
	protected extractTrigrams( text : string ) : string[]
	{
		const normalized = text.toLowerCase().replace( /\s+/g, " " ).trim() ;
		if ( normalized.length < 3 ) return [] ;

		const trigrams = new Set<string>() ;

		for ( let i = 0; i <= normalized.length - 3; i++ )
			trigrams.add( normalized.slice( i, i + 3 ) ) ;

		return [ ...trigrams ] ;
	}

	// Jaccard similarity over trigram sets — used for storage-time dedup
	protected trigramJaccard( a : string[], b : string[] ) : number
	{
		return this.jaccard( new Set( a ), new Set( b ) ) ;
	}

	// In-memory trigram dedup: fetch recent records and compute Jaccard.
	// Threshold 0.65, min 20 chars. Fails open (returns false) on error.
	protected isSimilar( content : string ) : boolean
	{
		if ( content.length < 20 ) return false ;

		const trigrams = this.extractTrigrams( content ) ;
		if ( trigrams.length < 3 ) return false ;

		try
		{
			const recent = this.fetchRecent( 200 ) ;
			for ( const r of recent )
			{
				const existingTrigrams = this.extractTrigrams( r ) ;

				if ( this.trigramJaccard( trigrams, existingTrigrams ) > 0.65 )
					return true ;
			}
		}
		catch
		{
			return false ;
		}

		return false ;
	}

	// Fetch recent records for in-memory dedup comparison
	protected fetchRecent( limit : number = 200 ) : string[]
	{
		const rows = this.stmtRecent.all( limit ) as Array<{ content : string }> ;
		return rows.map( r => r.content ) ;
	}

	// FTS5 search with age gate, ordered by bm25 relevance
	protected searchMemories( query : string, limit : number, maxAgeDays : number ) : MemoryHit[]
	{
		const sanitized = this.sanitizeQuery( query ) ;
		if ( ! sanitized ) return [] ;

		try
		{
			return this.stmtSearch.all( sanitized, maxAgeDays, maxAgeDays, limit ) as MemoryHit[] ;
		}
		catch
		{
			return [] ;
		}
	}

	// Compress FTS hits into a token-budgeted context block with single-pass dedup
	protected compressMemories( hits : MemoryHit[], maxTokens : number, maxSnippetChars : number ) : string
	{
		if ( ! hits.length ) return "" ;

		const pick : MemoryHit[] = [] ;

		for ( const h of hits )
		{
			let dup = false ;

			for ( const p of pick )
			{
				if ( this.contentOverlap( p.content, h.content ) > 0.6 )
				{
					dup = true ;
					break ;
				}
			}
			if ( ! dup ) pick.push( h ) ;
		}

		const parts : string[] = [] ;
		let budget = maxTokens ;

		for ( const h of pick )
		{
			let snippet = h.content.trim() ;
			if ( snippet.length > maxSnippetChars )
			{
				const truncated = snippet.slice( 0, maxSnippetChars ) ;
				const match     = truncated.match( /[\s\S]*[.!?](?=\s|$)/ ) ;

				snippet = match ? match[ 0 ].trimEnd() + "…" : truncated + "…" ;
			}

			const line = h.role === "assistant"
				? `→ ${snippet}`
				: `  ${snippet}` ;

			const est = Math.max( 1, line.split( /\s+/ ).filter( Boolean ).length ) ;
			if ( est > budget ) break ;

			parts.push( line ) ;
			budget -= est ;
		}

		return parts.join( "\n" ) ;
	}

	// True if part is non-text/synthetic/ignored (runtime-injected)
	protected isRuntime( p : { type : string; synthetic? : boolean; ignored? : boolean } ) : boolean
	{
		const is = ( p.type != "text" || p.synthetic == true || p.ignored == true ) ;

		if ( is )
			log( LOG_LEVEL.DEBUG, `Runtime part: type=${p.type} synthetic=${p.synthetic} ignored=${p.ignored}` ) ;

		return is ;
	}

	// Extract plain text from a message, stripping runtime parts and noise tags
	protected extractText( message : MessageLike ) : string
	{
		const parts : string[] = [] ;

		for ( const part of message.parts )
		{
			if ( this.isRuntime( part ) ) continue ;
			if ( part.text ) parts.push( part.text ) ;
		}

		return parts.join( "\n" ).trim() ;
	}

	// ── Public hooks ──────────────────────────────────────────────────

	// Search memory, compress results into token-budgeted block
	public recall( args : { query : string; max_results? : number } ) : string
	{
		const limit = args.max_results ?? this.config.max_results ;
		const hits  = this.searchMemories(
			args.query, limit, this.config.search_max_days
		) ;

		const contextStr = ! hits.length
			? ""
			: this.compressMemories( hits, this.config.max_tokens_memory, this.config.max_snippet_chars ) ;

		if ( ! contextStr )
			return "<deep-memory>\n(no matches found)\n</deep-memory>" ;

		return `<deep-memory>\n${contextStr}\n</deep-memory>` ;
	}

	// Return storage statistics as formatted string
	public stats() : string
	{
		const row = this.db.prepare(
			`SELECT
				COUNT(*) AS total,
				COALESCE( SUM( LENGTH( content ) ), 0 ) AS size_bytes,
				SUM( CASE WHEN role = 'user' THEN 1 ELSE 0 END ) AS user_count,
				SUM( CASE WHEN role = 'assistant' THEN 1 ELSE 0 END ) AS assistant_count,
				MIN( created ) AS oldest,
				MAX( created ) AS newest
			 FROM records`
		).get() as {
			total : number ;
			size_bytes : number ;
			user_count : number ;
			assistant_count : number ;
			oldest : string | null ;
			newest : string | null ;
		} | null ;

		const pc = this.db.prepare( "PRAGMA page_count" ).get() as { page_count : number } | null ;
		const ps = this.db.prepare( "PRAGMA page_size" ).get() as { page_size : number } | null ;
		const dbSize = ( pc?.page_count ?? 0 ) * ( ps?.page_size ?? 0 ) ;

		let oldestPreview : string | null = null ;
		let newestPreview : string | null = null ;
		let oldestRole : string | null = null ;
		let newestRole : string | null = null ;

		if ( row && row.oldest )
		{
			const o = this.db.prepare(
				"SELECT role, content FROM records ORDER BY created ASC LIMIT 1"
			).get() as { role : string; content : string } | null ;

			if ( o )
			{
				oldestRole = o.role ;
				oldestPreview = o.content.slice( 0, 80 ) ;
			}
		}

		if ( row && row.newest )
		{
			const n = this.db.prepare(
				"SELECT role, content FROM records ORDER BY created DESC LIMIT 1"
			).get() as { role : string; content : string } | null ;

			if ( n )
			{
				newestRole = n.role ;
				newestPreview = n.content.slice( 0, 80 ) ;
			}
		}

		const fmt = ( n : number ) : string =>
		{
			if ( n < 1024 ) return `${n} B` ;
			if ( n < 1024 * 1024 ) return `${( n / 1024 ).toFixed( 1 )} KB` ;
			return `${( n / ( 1024 * 1024 ) ).toFixed( 1 )} MB` ;
		} ;

		const lines : string[] = [] ;
		lines.push( `records: ${row?.total ?? 0}` ) ;
		lines.push( `size: ${fmt( row?.size_bytes ?? 0 )}` ) ;
		lines.push( `db_size: ${fmt( dbSize )}` ) ;
		lines.push( `by_role: user=${row?.user_count ?? 0}, assistant=${row?.assistant_count ?? 0}` ) ;
		lines.push( `dedup_skipped: ${this.dedupSkipped}` ) ;

		if ( row?.oldest )
			lines.push( `oldest: ${row.oldest} (${oldestRole}) "${oldestPreview}"` ) ;
		else
			lines.push( "oldest: (none)" ) ;

		if ( row?.newest )
			lines.push( `newest: ${row.newest} (${newestRole}) "${newestPreview}"` ) ;
		else
			lines.push( "newest: (none)" ) ;

		return `<deep-memory-stats>\n${lines.join( "\n" )}\n</deep-memory-stats>` ;
	}

	// Store a specific fact/decision in long-term memory
	public store( args : { role : "user" | "assistant"; content : string } ) : string
	{
		if ( ! this.isValidRole( args.role ) )
			return "<deep-memory>\n(error: invalid role)\n</deep-memory>" ;

		const normalized = this.normalizeContent( args.content ) ;
		if ( ! normalized )
			return "<deep-memory>\n(error: empty after normalization)\n</deep-memory>" ;

		const id = this.hashContent( args.role, normalized ) ;
		const result = this.stmtInsert.run( id, args.role, normalized ) ;

		if ( result.changes )
		{
			log( LOG_LEVEL.INFO, `Stored: 1 record (role=${args.role})` ) ;
			return "<deep-memory>\n(stored)\n</deep-memory>" ;
		}

		return "<deep-memory>\n(already exists)\n</deep-memory>" ;
	}

	// Store conversation messages after stripping noise (tags, metadata, etc)
	public handleMessagesTransform( output : { messages: Array<MessageLike> } ) : void
	{
		try
		{
			if ( ! output.messages?.length ) return ;

			let stored = 0 ;

			for ( const msg of output.messages )
			{
				try
				{
					if ( ! this.isValidRole( msg.info.role ) ) continue ;

					if ( msg.info.sessionID )
						this.sessionID = msg.info.sessionID ;

					const id = msg.info.id ;
					if ( id )
					{
						if ( this.seen.has( id ) ) continue ;
						this.seen.add( id ) ;
					}

					const raw = this.extractText( msg ) ;
					if ( ! raw ) continue ;

					const normalized = this.normalizeContent( raw ) ;
					if ( ! normalized ) continue ;

					if ( this.isSimilar( normalized ) )
					{
						log( LOG_LEVEL.DEBUG, `Dedup: skipped similar record (role=${msg.info.role})` ) ;
						this.dedupSkipped++ ;
						continue ;
					}

					const hashId = this.hashContent( msg.info.role, normalized ) ;
					const result = this.stmtInsert.run( hashId, msg.info.role, normalized ) ;

					if ( result.changes ) stored++ ;
				}
				catch ( err )
				{
					log( LOG_LEVEL.ERROR, `messages.transform: ${( err as Error ).message}` ) ;
					continue ;
				}
			}

			if ( stored ) log( LOG_LEVEL.INFO, `Stored: ${stored} records` ) ;
		}
		catch ( err )
		{
			log( LOG_LEVEL.ERROR, `messages.transform: ${( err as Error ).message}` ) ;
		}
	}

	// Append memory-search tool reminder to system prompt
	public handleSystemTransform( output : { system : string[] } ) : void
	{
		output.system.push( SYSTEM_PROMPT ) ;
	}

	// Fetch last session message via SDK (backfill for the message transform never sees)
	protected async fetchLastMessage() : Promise<MessageLike | null>
	{
		if ( ! this.sessionID ) return null ;

		try
		{
			const res = await this.client.session.messages( {
				path  : { id : this.sessionID } ,
				query : { limit : 1 } ,
			} ) ;

			return res?.data?.[ 0 ] ?? null ;
		}
		catch
		{
			log( LOG_LEVEL.ERROR, "fetchLastMessage failed" ) ;
			return null ;
		}
	}

	// Backfill last message on dispose, close DB
	public async dispose() : Promise<void>
	{
		try
		{
			const msg = await this.fetchLastMessage() ;
			if ( msg )
			{
				const raw  = this.extractText( msg ) ;
				const norm = this.normalizeContent( raw ) ;

				if ( norm && this.isValidRole( msg.info.role ) && ! this.isSimilar( norm ) )
				{
					const id   = this.hashContent( msg.info.role, norm ) ;
					const res  = this.stmtInsert.run( id, msg.info.role, norm ) ;

					if ( res.changes )
						log( LOG_LEVEL.DEBUG, `Stored last message (role=${msg.info.role})` ) ;
				}
			}
		}
		catch ( err )
		{
			log( LOG_LEVEL.ERROR, `Dispose backfill: ${( err as Error ).message}` ) ;
		}

		try
		{
			this.db.close() ;
		}
		catch {}
		log( LOG_LEVEL.INFO, "Disposed" ) ;
	}
}

// ─── Plugin ────────────────────────────────────────────────────────────────

// Plugin factory: load config, open storage, register hooks
export default ( async ( ctx : PluginInput ) =>
{
	const opts = loadConfig() ;

	if ( ! opts.enabled )
	{
		log( LOG_LEVEL.INFO, "Disabled" ) ;
		return {} ;
	}

	const dm = new DeepMemory( opts, ctx.client ) ;

	log( LOG_LEVEL.INFO, "Initialized" ) ;

	return {
		tool : {
			memory_search : tool( {
				description : SEARCH_DESC,
				args : {
					query : tool.schema.string().describe( SEARCH_QUERY_DESC ),
					max_results : tool.schema.number().optional().describe( SEARCH_MAX_RESULTS_DESC ),
				},
				async execute( args, _context )
				{
					try
					{
						return dm.recall( args ) ;
					}
					catch ( err )
					{
						log( LOG_LEVEL.ERROR, `memory_search: ${( err as Error ).message}` ) ;
						return "<deep-memory>\n(error searching memory)\n</deep-memory>" ;
					}
				},
			} ),

			memory_store : tool( {
				description : STORE_DESC,
				args : {
					role : tool.schema.string().describe( STORE_ROLE_DESC ),
					content : tool.schema.string().describe( STORE_CONTENT_DESC ),
				},
				async execute( args, _context )
				{
					try
					{
						return dm.store( args ) ;
					}
					catch ( err )
					{
						log( LOG_LEVEL.ERROR, `memory_store: ${( err as Error ).message}` ) ;
						return "<deep-memory>\n(error storing memory)\n</deep-memory>" ;
					}
				},
			} ),

			memory_stats : tool( {
				description : STATS_DESC,
				args : {},
				async execute( _args, _context )
				{
					try
					{
						return dm.stats() ;
					}
					catch ( err )
					{
						log( LOG_LEVEL.ERROR, `memory_stats: ${( err as Error ).message}` ) ;
						return "<deep-memory-stats>\n(error reading stats)\n</deep-memory-stats>" ;
					}
				},
			} ),
		},

		"experimental.chat.messages.transform" : async ( _input, output ) =>
		{
			dm.handleMessagesTransform( output ) ;
		},

		"experimental.chat.system.transform" : async ( _input, output ) =>
		{
			dm.handleSystemTransform( output ) ;
		},

		dispose : async () =>
		{
			dm.dispose() ;
		},
	} ;
} ) satisfies Plugin ;

// ─── END ──────────────────────────────────────────────────────────────
