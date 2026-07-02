/**
*	deep-memory.ts
*
*	OpenCode plugin — persistent long-term memory via SQLite FTS5.
*	Stores conversation turns, recalls relevant context on each turn,
*	prunes old entries, deduplicates near-duplicates.
*
*	Install: cp deep-memory.ts ~/.config/opencode/plugins/deep-memory.ts
*	Storage: ~/.config/opencode/storage/deep-memory.db
*	Config:  ~/.config/opencode/deep-memory.json
*	Log:     ~/.config/opencode/deep-memory.log
*
*	@example ~/.config/opencode/deep-memory.json
*	{
*		"fts_results": 5,
*		"keep": 500,
*		"max_tokens_memory": 1500,
*		"max_age_days": 0,
*		"log_level": "info",
*		"prune_check_interval": 10,
*		"overlap_threshold": 0.4,
*		"dedup_threshold": 0.5,
*		"recent_window": 30,
*		"overlap_window": 15,
*		"max_snippet_chars": 250
*	}
*
*	@name deep-memory
*	@version 1.0.1
*	@author Alejandro Carraretto
*	@author MiniMax-M3
*	@license MIT
*/

import type { Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { Database } from "bun:sqlite";
import { mkdirSync, existsSync, appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

// ─── Paths ─────────────────────────────────────────────────────────────────

const HOME = process.env.HOME || homedir();
const CONFIG_DIR = `${HOME}/.config/opencode`;
const STORAGE_DIR = `${CONFIG_DIR}/storage`;
const DB_PATH = `${STORAGE_DIR}/deep-memory.db`;
const CONFIG_FILE = `${CONFIG_DIR}/deep-memory.json`;
const LOG_FILE = `${CONFIG_DIR}/deep-memory.log`;

// ─── Defaults ──────────────────────────────────────────────────────────────

const DEFAULTS = {
	fts_results: 5,
	keep: 500,
	max_tokens_memory: 1500,
	max_age_days: 0,
	log_level: "info" as "silent" | "info" | "debug",
	prune_check_interval: 10,
	overlap_threshold: 0.4,
	dedup_threshold: 0.5,
	recent_window: 30,
	overlap_window: 15,
	max_snippet_chars: 250,
} as const;

type DeepMemoryOptions = Partial<typeof DEFAULTS>;

// ─── Internal types (NOT exported) ─────────────────────────────────────────

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

// ─── Logger ────────────────────────────────────────────────────────────────

class Logger
{
	private level: number;

	constructor( level: "silent" | "info" | "debug" )
	{
		this.level = { silent: 0, info: 1, debug: 2 }[ level ];
	}

	set( level: "silent" | "info" | "debug" ): void
	{
		this.level = { silent: 0, info: 1, debug: 2 }[ level ];
	}

	log( level: "info" | "debug" | "error", ...args: unknown[] ): void
	{
		if ( this.level === 0 ) return;
		if ( level === "debug" && this.level < 2 ) return;

		const label = level.toUpperCase();
		const msg = args.map( a =>
			typeof a === "string" ? a : JSON.stringify( a )
		).join( " " );

		try
		{
			appendFileSync( LOG_FILE, `[${new Date().toISOString()}] [${label}]: ${msg}\n` );
		}
		catch { /* log file unavailable — silent */ }
	}
}

// ─── Storage (encapsulated DB) ─────────────────────────────────────────────

class Storage
{
	private db: Database;
	private stmtInsert: ReturnType<Database["prepare"]>;
	private stmtCount: ReturnType<Database["prepare"]>;
	private stmtRecent: ReturnType<Database["prepare"]>;
	private stmtSearch: ReturnType<Database["prepare"]>;
	private stmtPrune: ReturnType<Database["prepare"]>;
	private closed = false;

	private constructor( db: Database )
	{
		this.db = db;
		this.stmtInsert = db.prepare(
			"INSERT INTO turns (session_id, role, content, content_hash) VALUES (?, ?, ?, ?)"
		);
		this.stmtCount = db.prepare(
			"SELECT COUNT(*) as c FROM turns WHERE session_id = ?"
		);
		this.stmtRecent = db.prepare(
			"SELECT id, session_id, role, content, created_at FROM turns WHERE session_id = ? ORDER BY created_at DESC LIMIT ?"
		);
		this.stmtSearch = db.prepare(
			`SELECT t.id, t.role, t.content, t.created_at, rank
			 FROM turns_fts JOIN turns t ON turns_fts.rowid = t.id
			 WHERE turns_fts MATCH ? AND t.session_id = ?
			 ORDER BY rank LIMIT ?`
		);
		this.stmtPrune = db.prepare(
			`DELETE FROM turns WHERE id IN (
				SELECT id FROM turns WHERE session_id = ?
				ORDER BY created_at ASC LIMIT ?
			)`
		);
	}

	static open(): Storage
	{
		if ( !existsSync( STORAGE_DIR ) )
			mkdirSync( STORAGE_DIR, { recursive: true } );

		const db = new Database( DB_PATH );

		// Pragmas — tuned for write-heavy, read-light workload
		db.exec( `
			PRAGMA synchronous          = NORMAL;
			PRAGMA temp_store           = MEMORY;
			PRAGMA mmap_size            = 0;
			PRAGMA page_size            = 8192;
			PRAGMA cache_size           = 25000;
			PRAGMA cache_spill          = ON;
			PRAGMA journal_mode         = WAL;
			PRAGMA journal_size_limit   = 0;
			PRAGMA wal_autocheckpoint   = 1000;
			PRAGMA automatic_index      = ON;
			PRAGMA recursive_triggers   = ON;
			PRAGMA foreign_keys         = ON;
			PRAGMA auto_vacuum          = OFF;
			PRAGMA threads              = 4;
			PRAGMA busy_timeout         = 5000;
			PRAGMA user_version         = 1;
		` );

		// Schema (idempotent)
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
				content, content='turns', content_rowid='id', tokenize='unicode61'
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

		// Rebuild FTS index if needed (safe on first run)
		try { db.run( "INSERT INTO turns_fts(turns_fts) VALUES('rebuild')" ); } catch {}

		return new Storage( db );
	}

	close(): void
	{
		if ( this.closed ) return;
		this.closed = true;
		try
		{
			this.db.run( "PRAGMA wal_checkpoint(TRUNCATE)" );
			this.db.close();
		}
		catch { /* already closed */ }
	}

	/** Insert a batch of turns in a single transaction. Returns count inserted. */
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
				const text = m.text?.trim();
				if ( !text ) continue;
				try
				{
					this.stmtInsert.run(
						sessionId, m.role, text, hashContent( m.role, text )
					);
					count++;
				}
				catch { /* duplicate by unique index */ }
			}
		} );
		tx( messages );
		return count;
	}

	countTurns( sessionId: string ): number
	{
		return ( this.stmtCount.get( sessionId ) as { c: number } ).c;
	}

	getRecentTurns( sessionId: string, limit: number ): TurnRow[]
	{
		return this.stmtRecent.all( sessionId, limit ) as TurnRow[];
	}

	searchMemories(
		query: string,
		sessionId: string,
		limit: number,
		maxAgeDays: number
	): MemoryHit[]
	{
		const sanitized = sanitizeFtsQuery( query );
		if ( !sanitized ) return [];

		// Build query with optional age filter
		const sql = maxAgeDays > 0
			? `SELECT t.id, t.role, t.content, t.created_at, rank
				 FROM turns_fts JOIN turns t ON turns_fts.rowid = t.id
				 WHERE turns_fts MATCH ? AND t.session_id = ?
				   AND t.created_at >= datetime('now', '-${maxAgeDays} days')
				 ORDER BY rank LIMIT ?`
			: `SELECT t.id, t.role, t.content, t.created_at, rank
				 FROM turns_fts JOIN turns t ON turns_fts.rowid = t.id
				 WHERE turns_fts MATCH ? AND t.session_id = ?
				 ORDER BY rank LIMIT ?`;

		try
		{
			return this.db.prepare( sql ).all( sanitized, sessionId, limit ) as MemoryHit[];
		}
		catch
		{
			return [];
		}
	}

	pruneOldTurns( sessionId: string, keep: number ): number
	{
		if ( keep <= 0 ) return 0;
		const count = this.countTurns( sessionId );
		if ( count <= keep ) return 0;
		const toDelete = count - keep;
		this.stmtPrune.run( sessionId, toDelete );
		return toDelete;
	}
}

// ─── Session state (per-plugin-instance, in-memory) ────────────────────────

class SessionState
{
	lastMessageId: string | null = null;
	lastRecallQuery: string | null = null;
	turnCount = 0;
}

// ─── Pure helpers (NOT exported) ───────────────────────────────────────────

function hashContent( role: string, content: string ): string
{
	return `${Bun.hash( role + ":" + content )}`;
}

function sessionHash( path: string ): string
{
	return Bun.hash( path ).toString( 36 );
}

function isRealUserMessage( text: string ): boolean
{
	return text.length < 300
		&& !/^(Explore|Investigate|Analyze|Look|Read|Search|Find|Check)\b/i.test( text );
}

function sanitizeFtsQuery( input: string ): string
{
	if ( !input || typeof input !== "string" ) return "";

	const terms = input
		.replace( /[^\w\sáéíóúüñÁÉÍÓÚÜÑ]/g, "" )
		.split( /\s+/ )
		.filter( t => t.length > 2 );

	if ( terms.length === 0 ) return "";
	return terms.map( t => `"${t}"` ).join( " AND " );
}

/** Tokenize once, cache by string identity. */
const tokenCache = new WeakMap<string, Set<string>>();

function tokenize( s: string ): Set<string>
{
	let tokens = tokenCache.get( s );
	if ( tokens ) return tokens;

	tokens = new Set(
		s.toLowerCase().split( /\s+/ ).filter( w => w.length > 2 )
	);
	tokenCache.set( s, tokens );
	return tokens;
}

/** Jaccard overlap with early exit. */
function contentOverlap( a: string, b: string ): number
{
	const setA = tokenize( a );
	const setB = tokenize( b );

	if ( setA.size < 3 || setB.size < 3 ) return 0;

	// Iterate the smaller set for early exit
	const [ smaller, larger ] = setA.size <= setB.size
		? [ setA, setB ] : [ setB, setA ];

	let inter = 0;
	const minInter = 0; // we need exact count for Jaccard
	for ( const x of smaller )
	{
		if ( larger.has( x ) ) inter++;
	}

	const union = setA.size + setB.size - inter;
	return union === 0 ? 0 : inter / union;
}

function compressMemories(
	hits: MemoryHit[],
	maxTokens: number,
	dedupThreshold: number,
	maxSnippetChars: number
): string
{
	if ( hits.length === 0 ) return "";

	// Dedup: skip hits that overlap >threshold with a higher-ranked one
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

	// Sort: assistant first, then by rank (lower rank = better match in FTS5)
	pick.sort( ( a, b ) =>
	{
		if ( a.role !== b.role )
			return a.role === "assistant" ? -1 : 1;
		return a.rank - b.rank;
	} );

	const parts: string[] = [];
	let budget = maxTokens;

	for ( const h of pick )
	{
		let snippet = h.content.trim();
		if ( snippet.length > maxSnippetChars )
		{
			const match = snippet.match( /^(.{80,250}[.!?])\s/ );
			snippet = match ? match[ 1 ] + " (+)" : snippet.substring( 0, maxSnippetChars ) + "…";
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

function extractText( msg: MessageLike ): string
{
	return msg.parts
		.filter( p => p.type === "text" && p.text )
		.map( p => p.text! )
		.join( "\n" )
		.trim();
}

function loadConfigFromFile(): DeepMemoryOptions
{
	if ( !existsSync( CONFIG_FILE ) ) return {};

	try
	{
		const raw = JSON.parse( readFileSync( CONFIG_FILE, "utf-8" ) );
		const cfg: DeepMemoryOptions = {};
		if ( raw.fts_results !== undefined ) cfg.fts_results = raw.fts_results;
		if ( raw.keep !== undefined ) cfg.keep = raw.keep;
		if ( raw.max_tokens_memory !== undefined ) cfg.max_tokens_memory = raw.max_tokens_memory;
		if ( raw.max_age_days !== undefined ) cfg.max_age_days = raw.max_age_days;
		if ( raw.log_level !== undefined ) cfg.log_level = raw.log_level;
		if ( raw.prune_check_interval !== undefined ) cfg.prune_check_interval = raw.prune_check_interval;
		if ( raw.overlap_threshold !== undefined ) cfg.overlap_threshold = raw.overlap_threshold;
		if ( raw.dedup_threshold !== undefined ) cfg.dedup_threshold = raw.dedup_threshold;
		if ( raw.recent_window !== undefined ) cfg.recent_window = raw.recent_window;
		if ( raw.overlap_window !== undefined ) cfg.overlap_window = raw.overlap_window;
		if ( raw.max_snippet_chars !== undefined ) cfg.max_snippet_chars = raw.max_snippet_chars;
		return cfg;
	}
	catch
	{
		return {};
	}
}

function mergeOptions(
	fileCfg: DeepMemoryOptions,
	rawOptions: PluginOptions | undefined
): typeof DEFAULTS
{
	const fromRaw: DeepMemoryOptions = {};
	if ( rawOptions && typeof rawOptions === "object" )
	{
		const r = rawOptions as Record<string, unknown>;
		if ( typeof r.fts_results === "number" ) fromRaw.fts_results = r.fts_results;
		if ( typeof r.keep === "number" ) fromRaw.keep = r.keep;
		if ( typeof r.max_tokens_memory === "number" ) fromRaw.max_tokens_memory = r.max_tokens_memory;
		if ( typeof r.max_age_days === "number" ) fromRaw.max_age_days = r.max_age_days;
		if ( r.log_level === "silent" || r.log_level === "info" || r.log_level === "debug" )
			fromRaw.log_level = r.log_level;
	}

	return { ...DEFAULTS, ...fileCfg, ...fromRaw };
}

// ─── Plugin (ONLY default export) ──────────────────────────────────────────

export default ( async ( ctx: PluginInput, rawOptions?: PluginOptions ) =>
{
	const opts = mergeOptions( loadConfigFromFile(), rawOptions );
	const logger = new Logger( opts.log_level );
	const storage = Storage.open();
	const state = new SessionState();

	const sessionKey = ctx.worktree || ctx.directory || "default";
	const sessionId = sessionHash( sessionKey );

	// Backup shutdown handler in case opencode doesn't call dispose
	const onExit = () => storage.close();
	process.on( "exit", onExit );

	logger.log( "info", `Initialized | session: ${sessionId} | worktree: ${sessionKey}` );

	return {
		"experimental.chat.messages.transform": async ( _input, output ) =>
		{
			try
			{
				if ( !output.messages?.length ) return;

				// Only process messages newer than the last seen one
				const pairs: Array<{ role: "user" | "assistant"; text: string }> = [];
				let newestId: string | null = state.lastMessageId;

				for ( const msg of output.messages )
				{
					const text = extractText( msg as MessageLike );
					if ( !text ) continue;
					pairs.push( { role: msg.info.role, text } );
					if ( msg.info.id && msg.info.id > ( newestId || "" ) )
						newestId = msg.info.id;
				}

				if ( pairs.length === 0 ) return;

				const stored = storage.storeTurns( sessionId, pairs );
				state.turnCount += stored;
				state.lastMessageId = newestId;

				logger.log( "info", "Stored:", stored, "turns | total:", state.turnCount );

				// Throttled pruning: only check periodically
				if (
					opts.keep > 0 &&
					state.turnCount % opts.prune_check_interval === 0
				)
				{
					const deleted = storage.pruneOldTurns( sessionId, opts.keep );
					if ( deleted > 0 )
						logger.log( "info", "Pruned:", deleted, "old turns" );
				}
			}
			catch ( err )
			{
				logger.log( "error", "messages.transform:", ( err as Error ).message );
			}
		},

		"experimental.chat.system.transform": async ( _input, output ) =>
		{
			try
			{
				logger.log( "debug", "[DEBUG-a4f2] step=enter opts.recent_window=", opts.recent_window, "type=", typeof opts.recent_window );
				if ( !output.system ) output.system = [];

				// Single recent-turns query, reused for both query selection and overlap filter
				logger.log( "debug", "[DEBUG-a4f2] step=before-getRecentTurns sessionId=", sessionId, "type=", typeof sessionId );
				const recent = storage.getRecentTurns( sessionId, opts.recent_window );
				logger.log( "debug", "[DEBUG-a4f2] step=after-getRecentTurns count=", recent.length );
				if ( recent.length === 0 )
				{
					logger.log( "debug", "Skip: no turns stored yet" );
					return;
				}

				const lastRealUser = recent.find(
					t => t.role === "user" && isRealUserMessage( t.content )
				);
				logger.log( "debug", "[DEBUG-a4f2] step=after-findRealUser found=", !!lastRealUser );
				if ( !lastRealUser )
				{
					logger.log( "debug", "Skip: no real user message" );
					return;
				}

				const query = lastRealUser.content.trim();
				logger.log( "debug", "[DEBUG-a4f2] step=after-trim queryLen=", query.length );
				if ( query.length < 3 )
				{
					logger.log( "debug", "Skip: query too short" );
					return;
				}

				// Skip if same query as last recall (avoid redundant work)
				if ( state.lastRecallQuery === query )
				{
					logger.log( "debug", "Skip: same query as last recall" );
					return;
				}

				logger.log( "debug", "[DEBUG-a4f2] step=before-searchMemories fts_results=", opts.fts_results, "max_age_days=", opts.max_age_days );
				const hits = storage.searchMemories(
					query, sessionId, opts.fts_results, opts.max_age_days
				);
				logger.log( "debug", "[DEBUG-a4f2] step=after-searchMemories hits=", hits.length );

				if ( hits.length === 0 )
				{
					logger.log( "debug", "Recall: 0 — no FTS matches" );
					state.lastRecallQuery = query;
					return;
				}

				// Filter out hits overlapping with recent conversation
				const overlapWindow = recent.slice( 0, opts.overlap_window );
				const filteredHits = hits.filter( hit =>
				{
					for ( const turn of overlapWindow )
					{
						if ( contentOverlap( hit.content, turn.content ) > opts.overlap_threshold )
							return false;
					}
					return true;
				} );
				logger.log( "debug", "[DEBUG-a4f2] step=after-overlapFilter filtered=", filteredHits.length );

				if ( filteredHits.length === 0 )
				{
					logger.log( "debug", "Recall: 0 — excluded by overlap (", hits.length, "hits )" );
					state.lastRecallQuery = query;
					return;
				}

				const context = compressMemories(
					filteredHits,
					opts.max_tokens_memory,
					opts.dedup_threshold,
					opts.max_snippet_chars
				);
				logger.log( "debug", "[DEBUG-a4f2] step=after-compress contextLen=", context.length );
				if ( !context )
				{
					logger.log( "debug", "Skip: context empty after compression" );
					state.lastRecallQuery = query;
					return;
				}

				logger.log( "info", "Recall:", filteredHits.length, "memories (", context.length, "chars )" );
				output.system.push( `[Memory Recall]\n${context}` );
				state.lastRecallQuery = query;
				logger.log( "debug", "[DEBUG-a4f2] step=exit-success" );
			}
			catch ( err )
			{
				logger.log( "error", "system.transform:", ( err as Error ).message, "stack=", ( err as Error ).stack );
			}
		},

		dispose: async () =>
		{
			process.removeListener( "exit", onExit );
			storage.close();
			logger.log( "info", "Disposed | session:", sessionId );
		},
	};
} ) satisfies Plugin;
