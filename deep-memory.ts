/**
*	deep-memory.ts
*
*	OpenCode plugin — persistent long-term memory via SQLite FTS5.
*	Stores conversation turns, recalls relevant context on each turn.
*
*	Install: cp deep-memory.ts ~/.config/opencode/plugins/deep-memory.ts
*	Storage: ~/.config/opencode/storage/deep-memory.db
*	Config:  ~/.config/opencode/deep-memory.json
*	Log:     ~/.config/opencode/deep-memory.log
*
*	@example ~/.config/opencode/deep-memory.json
*	{
*		"fts_results": 20,
*		"max_tokens_memory": 2000,
*		"max_age_days": 3000,       // 0 = forever
*		"overlap_threshold": 0.5,
*		"dedup_threshold": 0.6,
*		"overlap_window": 8,
*		"max_snippet_chars": 250,
*		"log_level": "info"         // "silent" | "error" | "info" | "debug"
*	}
*
*	@name deep-memory
*	@version 1.0.28
*	@author Alejandro Carraretto
*	@author DeepSeek-V4
*	@license MIT
*/

import { type Plugin, type PluginInput, tool } from "@opencode-ai/plugin";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, existsSync, appendFileSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

// ─── Paths ─────────────────────────────────────────────────────────────────

const CONFIG_DIR  = join( homedir(), ".config", "opencode" ) ;
const CONFIG_FILE = join( CONFIG_DIR, "deep-memory.json" ) ;
const LOG_FILE    = join( CONFIG_DIR, "deep-memory.log" ) ;
const STORAGE_DIR = join( CONFIG_DIR, "storage" ) ;
const DB_PATH     = join( STORAGE_DIR, "deep-memory.db" ) ;

// ─── Constants ─────────────────────────────────────────────────────────────

const CONFIG =
{
	fts_results:        20,
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
	/<env>[\s\S]*?<\/env>/g,
	/<thinking>[\s\S]*?<\/thinking>/g,
	/<system>[\s\S]*?<\/system>/g,
	/<system-reminder>[\s\S]*?<\/system-reminder>/g,
	/<tool_result>[\s\S]*?<\/tool_result>/g,
	/<mcp_instructions>[\s\S]*?<\/mcp_instructions>/g,
	/<conversation-checkpoint>[\s\S]*?<\/conversation-checkpoint>/g,
	/<template>[\s\S]*?<\/template>/g,
	/<available_skills>[\s\S]*?<\/available_skills>/g,
	/<available_references>[\s\S]*?<\/available_references>/g,
	/<dcp-message-id>[\s\S]*?<\/dcp-message-id>/g,
	/\[Tool output truncated/g,
	/\[Old tool result/g,
	/▣\s*(?:DCP|Compression)[\s\S]*/g,
	/\[Compressed[\s\S]*/g,
	/<previous-summary>[\s\S]*?<\/previous-summary>/g,
	/<handoff-resume>[\s\S]*?<\/handoff-resume>/g,
];

// ─── Interfaces ────────────────────────────────────────────────────────────

interface TurnRow
{
	id: number;
	session_id: string;
	role: "user" | "assistant";
	content: string;
	created_at: string;
}

interface MemoryHit
{
	id: number;
	role: "user" | "assistant";
	content: string;
	created_at: string;
	rank: number;
}

interface MessageLike
{
	info: { role: "user" | "assistant"; id?: string };
	parts: Array<{ type: string; text?: string }>;
}

// ─── Config ─────────────────────────────────────────────────────────────────

// Load config from ~/.config/opencode/deep-memory.json, fall back to defaults
function loadConfig()
{
	let file : Record<string, unknown> = {};
	try
	{
		file = JSON.parse( readFileSync( CONFIG_FILE, "utf8" ) );
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

	CONFIG.log_level = opts.log_level;

	return opts;
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

// ─── Storage ───────────────────────────────────────────────────────────────

// SQLite-backed turn store with FTS5 index for full-text search.
// Schema is fixed at v4; migrations are handled externally, not at runtime.
class Storage
{
	private db: Database;
	private stmtInsert: ReturnType<Database["prepare"]>;
	private stmtRecent: ReturnType<Database["prepare"]>;
	private stmtSearch: ReturnType<Database["prepare"]>;
	private stmtNextTurn: ReturnType<Database["prepare"]>;

	// Prepare prepared statements: insert, recent, search (ranked), next-turn lookup
	private constructor( db: Database )
	{
		this.db = db;
		this.stmtInsert = db.prepare(
			"INSERT OR IGNORE INTO turns (session_id, role, content, content_hash) VALUES (?, ?, ?, ?)"
		);
		this.stmtRecent = db.prepare(
			"SELECT id, session_id, role, content, created_at FROM turns WHERE session_id = ? ORDER BY created_at DESC LIMIT ?"
		);
		// Rank = FTS relevance × role weight (user=3x, assistant=1x) × recency decay (30-day half-life)
		this.stmtSearch = db.prepare(
			`SELECT t.id, t.role, t.content, t.created_at,
			        rank * CASE WHEN t.role = 'user' THEN 3.0 ELSE 1.0 END
			             * (1.0 + MAX(0.0, 1.0 - (julianday('now') - julianday(t.created_at)) / 30.0)) AS rank
			 FROM turns_fts JOIN turns t ON turns_fts.rowid = t.id
			 WHERE turns_fts MATCH ?
			   AND (? = 0 OR julianday('now') - julianday(t.created_at) <= ?)
			 ORDER BY rank LIMIT ?`
		);
		this.stmtNextTurn = db.prepare(
			"SELECT id, role, content, created_at FROM turns WHERE id = ? + 1 AND role = 'assistant' LIMIT 1"
		);
	}

	// Open or create the SQLite DB with WAL pragmas and v4 schema (turns + FTS5 + triggers)
	static open(): Storage
	{
		if ( !existsSync( STORAGE_DIR ) )
			mkdirSync( STORAGE_DIR, { recursive: true } );

		const db = new Database( DB_PATH );

		// Performance and durability pragmas
		db.exec( `
			PRAGMA synchronous          = NORMAL;
			PRAGMA temp_store           = MEMORY;
			PRAGMA page_size            = 8192;
			PRAGMA cache_size           = 25000;
			PRAGMA cache_spill          = ON;
			PRAGMA journal_mode         = WAL;
			PRAGMA wal_autocheckpoint   = 1000;
			PRAGMA automatic_index      = ON;
			PRAGMA recursive_triggers   = ON;
			PRAGMA foreign_keys         = ON;
			PRAGMA threads              = 4;
			PRAGMA busy_timeout         = 5000;
			PRAGMA user_version         = 4;
		` );

		// Schema: turns table with FTS5 mirror, kept in sync via triggers
		db.exec( `
			CREATE TABLE IF NOT EXISTS turns (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL,
				role TEXT NOT NULL CHECK(role IN ('user','assistant')),
				content TEXT NOT NULL,
				content_hash TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_dedup
				ON turns(session_id, content_hash);
			CREATE INDEX IF NOT EXISTS idx_turns_session_created
				ON turns(session_id, created_at);
			CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
				content, content='turns', content_rowid='id',
				tokenize="unicode61 remove_diacritics 1"
			);
			CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
				INSERT INTO turns_fts(rowid, content) VALUES (new.id, new.content);
			END;
			CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
				INSERT INTO turns_fts(turns_fts, rowid, content) VALUES('delete', old.id, old.content);
			END;
			CREATE TRIGGER IF NOT EXISTS turns_au AFTER UPDATE ON turns BEGIN
				INSERT INTO turns_fts(turns_fts, rowid, content) VALUES('delete', old.id, old.content);
				INSERT INTO turns_fts(rowid, content) VALUES (new.id, new.content);
			END;
		` );

		return new Storage( db );
	}

	// Close the DB with a WAL checkpoint; safe to call multiple times
	close(): void
	{
		try
		{
			this.db.run( "PRAGMA wal_checkpoint(TRUNCATE)" );
			this.db.close();
		}
		catch { /* already closed */ }
	}

	// Store messages in a transaction; dedup via unique index on (session_id, content_hash)
	storeTurns(
		sessionId: string,
		messages: Array<{ role: "user" | "assistant"; text: string }>
	): number
	{
		if ( messages.length === 0 ) return 0;

		let count = 0;
		const tx = this.db.transaction( ( msgs: typeof messages ) =>
		{
			for ( const m of msgs )
			{
				const text = normalizeContent( m.text );
				if ( !text ) continue;
				const result = this.stmtInsert.run(
					sessionId, m.role, text, hashContent( m.role, text )
				);
				if ( result.changes > 0 ) count++;
			}
		} );
		tx( messages );
		return count;
	}

	// Fetch the most recent turns for a session, newest first (used for overlap filtering)
	getRecentTurns( sessionId: string, limit: number ): TurnRow[]
	{
		return this.stmtRecent.all( sessionId, limit ) as TurnRow[];
	}

	// FTS5 search, ranked by relevance × role weight (user=3x) × recency decay (30-day half-life)
	// Expands user hits with their following assistant response (pair recall)
	searchMemories(
		query: string,
		limit: number,
		maxAgeDays: number
	): MemoryHit[]
	{
		const sanitized = sanitizeFtsQuery( query );
		if ( !sanitized ) return [];

		try
		{
			const hits = this.stmtSearch.all( sanitized, maxAgeDays, maxAgeDays, limit ) as MemoryHit[];

			// Expand user hits with their following assistant response
			const expanded: MemoryHit[] = [];
			const seenIds = new Set<number>();

			for ( const hit of hits )
			{
				if ( !seenIds.has( hit.id ) )
				{
					expanded.push( hit );
					seenIds.add( hit.id );
				}
				if ( hit.role === "user" )
				{
					const next = this.stmtNextTurn.get( hit.id ) as MemoryHit | undefined;
					if ( next && !seenIds.has( next.id ) )
					{
						expanded.push( { ...next, rank: hit.rank } );
						seenIds.add( next.id );
					}
				}
			}

			return expanded;
		}
		catch
		{
			return [];
		}
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// SHA-1 hex of role + content — dedup key for storeTurns
function hashContent( role: string, content: string ): string
{
	return createHash( "sha1" ).update( role + ":" + content ).digest( "hex" );
}

// SHA-1 hex (16 chars) of username + cwd — deterministic session identifier across restarts
function sessionHash( path: string ): string
{
	return createHash( "sha1" ).update( path ).digest( "hex" ).slice( 0, 16 );
}

// Strip DCP/system/thinking/tool tags and normalize to lowercase for FTS indexing
function normalizeContent( raw: string | undefined ): string
{
	if ( !raw ) return "";
	let text = raw;
	for ( const pattern of STRIP_PATTERNS )
		text = text.replace( pattern, "" );
	return text.toLowerCase().trim();
}

// Convert free-form text into a safe FTS5 OR-query (strips punctuation, keeps >2-char terms)
function sanitizeFtsQuery( input: string ): string
{
	if ( !input || typeof input !== "string" ) return "";

	const terms = input
		.toLowerCase()
		.replace( /[^\p{L}\p{N}\s-]/gu, "" )
		.split( /[\s-]+/ )
		.filter( t => t.length > 2 );

	if ( terms.length === 0 ) return "";
	return terms.map( t => `"${t}"*` ).join( " OR " );
}

// Jaccard similarity over word tokens — used for dedup and overlap filtering
// Returns 0 for texts with fewer than 3 significant tokens to avoid spurious matches
function contentOverlap( a: string, b: string ): number
{
	const setA = new Set( a.toLowerCase().split( /[\s-]+/ ).filter( w => w.length > 2 ) );
	const setB = new Set( b.toLowerCase().split( /[\s-]+/ ).filter( w => w.length > 2 ) );

	if ( setA.size < 3 || setB.size < 3 ) return 0;

	const [ smaller, larger ] = setA.size <= setB.size
		? [ setA, setB ] : [ setB, setA ];

	let inter = 0;
	for ( const x of smaller )
	{
		if ( larger.has( x ) ) inter++;
	}

	const union = setA.size + setB.size - inter;
	return union === 0 ? 0 : inter / union;
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
	if ( hits.length === 0 ) return "";

	const pick: MemoryHit[] = [];
	for ( const h of hits )
	{
		let isDup = false;
		for ( const p of pick )
		{
			if ( contentOverlap( p.content, h.content ) > dedupThreshold )
			{
				isDup = true;
				break;
			}
		}
		if ( !isDup ) pick.push( h );
	}

	pick.sort( ( a, b ) => b.rank - a.rank );

	const parts: string[] = [];
	let budget = maxTokens;

	for ( const h of pick )
	{
		let snippet = h.content.trim();
		if ( snippet.length > maxSnippetChars )
		{
			const truncated = snippet.slice( 0, maxSnippetChars );
			const match     = truncated.match( /[\s\S]*[.!?](?=\s|$)/ );
			snippet = match ? match[ 0 ].trimEnd() + "…" : truncated + "…";
		}

		const line = h.role === "assistant"
			? `→ ${snippet}`
			: `  ${snippet}`;

		const est = Math.ceil( line.length / 4 );
		if ( est > budget ) break;

		parts.push( line );
		budget -= est;
	}

	return parts.join( "\n" );
}

// Extract plain text from a MessageLike, filtering out <system-reminder> noise
function extractText( msg: MessageLike ): string
{
	return msg.parts
		.filter( p =>
			p.type === "text" &&
			p.text &&
			!p.text.startsWith( "<system-reminder>" )
		)
		.map( p => p.text! )
		.join( "\n" )
		.trim();
}

// ─── Plugin ────────────────────────────────────────────────────────────────

export default ( async ( ctx: PluginInput ) =>
{
	const opts      = loadConfig();
	const storage   = Storage.open();
	const sessionId = sessionHash( `${userInfo().username}:${ctx.directory || process.cwd()}` );
	const onExit    = () => storage.close();

	process.once( "exit", onExit );
	log( LOG_LEVEL.INFO, `Initialized | session: ${sessionId}` );

	return {
		tool: {
			deep_memory_recall: tool( {
				description: "Search long-term memory using full-text search. Use this when you need to recall past conversation turns, decisions, or facts stored across all sessions.",
				args: {
					query: tool.schema.string().describe( "The search query — natural language text describing what to find in memory" ),
					max_results: tool.schema.number().optional().describe( "Maximum number of results to return (default: fts_results config)" ),
				},
				async execute( args, context )
				{
					try
					{
						return handleRecall( args, opts, storage, sessionId );
					}
					catch ( err )
					{
						log( LOG_LEVEL.ERROR, `deep_memory_recall: ${( err as Error ).message}` );
						return "<deep-memory>\n(error searching memory)\n</deep-memory>";
					}
				},
			} ),
		},

		"experimental.chat.messages.transform": async ( _input, output ) =>
		{
			handleMessagesTransform( output, storage, sessionId );
		},

		"experimental.chat.system.transform": async ( _input, output ) =>
		{
			output.system.push( "[deep-memory active: use tool deep_memory_recall() to search long-term memory]" );
		},

		dispose: async () =>
		{
			process.removeListener( "exit", onExit );
			storage.close();
			log( LOG_LEVEL.INFO, `Disposed | session: ${sessionId}` );
		},
	};
} ) satisfies Plugin;

// ─── Handlers ────────────────────────────────────────────────────────────────

function handleRecall(
	args    : { query: string; max_results?: number },
	opts    : ReturnType<typeof loadConfig>,
	storage : Storage,
	sessionId : string,
): string
{
	const limit   = args.max_results ?? opts.fts_results;
	const recent  = storage.getRecentTurns( sessionId, opts.overlap_window );
	const hits    = storage.searchMemories( args.query, limit, opts.max_age_days );

	const filteredHits = hits.filter( hit =>
	{
		for ( const turn of recent )
		{
			if ( contentOverlap( hit.content, turn.content ) > opts.overlap_threshold )
				return false;
		}
		return true;
	} );

	const contextStr = filteredHits.length === 0
		? ""
		: compressMemories(
			filteredHits, opts.max_tokens_memory, opts.dedup_threshold, opts.max_snippet_chars
		);

	if ( !contextStr )
		return "<deep-memory>\n(no matches found)\n</deep-memory>";

	return `<deep-memory>\n${contextStr}\n</deep-memory>`;
}

function handleMessagesTransform(
	output  : { messages: Array<MessageLike> },
	storage : Storage,
	sessionId : string,
): void
{
	try
	{
		if ( !output.messages?.length ) return;

		const pairs: Array<{ role: "user" | "assistant"; text: string }> = [];
		for ( const msg of output.messages )
		{
			const text = extractText( msg as MessageLike );
			if ( !text ) continue;
			pairs.push( { role: msg.info.role, text } );
		}
		if ( pairs.length > 0 )
		{
			const stored = storage.storeTurns( sessionId, pairs );
			log( LOG_LEVEL.INFO, `Stored: ${stored} turns` );
		}
	}
	catch ( err )
	{
		log( LOG_LEVEL.ERROR, `messages.transform: ${( err as Error ).message}` );
	}
}
