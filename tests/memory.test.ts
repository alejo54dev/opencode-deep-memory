import { expect, test, describe } from "bun:test";
import { sanitizeFtsQuery, contentOverlap, compressMemories, sessionHash } from "../src/deep-memory.js";
import type { MemoryHit } from "../src/deep-memory.js";

// ---------------------------------------------------------------------------
// sanitizeFtsQuery
// ---------------------------------------------------------------------------

describe( "sanitizeFtsQuery", () =>
{
	test( "returns empty for empty input", () =>
	{
		expect( sanitizeFtsQuery( "" ) ).toBe( "" );
		expect( sanitizeFtsQuery( "   " ) ).toBe( "" );
	} );

	test( "filters single-character terms", () =>
	{
		expect( sanitizeFtsQuery( "a b c" ) ).toBe( "" );
	} );

	test( "keeps terms longer than 2 chars", () =>
	{
		const result = sanitizeFtsQuery( "the cat sat" );
		expect( result ).toBe( '"the" AND "cat" AND "sat"' );
	} );

	test( "removes special characters", () =>
	{
		const result = sanitizeFtsQuery( "hello! world? [test]" );
		expect( result ).toBe( '"hello" AND "world" AND "test"' );
	} );

	test( "handles Spanish characters", () =>
	{
		const result = sanitizeFtsQuery( "cómo estás aplicación" );
		expect( result ).toContain( '"cómo"' );
		expect( result ).toContain( '"estás"' );
		expect( result ).toContain( '"aplicación"' );
	} );

	test( "quotes each term to avoid FTS5 keyword parsing", () =>
	{
		// "OR" is 2 chars → filtered by t.length > 2
		const result = sanitizeFtsQuery( "AND OR NOT NEAR" );
		expect( result ).toBe( '"AND" AND "NOT" AND "NEAR"' );
	} );

	test( "returns empty for terms all <= 2 chars", () =>
	{
		// "an" is 2 chars → filtered by t.length > 2
		expect( sanitizeFtsQuery( "a an at be" ) ).toBe( "" );
	} );
} );

// ---------------------------------------------------------------------------
// contentOverlap (Jaccard index)
// ---------------------------------------------------------------------------

describe( "contentOverlap", () =>
{
	test( "identical texts return 1.0", () =>
	{
		const text = "the quick brown fox jumps over lazy dog";
		expect( contentOverlap( text, text ) ).toBe( 1.0 );
	} );

	test( "completely different texts return 0.0", () =>
	{
		const a = "the quick brown fox";
		const b = "alpha beta gamma delta epsilon";
		expect( contentOverlap( a, b ) ).toBe( 0.0 );
	} );

	test( "partial overlap returns correct ratio", () =>
	{
		const a = "hello world foo bar baz";
		const b = "hello world something else here";
		// tokens >2 in a: hello, world, foo, bar, baz = 5
		// tokens >2 in b: hello, world, something, else, here = 5
		// intersection: hello, world = 2
		// union: 5 + 5 - 2 = 8
		// Jaccard: 2/8 = 0.25
		expect( contentOverlap( a, b ) ).toBe( 0.25 );
	} );

	test( "returns 0 if either text has fewer than 3 significant tokens", () =>
	{
		expect( contentOverlap( "hi", "hello world" ) ).toBe( 0.0 );
		expect( contentOverlap( "hello world", "hi" ) ).toBe( 0.0 );
	} );

	test( "is case-insensitive", () =>
	{
		const a = "HELLO WORLD FOO BAR";
		const b = "hello world foo bar";
		expect( contentOverlap( a, b ) ).toBe( 1.0 );
	} );

	test( "returns partial overlap with punctuation (tokens include punctuation)", () =>
	{
		const a = "hello! world. (foo) bar";
		const b = "hello world foo bar";
		// Tokens >2 in a: hello!, world., (foo), bar  → 4 unique
		// Tokens >2 in b: hello, world, foo, bar     → 4 unique
		// Intersection: bar only (1)
		// Union: 4 + 4 - 1 = 7
		// Jaccard: 1/7 ≈ 0.14
		expect( contentOverlap( a, b ) ).toBeCloseTo( 0.142857, 5 );
	} );
} );

// ---------------------------------------------------------------------------
// compressMemories
// ---------------------------------------------------------------------------

describe( "compressMemories", () =>
{
	function makeHit( overrides: Partial<MemoryHit> = {} ): MemoryHit
	{
		return {
			id: 1,
			role: "user",
			content: "sample content for testing purposes only",
			created_at: "2026-01-01 12:00:00",
			rank: 1.0,
			...overrides,
		};
	}

	test( "returns empty for empty hits", () =>
	{
		expect( compressMemories( [], 1000 ) ).toBe( "" );
	} );

	test( "includes single hit content", () =>
	{
		const hits = [ makeHit( { content: "hello world" } ) ];
		const result = compressMemories( hits, 1000 );
		expect( result ).toContain( "hello world" );
	} );

	test( "deduplicates hits with >50% overlap", () =>
	{
		const hits = [
			makeHit( { id: 1, content: "the quick brown fox jumps over lazy dog" } ),
			makeHit( { id: 2, content: "the quick brown fox jumps over lazy cat" } ),
		];
		const result = compressMemories( hits, 1000 );
		// Only one should survive (second is >50% overlap with first)
		expect( result.split( "\n" ).length ).toBe( 1 );
	} );

	test( "keeps distinct hits", () =>
	{
		const hits = [
			makeHit( { id: 1, content: "alpha beta gamma delta epsilon" } ),
			makeHit( { id: 2, content: "zeta eta theta iota kappa" } ),
		];
		const result = compressMemories( hits, 1000 );
		expect( result.split( "\n" ).length ).toBe( 2 );
	} );

	test( "assistant messages appear first", () =>
	{
		const hits = [
			makeHit( { id: 1, role: "user", content: "user message alpha beta gamma" } ),
			makeHit( { id: 2, role: "assistant", content: "assistant reply delta epsilon zeta" } ),
		];
		const result = compressMemories( hits, 1000 );
		const lines = result.split( "\n" );
		expect( lines[ 0 ] ).toMatch( /^→/ ); // assistant prefix
		expect( lines[ 1 ] ).not.toMatch( /^→/ );
	} );

	test( "respects token budget", () =>
	{
		const longContent = Array( 50 ).fill( "word" ).join( " " );
		const hits = [
			makeHit( { content: longContent } ),
		];
		// Budget of 1 token should exclude the hit
		const empty = compressMemories( hits, 1 );
		expect( empty ).toBe( "" );

		// Large budget should include it
		const full = compressMemories( hits, 2000 );
		expect( full ).not.toBe( "" );
	} );

	test( "truncates content longer than 250 chars at sentence boundary", () =>
	{
		// Build content just over 250 chars with a clear sentence end
		const longContent = "This is a test sentence. " + "word ".repeat( 60 );
		const hits = [ makeHit( { content: longContent } ) ];
		const result = compressMemories( hits, 2000 );
		expect( result.length ).toBeLessThan( longContent.length + 10 );
	} );
} );

// ---------------------------------------------------------------------------
// sessionHash
// ---------------------------------------------------------------------------

describe( "sessionHash", () =>
{
	test( "returns deterministic hash for same input", () =>
	{
		expect( sessionHash( "/home/user/project" ) ).toBe(
			sessionHash( "/home/user/project" )
		);
	} );

	test( "returns different hash for different inputs", () =>
	{
		expect( sessionHash( "/project/a" ) ).not.toBe(
			sessionHash( "/project/b" )
		);
	} );

	test( "returns a string", () =>
	{
		expect( typeof sessionHash( "/test" ) ).toBe( "string" );
	} );
} );
