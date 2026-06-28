import { Database } from "bun:sqlite";

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

function contentHash( role: string, content: string ): string
{
	return `${Bun.hash( role + ":" + content )}`;
}

export function sessionHash( path: string ): string
{
	return Bun.hash( path ).toString( 36 );
}

export function ensureSession(
	db: Database,
	sessionId: string,
	sessionKey: string,
	project: string
): void
{
	db.run(
		"INSERT OR IGNORE INTO sessions (id, session_key, project) VALUES (?, ?, ?)",
		[sessionId, sessionKey, project]
	);
}

export function storeTurn(
	db: Database,
	sessionId: string,
	role: string,
	content: string
): boolean
{
	const hash = contentHash( role, content );

	try
	{
		db.run(
			"INSERT INTO turns (session_id, role, content, content_hash) VALUES (?, ?, ?, ?)",
			[sessionId, role, content, hash]
		);
		return true;
	}
	catch
	{
		return false; // duplicate or constraint error
	}
}

export function storeConversationTurns(
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

		if ( storeTurn( db, sessionId, msg.role, text ) )
			count++;
	}

	return count;
}

export function sanitizeFtsQuery( input: string ): string
{
	const terms = input
		.replace( /[^\w\sáéíóúüñÁÉÍÓÚÜÑ]/g, "" )
		.split( /\s+/ )
		.filter( t => t.length > 2 );

	if ( terms.length === 0 ) return "";

	// Quote each term so FTS5 keywords (AND, OR, NOT, NEAR) are treated as literals
	return terms.map( t => `"${t}"` ).join( " AND " );
}

export function searchMemories(
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
		const rows = db.query( `
			SELECT t.id, t.role, t.content, t.created_at, rank
			FROM turns_fts
			JOIN turns t ON turns_fts.rowid = t.id
			WHERE turns_fts MATCH ? AND t.session_id = ? ${ageFilter}
			ORDER BY rank
			LIMIT ?
		`).all( sanitized, sessionId, limit ) as MemoryHit[];

		return rows;
	}
	catch
	{
		return [];
	}
}

export function getRecentTurns(
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

export function pruneOldTurns(
	db: Database,
	sessionId: string,
	keep: number
): number
{
	if ( keep <= 0 ) return 0;

	const count = db.query(
		"SELECT COUNT(*) as c FROM turns WHERE session_id = ?"
	).get( sessionId ) as { c: number };

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

export function compressMemories(
	hits: MemoryHit[],
	maxTokens: number
): string
{
	if ( hits.length === 0 ) return "";

	// Deduplicate: skip hits that overlap >50% with a higher-ranked one
	const pick: MemoryHit[] = [];
	for ( const h of hits )
	{
		const isDupe = pick.some( p => contentOverlap( p.content, h.content ) > 0.5 );
		if ( !isDupe ) pick.push( h );
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
		// Truncate long content at sentence boundary
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
