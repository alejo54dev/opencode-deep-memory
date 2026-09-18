# Deep Memory (tiny brain, big thoughts)

![Version](https://img.shields.io/badge/version-1.1.36-blue)
![License](https://img.shields.io/badge/license-AGPL%203.0-blue)
![OpenCode v1](https://img.shields.io/badge/OpenCode-v1-purple)

> Your AI has amnesia. Every session starts from scratch? You repeat configs, decisions, errors you already fixed? Not anymore!

## 💡 What it does

> Your AI should remember. Period.

- **Global memory** — every message of every session, across every project. Nothing is scoped away. `data_keep_days` prunes the store at startup; search always covers what remains.

- **Auto memory** — every message saves itself. Junk tags get stripped. Near-duplicates skipped via trigram Jaccard > 0.65 over the recent 200 (min 20 chars). You do nothing.

- **Cross-project search** — that bug you fixed last week shows up on its own. SQLite FTS5, keyword + prefix matching.

- **Plain pipeline** — FTS5 → `bm25()` ranking → the results cut → the block budget. No embeddings, no LLM calls in retrieval.

- **Store on demand** — `memory_store(role, content)` persists a specific fact or decision. Same normalize and dedup gates as the automatic capture — just triggered by you.

- **Copy and it works** — one TypeScript file (652 lines), native `bun:sqlite`. No npm, no node_modules, no drama.

- **Safe by design** — normalize, dedup gates and a controlled startup prune. Ranking only reorders — no recency decay, no candidate dropped.

## 🧠 Philosophy

Memory is a growing stack, not a cache that gets cleaned. Everything saved.

The model decides when to ask. A short `<memory>` reminder in the system prompt points at `memory_search()` and `memory_store()`. No forced injection, no tokens wasted on noise.

When it asks, the search runs over the whole database — across projects, across sessions, across months — and returns only what matters.

The recall path has no knobs: its constants are measured against a real store, never settings. Nothing to tune — and nothing to break.

## 🔄 How it works

One store; messages go in, searches come out.

```mermaid
flowchart TD
    AGENT["🤖 agent"] --> D{"which tool?"}

    MSG["💬 every message"] -->|"auto-capture"| STORE["🗄️ store<br/>SQLite + FTS5"]

    D -->|"memory_search"| READ["🔍 FTS5 → bm25<br/>→ results cut → budget"]
    D -->|"memory_store"| WRITE["💾 memory_store"]

    WRITE --> STORE
    STORE -. "reads" .-> READ
    READ --> OUT["📎 past context"]

    style AGENT fill:#1a1a2e,stroke:#e94560,color:#fff
    style D fill:#16213e,stroke:#e94560,color:#fff
    style MSG fill:#0f3460,stroke:#53a8b6,color:#fff
    style STORE fill:#16213e,stroke:#e94560,color:#fff
    style READ fill:#0f3460,stroke:#53a8b6,color:#fff
    style WRITE fill:#0f3460,stroke:#53a8b6,color:#fff
    style OUT fill:#1a1a2e,stroke:#e94560,color:#fff
```

Every message is captured automatically. `memory_store` saves one fact when the user explicitly asks. `memory_search` runs when the model needs past context: FTS5 over the whole store → `bm25()` ranking → the results cut → the block budget.

## 🧰 Tools

| Tool | What it does | Answer wrapped in |
|---|---|---|
| `memory_search(query, max_results?)` | Recall: FTS5 + bm25, compressed to a fixed block budget | `<memory-result>` |
| `memory_store(role, content)` | Save one fact or decision | `<memory-store>` |

A short `<memory>` reminder is also injected into the system prompt.

## 🎯 Use cases

**History repeats.** You fixed a bug in project A two months ago. Now project B has something similar. The model remembers and hands you the fix. 30 minutes saved.

**The "why we used SQLite".** You discussed it three sessions ago. The model knows. No more Slack digging or git blame archaeology.

**Time machine.** A new feature touches code you discussed weeks ago. The model brings the context, the trade-offs, the discarded alternatives. Old debates, settled.

**Bug backtrack.** Same error message, different file. The model: "Last time it was a null pointer after the refactor." Fixed in seconds.

## 🚀 Installation

```bash
cp deep-memory.ts ~/.config/opencode/plugins/deep-memory.ts
```

No npm, no build step, no dependencies. OpenCode runs TypeScript natively. Restart opencode; capture runs on its own and the tools become available.

## ⚙️ Configuration

Copy `deep-memory.jsonc` (included in this repo) to `~/.config/opencode/` and edit:

```jsonc
{
	"enabled": true,            // master switch
	"data_keep_days": 600,      // 0 = forever, prune records older than this on startup
	"log_level": "info"         // "silent" | "error" | "info" | "debug"
}
```

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Master switch |
| `data_keep_days` | `600` | 0 = forever, prune records older than this on startup |
| `log_level` | `"info"` | `"silent"`, `"error"`, `"info"`, `"debug"` |

Recall is fixed by design — these are measured constants, not settings:

| Constant | Value | Why |
|---|---|---|
| Results per call | `10` default, `20` max | the model can ask for fewer per call; `max_results` is clamped to 1-20 |
| Snippet length | `600` chars | long records are cut at a sentence boundary, never mid-word |
| Block budget | `1200` words | measured: every requested result fits up to the 20 cap |

The config file carries only operational keys — switch, retention, log level. Zero recall knobs, nothing to misconfigure.

## 🪵 Logs

`~/.config/opencode/deep-memory.log` (append-only). Format: `[TIMESTAMP] [LEVEL]: message`.

```bash
tail -f ~/.config/opencode/deep-memory.log
```

```log
[2026-09-17T01:20:00] [INFO]: Config loaded
[2026-09-17T01:20:00] [INFO]: Initialized
[2026-09-17T01:31:12] [INFO]: Stored: 2 records
[2026-09-17T01:35:40] [DEBUG]: Dedup: skipped similar record (role=assistant)
[2026-09-17T01:40:00] [INFO]: Disposed
```

## 💬 Notes

- **Exact dedup** — `id` is the MD5 of `role + ":" + content.toLowerCase()`, a `TEXT PRIMARY KEY` with `INSERT OR IGNORE`.
- **Near-dup scope** — the trigram gate only looks at the last 200 records, so two near-identical messages far apart in time can both be stored.
- **System-injected parts** — message parts flagged `synthetic` or `ignored` are skipped during storage.

Less is more. :)

## 👤 Authors

- Alejandro Carraretto
- DeepSeek-Flash — assistant model during development

## 📄 License

AGPL-3.0 — version 1.1.36
