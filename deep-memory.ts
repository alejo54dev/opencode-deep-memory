/**
*	deep-memory.ts
*
*	OpenCode plugin — persistent long-term memory via SQLite FTS5.
*	Stores conversation turns, recalls relevant context on each turn.
*
*	Install: cp deep-memory.ts ~/.config/opencode/plugins/deep-memory.ts
*	Storage: ~/.config/opencode/storage/deep-memory.db
*	Config:  ~/.config/opencode/deep-memory.jsonc
*	Log:     ~/.config/opencode/deep-memory.log
*
*	@example ~/.config/opencode/deep-memory.jsonc
*	{
*		"fts_results": 20,
*		"max_tokens_memory": 2000,
*		"max_age_days": 3000,       // 0 = forever
*		"overlap_threshold": 0.5,
*		"dedup_threshold": 0.6,
*		"overlap_window": 8,
*		"max_snippet_chars": 250,
*		"log_level": "info",        // "silent" | "error" | "info" | "debug"
*	}
*
*	@name deep-memory
*	@version 1.0.34
*	@author Alejandro Carraretto
*	@author DeepSeek-V4
*	@license MIT
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
	fts_results:        10,
	max_tokens_memory:  2000,
	max_age_days:       3000,
	overlap_threshold:  0.5,
	dedup_threshold:    0.6,
	overlap_window:     8,
	max_snippet_chars:  250,
	log_level:          "info" as "silent" | "error" | "info" | "debug",
};

const LOG_LEVEL =
{
	SILENT : 0,
	ERROR  : 1,
	INFO   : 2,
	DEBUG  : 3,
} as const ;

const STRIP_PATTERNS =
[
	/<system[^>]*>[\s\S]*?<\/system[^>]*>/gi,
	/<env[^>]*>[\s\S]*?<\/env[^>]*>/gi,
	/<think[^>]*>[\s\S]*?<\/think[^>]*>/gi,
	/<tool_[^>]*>[\s\S]*?<\/tool_[^>]*>/gi,
	/<mcp_[^>]*>[\s\S]*?<\/mcp_[^>]*>/gi,
	/<dcp-[^>]*>[\s\S]*?<\/dcp-[^>]*>/gi,
	/<conver[^>]*>[\s\S]*?<\/conver[^>]*>/gi,
	/<temp[^>]*>[\s\S]*?<\/temp[^>]*>/gi,
	/<available_[^>]*>[\s\S]*?<\/available_[^>]*>/gi,
	/<prev[^>]*>[\s\S]*?<\/prev[^>]*>/gi,
	/<handoff[^>]*>[\s\S]*?<\/handoff[^>]*>/gi,
	/<deep-[^>]*>[\s\S]*?<\/deep-[^>]*>/gi,
	/\[Tool output truncated/gi,
	/\[Old tool result/gi,
	/▣\s*(?:DCP|Compression)[\s\S]*/gi,
	/\[Compressed[\s\S]*/gi,
];

const TOOL_DESC =
[
	"Search long-term memory using full-text search.",
	"Use this when you need to recall past conversation turns,",
	"decisions, or facts stored across all sessions.",
].join( " " ) ;

const QUERY_DESC =
[
	"The search query — natural language text",
	"describing what to find in memory",
].join( " " ) ;

const MAX_RESULTS_DESC =
[
	"Maximum number of results to return",
	"(default: fts_results config)",
].join( " " ) ;

// ─── Interfaces ────────────────────────────────────────────────────────────

interface RecordRow
{
	id: number ;
	role: "user" | "assistant" ;
	content: string ;
	created_at: string ;
}

interface MemoryHit
{
	id: number ;
	role: "user" | "assistant" ;
	content: string ;
	created_at: string ;
	rank: number ;
}

interface MessageLike
{
	info: { role: "user" | "assistant"; id?: string } ;
	parts: Array<{ type: string; text?: string }> ;
}

// ─── Config ─────────────────────────────────────────────────────────────────

// Load config from ~/.config/opencode/deep-memory.json, fall back to defaults
function loadConfig()
{
	let file : Record<string, unknown> = {} ;
	try
	{
		file = Bun.JSONC.parse( readFileSync( CONFIG_FILE, "utf8" ) ) ;
		log( LOG_LEVEL.INFO, "Config loaded" ) ;
	}
	catch
	{
		log( LOG_LEVEL.ERROR, `Config not found or parse error at ${ CONFIG_FILE }` ) ;
	}

	const opts =
	{
		fts_results:        Math.max( 1,  file.fts_results        ?? CONFIG.fts_results       ),
		max_tokens_memory:  Math.max( 100, file.max_tokens_memory ?? CONFIG.max_tokens_memory ),
		max_age_days:       Math.max( 0,  file.max_age_days       ?? CONFIG.max_age_days      ),
		overlap_threshold:  Math.max( 0,  file.overlap_threshold  ?? CONFIG.overlap_threshold ),
		dedup_threshold:    Math.max( 0,  file.dedup_threshold    ?? CONFIG.dedup_threshold   ),
		overlap_window:     Math.max( 1,  file.overlap_window     ?? CONFIG.overlap_window    ),
		max_snippet_chars:  Math.max( 50, file.max_snippet_chars  ?? CONFIG.max_snippet_chars ),
		log_level:          file.log_level                        ?? CONFIG.log_level          ,
	} as typeof CONFIG;

	CONFIG.log_level = opts.log_level ;

	return opts ;
}

// ─── Logger ────────────────────────────────────────────────────────────────

// Append timestamped entry to ~/.config/opencode/deep-memory.log
function log( level : number, message : string ) : void
{
	const min = LOG_LEVEL[ ( CONFIG.log_level ?? "info" ).toUpperCase() ] ?? LOG_LEVEL.ERROR ;

	if ( level > min ) return ;

	const label = Object.keys( LOG_LEVEL )[ level ] ?? "" ;

	try
	{
		appendFileSync( LOG_FILE, `[${ new Date().toISOString() }] [${ label }]: ${ message }\n` ) ;
	}
	catch {}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// SHA-1 hex of role + content — dedup key for storeTurns
function isValidRole( role: string ): boolean
{
	return ["user", "assistant"].includes( role );
}


function hashContent( role: string, content: string ): string
{
	return createHash( "sha1" ).update( role + ":" + content ).digest( "hex" ) ;
}


// Strip DCP/system/thinking/tool tags and normalize to lowercase for FTS indexing
function normalizeContent( raw: string | undefined ): string
{
	if ( !raw ) return "" ;

	let text = raw ;

	for ( const pattern of STRIP_PATTERNS )
		text = text.replace( pattern, "" ) ;

	return text.toLowerCase().trim() ;
}

// Convert free-form text into a safe FTS5 OR-query (strips punctuation, keeps >2-char terms)
function sanitizeFtsQuery( input: string ): string
{
	if ( !input || typeof input !== "string" ) return "" ;

	const cleaned = input.toLowerCase().replace( /[^\p{L}\p{N}\s-]/gu, "" ) ;
	const raw     = cleaned.split( /[\s-]+/ ) ;

	const terms : string[] = [] ;

	for ( const t of raw )
		if ( t.length > 2 ) terms.push( t ) ;

	if ( terms.length === 0 ) return "" ;

	return terms.map( t => `"${t}"*` ).join( " OR " ) ;
}

// Jaccard similarity over word tokens — used for dedup and overlap filtering
// Returns 0 for texts with fewer than 3 significant tokens to avoid spurious matches
function contentOverlap( a: string, b: string ): number
{
	const setA = new Set( a.toLowerCase().split( /[\s-]+/ ).filter( w => w.length > 2 ) ) ;
	const setB = new Set( b.toLowerCase().split( /[\s-]+/ ).filter( w => w.length > 2 ) ) ;

	if ( setA.size < 3 || setB.size < 3 ) return 0 ;

	const [ smaller, larger ] = setA.size <= setB.size
		? [ setA, setB ] : [ setB, setA ] ;

	let inter = 0;
	for ( const x of smaller )
		if ( larger.has( x ) ) inter++ ;

	const union = setA.size + setB.size - inter ;
	return union === 0 ? 0 : inter / union ;
}

// Compress FTS hits into a token-budgeted context block with single-pass dedup
// Skips hits that overlap heavily with already-picked ones; sorts by rank descending
function compressMemories(
	hits: MemoryHit[],
	maxTokens: number,
	dedupThreshold: number,
	maxSnippetChars: number
): string
{
	if ( hits.length === 0 ) return "" ;

	const pick: MemoryHit[] = [] ;
	for ( const h of hits )
	{
		let isDup = false ;

		for ( const p of pick )
		{
			if ( contentOverlap( p.content, h.content ) > dedupThreshold )
			{
				isDup = true ;
				break ;
			}
		}
		if ( !isDup ) pick.push( h ) ;
	}

	pick.sort( ( a, b ) => b.rank - a.rank ) ;

	const parts: string[] = [] ;
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

		const est = Math.ceil( line.length / 4 ) ;
		if ( est > budget ) break ;

		parts.push( line ) ;
		budget -= est ;
	}

	return parts.join( "\n" ) ;
}

// Extract plain text from a MessageLike, filtering out <system-reminder> noise
function extractText( msg: MessageLike ): string
{
	const parts: string[] = [];

	for ( const p of msg.parts )
	{
		if ( p.type === "text" && p.text && !p.text.startsWith( "<system-reminder>" ) )
		{
			parts.push( p.text );
		}
	}

	return parts.join( "\n" ).trim();
}

// Current local datetime as ISO-like string: "2026-07-06T20:30:26"
function timestamp(): string
{
	const utc    = new Date() ;
	const offset = utc.getTimezoneOffset() ;
	const local  = new Date( utc.getTime() - offset * 60 * 1000 ) ;

	return local.toISOString().slice( 0, 19 ) ;
}

// ─── Storage ───────────────────────────────────────────────────────────────

// SQLite-backed turn store with FTS5 index for full-text search.
// Schema is fixed at v4; migrations are handled externally, not at runtime.
class Storage
{
	private db: Database ;
	private stmtInsert: ReturnType<Database["prepare"]> ;
	private stmtRecent: ReturnType<Database["prepare"]> ;
	private stmtSearch: ReturnType<Database["prepare"]> ;
	private stmtNextTurn: ReturnType<Database["prepare"]> ;

	// Prepare prepared statements: insert, recent, search (ranked), next-turn lookup
	private constructor( db: Database )
	{
		this.db = db;
		this.stmtInsert = db.prepare(
			"INSERT OR IGNORE INTO records ( role, content, content_hash ) VALUES ( ?, ?, ? )"
		);
		this.stmtRecent = db.prepare(
			"SELECT id, role, content, created_at FROM records ORDER BY created_at DESC LIMIT ?"
		);
		// Rank = FTS relevance × role weight (user=3x, assistant=1x) × recency decay (30-day half-life)
		this.stmtSearch = db.prepare(
			`SELECT t.id, t.role, t.content, t.created_at,
			        rank * CASE WHEN t.role = 'user' THEN 3.0 ELSE 1.0 END
			             * ( 1.0 + MAX( 0.0, 1.0 - ( julianday( 'now' ) - julianday( t.created_at ) ) / 30.0 ) ) AS rank
			 FROM records_fts JOIN records t ON records_fts.rowid = t.id
			 WHERE records_fts MATCH ?
			   AND ( ? = 0 OR julianday( 'now' ) - julianday( t.created_at ) <= ? )
			 ORDER BY rank LIMIT ?`
		);
		this.stmtNextTurn = db.prepare(
			"SELECT id, role, content, created_at FROM records WHERE id = ? + 1 AND role = 'assistant' LIMIT 1"
		);
	}

	// Open or create the SQLite DB with WAL pragmas and v4 schema (turns + FTS5 + triggers)
	static open(): Storage
	{
		if ( !existsSync( STORAGE_DIR ) )
			mkdirSync( STORAGE_DIR, { recursive: true } ) ;

		const db = new Database( DB_PATH ) ;

		// Performance and durability pragmas
		db.exec( `
			PRAGMA synchronous          = NORMAL ;
			PRAGMA temp_store           = MEMORY ;
			PRAGMA page_size            = 8192 ;
			PRAGMA cache_size           = 25000 ;
			PRAGMA cache_spill          = ON ;
			PRAGMA journal_mode         = WAL ;
			PRAGMA wal_autocheckpoint   = 1000 ;
			PRAGMA automatic_index      = ON ;
			PRAGMA recursive_triggers   = ON ;
			PRAGMA foreign_keys         = ON ;
			PRAGMA threads              = 4 ;
			PRAGMA busy_timeout         = 5000 ;
			PRAGMA user_version         = 1 ;
		` );

		// Schema: records table with FTS5 mirror, kept in sync via triggers
		db.exec( `
			CREATE TABLE IF NOT EXISTS records (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				role TEXT NOT NULL CHECK( role IN ( 'user','assistant' ) ),
				content TEXT NOT NULL,
				content_hash TEXT NOT NULL UNIQUE,
				created_at TEXT NOT NULL DEFAULT ( datetime( 'now' ) )
			);
			CREATE INDEX IF NOT EXISTS idx_records_created
				ON records( created_at )
			;
			CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
				content, content='records', content_rowid='id',
				tokenize="unicode61 remove_diacritics 1"
			);
			CREATE TRIGGER IF NOT EXISTS records_ai AFTER INSERT ON records BEGIN
				INSERT INTO records_fts( rowid, content ) VALUES ( new.id, new.content );
			END
			;
			CREATE TRIGGER IF NOT EXISTS records_ad AFTER DELETE ON records BEGIN
				INSERT INTO records_fts( records_fts, rowid, content ) VALUES( 'delete', old.id, old.content );
			END
			;
			CREATE TRIGGER IF NOT EXISTS records_au AFTER UPDATE ON records BEGIN
				INSERT INTO records_fts( records_fts, rowid, content ) VALUES( 'delete', old.id, old.content );
				INSERT INTO records_fts( rowid, content ) VALUES ( new.id, new.content );
			END
			;
		` );

		return new Storage( db ) ;
	}

	// Close the DB with a WAL checkpoint; safe to call multiple times
	close(): void
	{
		try
		{
			this.db.run( "PRAGMA wal_checkpoint( TRUNCATE )" ) ;
			this.db.close() ;
		}
		catch { /* already closed */ }
	}

	// Store messages in a transaction; dedup via content_hash UNIQUE constraint
	storeRecords(
		messages: Array<{ role: "user" | "assistant"; text: string }>
	): number
	{
		if ( messages.length === 0 ) return 0 ;

		let count = 0 ;
		const tx = this.db.transaction( ( msgs: typeof messages ) =>
		{
			for ( const m of msgs )
			{
				const text = normalizeContent( m.text );
				if ( !text ) continue ;

				const result = this.stmtInsert.run(
					m.role, text, hashContent( m.role, text )
				);
				if ( result.changes > 0 ) count++ ;
			}
		} );

		tx( messages ) ;
		return count ;
	}

	// Fetch the most recent records, newest first (used for overlap filtering)
	getRecentRecords( limit: number ): RecordRow[]
	{
		return this.stmtRecent.all( limit ) as RecordRow[] ;
	}

	// FTS5 search, ranked by relevance × role weight (user=3x) × recency decay (30-day half-life)
	// Expands user hits with their following assistant response (pair recall)
	searchMemories(
		query: string,
		limit: number,
		maxAgeDays: number
	): MemoryHit[]
	{
		const sanitized = sanitizeFtsQuery( query ) ;
		if ( !sanitized ) return [] ;

		try
		{
			const hits = this.stmtSearch.all( sanitized, maxAgeDays, maxAgeDays, limit ) as MemoryHit[] ;

			// Expand user hits with their following assistant response
			const expanded: MemoryHit[] = [] ;
			const seenIds = new Set<number>() ;

			for ( const hit of hits )
			{
				if ( !seenIds.has( hit.id ) )
				{
					expanded.push( hit ) ;
					seenIds.add( hit.id ) ;
				}
				if ( hit.role === "user" )
				{
					const next = this.stmtNextTurn.get( hit.id ) as MemoryHit | undefined ;
					if ( next && !seenIds.has( next.id ) )
					{
						expanded.push( { ...next, rank: hit.rank } ) ;
						seenIds.add( next.id ) ;
					}
				}
			}

			return expanded ;
		}
		catch
		{
			return [] ;
		}
	}
}

// ─── DeepMemory ────────────────────────────────────────────────────────────

class DeepMemory
{
	private opts    : ReturnType<typeof loadConfig> ;
	private storage : Storage ;

	private _boundOnExit : () => void ;

	constructor(
		opts    : ReturnType<typeof loadConfig>,
		storage : Storage,
	)
	{
		this.opts    = opts ;
		this.storage = storage ;

		this._boundOnExit = () => this.storage.close() ;
		process.once( "exit", this._boundOnExit ) ;
	}

	// ── Public hooks ──────────────────────────────────────────────────────

	recall(
		args : { query: string; max_results?: number },
	): string
	{
		const limit   = args.max_results ?? this.opts.fts_results ;
		const recent  = this.storage.getRecentRecords( this.opts.overlap_window ) ;
		const hits    = this.storage.searchMemories( args.query, limit, this.opts.max_age_days ) ;

		const filteredHits = hits.filter( hit =>
		{
			for ( const record of recent )
			{
				if ( contentOverlap( hit.content, record.content ) > this.opts.overlap_threshold )
					return false ;
			}
			return true ;
		} );

		const contextStr = filteredHits.length === 0
			? ""
			: compressMemories(
				filteredHits, this.opts.max_tokens_memory, this.opts.dedup_threshold, this.opts.max_snippet_chars
			);

		if ( !contextStr )
			return "<deep-memory>\n(no matches found)\n</deep-memory>" ;

		return `<deep-memory>\n${contextStr}\n</deep-memory>` ;
	}

	handleMessagesTransform(
		output : { messages: Array<MessageLike> },
	): void
	{
		try
		{
			if ( !output.messages?.length ) return ;

			const pairs: Array<{ role: "user" | "assistant"; text: string }> = [] ;

			for ( const msg of output.messages )
			{
				if ( !isValidRole( msg.info.role ) ) continue ;

				const text = extractText( msg as MessageLike ) ;
				if ( !text ) continue ;

				pairs.push( { role: msg.info.role, text } ) ;
			}

			if ( pairs.length > 0 )
			{
				const stored = this.storage.storeRecords( pairs ) ;
				log( LOG_LEVEL.INFO, `Stored: ${stored} records` ) ;
			}
		}
		catch ( err )
		{
			log( LOG_LEVEL.ERROR, `messages.transform: ${( err as Error ).message}` ) ;
		}
	}

	handleSystemTransform(
		output : { system: string[] },
	): void
	{
		output.system.push( "[deep-memory active: use tool memory_search() to search long-term memory]" ) ;
	}

	dispose(): void
	{
		process.removeListener( "exit", this._boundOnExit ) ;
		this.storage.close() ;
		log( LOG_LEVEL.INFO, `Disposed at ${ timestamp() }` ) ;
	}
}

// ─── Plugin ────────────────────────────────────────────────────────────────

export default ( async ( _ctx: PluginInput ) =>
{
	const opts      = loadConfig() ;
	const storage   = Storage.open() ;
	const dm        = new DeepMemory( opts, storage ) ;

	log( LOG_LEVEL.INFO, `Initialized at ${ timestamp() }` ) ;

	return {
		tool: {
			memory_search: tool( {
				description: TOOL_DESC,
				args: {
					query: tool.schema.string().describe( QUERY_DESC ),
					max_results: tool.schema.number().optional().describe( MAX_RESULTS_DESC ),
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
		},

		"experimental.chat.messages.transform": ( _input, output ) =>
		{
			dm.handleMessagesTransform( output ) ;
		},

		"experimental.chat.system.transform": ( _input, output ) =>
		{
			dm.handleSystemTransform( output ) ;
		},

		dispose: () =>
		{
			dm.dispose() ;
		},
	};
} ) satisfies Plugin ;

// ─── END ──────────────────────────────────────────────────────────────
