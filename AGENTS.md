# AGENTS.md

## Project

OpenCode plugin — persistent long-term memory via SQLite FTS5. Single-file TypeScript, runs on Bun.

## Stack

- **Runtime:** Bun (uses `bun:sqlite`, `node:crypto`, `node:fs`)
- **DB:** SQLite with FTS5 (`unicode61 remove_diacritics 1`)
- **Hash:** SHA-1 (`node:crypto` native)
- **Build:** `bun build --target=bun`

## File layout

```
deep-memory/
├── deep-memory.ts          # source (single file, ~770 lines)
├── deep-memory.ts.v1.bak   # v1.0.1 backup (do not delete)
├── README.md
├── AGENTS.md
└── .handoff/               # session handoffs (gitignored)
```

## Deploy

See script header (`deep-memory.ts:8`) for install path. Canonical load path: `plugins/` only.

## Verify

```bash
sqlite3 ~/.config/opencode/storage/deep-memory.db "PRAGMA user_version;"
# expect: 2

sqlite3 ~/.config/opencode/storage/deep-memory.db \
  "SELECT COUNT(*) FROM turns; SELECT COUNT(*) FROM turns_fts;"
# expect: equal counts (triggers working)

sqlite3 ~/.config/opencode/storage/deep-memory.db \
  "SELECT LENGTH(content_hash), LENGTH(session_id) FROM turns LIMIT 1;"
# expect: 40 | 16
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
- English-only artifacts.

## Key invariants

- `content_hash` = SHA-1 hex (40 chars) of `role + ":" + content`.
- `session_id` = SHA-1 hex truncated to 16 chars of `username + ":" + cwd` (portable, no worktree dep, stable across hostname changes).
- FTS5 tokenizer: `unicode61 remove_diacritics 1` (case + diacritic insensitive).
- Content normalized lowercase before insert (consistent with FTS5).
- Dedup via `INSERT OR IGNORE` on `idx_turns_dedup`.
- Logger: async buffer + 1s flush + 10MB rotation (keep 3 files).
- `process.once("exit")` registered, removed in `dispose`.

## Plugin hooks

| Hook | Purpose |
|---|---|
| `experimental.chat.messages.transform` | Store turns |
| `experimental.chat.system.transform` | Recall + inject context |
| `dispose` | Cleanup |

## Do not

- Do not delete `deep-memory.ts.v1.bak` (rollback reference).
- Do not bump major version without explicit user request.
- Do not push without explicit user request.
- Do not modify `~/.config/opencode/storage/deep-memory.db` directly — use the plugin.
- Do not copy `deep-memory.ts` to `~/.config/opencode/` root. Only `plugins/` is canonical.
- Do not duplicate script header info (paths, install, config example) across md files.
