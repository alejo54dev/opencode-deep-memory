# deep-memory

OpenCode plugin — persistent long-term memory via SQLite FTS5.

Stores conversation turns, recalls relevant context on each turn, prunes old entries, deduplicates near-duplicates.

## Install

```bash
cp deep-memory.ts ~/.config/opencode/plugins/deep-memory.ts
```

## Paths

| File | Location |
|---|---|
| Plugin | `~/.config/opencode/plugins/deep-memory.ts` |
| Database | `~/.config/opencode/storage/deep-memory.db` |
| Config | `~/.config/opencode/deep-memory.json` |
| Log | `~/.config/opencode/deep-memory.log` |

Plugin lives ONLY in `plugins/`. Do not copy to `~/.config/opencode/` root.

## Config

`~/.config/opencode/deep-memory.json`:

```json
{
	"fts_results": 5,
	"keep": 500,
	"max_tokens_memory": 1500,
	"max_age_days": 0,
	"log_level": "info",
	"prune_check_interval": 10,
	"overlap_threshold": 0.4,
	"dedup_threshold": 0.5,
	"recent_window": 30,
	"overlap_window": 15,
	"max_snippet_chars": 250
}
```

| Key | Default | Range | Purpose |
|---|---|---|---|
| `fts_results` | 5 | 1–50 | Max FTS5 hits per recall |
| `keep` | 500 | 0–100000 | Max turns per session (0 = unlimited) |
| `max_tokens_memory` | 1500 | 100–10000 | Token budget for injected context |
| `max_age_days` | 0 | 0–3650 | Age filter (0 = no filter) |
| `log_level` | `info` | silent/info/debug | Logger verbosity |
| `prune_check_interval` | 10 | 1–1000 | Turns between prune checks |
| `overlap_threshold` | 0.4 | 0–1 | Jaccard overlap to exclude from recall |
| `dedup_threshold` | 0.5 | 0–1 | Jaccard overlap to dedup within recall |
| `recent_window` | 30 | 1–500 | Recent turns scanned for query |
| `overlap_window` | 15 | 1–200 | Recent turns compared against hits |
| `max_snippet_chars` | 250 | 50–2000 | Max chars per recalled snippet |

## Schema

```sql
PRAGMA user_version = 2;

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

1. **`experimental.chat.messages.transform`** — stores each turn (deduped by `session_id + content_hash` SHA-1).
2. **`experimental.chat.system.transform`** — finds last real user message, queries FTS5, filters out overlap with recent context, dedups near-duplicates, injects compressed memories into system prompt.
3. **`dispose`** — flushes log buffer, closes DB, removes exit listener.

## Build

```bash
bun build deep-memory.ts --target=bun --outfile deep-memory.bundle.js
```

## License

MIT
