# AGENTS.md

## Project

OpenCode plugin — persistent long-term memory via SQLite FTS5. Single-file TypeScript, runs on Bun.

## Stack

- **Runtime:** Bun (uses `bun:sqlite`, `node:crypto`, `node:fs`, `node:path`)
- **DB:** SQLite with FTS5 (`unicode61 remove_diacritics 1`)
- **Hash:** SHA-1 (`node:crypto` native)
- **Build:** `bun build --target=bun --external="@opencode-ai/plugin"`

## File layout

```
deep-memory/
├── deep-memory.ts          # source (single file, 569 lines)
├── README.md
├── AGENTS.md
└── .handoff/               # session handoffs (gitignored)
```

## Deploy

See script header (`deep-memory.ts:8`) for install path. Canonical load path: `plugins/` only.

## Verify

```bash
sqlite3 ~/.config/opencode/storage/deep-memory.db "PRAGMA user_version;"
# expect: 4

sqlite3 ~/.config/opencode/storage/deep-memory.db \
  "SELECT COUNT(*) FROM turns; SELECT COUNT(*) FROM turns_fts;"
# expect: equal counts (triggers working)

sqlite3 ~/.config/opencode/storage/deep-memory.db \
  "SELECT LENGTH(content_hash), LENGTH(session_id) FROM turns LIMIT 1;"
# expect: 40 | 16
```

## Philosophy: stack-first

The plugin treats memory as a **growing stack**, not a bounded cache:

- **Stack grows** — every turn is stored, no pruning.
- **FTS searches the whole stack** — `fts_results: 20` returns up to 20 hits per recall, ranked by FTS rank × role weight × recency decay.
- **Context comes to the front** — `max_tokens_memory: 3000` injects compressed memories at the top of the system prompt on every turn.
- **Permissive dedup** — `dedup_threshold: 0.6` keeps variations instead of collapsing them.
- **Permissive overlap** — `overlap_threshold: 0.5` allows recall even when the topic repeats in recent turns.
- **Long retention** — `max_age_days: 3650` (10 years) keeps memories available across sessions.

The goal: thousands of records accumulate, FTS finds relevant context across the entire history, and the model always sees relevant past facts at the front of its working memory.

## Changelog (v1.0.19)

- **STRIP_PATTERNS constant:** Abstracted strip patterns into `STRIP_PATTERNS` array in Constants section. Added `<thinking>` and `<tool_result>` filters. Moved `CONFIG` from "Defaults & Config" to Constants.

## Changelog (v1.0.18)

- **Fix sort order in compressMemories:** `b.rank - a.rank` (descending) so most relevant hits are included first in the token budget.

## Changelog (v1.0.16)

- **Path unification:** `join(homedir(), ".config", "opencode")` instead of `${HOME}/.config/opencode`.
- **Logger refactor:** Numeric LOG_LEVEL constant, function `log(level, message)` instead of string-level + rest args.
- **Config unification:** `loadConfig()` IIFE pattern matching auto-handoff style.
- **Section ordering:** Paths → Constants → Config → Logger → Interfaces → Storage → Helpers → Plugin.
- **Cross-project recall:** FTS query no longer filters by `session_id` — searches entire DB.
- **Handoff content indexed:** `extractText` only filters `<system-reminder>`; `<system>` passes through.
- **Typo tolerance:** `sanitizeFtsQuery` uses prefix search (`"term"*`) instead of exact match.
- **Pair recall:** Assistant responses are included after matching user turns.
- **Stronger directive:** `IMPORTANT:` block says "YOUR verified long-term memory — MUST answer from it".
- **Debounce instead of skip:** Same query within 2s is debounced, not permanently blocked.
- **Content normalization before write:** `<system>` / `<system-reminder>` tags stripped before INSERT.

## Config

Canonical config at `~/.config/opencode/deep-memory.json`:

```json
{
	"fts_results": 20,
	"max_tokens_memory": 3000,
	"max_age_days": 3650,
	"log_level": "info",
	"overlap_threshold": 0.5,
	"dedup_threshold": 0.6,
	"recent_window": 8,
	"overlap_window": 8,
	"max_snippet_chars": 250
}
```

## Reset (dev only)

```bash
rm ~/.config/opencode/storage/deep-memory.db
rm ~/.config/opencode/deep-memory.log
```

## Conventions

- Tabs, Allman braces, spaces inside parens/brackets (see `my-coding-preferences` skill).
- Version: patch bump only (`1.0.x`) per coding rules.
- Schema version: bump `PRAGMA user_version` on schema change.
- No comments unless asked.
- Recall block includes `IMPORTANT:` directive to prevent external verification.
- English-only artifacts.

## Key invariants

- `content_hash` = SHA-1 hex (40 chars) of `role + ":" + content`.
- `session_id` = SHA-1 hex truncated to 16 chars of `username + ":" + cwd` (portable, no worktree dep, stable across hostname changes).
- FTS5 tokenizer: `unicode61 remove_diacritics 1` (case + diacritic insensitive).
- Content normalized lowercase before insert (consistent with FTS5).
- FTS query is **cross-project** — no `AND t.session_id = ?` filter.
- Prefix search in FTS: `"term"*` for typo tolerance.
- Dedup via `INSERT OR IGNORE` on `idx_turns_dedup`.
- Pair recall: assistant response inserted after matching user FTS hit (via `stmtNextTurn`: `id = ? + 1`).
- Debounce: same recall query within 2s is skipped (`lastRecallQuery` + `lastRecallTime`).
- Logger: synchronous append, non-fatal on write failures.
- `process.once("exit")` registered, removed in `dispose`.

## Plugin hooks

| Hook | Purpose |
|---|---|
| `experimental.chat.messages.transform` | Store turns (filters only `<system-reminder>`) |
| `experimental.chat.system.transform` | Append tool-reminder to system prompt |
| `dispose` | Cleanup |

## Do not

- Do not bump major version without explicit user request.
- Do not push without explicit user request.
- Do not modify `~/.config/opencode/storage/deep-memory.db` directly — use the plugin.
- Do not copy `deep-memory.ts` to `~/.config/opencode/` root. Only `plugins/` is canonical.
- Do not duplicate script header info (paths, install, config example) across md files.
