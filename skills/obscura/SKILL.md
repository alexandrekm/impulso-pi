---
name: obscura
description: Render pages and drive the web via the obscura CLI — screenshots, PDFs, screencasts, JS-rendered extraction, and headless-browser automation without Chromium.
author: alexandre.mendonca
tags: [obscura, browser, render, screenshot, headless, scraping]
disable-model-invocation: true
---

# Obscura (obscura CLI)

Render and browse the web via the **`obscura` CLI** — a lightweight Rust headless browser that runs real JavaScript (V8), renders CSS natively (no Chromium), and captures screenshots/PDFs. Install/setup/env-var details live in `skill://obscura/REFERENCE.md`.

Announce at start: "I'm using the obscura skill to <task>."

## When to use what

| Task | Command shape |
|------|---------------|
| One page, text/HTML/links/markdown out | `obscura fetch <url> --dump text\|html\|links\|markdown` |
| Screenshot / PDF of a page | `obscura fetch <url> --screenshot out.png` |
| Run JS on a page, read the result | `obscura fetch <url> --eval "<js>"` |
| Many URLs in parallel | `obscura scrape <url...> --concurrency N` |
| Interactive automation (click, fill, login) | `obscura serve` + Puppeteer/Playwright over CDP |

Binary lives at `~/.local/bin/obscura` (with `obscura-worker` next to it). Use the full path if not on PATH. Rendering is built into the release binaries.

**If obscura is not detected** (`command -v obscura` fails and `~/.local/bin/obscura` is absent): don't fall back to another browser — offer to install it, with the user's OK, using the per-OS commands (macOS and Ubuntu) at the top of `skill://obscura/REFERENCE.md`. Keep `obscura` and `obscura-worker` in the same directory.

**Local dev servers**: obscura blocks private/internal IPs by default (SSRF protection) — pass `--allow-private-network` (or `OBSCURA_ALLOW_PRIVATE_NETWORK=1`) for localhost/LAN URLs.

## Feature files (load on demand)

Each area is a self-contained file — `read skill://obscura/<FILE>` only when the task needs it.

| Need | Load |
|------|------|
| **Screenshots** (viewport · full-page · scrolled · PDF · screencast) | `skill://obscura/RENDER.md` |
| **Extraction** (dumps · eval JS · waiting/settling · parallel scrape · assets · raw bodies) | `skill://obscura/FETCH.md` |
| **Automation** (CDP server · Puppeteer/Playwright · forms/login · MCP) | `skill://obscura/CDP.md` |
| Install · build variants · env vars · full flag reference · troubleshooting | `skill://obscura/REFERENCE.md` |
