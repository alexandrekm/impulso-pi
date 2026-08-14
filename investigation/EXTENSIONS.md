# Pi Extensions

Useful extensions for [pi](https://pi.dev), the coding agent, and how they map onto
[omp (Oh My Pi)](https://github.com/can1357/oh-my-pi) built-ins.

Useful extensions for [pi](https://pi.dev), the coding agent.

> **OMP status legend:** **built-in** = omp already has this capability as a native tool. **installed** = already installed as an omp plugin. **not covered** = no omp equivalent.

See also: [OMP-MAPPING.md](OMP-MAPPING.md) (built-in → extension table) and
[ORCHESTRATION.md](ORCHESTRATION.md) (omp vs pi extensions vs Orca).

## Extensions

### [pi-observational-memory](https://pi.dev/packages/pi-observational-memory)
Makes long Pi sessions feel endless. Continuously captures **observations** (concrete events and decisions) and **reflections** (durable facts) while you work, so your agent stays coherent across compactions, handoffs, and multi-day sessions. When compaction hits, the memory is already prepared — making compaction fast instead of a slow summarization pause.

> **OMP:** built-in (`recall`, `reflect`, `retain` tools + `memory_edit`).

### [pi-subagent-in-memory](https://github.com/ross-jill-ws/pi-subagent-in-memory)
Spawns in-process subagents with live TUI card widgets, JSONL session logging, and zero system-prompt overhead. Supports parallel subagents, configurable nesting depth and timeouts, partial-result salvage on failure, and keyboard-driven detail overlays. The LLM only sees the tool schemas — no hidden context injection.

> **OMP:** built-in (`task` tool with `parallel`/`pipeline`).

### [pi-profiles](https://github.com/chaychoong/pi-profiles)
Configuration profile manager for pi. Switch between independent sets of settings, extensions, skills, themes, and auth with a single command (`ppi use <name>`). Each profile is a full isolated agent directory; auth and models are symlinked by default so one `pi login` works everywhere. Zero runtime dependencies, zero pi modifications.

> **OMP:** built-in (`--profile` flag, `~/.omp/profiles/<name>/`).

### [@plannotator/pi-extension](https://pi.dev/packages/@plannotator/pi-extension)
File-based plan mode with a visual browser UI for reviewing, annotating, and approving agent plans before execution. In plan mode the agent is restricted to read-only tools and writes only to the plan file; you approve, deny with annotations, or approve with notes. Includes per-phase model/thinking/tool configuration, code review (`/plannotator-review`), and a shared event API for other extensions.

> **OMP:** installed plugin (in `~/.omp/plugins/`).

### [@dietrichgebert/ponytail](https://pi.dev/packages/@dietrichgebert/ponytail)
Lazy senior dev mode for AI agents — enforces a "do the least that works" ladder (YAGNI → reuse → stdlib → native → installed dep → one line → minimum code). Active every session with `lite`/`full`/`ultra`/`off` levels. Measured 54% less code and 20% lower cost on real agentic benchmarks while staying fully safe. Also ships `/ponytail-review`, `/ponytail-audit`, `/ponytail-debt`, and `/ponytail-gain` commands.

> **OMP:** installed plugin (in `~/.omp/plugins/`).

### [@juicesharp/rpiv-todo](https://pi.dev/packages/@juicesharp/rpiv-todo)
A todo list for the model, rendered as a live overlay panel above the editor. The list is rebuilt from the conversation itself, so it survives `/reload` and compaction. Supports `blockedBy` dependency validation, session-keyed state, configurable max lines and collapse key, and nine shipped locales.

> **OMP:** built-in (`todo` tool).

### [@juicesharp/rpiv-ask-user-question](https://pi.dev/packages/@juicesharp/rpiv-ask-user-question)
A structured questionnaire the model puts to you instead of guessing. Up to four questions with typed options (2–4 authored choices each, with descriptions) arrive in a single tabbed terminal dialog; you can always answer in free-form text, attach notes, compare markdown previews side-by-side, and review before submitting. Works in terminal, RPC/ACP hosts, and degrades gracefully in non-interactive runs.

> **OMP:** built-in (`ask` tool).

### [pi-web-access](https://pi.dev/packages/pi-web-access)
Web search, URL fetching, GitHub repo cloning, PDF extraction, YouTube video understanding, and local video analysis. Zero-config Exa search (no API key needed), plus 15+ configurable search providers (OpenAI, Brave, Tavily, Kagi, Jina, SearXNG, DuckDuckGo, etc.). GitHub URLs are cloned locally instead of scraped; YouTube and local videos are analyzed via Gemini with transcript, visual descriptions, and frame extraction.

> **OMP:** built-in (`web_search` tool).

### [pi-lens](https://pi.dev/packages/pi-lens)
Real-time code feedback for pi — LSP diagnostics and navigation, language-specific linters and type-checkers, safe formatting/autofix, ast-grep and tree-sitter structural rules, impact-cascade diagnostics across related files, ranked `symbol_search`, diagnostic triage (`lens_diagnostic_mark`), read-guard and edit-autopatch, background security scans, and an interactive `/lens-map` dependency graph.

> **OMP:** `lsp` built-in (same surface — LSP diagnostics/navigation). `ast_grep` built-in (pi-lens bundles ast-grep for structural rules; omp ships its own `ast_grep` tool — same library, different tool wrappers). `ast_edit` built-in (omp's `ast_edit` does staged structural rewrites via ast-grep codemods; pi-lens does not provide an equivalent rewrite tool). OMP's `security_scan` is a separate, heavier pipeline (native security reviews + Codex Security cloud scans, SARIF reports) — not pi-lens's inline lint-style scanning.

### [command-guard](../extensions/command-guard/) (this repo)
Default-allow bash gate: glob `ask`/`deny` lists, wrapper peeling (`timeout`, `xargs`, `env`, `bash -c`, …), compound-command most-restrictive. Replaces `@gotgenes/pi-permission-system`, which floors wrappers like `xargs`/`timeout` to always-ask.

> **OMP:** not covered. omp has approval mode but not this glob policy.

### [@gotgenes/pi-permission-system](https://pi.dev/packages/@gotgenes/pi-permission-system)
Centralized, deterministic permission gates over tool, bash, MCP, skill, and special operations. Hides disallowed tools before the agent starts, enforces `allow`/`ask`/`deny` at call time with UI confirmation, gates bash commands with wildcard patterns, protects sensitive file paths (cross-cutting, symlink-resolved), guards external directories, and fails closed on parse errors or indirection wrappers. Supports per-agent overrides and an authorizer chain for case-by-case decisions.

> **OMP:** not covered. omp has [approval mode](https://github.com/can1357/oh-my-pi) but not granular per-tool/bash/path policy gates.

### [pi-zentui](https://pi.dev/packages/pi-zentui)
A Starship-inspired statusline footer and Opencode-style TUI for pi. Styles three surfaces independently: editor (opencode, copy-friendly, or minimalist frames), user messages (framed, compact, or labeled), and a configurable Starship footer with git status, runtime detection, context/token/cost, and custom format templates. Interactive `/zentui` menu with seven sections.

> **OMP:** not covered. omp has its own TUI renderer; this is a cosmetic alternative.

### [pi-ask-user](https://pi.dev/packages/pi-ask-user)
Interactive `ask_user` tool with a searchable split-pane selection UI, multi-select, freeform input, and optional comments. Configurable overlay or inline display mode, runtime overlay toggle (`alt+o`), responsive context collapse on small terminals, auto-dismiss timeout, and graceful fallback when the interactive UI is unavailable. Bundles an `ask-user` skill that mandates decision-gating on high-stakes or ambiguous tasks.

> **OMP:** built-in (`ask` tool).

### [pi-provider-litellm](https://pi.dev/packages/pi-provider-litellm)
LiteLLM proxy provider extension — discovers models from self-hosted LiteLLM proxies and registers them as native pi providers. Supports `/login litellm`, enterprise SSO, Google ADC token auth, multiple provider aliases with separate credentials, LiteLLM MCP tool discovery, and the LiteLLM Skills Gateway for prompt injection. Tries `/model/info` first, falls back to `/v1/models`, then `/health` + per-endpoint probing.

> **OMP:** not covered. omp has its own provider/model system but no LiteLLM proxy discovery.

### [pi-agent-browser-native](https://pi.dev/packages/pi-agent-browser-native)
Browser automation as a native pi tool (`agent_browser`) instead of shell commands. Wraps the `agent-browser` CLI with compact page snapshots, `@eN` interactive refs, screenshot/download artifact handling, session and profile management, auth redaction, stale-ref recovery guidance, Electron desktop app support, and an optional `agent_browser_web_search` companion. Requires `agent-browser` on PATH.

> **OMP:** built-in (`browser` tool with Puppeteer).

### [@diegopetrucci/pi-mcp-adapter](https://pi.dev/packages/@diegopetrucci/pi-mcp-adapter)
MCP (Model Context Protocol) adapter for pi — connect MCP servers (chrome-devtools, github, databases, APIs) without burning context. Lazy server lifecycle, on-demand tool discovery via a single `mcp` proxy tool (~200 tokens), and optional `directTools` mode for per-tool registration. Auto-detects existing `.mcp.json` / Cursor / Claude Code configs. Can bring MCP server equivalents (e.g. chrome-devtools MCP, github MCP) into pi, though these are third-party MCP servers, not the same as omp's native built-in tools.

> **OMP:** built-in (omp has native MCP support with `mcp-config`).

### [pi-cache-optimizer](https://pi.dev/packages/pi-cache-optimizer)
Improves provider-side KV/prompt cache hit rates by reordering stable prompt content, compressing skill listings, adding a `prompt_cache_key` fallback for OpenAI-compatible providers, detecting adaptive-thinking compat for Claude/Kimi models, and showing footer cache stats. Includes `/cache-optimizer doctor`, `compat`, `fix`, and `stats` commands. Renamed from `pi-deepseek-cache-optimizer`.

> **OMP:** not covered. omp has its own provider streaming and cache internals but no user-facing cache-hit optimizer.

### [pi-codex-goal](https://pi.dev/packages/pi-codex-goal)
Codex-style goal tracking and continuation for pi. Adds a `/goal` command plus `get_goal`, `create_goal`, and `update_goal` tools. Goal state is stored in session custom entries, so it survives reload, compaction, fork, and tree navigation. Tracks elapsed time and token budgets, sends hidden steering messages when budget is reached or the agent is idle, and shows Codex-style status labels in the footer.

> **OMP:** not covered. omp has `todo` and `goal_updated` events but no Codex-style goal tracking with token budgets and continuation.

### [@pi-stef/atlassian](https://pi.dev/packages/@pi-stef/atlassian)
Pi extension and CLI for verified Atlassian Jira and Confluence Cloud tools. Implements against Jira REST v3, Jira Software REST, and Confluence REST v2. Includes slash commands (`/jira-issue`, `/story-context`, `/confluence-page`), a `story_context` tool that traverses linked Jira issues and Confluence pages, and optional Figma enrichment. Auth via env vars or config file.

> **OMP:** not covered. omp has Glean MCP for company knowledge but no native Jira/Confluence integration.

### [@vigolium/piolium](https://pi.dev/packages/@vigolium/piolium)
Multi-phase security audit pipeline for pi — 17 phases (P1–P17) across five stages: recon & threat modeling, static analysis, adversarial validation, PoC construction, and final reporting. Runs specialist sub-agents with isolated context windows, capped concurrency, and resumable state. Slash commands include `/piolium-lite` (quick recon + SAST), `/piolium-balanced` (default audit with PoCs), `/piolium-deep` (full 17-phase audit), `/piolium-diff` (scan changed files), and `/piolium-confirm` (live finding confirmation). Writes findings, reports, and evidence under `piolium/` in the target repo. 479K downloads/mo.

> **OMP:** partial — omp's `security_scan` is built-in and also runs Codex Security cloud scans + SARIF reports; piolium is a heavier, more thorough on-prem audit but lacks cloud scan integration.

### [@ribbons-digital/pi-advisor](https://pi.dev/packages/@ribbons-digital/pi-advisor)
Automatic isolated secondary review for pi — a separate reviewer model observes completed turns from the primary agent and delivers bounded, actionable notes when it finds correctness, safety, verification, or workflow issues. Silence-first: stays quiet when work is sound. Has its own conversation state, read-only tools (`read`, `grep`, `find`, `ls`), context/token/cost governors, and `WATCHDOG.yml` configuration. Supports `/advisor on/off/status/dump/configure`.

> **OMP:** partial — omp has a built-in advisor subsystem with `WATCHDOG.md`/`WATCHDOG.yml` rosters, multiple named advisors, severity levels (nit/concern/blocker), steering delivery, emission guards, and subagent advisor support. pi-advisor covers the core case (single advisor, automatic review) but is narrower.

### [pi-external-advisor](https://pi.dev/packages/pi-external-advisor)
Fork of pi-advisor that replaces the built-in LLM provider with an external agent CLI (Codex CLI or Claude CLI) for advisor consultation. Curates transcript, pipes it to the external CLI, parses the response as verdict + action items. Supports session resume for KV-cache warmth. Configurable via `/advisor on codex|claude` and interactive `/advisor config`.

> **OMP:** not covered. omp's advisor uses its own provider system, not external CLI subprocesses.

### [pi-auto-router](https://pi.dev/packages/pi-auto-router)
Auto-router and failover extension — keeps one stable set of pi model names while automatically routing and failing over the same request across Claude, Gemini, Codex, DeepSeek, Ollama, OpenRouter, and other configured targets. Subscription-first routing, same-request failover on rate limits/overload, circuit breaker pattern, per-provider budget tracking with daily/monthly limits, Utilization Velocity Index for OAuth quota monitoring, and policy-based model selection. Exposes routing profiles like `auto-router/subscription-reasoning`.

> **OMP:** partial — omp has built-in context promotion (overflow recovery that promotes to a larger-context sibling before compaction) and multi-credential rotation with backoff, but no same-request cross-provider failover, circuit breaker, or budget-aware routing. pi-auto-router fills that gap.

### [impulso-omp](https://github.com/alexandrekm/impulso-omp)
Agentic skills framework — planning, execution, TDD, grilling, and PR review skills with a bootstrap extension that injects skill awareness at session start. General-purpose skills (`using-impulso`, `writing-plans`, `executing-plans`, `test-driven-development`, `grilling`, `address-pr-comments`) load automatically; Motive-specific skills (`mtv-jira`, `mtv-commit-and-pr`, `atv-ask-motive`, etc.) are opt-in via `customDirectories`. Uses `pi.extensions` manifest, so it works in both pi and omp.

> **OMP:** installed plugin (in `~/.omp/plugins/`). Repo is private; install from a local checkout.

## Install

```bash
# Memory & continuity
pi install npm:pi-observational-memory

# Subagents
pi install npm:pi-subagent-in-memory

# Profiles
npm install -g pi-profiles

# Plan review
pi install npm:@plannotator/pi-extension

# Lazy mode
pi install npm:@dietrichgebert/ponytail

# Todo overlay
pi install npm:@juicesharp/rpiv-todo

# Structured questions
pi install npm:@juicesharp/rpiv-ask-user-question

# Web access
pi install npm:pi-web-access

# Code feedback (LSP, linters)
pi install npm:pi-lens

# Permissions (in-repo command-guard extension; not an npm package)

# TUI styling
pi install npm:pi-zentui

# Interactive ask_user
pi install npm:pi-ask-user

# LiteLLM proxy
pi install npm:pi-provider-litellm

# Browser automation
pi install npm:pi-agent-browser-native

# Cache optimizer (prompt/KV cache hit rates)
pi install npm:pi-cache-optimizer

# Codex-style goal tracking
pi install npm:pi-codex-goal

# Atlassian Jira & Confluence
pi install npm:@pi-stef/atlassian

# Advisor (secondary review)
pi install npm:@ribbons-digital/pi-advisor

# External advisor (Codex/Claude CLI)
pi install npm:pi-external-advisor

# Auto-router with cross-provider failover
pi install npm:pi-auto-router

# Security audit pipeline
pi install npm:@vigolium/piolium

# MCP adapter
pi install npm:@diegopetrucci/pi-mcp-adapter

# Agentic skills framework (private repo — install from local checkout)
# git clone git@github.com:alexandrekm/impulso-omp.git ~/code/impulso-omp
# pi install ~/code/impulso-omp
```
