# deep-memory

OpenCode plugin — persistent long-term memory via SQLite FTS5.

Install, paths, and config example: see script header in `deep-memory.ts`.

## Schema

```sql
PRAGMA user_version = 4;

CREATE TABLE turns (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	session_id TEXT NOT NULL,
	role TEXT NOT NULL CHECK(role IN ('user','assistant')),
	content TEXT NOT NULL,
	content_hash TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_turns_dedup ON turns(session_id, content_hash);
CREATE INDEX idx_turns_session_created ON turns(session_id, created_at);

CREATE VIRTUAL TABLE turns_fts USING fts5(
	content, content='turns', content_rowid='id',
	tokenize="unicode61 remove_diacritics 1"
);
```

Triggers keep `turns_fts` in sync with `turns` on insert/delete/update.

## How it works

1. **`experimental.chat.messages.transform`** — stores each turn (deduped by `session_id + content_hash` SHA-1, by role `user`/`assistant`).
2. **`experimental.chat.system.transform`** — finds last real user message, queries FTS5 across the entire stack, filters out overlap with recent context, dedups near-duplicates, injects compressed memories at the top of the system prompt with an authoritative directive to answer directly from them.
3. **`dispose`** — flushes log buffer, closes DB, removes exit listener.

## Philosophy: stack-first

Memory is a **growing stack**, not a bounded cache. Every turn is stored, no pruning. FTS searches the whole stack (`fts_results: 20`) and injects up to `max_tokens_memory: 3000` tokens of compressed context at the front of the system prompt on every turn. The goal: thousands of records accumulate, FTS finds relevant context across the entire history, and the model always sees relevant past facts at the front of its working memory.

## Build

```bash
bun build deep-memory.ts --target=bun
```

## License

MIT
