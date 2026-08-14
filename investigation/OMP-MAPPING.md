# OMP built-ins → Pi extension mapping

Which omp built-in tools have community pi extension equivalents.
Extension descriptions live in [EXTENSIONS.md](EXTENSIONS.md); orchestration is
covered in depth in [ORCHESTRATION.md](ORCHESTRATION.md).

## OMP built-in tools → Pi extension mapping

[OMP (Oh My Pi)](https://github.com/can1357/oh-my-pi) is a fork of pi with additional built-in tools. Many of omp's built-in capabilities have community pi extension equivalents:

| OMP built-in | Pi extension | Status |
|---|---|---|
| `ask` | `pi-ask-user`, `@juicesharp/rpiv-ask-user-question` | ✅ covered |
| `todo` | `@juicesharp/rpiv-todo` | ✅ covered |
| `web_search` | `pi-web-access` | ✅ covered |
| `task` (subagents) | `pi-subagent-in-memory` | ✅ covered |
| `lsp` | `pi-lens` | ✅ covered (same surface — LSP diagnostics, navigation, go-to-definition, references) |
| `ast_grep` | `pi-lens` | ✅ partial (pi-lens bundles ast-grep for structural search/rules; omp ships its own `ast_grep` tool — same underlying library, different tool wrapper) |
| `ast_edit` | — | ❌ no pi equivalent (omp's `ast_edit` stages structural rewrites via ast-grep codemods with proposal/resolve/reject; pi-lens has no equivalent rewrite tool) |
| `recall`, `reflect`, `retain` | `pi-observational-memory` | ✅ covered |
| `browser` | `pi-agent-browser-native` | ✅ covered |
| MCP tools (datadog, glean, github) | `@diegopetrucci/pi-mcp-adapter` | ✅ covered |
| `security_scan` | `@vigolium/piolium` | ✅ covered (piolium: 17-phase on-prem audit with PoCs + reports; omp additionally runs Codex Security cloud scans + SARIF) |
| `github` (PR ops, Actions watch) | — | ❌ no pi equivalent (omp wraps `gh` CLI for PR checkout/push/create, code search, Actions run watching with live streaming; no pi extension provides this) |
| `eval` (persistent kernel) | — | ❌ no pi equivalent (omp runs Python/JS/Ruby/Julia cells in retained kernels with `display()`, `agent()`, `parallel()`, `completion()`, streaming output, and artifact-backed truncation) |
| `hub` (agent coordination) | — | ❌ no pi equivalent (omp provides peer messaging over a process-global mailbox bus, background-job control, and shared long-running process supervision with restart policies) |
| `debug` (DAP debugger) | — | ❌ no pi equivalent (omp drives full DAP sessions: launch/attach, breakpoints, stepping, evaluate, stack/threads/scopes/variables, disassembly, memory read/write, custom requests, plus interactive profiling, heap snapshots, log/SSE viewers) |
| `inspect_image` (vision) | — | ❌ no pi equivalent (omp sends images to a vision-capable model with auto-resize, format sniffing, attachment resolution, and 20 MiB cap; no pi extension wraps this) |
| `checkpoint`, `rewind` | — | ❌ no pi equivalent (omp lets the agent checkpoint conversation state, explore, then rewind to the checkpoint with a concise report — pruning exploratory context from the session tree) |
| `learn`, `manage_skill` | — | ❌ no pi equivalent (omp captures reusable lessons into long-term memory and can auto-create/update managed `SKILL.md` files; `manage_skill` creates/updates/deletes managed skills with immediate session refresh) |
| `generate_image` | — | ❌ no pi equivalent (omp generates or edits images via OpenAI/Codex/Antigravity/xAI/OpenRouter/Gemini with multi-provider fallback, aspect ratios, and input image editing) |
| `tts` | — | ❌ no pi equivalent (omp synthesizes speech via local Kokoro-82M or xAI Grok Voice, writes WAV/MP3 files, supports 11+ local voices) |
| `computer` (computer use) | — | ❌ no pi equivalent (omp drives the real desktop: window enumeration, screenshots, native input, OS accessibility trees, clipboard, with read-only mode and persistent worker) |
| `stats` (usage dashboard) | `pi-session-economy` (from [pi-toolbox](https://github.com/bmxburner/pi-toolbox)) | ✅ partial (pi-session-economy: `/session-stats` + `/session-audit` with live meters inside pi-compositor; omp: `omp stats` as `@oh-my-pi/omp-stats` reads session JSONL logs into a local dashboard at localhost:3847 with `/api/stats` endpoints — more structured API but pi-session-economy covers the core usage tracking) |
| Advisor (secondary review) | `@ribbons-digital/pi-advisor`, `pi-external-advisor` | ✅ partial (pi-advisor: single automatic reviewer with read-only tools, silence-first; omp: built-in multi-advisor rosters with WATCHDOG.yml, severity levels, steering, emission guards, subagent support) |
| Model fallback / context promotion | `pi-auto-router` | ✅ partial (pi-auto-router: same-request cross-provider failover, circuit breaker, budget-aware routing; omp: built-in context promotion to larger-context sibling on overflow + multi-credential rotation, but no cross-provider failover) |
| Plan mode (restricted execution) | `@plannotator/pi-extension` | ✅ covered (plannotator: file-based plan mode with browser review UI, per-phase model/tool config; omp: built-in plan mode with tool restriction, plan reference injection, approval flow) |
| Vibe mode (director + workers) | — | ❌ no pi equivalent (omp's vibe mode turns the top-level session into a director for persistent background worker sessions with `vibe_spawn`/`vibe_send`/`vibe_wait`/`vibe_kill`/`vibe_list`; no pi extension provides this) |
| Approval mode (tool gating) | `command-guard` (this repo); `@gotgenes/pi-permission-system` | ✅ partial (command-guard: default-allow glob ask/deny with wrapper peeling; omp: always-ask/write/yolo with per-tool overrides) |
| Collab (live session sharing) | `@q.roy/pi-remote`, `@ifi/pi-web-remote`, `@clevercloud/pi-remote-control` | ✅ partial (pi: remote access via web/Discord/Telegram/mobile relay; omp: built-in `/collab` with E2E encryption, native TUI rendering on guests, full-control/view-only links, web client, subagent hub access) |
| Session tree (`/tree`, `/branch`) | pi core (built-in) | ✅ covered (pi has native session tree, `/tree`, `/branch`, `--fork`, `--resume`, `--continue`; omp inherits this from pi and adds branch summaries, compaction-aware navigation, checkpoint/rewind on top) |
| Handoff (`/handoff`) | `@ttiimmaahh/pi-handoff`, `pi-continue` | ✅ partial (pi-handoff: auto-writes structured handoff doc at context threshold; pi-continue: continuation ledger; omp: built-in `/handoff` generates via side-request with cache prefix, creates new session, injects as custom message, supports auto-trigger via `compaction.strategy: handoff`) |
| Compaction (snapcompact, shake, handoff) | `pi-observational-memory` (compaction hooks) | ✅ partial (pi-observational-memory: hooks into compaction to inject observations/reflections; omp: built-in snapcompact bitmap archival, shake mechanical elision, handoff strategy, context promotion, remote compaction, v2 streaming compaction, branch summaries) |
