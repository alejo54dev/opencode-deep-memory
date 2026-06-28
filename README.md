# @sistema54/deep-large-memory

Long-term memory plugin for [opencode](https://opencode.ai). Uses SQLite FTS5
to store and recall relevant past conversations — fully local, zero external
dependencies.

## How it works

Every user message and assistant response is stored in a local SQLite database
with FTS5 full-text search. Before each LLM call, the plugin searches for
relevant past turns using BM25 ranking and injects them as system context.

No embeddings. No cloud services. No API keys.

## Install

```bash
opencode plugin install alejo54dev/deep-large-memory
```

Or add to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugin": [
    "alejo54dev/deep-large-memory"
  ]
}
```

## Options

All optional:

```jsonc
"plugin": [
  ["alejo54dev/deep-large-memory", {
    "fts_results": 5,          // Max FTS5 results per query
    "keep": 500,               // Max turns per session (0 = unlimited)
    "max_tokens_memory": 1500, // Token budget for injected context
    "max_age_days": 0          // Search scope in days (0 = all time)
  }]
]
```

## Storage

`~/.config/opencode/storage/deep-memory.db`

## Why not ByteRover?

| | ByteRover | @sistema54/deep-large-memory |
|---|---|---|
| Search | Cloud embeddings | Local BM25 |
| Privacy | Their server | Your machine |
| Cost | Paid | Free |
| Deps | Heavy SDK | Bun SQLite |

## Development

```bash
git clone https://github.com/alejo54dev/deep-large-memory.git
cd deep-large-memory
bun install
bun test
bun run build
```

## License

MIT
