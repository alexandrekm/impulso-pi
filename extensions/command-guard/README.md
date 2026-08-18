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
  "allow": ["rm -f*", "rm -rf*", "rm --force*"],
  "ask": ["rm *", "sudo *", "anyscale * submit*", "aws s3 rm*", "aws * delete-*"],
  "deny": []
}
```

Work additionally asks on mutating Anyscale verbs (`submit`, `deploy`,
`terminate`, …) and AWS write-style operations (`s3 rm`/`sync`, `create-*`,
`delete-*`, `terminate-*`, …). `git push` is allowed.

- Default is allow. Only listed globs prompt or block.
- `allow` globs are checked after `deny` and before `ask`, so they carve
  exceptions out of an `ask` rule. `rm -f` / `rm -rf` / `rm --force` are
  allowed without a prompt (force-flagged `rm` is usually intentional);
  plain `rm` and `rm -r` still ask.
- `include` may point at another JSON file (relative or `~/…`); rules are concatenated.
- `.env` / `.env.*` tool paths are always denied except `.env.example`.
