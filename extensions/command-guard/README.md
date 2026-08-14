# command-guard

Default-allow bash gate for pi. Ask/deny glob lists in `command-guard.json`;
wrappers (`timeout`, `xargs`, `env`, `bash -c`, …) are peeled so the inner
command is gated. Port of the Go PreToolUse hook in
KeepTruckin/motive-agent-skills#207.

TypeScript on purpose: pi loads `extensions/*/index.ts`. The engine is
`engine.ts`; the `tool_call` hook is `command-guard.ts` (installed as `index.ts`).

## Config

Synced per profile as `extensions/command-guard/command-guard.json`:

```json
{
  "ask": ["rm *", "sudo *", "git push*"],
  "deny": []
}
```

- Default is allow. Only listed globs prompt or block.
- `include` may point at another JSON file (relative or `~/…`); rules are concatenated.
- `.env` / `.env.*` tool paths are always denied except `.env.example`.
