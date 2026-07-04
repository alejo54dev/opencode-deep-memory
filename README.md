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

1. **`experimental.chat.messages.transform`** — stores each turn (deduped by `session_id + content_hash` SHA-1, by role `user`/`assistant`). Filters only `<system-reminder>` noise before write; passes `<system>` (handoff) through for indexing.
2. **`experimental.chat.system.transform`** — appends a reminder to use the `deep_memory_recall` tool.
3. **`tool.deep_memory_recall`** — on-demand FTS5 search across the **entire DB** (cross-project, no session filter). Returns ranked hits with pair recall (user + following assistant), overlap filter against recent context, dedup, and token-budgeted compression.
4. **`dispose`** — closes DB, removes exit listener.

## Philosophy: stack-first

Memory is a **growing stack**, not a bounded cache. Every turn is stored, no pruning. FTS searches the whole DB (`fts_results: 20`) and injects up to `max_tokens_memory: 3000` tokens of compressed context at the front of the system prompt on every turn. The goal: thousands of records accumulate, FTS finds relevant context across the entire history, and the model always sees relevant past facts at the front of its working memory.

## Build

```bash
bun build deep-memory.ts --target=bun --external="@opencode-ai/plugin"
```

## License

MIT
