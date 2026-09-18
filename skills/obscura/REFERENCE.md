# Obscura reference

Install, build variants, env vars, full flag reference, troubleshooting. Canonical source: `obscura --help` / `obscura <cmd> --help`; online: https://github.com/h4ckf0r0day/obscura and https://docs.obscura.sh

## Install

This machine: binary at `~/.local/bin/obscura` (+ `obscura-worker` — keep them in the same directory for the parallel `scrape` command; both must stay for `scrape` to work).

First detect: `command -v obscura || ls ~/.local/bin/obscura`. If missing, install per OS (ask the user before touching their machine). Both `obscura` and `obscura-worker` extract from the same archive — **keep them in the same directory** (the parallel `scrape` command spawns workers).

### macOS — Apple Silicon

```bash
curl -LO https://github.com/h4ckf0r0day/obscura/releases/latest/download/obscura-aarch64-macos.tar.gz
tar xzf obscura-aarch64-macos.tar.gz
xattr -d com.apple.quarantine obscura obscura-worker   # clear Gatekeeper quarantine
mkdir -p ~/.local/bin && mv obscura obscura-worker ~/.local/bin/
```

### macOS — Intel

```bash
curl -LO https://github.com/h4ckf0r0day/obscura/releases/latest/download/obscura-x86_64-macos.tar.gz
tar xzf obscura-x86_64-macos.tar.gz
xattr -d com.apple.quarantine obscura obscura-worker
mkdir -p ~/.local/bin && mv obscura obscura-worker ~/.local/bin/
```

`~/.local/bin` must be on PATH; use the full path otherwise. If macOS still blocks execution: System Settings → Privacy & Security → Allow Anyway, or re-run the `xattr` line.

### Ubuntu / Debian Linux — x86_64

```bash
curl -LO https://github.com/h4ckf0r0day/obscura/releases/latest/download/obscura-x86_64-linux.tar.gz
tar xzf obscura-x86_64-linux.tar.gz
mkdir -p ~/.local/bin && mv obscura obscura-worker ~/.local/bin/
```

### Ubuntu / Debian Linux — ARM64 (aarch64)

```bash
curl -LO https://github.com/h4ckf0r0day/obscura/releases/latest/download/obscura-aarch64-linux.tar.gz
tar xzf obscura-aarch64-linux.tar.gz
mkdir -p ~/.local/bin && mv obscura obscura-worker ~/.local/bin/
```

Linux release builds target Ubuntu 22.04, so the binary needs glibc 2.35+ (check with `ldd --version`). Verify after any install: `obscura --version`.

### Other

NixOS: `nix-env -iA nixpkgs.obscura`. Docker: `docker run -d --name obscura -p 127.0.0.1:9222:9222 h4ckf0r0day/obscura`. Windows: download the `.zip` from the releases page and extract manually.

Archive suffixes: none = rendering; `-stealth` = rendering+stealth transport; `-no-render` = no rendering; `-no-render-stealth` = neither.

Build from source (Rust 1.75+; first build ~5 min — V8 compiles once, cached):

```bash
git clone https://github.com/h4ckf0r0day/obscura.git && cd obscura
cargo build --release -p obscura-cli --bins --features render            # rendering
cargo build --release -p obscura-cli --bins --features render,stealth   # + stealth (needs cmake, clang, libclang-dev, llvm-dev)
```

## Stealth mode

Runtime `--stealth` flag (needs a `render,stealth` build) — applies to `fetch`, `serve`, `scrape`, `mcp`. Adds per-session fingerprint randomization (GPU, screen, canvas, audio, battery), realistic `navigator.userAgentData`, `navigator.webdriver = undefined`, native-function masking, and blocks 3,520 tracker domains. Does not remove screenshot/screencast/PDF/CDP/MCP functionality.

## Flag reference

### Global (before the subcommand)

`--proxy <url>` (HTTP/SOCKS5, inherited by scrape workers), `--stealth`, `--v8-flags "<flags>"`, `--allow-private-network`.

### `fetch <URL>`

| Flag | Default | Description |
|------|---------|-------------|
| `--dump` | `html` | `html` `text` `links` `markdown` `assets` `original` |
| `--eval` | — | JS expression to evaluate |
| `--wait-until` | `load` | `load` `domcontentloaded` `networkidle0` |
| `--timeout` | 30 | max navigation time, seconds |
| `--wait` | adaptive ≤5s | post-load settling; explicit value = fixed seconds |
| `--selector` | — | wait for CSS selector |
| `-s`, `--screenshot` | — | write a PNG (single URL; render build) |
| `--output` | — | write dump/eval output to a file |
| `--quiet` | off | suppress banner |

### `serve`

`--port` (9222), `--proxy`, `--stealth`, `--workers` (1), `--font-dir` (repeatable), `--obey-robots`.

### `scrape <URL...>`

`--concurrency` (10), `--eval`, `--format json|text`, `--quiet`, `--proxy` (global).

### `mcp`

`--http --port <n>` (default stdio), `--proxy`, `--user-agent`, `--stealth`.

## Env vars

| Var | Default | Purpose |
|-----|---------|---------|
| `OBSCURA_ALLOW_PRIVATE_NETWORK` | `0` | allow localhost/LAN/private IPs (same as `--allow-private-network`) |
| `OBSCURA_SCRIPT_DEADLINE_MS` | 30000 | page script-execution budget; raise for heavy React/Vue/Angular SPAs (pair with a matching navigation timeout) |
| `OBSCURA_MODULE_DEADLINE_MS` | 3000 | per-module budget on an already-rendered page; raise for long-running modules (e.g. Vite HMR) |
| `OBSCURA_FETCH_TIMEOUT_MS` | — | the module's network request timeout |
| `OBSCURA_NETWORK_BODY_BUFFER_BYTES` | 2 MiB | response-body retention limit for `Network.getResponseBody` / streaming; raise for large downloads |

## Troubleshooting

- **`obscura: command not found` / binary not detected** → install it per the [Install](#install) section (macOS Apple Silicon/Intel, Ubuntu x86_64/ARM64); keep `obscura-worker` next to it. Confirm with the user before installing on their machine.
- **Fetch to localhost fails / blocked** → private-network SSRF guard: pass `--allow-private-network`.
- **`JavaScript heap out of memory` on JS-heavy pages** → `obscura --v8-flags "--max-old-space-size=4096" fetch <url>`.
- **SPA hasn't fired its data requests before capture** → `--wait-until networkidle0` and/or raise `OBSCURA_SCRIPT_DEADLINE_MS`.
- **Slow/hung page stalls** → `--timeout N` bounds navigation; the script budget bounds execution.
- **`scrape` fails to spawn workers** → `obscura-worker` must be in the same directory as `obscura`.
- **Screenshot/PDF look different from Chrome** → obscura is an independent engine: long-tail CSS, some Web APIs, media playback, compositor effects, and platform font rasterization may differ. Prefer `--wait`/`networkidle0` settling before comparing.
- **Render commands missing (`--screenshot` ignored)** → binary is a `-no-render` build; use the plain (rendering) archive.
