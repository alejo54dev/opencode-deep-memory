import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";

let _db: Database | null = null;

const HOME = process.env.HOME || "/tmp";
const STORAGE_DIR = `${HOME}/.config/opencode/storage`;

export function dbPath(): string
{
	return `${STORAGE_DIR}/deep-memory.db`;
}

export function getDb(): Database
{
	if ( _db ) return _db;

	if ( !existsSync( STORAGE_DIR ) )
		mkdirSync( STORAGE_DIR, { recursive: true } );

	_db = new Database( dbPath() );
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
	initSchema( _db );
	return _db;
}

function initSchema( db: Database ): void
{
	db.run( `
		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			session_key TEXT NOT NULL,
			project TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	` );

	db.run( `
		CREATE TABLE IF NOT EXISTS turns (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL REFERENCES sessions(id),
			role TEXT NOT NULL CHECK(role IN ('user','assistant')),
			content TEXT NOT NULL,
			content_hash TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	` );

	db.run( `
		CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_dedup
			ON turns(session_id, content_hash)
	` );

	db.run( `
		CREATE INDEX IF NOT EXISTS idx_turns_session_created
			ON turns(session_id, created_at)
	` );

	db.run( `
		CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
			content,
			content='turns',
			content_rowid='id',
			tokenize='unicode61'
		)
	` );

	db.run( `
		CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns
		BEGIN
			INSERT INTO turns_fts(rowid, content) VALUES (new.id, new.content);
		END
	` );

	db.run( `
		CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns
		BEGIN
			INSERT INTO turns_fts(turns_fts, rowid, content) VALUES('delete', old.id, old.content);
		END
	` );

	db.run( `
		CREATE TRIGGER IF NOT EXISTS turns_au AFTER UPDATE ON turns
		BEGIN
			INSERT INTO turns_fts(turns_fts, rowid, content) VALUES('delete', old.id, old.content);
			INSERT INTO turns_fts(rowid, content) VALUES (new.id, new.content);
		END
	` );

	try
	{
		db.run( "INSERT INTO turns_fts(turns_fts) VALUES('rebuild')" );
	}
	catch
	{
		// safe: rebuild may fail on first run if FTS is already empty
	}
}

export function closeDb(): void
{
	if ( _db )
	{
		_db.close();
		_db = null;
	}
}
