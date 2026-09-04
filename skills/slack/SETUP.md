# Slack setup: slackcli install, auth, recovery

[`slackcli`](https://github.com/shaharia-lab/slackcli) — read/search/send
Slack messages as the user's own session. Credentials live in
`~/.config/slackcli/` (0600) — never print, commit, or sync them.

## Install (patched build)

We run a locally patched v0.10.0: upstream `login-auto` fails on slow
browsers (single-shot CDP page-target lookup). Patch in
`src/lib/browser-auth.ts` `openBrowserSession`: retry `findPageTarget`
every 500ms for 60s, only accepting an http(s) page target.

```bash
git clone https://github.com/shaharia-lab/slackcli.git && cd slackcli
# apply the patch above
bun install && bun run build    # -> dist/slackcli
cp dist/slackcli ~/.local/bin/slackcli
```

Do NOT run `slackcli update` — it overwrites the patched binary. The
unpatched reference is at `~/.local/bin/slackcli.orig`.

## Auth (user runs this — interactive SSO)

Requires Brave (`brew install --cask brave-browser`; Chrome is org-managed,
Vivaldi drops the start URL):

```bash
SLACKCLI_BROWSER="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
  slackcli auth login-auto
```

Verify: `slackcli auth list` → workspaces with `Auth: 🌐 Browser`.

## Auth expired

Calls return `invalid_auth` / `auth list` is empty → ask the user to re-run
the `login-auto` command above. SSO needs the human; do not attempt
headless re-auth.
