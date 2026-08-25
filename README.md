# Deep Memory (tiny brain, big thoughts)

![Version](https://img.shields.io/github/v/release/alejo54dev/opencode-deep-memory)
![License](https://img.shields.io/badge/license-MIT-green)
![OpenCode](https://img.shields.io/badge/OpenCode-plugin-purple)

> Your AI has amnesia. Every session starts from scratch? You repeat configs, decisions, errors you already fixed? Not anymore!
## 💡 What it does

> Your AI should remember. Period.

- **Copy and it works** — 853 lines, native bun:sqlite. No npm, no node_modules, no drama.

- **Auto memory** — every message saves itself. Junk tags get stripped. Near-duplicates skipped via trigram Jaccard > 0.65. You do nothing.

- **Cross-project search** — that bug you fixed last week shows up on its own. SQLite FTS5, typo-tolerant.

- **Smart pipeline** — FTS5 → age gate → `bm25()` relevance ranking → dedup → token budget. Storage-time in-memory trigram dedup skips near-duplicates.

- **Store on demand** — `memory_store()` lets you persist a specific fact or decision when you need it to stick. Same dedup, same pipeline — just triggered by you instead of automatically.

- **Stats on demand** — `memory_stats()` returns record count, content size, DB file size, records per role, and oldest/newest record previews.

## 🧠 Philosophy

Memory is a growing stack, not a cache that gets cleaned. Everything saved.

The model decides when to ask. A single line in the system prompt reminds it about `memory_search()`. No forced injection, no tokens wasted on noise.

When it asks, the pipeline searches the entire DB — across projects, across sessions, across months — and returns only what matters.

## 🔄 How it works

```mermaid
flowchart TD
    A["📝 Messages flow<br/>through hook"]
    A --> B["💾 Auto-store in SQLite<br/>Trigram dedup + strip tags"]
    B --> C["📎 System prompt gets<br/>tool reminder"]

    C --> D{"Model calls<br/>a tool?"}
    D -->|"🔍 memory_search"| E["FTS5 cross-project<br/>(no session filter)"]
    E --> F["Relevance ranking (bm25)<br/>→ Age Gate → Dedup<br/>→ Token Budget"]
    F --> G["📎 &lt;deep-memory&gt;<br/>returned to model"]
    D -->|"💾 memory_store"| H["Store specific fact<br/>(bypasses trigram dedup)"]
    D -->|"📊 memory_stats"| I["Return storage stats<br/>(count, size, roles)"]
    D -.->|"❌ No"| J["💬 Normal response"]
    G -.-> J
    H -.-> J
    I -.-> J
    J -.-> A

    style A fill:#1a1a2e,stroke:#e94560,color:#fff
    style B fill:#0f3460,stroke:#53a8b6,color:#fff
    style C fill:#0f3460,stroke:#53a8b6,color:#fff
    style D fill:#16213e,stroke:#e94560,color:#fff
    style E fill:#0f3460,stroke:#53a8b6,color:#fff
    style F fill:#0f3460,stroke:#53a8b6,color:#fff
    style G fill:#1a1a2e,stroke:#e94560,color:#fff
    style H fill:#0f3460,stroke:#53a8b6,color:#fff
    style I fill:#0f3460,stroke:#53a8b6,color:#fff
    style J fill:#1a1a2e,stroke:#e94560,color:#fff
```

## 🎯 Use cases

**History repeats.** You fixed a bug in project A two months ago. Now project B has something similar. The model remembers and hands you the fix. 30 minutes saved.

**The "why we used SQLite".** You discussed it three sessions ago. The model knows. No more Slack digging or git blame archaeology.

**Time machine.** A new feature touches code you discussed weeks ago. The model brings the context, the trade-offs, the discarded alternatives. Old debates, settled.

**Bug backtrack.** Same error message, different file. The model: "Last time it was a null pointer after the refactor." Fixed in seconds.

## 🚀 Installation

```bash
cp deep-memory.ts ~/.config/opencode/plugins/deep-memory.ts
```

No npm, no build step, no dependencies. OpenCode runs TypeScript natively.

## ⚙️ Configuration

Copy `deep-memory.jsonc` (included in this repo) to `~/.config/opencode/` and edit:

```jsonc
{
	"enabled": true,            // master switch
	"max_results": 20,          // max FTS results returned per search call
	"search_max_days": 600,     // 0 = all, max days of records to consider
	"max_tokens_memory": 2000,  // max tokens consumed by memory recall block
	"max_snippet_chars": 3000,  // max chars per memory snippet in recall output
	"data_keep_days": 1000,     // 0 = forever, prune records older than this on startup
	"log_level": "info"         // "silent" | "error" | "info" | "debug"
}
```

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Master switch |
| `max_results` | `20` | Max FTS results per search |
| `search_max_days` | `600` | 0 = all, max days of records to consider |
| `max_tokens_memory` | `2000` | Token budget for compressed context |
| `max_snippet_chars` | `3000` | Max chars per snippet before truncation |
| `data_keep_days` | `1000` | 0 = forever, prune records older than this on startup |
| `log_level` | `"info"` | `"silent"`, `"error"`, `"info"`, `"debug"` |

## 🪵 Logs

`~/.config/opencode/deep-memory.log` (append-only). Format: `[TIMESTAMP] [LEVEL] message`.

```bash
tail -f ~/.config/opencode/deep-memory.log
```

```log
[2026-07-05T10:30:00] [INFO]: Config loaded
[2026-07-05T10:30:01] [INFO]: Initialized
[2026-07-05T10:35:12] [INFO]: Stored: 1 record
[2026-07-05T10:40:23] [INFO]: Stored: 1 record
[2026-07-05T10:45:00] [INFO]: Disposed
```

## 💬 Notes

- **Auto-store** — every message saves itself. Junk tags get stripped. Near-duplicates skipped via trigram Jaccard > 0.65 (min 20 chars).
- **Exact dedup** — `id` (MD5, 32 chars) of `role + ":" + content.toLowerCase()` as `TEXT PRIMARY KEY` with `INSERT OR IGNORE` catches exact duplicates at insert.
- **`memory_store` bypass** — on-demand storage skips trigram dedup (intentional persistence). Same `id` dedup still applies.
- **Relevance ranking** — FTS5 results ordered by `bm25()` (most relevant first), not insertion order.
- **Age gate** — `search_max_days` filters records in SQL via `julianday()` comparison. `0` = all records.
- **Cross-project** — FTS5 search has no session filter. Finds context across all projects and sessions.
- **System-injected parts** — message parts flagged `synthetic` or `ignored` are skipped during storage.
- **Startup prune** — `data_keep_days` deletes old records on init. `0` = forever.

Less is more. :)

## 👤 Authors

- Alejandro Carraretto
- DeepSeek-V4 — assistant model during development

## 📄 License

MIT — version 1.1.24
