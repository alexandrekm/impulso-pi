# Chat (Glean Assistant)

Ask Glean AI questions that need company-specific context via `glean chat`. Streams the response to stdout.

## Basic chat

```bash
glean chat "What are our company holidays?"
glean chat "Summarize our Q1 engineering goals"
glean chat --timeout 120000 "Summarize all Q1 OKRs across teams"
```

`--message` is the positional arg. If omitted, `glean chat` **reads stdin until EOF (Ctrl+D)** — useful for multiline or piped input, but it will block waiting if you forget to pipe something.

## Flags

| Flag | Description |
|------|-------------|
| `--message` | Chat message (positional) — or stdin if absent |
| `--timeout` | Request timeout in ms (default 60000) |
| `--save` | Persist the chat session for continuation (default true) |
| `--json` | Raw SDK chat request body (overrides all flags) |
| `--dry-run` | Print request body without sending |

## Pipe input / multiline

```bash
echo "What is Glean?" | glean chat
cat notes.md | glean chat        # ask about the piped content
glean chat                       # interactive multiline, Ctrl+D to send
```

## Raw request body

```bash
glean chat --json '{"messages":[{"author":"USER","messageType":"CONTENT","fragments":[{"text":"What is Glean?"}]}]}'
glean chat --dry-run "test"
```

The `--json` shape uses `messages[]` with `author` (`USER`/`ASSISTANT`), `messageType` (`CONTENT`), and `fragments[]` (`{text: "…"}`). Use it for multi-turn context or to pin specific message formatting.

## When to use chat vs. search

- **`glean search`** — find documents by keyword; returns ranked results with titles + snippets. Use when the user wants *where is X* or *list docs about Y*.
- **`glean chat`** — synthesize an answer across sources (Glean Assistant). Use when the user wants a *summary*, *explanation*, or an answer that draws on multiple docs.
