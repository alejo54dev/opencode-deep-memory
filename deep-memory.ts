/**
*	deep-memory.ts
*
*	OpenCode plugin — global memory via SQLite FTS5.
*	Stores conversation records, recalls relevant context on demand.
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
*		"max_tokens_memory": 800,   // max tokens consumed by memory recall block
*		"max_snippet_chars": 600,   // max chars per memory snippet in recall output
*		"data_keep_days": 600,      // 0 = forever, prune records older than this on startup
*		"log_level": "info"         // "silent" | "error" | "info" | "debug"
*	}
*
*	@name deep-memory
*	@version 1.1.31
*	@author Alejandro Carraretto
*	@assistant DeepSeek-Flash
*	@license AGPL-3.0
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

const CONFIG : Config =
{
	enabled: true,             // master switch
	max_results: 20,           // max FTS results returned per search call
	search_max_days: 600,      // 0 = all, max days of records to consider
	max_tokens_memory: 800,    // max tokens consumed by memory recall block
	max_snippet_chars: 600,    // max chars per memory snippet in recall output
	data_keep_days: 600,       // 0 = forever, prune records older than this on startup
	log_level: "info",
};

const LOG_LEVEL =
{
	SILENT : 0,
	ERROR  : 1,
	INFO   : 2,
	DEBUG  : 3,
} as const ;

// Storage tuning — measured constants, not knobs
const DEDUP_THRESHOLD = 0.65 ;   // trigram Jaccard above which a record is a near-duplicate
const RECENT_WINDOW   = 200 ;    // records compared on every store for near-dup detection

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
	"Search global memory for past records, decisions, or facts across",
	"all projects and sessions. Use this when you need to recall past work.",
].join( " " ) ;

const SEARCH_QUERY_DESC = [
	"The search query — natural language text",
	"describing what to find in memory",
].join( " " ) ;

const SEARCH_MAX_RESULTS_DESC = [
	"Maximum number of results to return",
	"(default: the configured max_results)",
].join( " " ) ;

const STORE_DESC = [
	"Store a fact, decision, or piece of information in global memory.",
	"Use this when the user explicitly asks to remember something that should be",
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
	"<memory>",
	"memory_search() reads global memory across projects and sessions;",
	"memory_store() persists an explicit fact or decision.",
	"When you don't know something, search memory before inventing; if memory",
	"has nothing, look outside.",
	"Store only when the user explicitly asks.",
	"</memory>",
].join( "\n" ) ;

// ─── Interfaces ────────────────────────────────────────────────────────────

interface Config
{
	enabled           : boolean ;
	max_results       : number ;
	search_max_days   : number ;
	max_tokens_memory : number ;
	max_snippet_chars : number ;
	data_keep_days    : number ;
	log_level         : "silent" | "error" | "info" | "debug" ;
}

interface MemoryHit
{
	id : string ;
	role : "user" | "assistant" ;
	content : string ;
	created : string ;
}

interface MessageLike
{
	info : { role: "user" | "assistant"; id? : string; sessionID? : string; summary? : boolean } ;
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
function loadConfig() : Config
{
	let file : Partial<Config> = {} ;
	let loaded = false ;
	try
	{
		file = Bun.JSONC.parse( readFileSync( CONFIG_FILE, "utf8" ) ) as Partial<Config> ;
		loaded = true ;
	}
	catch
	{
		log( LOG_LEVEL.ERROR, `Config not found or parse error at ${ CONFIG_FILE }` ) ;
	}

	Object.assign( CONFIG, file ) ;

	CONFIG.max_results       = Math.max( 1, CONFIG.max_results ) ;
	CONFIG.search_max_days   = Math.max( 0, CONFIG.search_max_days ) ;
	CONFIG.max_tokens_memory = Math.max( 100, CONFIG.max_tokens_memory ) ;
	CONFIG.max_snippet_chars = Math.max( 50, CONFIG.max_snippet_chars ) ;
	CONFIG.data_keep_days    = Math.max( 0, CONFIG.data_keep_days ) ;

	log( LOG_LEVEL.INFO, loaded ? "Config loaded" : "Config loaded (defaults)" ) ;

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
	private config : Config ;
	private db : Database ;
	private stmtInsert : ReturnType<Database[ "prepare" ]> ;
	private stmtSearch : ReturnType<Database[ "prepare" ]> ;
	private stmtRecent : ReturnType<Database[ "prepare" ]> ;
	private seen : Set<string> = new Set() ;
	private client : PluginInput[ "client" ] ;
	private sessionID : string | null = null ;

	constructor( config : Config, client : PluginInput[ "client" ] )
	{
		this.config = config ;
		this.client = client ;

		if ( ! existsSync( STORAGE_DIR ) )
			mkdirSync( STORAGE_DIR, { recursive : true } ) ;

		this.db = new Database( DB_PATH ) ;

		this.db.exec(
			`PRAGMA synchronous  = NORMAL ;
			 PRAGMA temp_store   = MEMORY ;
			 PRAGMA page_size    = 8192 ;
			 PRAGMA cache_size   = 25000 ;
			 PRAGMA journal_mode = WAL ;
			 PRAGMA busy_timeout = 5000 ;`
		);

		this.db.exec(
			`CREATE TABLE IF NOT EXISTS records (
				id       TEXT PRIMARY KEY,
				role     TEXT NOT NULL CHECK( role IN ( 'user','assistant' ) ),
				content  TEXT NOT NULL,
				created  TEXT DEFAULT ( datetime( 'now' ) )
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
		if ( pruned > 0 )
			log( LOG_LEVEL.INFO, `Pruned: ${pruned} records` ) ;
	}

	// ── Internal helpers ───────────────────────────────────────────────

	// MD5 hex of role + normalized content — record ID and exact-dedup key
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

	// Extract plain text from a message, stripping runtime parts: non-text,
	// synthetic, ignored parts and compaction checkpoints (summary messages)
	protected extractText( message : MessageLike ) : string
	{
		const checkpoint = message.info.summary === true ;
		const parts : string[] = [] ;

		for ( const part of message.parts )
		{
			if ( checkpoint || part.type != "text" || part.synthetic == true || part.ignored == true ) continue ;
			if ( part.text ) parts.push( part.text ) ;
		}

		return parts.join( "\n" ).trim() ;
	}

	// Character 3-gram shingles of normalized text (first 800 chars)
	protected trigrams( text : string ) : Set<string>
	{
		const normalized = text.toLowerCase().replace( /\s+/g, " " ).trim().slice( 0, 800 ) ;
		const grams = new Set<string>() ;

		for ( let i = 0 ; i <= normalized.length - 3 ; i++ )
			grams.add( normalized.slice( i, i + 3 ) ) ;

		return grams ;
	}

	// Trigram-Jaccard against the recent window; true when a near-dup exists
	protected isNearDuplicate( normalized : string ) : boolean
	{
		const fresh = this.trigrams( normalized ) ;
		if ( fresh.size < 3 ) return false ;

		for ( const recent of this.stmtRecent.all( RECENT_WINDOW ) as Array<{ content : string }> )
		{
			const other = this.trigrams( recent.content ) ;
			if ( other.size < 3 ) continue ;

			let inter = 0 ;
			for ( const gram of fresh )
				if ( other.has( gram ) ) inter ++ ;

			if ( inter / ( fresh.size + other.size - inter ) > DEDUP_THRESHOLD ) return true ;
		}

		return false ;
	}

	// Convert free-form text into a safe FTS5 OR-query
	protected sanitizeQuery( input : string ) : string
	{
		if ( ! input || typeof input !== "string" ) return "" ;

		const cleaned = input.toLowerCase().replace( /[^\p{L}\p{N}]+/gu, " " ) ;
		const terms = cleaned.split( /\s+/ ).filter( t => t.length > 1 ) ;

		if ( ! terms.length ) return "" ;

		return terms.map( t => `"${t}"*` ).join( " OR " ) ;
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
		catch ( err )
		{
			log( LOG_LEVEL.ERROR, `searchMemories: ${( err as Error ).message }` ) ;
			return [] ;
		}
	}

	// Compress ranked hits into a token-budgeted context block
	protected compressMemories( hits : MemoryHit[], maxTokens : number, maxSnippetChars : number ) : string
	{
		if ( ! hits.length ) return "" ;

		const parts : string[] = [] ;
		let budget = maxTokens ;

		for ( const h of hits )
		{
			let snippet = h.content.trim() ;
			if ( snippet.length > maxSnippetChars )
			{
				const truncated = snippet.slice( 0, maxSnippetChars ) ;
				const match     = truncated.match( /[\s\S]*[.!?](?=\s|$)/ ) ;

				snippet = match ? match[ 0 ].trimEnd() + "…" : truncated + "…" ;
			}

			const line = h.role === "assistant"
				? `${h.created} → ${snippet}`
				: `${h.created}   ${snippet}` ;

			const est = Math.max( 1, line.split( /\s+/ ).filter( Boolean ).length ) ;
			if ( est > budget ) break ;

			parts.push( line ) ;
			budget -= est ;
		}

		return parts.join( "\n" ) ;
	}

	// Delete records older than keepDays; returns deleted count. 0 = noop
	protected prune( keepDays : number ) : number
	{
		if ( keepDays <= 0 ) return 0 ;

		const result = this.db.run(
			"DELETE FROM records WHERE julianday( 'now' ) - julianday( created ) > ?",
			[ keepDays ]
		);

		return result.changes ?? 0 ;
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

	// ── Public hooks ──────────────────────────────────────────────────────

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
					if ( msg.info.sessionID )
						this.sessionID = msg.info.sessionID ;

					const id = msg.info.id ;

					if ( id )
					{
						if ( this.seen.has( id ) ) continue ;
						this.seen.add( id ) ;
					}

					if ( this.storeMessage( msg ) ) stored++ ;
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

	// Store one record: normalize, near-dup gate, exact dedup, insert.
	// Returns the outcome so callers can report it.
	protected storeRecord( role : string, content : string ) : "stored" | "duplicate" | "similar" | "invalid"
	{
		if ( role !== "user" && role !== "assistant" ) return "invalid" ;

		const normalized = this.normalizeContent( content ) ;
		if ( ! normalized ) return "invalid" ;

		if ( normalized.length >= 20 && this.isNearDuplicate( normalized ) )
		{
			log( LOG_LEVEL.DEBUG, `Dedup: skipped similar record (role=${ role })` ) ;
			return "similar" ;
		}

		const id = this.hashContent( role, normalized ) ;
		const result = this.stmtInsert.run( id, role, normalized ) ;

		if ( ! result.changes ) return "duplicate" ;

		return "stored" ;
	}

	// Store one conversation message. Returns true when newly stored.
	protected storeMessage( msg : MessageLike ) : boolean
	{
		const raw = this.extractText( msg ) ;

		return raw ? this.storeRecord( msg.info.role, raw ) === "stored" : false ;
	}

	// Append memory-search tool reminder to system prompt
	public handleSystemTransform( output : { system : string[] } ) : void
	{
		output.system.push( SYSTEM_PROMPT ) ;
	}

	// Store an explicit fact/decision (memory_store tool)
	public store( args : { role : string; content : string } ) : string
	{
		const result = this.storeRecord( args.role, args.content ) ;

		if ( result === "stored" )
		{
			log( LOG_LEVEL.INFO, `Stored: 1 record (role=${ args.role })` ) ;
			return "<memory-store>\n(stored)\n</memory-store>" ;
		}

		if ( result === "duplicate" )
			return "<memory-store>\n(already exists)\n</memory-store>" ;

		if ( result === "similar" )
			return "<memory-store>\n(skipped: similar record exists)\n</memory-store>" ;

		return "<memory-store>\n(error: invalid role or empty content)\n</memory-store>" ;
	}

	// Search memory, compress results into token-budgeted block
	public recall( args : { query : string; max_results? : number } ) : string
	{
		const limit = Math.max( 1, args.max_results ?? this.config.max_results ) ;
		const hits  = this.searchMemories(
			args.query, limit, this.config.search_max_days
		) ;

		const contextStr = ! hits.length
			? ""
			: this.compressMemories( hits, this.config.max_tokens_memory, this.config.max_snippet_chars ) ;

		if ( ! contextStr )
			return "<memory-result>\n(no match fits the token budget)\n</memory-result>" ;

		return `<memory-result>\n${contextStr}\n</memory-result>` ;
	}

	// Backfill last message on dispose, close DB
	public async dispose() : Promise<void>
	{
		try
		{
			const msg = await this.fetchLastMessage() ;
			if ( msg ) this.storeMessage( msg ) ;
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

// Wrap a tool body so it never throws: log the error, return a block
function guard<A>( tag : string, open : string, fn : ( args : A ) => string ) : ( args : A ) => Promise<string>
{
	return async ( args : A ) =>
	{
		try
		{
			return fn( args ) ;
		}
		catch ( err )
		{
			log( LOG_LEVEL.ERROR, `${ tag }: ${ ( err as Error ).message }` ) ;
			return `<${ open }>\n(error: ${ tag })\n</${ open }>` ;
		}
	} ;
}

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
				execute : guard( "memory_search", "memory-result", args => dm.recall( args ) ),
			} ),

			memory_store : tool( {
				description : STORE_DESC,
				args : {
					role : tool.schema.string().describe( STORE_ROLE_DESC ),
					content : tool.schema.string().describe( STORE_CONTENT_DESC ),
				},
				execute : guard( "memory_store", "memory-store", args => dm.store( args ) ),
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
			await dm.dispose() ;
		},
	} ;
} ) satisfies Plugin ;

// ─── END ──────────────────────────────────────────────────────────────
