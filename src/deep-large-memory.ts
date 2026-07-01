import type { Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";

// ─── Types ────────────────────────────────────────────────────────────────

interface DeepMemoryOptions
{
	fts_results?: number;
	keep?: number;
	max_tokens_memory?: number;
	max_age_days?: number;
	log_level?: "silent" | "info" | "debug";
}

export interface TurnRow
{
	id: number;
	session_id: string;
	role: string;
	content: string;
	created_at: string;
}

export interface MemoryHit
{
	id: number;
	role: string;
	content: string;
	created_at: string;
	rank: number;
}

// ─── DB singleton ─────────────────────────────────────────────────────────

const HOME = process.env.HOME || "/tmp";
const STORAGE_DIR = `${HOME}/.config/opencode/storage`;
const DB_PATH = `${STORAGE_DIR}/deep-memory.db`;

let _db: Database | null = null;

function getDb(): Database
{
	if ( _db ) return _db;

	if ( !existsSync( STORAGE_DIR ) )
		mkdirSync( STORAGE_DIR, { recursive: true } );

	_db = new Database( DB_PATH );

	_db.exec( `
		PRAGMA synchronous          = NORMAL ;
		PRAGMA temp_store           = MEMORY ;
		PRAGMA mmap_size            = 0 ;
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
		PRAGMA busy_timeout         = 5000 ;
	` );

	_db.run( `
		CREATE TABLE IF NOT EXISTS turns (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			role TEXT NOT NULL CHECK(role IN ('user','assistant')),
			content TEXT NOT NULL,
			content_hash TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	` );

	_db.run( `
		CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_dedup
			ON turns(session_id, content_hash)
	` );

	_db.run( `
		CREATE INDEX IF NOT EXISTS idx_turns_session_created
			ON turns(session_id, created_at)
	` );

	_db.run( `
		CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
			content,
			content='turns',
			content_rowid='id',
			tokenize='unicode61'
		)
	` );

	_db.run( `
		CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns
		BEGIN
			INSERT INTO turns_fts(rowid, content) VALUES (new.id, new.content);
		END
	` );

	_db.run( `
		CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns
		BEGIN
			INSERT INTO turns_fts(turns_fts, rowid, content) VALUES('delete', old.id, old.content);
		END
	` );

	_db.run( `
		CREATE TRIGGER IF NOT EXISTS turns_au AFTER UPDATE ON turns
		BEGIN
			INSERT INTO turns_fts(turns_fts, rowid, content) VALUES('delete', old.id, old.content);
			INSERT INTO turns_fts(rowid, content) VALUES (new.id, new.content);
		END
	` );

	try
	{
		_db.run( "INSERT INTO turns_fts(turns_fts) VALUES('rebuild')" );
	}
	catch
	{
		// safe on first run
	}

	return _db;
}

function closeDb(): void
{
	if ( _db )
	{
		_db.close();
		_db = null;
	}
}

// ─── Log ──────────────────────────────────────────────────────────────────

let _logLevel: "silent" | "info" | "debug" = "info";

function log( level: "info" | "debug", ...args: unknown[] ): void
{
	if ( _logLevel === "silent" ) return;
	if ( level === "debug" && _logLevel !== "debug" ) return;

	console.log( "[deep-memory]", ...args );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function contentHash( role: string, content: string ): string
{
	return `${Bun.hash( role + ":" + content )}`;
}

export function sessionHash( path: string ): string
{
	return Bun.hash( path ).toString( 36 );
}

function isRealUserMessage( text: string ): boolean
{
	return text.length < 300
		&& !/^(Explore|Investigate|Analyze|Look|Read|Search|Find|Check)\b/i.test( text );
}

export function sanitizeFtsQuery( input: string ): string
{
	const terms = input
		.replace( /[^\w\sáéíóúüñÁÉÍÓÚÜÑ]/g, "" )
		.split( /\s+/ )
		.filter( t => t.length > 2 );

	if ( terms.length === 0 ) return "";

	return terms.map( t => `"${t}"` ).join( " AND " );
}

export function contentOverlap( a: string, b: string ): number
{
	const tokenize = ( s: string ) =>
		new Set( s.toLowerCase().split( /\s+/ ).filter( w => w.length > 2 ) );

	const setA = tokenize( a );
	const setB = tokenize( b );

	if ( setA.size < 3 || setB.size < 3 ) return 0;

	const intersection = new Set( [ ...setA ].filter( x => setB.has( x ) ) );
	const union = new Set( [ ...setA, ...setB ] );

	return intersection.size / union.size;
}

function extractText(
	msg: { info: { role: string }; parts: Array<{ type: string; text?: string }> }
): string
{
	return msg.parts
		.filter( p => p.type === "text" && p.text )
		.map( p => p.text! )
		.join( "\n" );
}

// ─── Storage ──────────────────────────────────────────────────────────────

function storeTurns(
	db: Database,
	sessionId: string,
	messages: Array<{ role: string; text: string }>
): number
{
	let count = 0;

	for ( const msg of messages )
	{
		const text = msg.text?.trim();
		if ( !text ) continue;

		try
		{
			db.run(
				"INSERT INTO turns (session_id, role, content, content_hash) VALUES (?, ?, ?, ?)",
				[sessionId, msg.role, text, contentHash( msg.role, text )]
			);
			count++;
		}
		catch
		{
			// duplicate by unique index on (session_id, content_hash)
		}
	}

	return count;
}

// ─── Search ───────────────────────────────────────────────────────────────

function searchMemories(
	db: Database,
	query: string,
	sessionId: string,
	limit: number = 5,
	maxAgeDays: number = 0
): MemoryHit[]
{
	const sanitized = sanitizeFtsQuery( query );
	if ( !sanitized ) return [];

	const ageFilter = maxAgeDays > 0
		? `AND t.created_at >= datetime('now', '-${maxAgeDays} days')`
		: "";

	try
	{
		return db.query( `
			SELECT t.id, t.role, t.content, t.created_at, rank
			FROM turns_fts
			JOIN turns t ON turns_fts.rowid = t.id
			WHERE turns_fts MATCH ? AND t.session_id = ? ${ageFilter}
			ORDER BY rank
			LIMIT ?
		`).all( sanitized, sessionId, limit ) as MemoryHit[];
	}
	catch
	{
		return [];
	}
}

function getRecentTurns(
	db: Database,
	sessionId: string,
	limit: number = 10
): TurnRow[]
{
	return db.query( `
		SELECT id, session_id, role, content, created_at
		FROM turns
		WHERE session_id = ?
		ORDER BY created_at DESC
		LIMIT ?
	`).all( sessionId, limit ) as TurnRow[];
}

function pruneOldTurns(
	db: Database,
	sessionId: string,
	keep: number
): number
{
	if ( keep <= 0 ) return 0;

	const count = ( db.query(
		"SELECT COUNT(*) as c FROM turns WHERE session_id = ?"
	).get( sessionId ) as { c: number } ).c;

	if ( count.c <= keep ) return 0;

	const toDelete = count.c - keep;

	db.run( `
		DELETE FROM turns
		WHERE id IN (
			SELECT id FROM turns
			WHERE session_id = ?
			ORDER BY created_at ASC
			LIMIT ?
		)
	`, [sessionId, toDelete] );

	return toDelete;
}

// ─── Compression ──────────────────────────────────────────────────────────

export function compressMemories( hits: MemoryHit[], maxTokens: number ): string
{
	if ( hits.length === 0 ) return "";

	// Deduplicate: skip hits that overlap >50% with a higher-ranked one
	const pick: MemoryHit[] = [];
	for ( const h of hits )
	{
		if ( !pick.some( p => contentOverlap( p.content, h.content ) > 0.5 ) )
			pick.push( h );
	}

	// Sort: assistant first (answers > questions), then by rank
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
		if ( snippet.length > 250 )
		{
			const match = snippet.match( /^(.{80,250}[.!?])\s/ );
			snippet = match ? match[1] + " (+)" : snippet.substring( 0, 250 ) + "…";
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

// ─── Plugin ───────────────────────────────────────────────────────────────

const DEFAULT_OPTIONS: DeepMemoryOptions = {
	fts_results: 5,
	keep: 500,
	max_tokens_memory: 1500,
	max_age_days: 0,
};

export default (async ( ctx: PluginInput, rawOptions?: PluginOptions ) =>
{
	const options: DeepMemoryOptions = { ...DEFAULT_OPTIONS, ...( rawOptions || {} ) };

	if ( options.log_level )
		_logLevel = options.log_level;

	const sessionKey = ctx.worktree || ctx.directory || "default";
	const sessionId = sessionHash( sessionKey );

	const db = getDb();
	process.on( "exit", () => closeDb() );

	return {
		"experimental.chat.messages.transform": async ( _input, output ) =>
		{
			try
			{
				if ( !output.messages?.length ) return;

				const pairs: Array<{ role: string; text: string }> = [];
				for ( const msg of output.messages )
				{
					const text = extractText( msg );
					if ( !text ) continue;
					pairs.push( { role: msg.info.role, text } );
				}

			const stored = storeTurns( db, sessionId, pairs );
			log( "info", "Stored:", stored, "turns | session:", sessionId );

			if ( options.keep && options.keep > 0 )
				{
					const count = ( db.query(
						"SELECT COUNT(*) as c FROM turns WHERE session_id = ?"
					).get( sessionId ) as { c: number } ).c;

					if ( count > options.keep )
						pruneOldTurns( db, sessionId, options.keep );
				}
			}
			catch ( err )
			{
				console.error( "[deep-memory] messages.transform error:", err );
			}
		},

		"experimental.chat.system.transform": async ( _input, output ) =>
		{
			try
			{
				if ( !output.system ) output.system = [];

		const recent = getRecentTurns( db, sessionId, 30 );
		const candidates = recent.filter( t => t.role === "user" );
		const lastRealUser = candidates.find( t => isRealUserMessage( t.content ) );
		if ( !lastRealUser )
		{
			log( "debug", "Skip: no real user message" );
			return;
		}

		const query = lastRealUser.content.trim();
		if ( query.length < 3 )
		{
			log( "debug", "Skip: query too short" );
			return;
		}

				const hits = searchMemories(
					db,
					query,
					sessionId,
					options.fts_results || 5,
					options.max_age_days || 0
				);

				if ( hits.length === 0 )
				{
					log( "debug", "Recall: 0 — no FTS matches" );
					return;
				}

				// Filter out hits overlapping >40% with recent conversation
				// avoids re-injecting context already present in chat history
				const recentWindow = getRecentTurns( db, sessionId, 15 );
				const filteredHits = hits.filter( hit =>
					!recentWindow.some( turn =>
						contentOverlap( hit.content, turn.content ) > 0.4
					)
				);

				if ( filteredHits.length === 0 )
				{
					log( "debug", "Recall: 0 — excluded by overlap (", hits.length, "hits )" );
					return;
				}

				const context = compressMemories( filteredHits, options.max_tokens_memory || 1500 );
				if ( !context )
				{
					log( "debug", "Skip: context empty after compression" );
					return;
				}

				log( "info", "Recall:", filteredHits.length, "memories (", context.length, "chars )" );
				output.system.push( `[Memory Recall]\n${context}` );
			}
			catch ( err )
			{
				console.error( "[deep-memory] system.transform error:", err );
			}
		},
	};
}) satisfies Plugin;
