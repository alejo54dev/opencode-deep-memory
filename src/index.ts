import type { Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { getDb, closeDb } from "./db.js";
import { sessionHash, ensureSession, storeConversationTurns, searchMemories, pruneOldTurns, compressMemories, getRecentTurns, contentOverlap, type MemoryHit } from "./memory.js";

interface DeepMemoryOptions
{
	fts_results?: number;
	keep?: number;
	max_tokens_memory?: number;
	max_age_days?: number;
}

function extractText( msg: { info: { role: string }; parts: Array<{ type: string; text?: string }> } ): string
{
	return msg.parts
		.filter( p => p.type === "text" && p.text )
		.map( p => p.text! )
		.join( "\n" );
}

function isRealUserMessage( text: string ): boolean
{
	return text.length < 300 && !/^(Explore|Investigate|Analyze|Look|Read|Search|Find|Check)\b/i.test( text );
}

const DEFAULT_OPTIONS: DeepMemoryOptions = {
	fts_results: 5,
	keep: 500,
	max_tokens_memory: 1500,
	max_age_days: 0,
};

export default (async ( ctx: PluginInput, rawOptions?: PluginOptions ) =>
{
	const options: DeepMemoryOptions = { ...DEFAULT_OPTIONS, ...( rawOptions || {} ) };

	const sessionKey = ctx.worktree || ctx.directory || "default";
	const project = ctx.worktree || "";
	const sessionId = sessionHash( sessionKey );

	const db = getDb();
	ensureSession( db, sessionId, sessionKey, project );
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

				storeConversationTurns( db, sessionId, pairs );

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

				// Get last REAL user message from DB for FTS query
				const recent = getRecentTurns( db, sessionId, 30 );
				const candidates = recent.filter( t => t.role === "user" );
				const lastRealUser = candidates.find( t => isRealUserMessage( t.content ) );
				if ( !lastRealUser ) return;

				const query = lastRealUser.content.trim();
				if ( query.length < 3 ) return;

				const hits = searchMemories(
					db,
					query,
					sessionId,
					options.fts_results || 5,
					options.max_age_days || 0
				);

				if ( hits.length === 0 ) return;

				// Filter out hits that overlap >40% with recent conversation window
				// avoids injecting context already present in chat history
				const recentWindow = getRecentTurns( db, sessionId, 15 );
				const filteredHits = hits.filter( hit =>
					!recentWindow.some( turn => contentOverlap( hit.content, turn.content ) > 0.4 )
				);

				if ( filteredHits.length === 0 ) return;

				const context = compressMemories( filteredHits, options.max_tokens_memory || 1500 );
				if ( !context ) return;

				output.system.push( `[Memory Recall]\n${context}` );
			}
			catch ( err )
			{
				console.error( "[deep-memory] system.transform error:", err );
			}
		},
	};
}) satisfies Plugin;
