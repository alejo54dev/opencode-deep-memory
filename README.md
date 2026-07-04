# deep-memory

![Version](https://img.shields.io/badge/version-1.0.22-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![OpenCode](https://img.shields.io/badge/OpenCode-plugin-purple)

> OpenCode plugin — persistent long-term memory via SQLite FTS5.
> Stores every conversation turn, recalls relevant context on demand.
> No pruning — memory is a growing stack.

## 🧠 What it is

- **`experimental.chat.messages.transform`** — stores each turn (deduped by `session_id + content_hash`) into SQLite. Strips DCP/system/thinking/tool tags before indexing.
- **`experimental.chat.system.transform`** — appends a reminder to use the `deep_memory_recall` tool.
- **`tool.deep_memory_recall`** — FTS5 search across the **entire DB** (cross-session, no session filter). Returns ranked hits with pair recall (user + following assistant), overlap filter, dedup, and token-budgeted compression.
- **`dispose`** — closes DB with WAL checkpoint, removes exit listener.

## 🔄 How it works

```
                     Message arrives (messages.transform)
                                │
                                ▼
┌──────────────────────────────────────────────────────────┐
│  ① Extract text :: strip DCP/system/thinking/tool tags   │
│  ② Store in SQLite :: dedup by session_id + content_hash │
└──────────────────────────────────────────────────────────┘
                                │
                     Model calls deep_memory_recall tool
                                │
                                ▼
┌──────────────────────────────────────────────────────────┐
│  ③ Get recent turns (overlap_window)                     │
│  ④ FTS5 search :: entire DB, no session filter           │
│     Ranked by: relevance × role weight × recency decay   │
│  ⑤ Pair recall :: expand user hits with assistant reply  │
│  ⑥ Age filter :: max_age_days                            │
│  ⑦ Overlap filter :: discard hits too similar to recent  │
│  ⑧ Compress :: dedup + token budget + snippet truncation │
└──────────────────────────────────────────────────────────┘
                                │
                                ▼
                     <deep-memory>...</deep-memory>
                          injected into context

              (system.transform runs every turn)
              "use deep_memory_recall()" reminder appended
```

## 🗄️ Schema

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

## 🏗️ Philosophy: stack-first

Memory is a **growing stack**, not a bounded cache. Every turn is stored, no pruning. FTS searches the whole DB (`fts_results: 20`) and injects up to `max_tokens_memory: 3000` tokens of compressed context at the front of the system prompt on every turn. The goal: thousands of records accumulate, FTS finds relevant context across the entire history, and the model always sees relevant past facts at the front of its working memory.

## 🚀 Build

```bash
bun build deep-memory.ts --target=bun --external="@opencode-ai/plugin"
```

Install by copying to plugins:

```bash
cp deep-memory.ts ~/.config/opencode/plugins/deep-memory.ts
```

## ⚙️ Configuration

`~/.config/opencode/deep-memory.json`:

```json
{
	"fts_results": 20,
	"max_tokens_memory": 3000,
	"max_age_days": 3650,
	"log_level": "info",
	"overlap_threshold": 0.5,
	"dedup_threshold": 0.6,
	"overlap_window": 8,
	"max_snippet_chars": 250
}
```

| Field | Default | Description |
|---|---|---|
| `fts_results` | `20` | Max FTS results per search |
| `max_tokens_memory` | `3000` | Token budget for compressed context |
| `max_age_days` | `3650` | Max age of recalled memories (`0` = forever) |
| `log_level` | `"info"` | `"silent"`, `"error"`, `"info"`, `"debug"` |
| `overlap_threshold` | `0.5` | Jaccard similarity threshold for overlap filter |
| `dedup_threshold` | `0.6` | Jaccard similarity threshold for dedup within recall |
| `overlap_window` | `8` | Recent turns to compare against for overlap filter |
| `max_snippet_chars` | `250` | Max chars per snippet before truncation |

## 💬 Notes

Less is more. :)

## 👤 Authors

- Alejandro Carraretto
- DeepSeek-V4

## 📄 License

MIT — version 1.0.22
