# Pi cache-optimizer extensions: investigation

Question: is [`jiangge/pi-cache-optimizer`](https://github.com/jiangge/pi-cache-optimizer)
legit and what it claims? Are there benchmarks vs vanilla pi? Are there
alternatives with more reliable sources?

Scope: extensions for `@earendil-works/pi-coding-agent` (the pi variant this
repo, `impulso-pi`, is built on — see [PROFILES.md](PROFILES.md)). Where an
extension targets a different pi lineage (e.g. `@mariozechner/pi-coding-agent`
/ pi-mono / omp), that is called out explicitly.

Date of investigation: Aug 2026. Pi version referenced: 0.84.1 (latest at
time of writing).

---

## TL;DR

- **`pi-cache-optimizer` is legit** — the source matches the README claims,
  it is carefully engineered, and it is honest (no inflated savings numbers).
- **No published A/B benchmarks vs vanilla pi exist** for *any* of these
  extensions. The only honest benchmark is one you run yourself.
- **Most "reliable source" alternatives:**
  - [`pi-warm-cache`](https://pi.dev/packages/pi-warm-cache) — most defensively
    engineered, no invented savings claims (keepalive, not rewrite).
  - [`@rohaquinlop/pi-deepseek-cache`](https://pi.dev/packages/@rohaquinlop/pi-deepseek-cache)
    — most concrete/citable mechanism (date/CWD freeze for DeepSeek prefix
    cache), with telemetry to verify.
  - [`pi-cache-graph`](https://pi.dev/packages/pi-cache-graph) — observability
    only; pair it with any optimizer to *measure* effect.
- **Pi core already does a lot** (0.79+ `CH` marker, 0.80.6+ Anthropic cache
  breakpoints, 0.82+ session `prompt_cache_key` for `llama.cpp`, 0.83+ Opus 5
  adaptive-thinking). Check you're on a recent Pi before stacking extensions.

---

## 1. Is `pi-cache-optimizer` legit?

**Verdict: yes.** I read the full `index.ts` (~8,400 lines) and `package.json`
and cross-checked them against the README. The code matches the claims
closely — this is a real, carefully-engineered pi extension, not vaporware
or malware.

### What it actually does (verified in source)

1. **Reorders stable prompt content to the front** — `optimizeSystemPrompt()`
   lifts uniquely-occurring stable candidates (customPrompt, tool snippets,
   guidelines, stable context files like `AGENTS.md`/`CLAUDE.md`/`.trellis/spec/`,
   skill blocks) ahead of dynamic context. Only lifts candidates that occur
   **exactly once** (avoids ripping the wrong copy out of quoted dynamic text);
   `MIN_STABLE_CANDIDATE_LENGTH = 8` guards against single-char noise.
2. **Integrity guard** — `extractStructuralMarkers()` verifies every XML tag
   and `<!-- NAME:START -->` comment marker in the original survives the
   reorder. If any marker drops, it falls back to the original prompt and
   sets a `promptTruncationDetected` footer warning.
3. **Skill compression** — replaces pi's verbose `<available_skills>` XML
   block with a compact name+location index when ≥4 skills. Idempotent (only
   fires if the verbose block is found verbatim as a substring).
4. **Session-overview churn stripping** — removes `RECENT COMMITS`,
   `Working directory:`, `Line count:` from trellis `<session-overview>`.
5. **`PI_CACHE_RETENTION=long`** set at load, with snapshot/restore so
   `/cache-optimizer disable` reverts it.
6. **OpenAI `prompt_cache_key` fallback** — injects a clamped (≤64 char)
   session-id-derived key for `openai-completions`/`openai-responses` payloads
   when none exists; opt-out via env vars.
7. **Footer stats** — persisted to `~/.pi/agent/pi-cache-optimizer-stats.json`,
   containing **only dates and numeric counters** (no prompts, keys,
   payloads). Confirmed in code.
8. **`/cache-optimizer fix`** — only edits `models.json` after explicit
   interactive preview + confirmation, with atomic temp+rename write and a
   timestamped backup. Non-interactive mode refuses to write.

### Legitimacy signals

- Real pi extension API usage (`getAgentDir()`, `BuildSystemPromptOptions`,
  `ExtensionContext`, `ExtensionAPI`).
- `peerDependencies: @earendil-works/pi-coding-agent` — proper packaging.
- MIT, 194 commits, 64 stars, validated against pi 0.84.1, designed for 0.82+.
- No network calls, no telemetry, no exfiltration — stats are local-only.
- Conservative defaults + multiple opt-out env vars.
- 7,828 downloads/mo on pi.dev (Aug 2026).

### Caveats (not red flags, just things to know)

- **Third-party** (author `jiangge`/`freescheme`), not an official Earendil
  package.
- **Mutates your system prompt every turn.** The integrity guard mitigates
  risk, but if you run other prompt-rewriting extensions, watch for
  interactions.
- Sets `PI_CACHE_RETENTION=long` process-wide; the code strips
  `prompt_cache_retention` for providers that don't opt in, but if you hit
  `400 Unsupported parameter: prompt_cache_retention`, use
  `/cache-optimizer doctor` or set `supportsLongCacheRetention: false`.
- Footer-stats attribution to "real upstream" behind a router/virtual
  channel depends on router extensions cooperating via the
  `Symbol.for("pi.routing.registry.v1")` protocol — works only if those
  extensions integrate.

---

## 2. Are there benchmarks vs vanilla pi?

**No rigorous A/B benchmarks exist** that I could find, in the repo or
elsewhere.

### What's in the repo

`tests/review-findings.test.ts` is the only test file. It's a **correctness
unit-test suite** (`node:test`), not a benchmark. It verifies:

- Reordering logic preserves ambiguous candidates, lifts unique ones
  deterministically, keeps nested dynamic content intact.
- Footer status prefixing, compact stat formatting, `setStatus` publishing.
- Command Tab-completion, footer-mode config persistence/override,
  interactive menu.
- Adaptive-thinking compat detection for Claude Opus 5.
- `modelOverrides` JSONC surgical edits (comment preservation, self-check
  rejection of shadowed edits, atomic write).

**No measured cache-hit numbers, no comparison harness against vanilla pi.**
The README's "Verify effect" section is a manual procedure (pick a model,
send similar turns, watch the footer) — it tells *you* to measure, it
doesn't report results.

### What the author does *not* claim

Notably, the README makes **no quantitative hit-rate or cost-savings
claims**. It says "improves the odds of cache hits; it cannot guarantee
hits." That's honest — there are no "94% hit rate!" marketing numbers on
the pi-cache-optimizer page.

### The number floating around (different package)

A separate package, **`pi-deepseek-optimized`** (different author, different
package), has a benchmark table with figures like "Hit ratio projection (50
turns) 94%" and "Cost projection WITHOUT stability ~$96 / WITH stability
~$6.51." Two caveats:

1. It's a **different package**, not pi-cache-optimizer.
2. The word "projection" is doing a lot of work — those are **modeled
   estimates** (50 turns × 16K tokens × pricing), not measured A/B results
   against vanilla pi.

### Independent benchmarks

I couldn't find any third-party benchmark comparing pi-cache-optimizer
against vanilla pi. Reddit/HN discussion is anecdotal ("I burned 1.08B
tokens for $6.25" type posts), no controlled before/after.

### Why a fair benchmark is genuinely hard

- Provider caches are **server-side and best-effort**; hit rates depend on
  the upstream (DeepSeek, OpenAI, Anthropic, your proxy), TTL eviction, and
  traffic from *other* users sharing the cache.
- Pi itself already does a lot (see §4 below). So "vanilla pi" is a moving
  target and already non-trivially good — the extension's marginal gain
  shrinks as pi core improves.
- Any single-session measurement is dominated by **warm-up** (first few
  turns are always misses) and by **what you actually do** (long stable
  sessions vs many short ones).

### Bottom line on benchmarks

The mechanism is sound (stable-prefix-first reordering is a real,
provider-documented lever for prefix caches — DeepSeek's own docs show
99.79% vs 0% for stable vs volatile prefixes). But there is no published
benchmark proving the extension's marginal benefit over vanilla pi, and the
author doesn't pretend otherwise. If you want a number, the honest path is
the README's own recipe: run `/cache-optimizer disable` for N turns, then
`enable` for N similar turns, and compare `/cache-optimizer stats` (or pi's
built-in `CH` marker) for your specific provider/workload.

---

## 3. Alternative extensions

### 3a. Most carefully engineered: `pi-warm-cache`

- **Author:** `ribbons-digital` · v0.3.0 (Aug 2026) · 270 dl/mo
- **pi.dev:** <https://pi.dev/packages/pi-warm-cache>
- **repo:** <https://github.com/ribbons-digital/pi-warm-cache>

Different angle: instead of rewriting prompts, it sends **keepalive probes**
to keep an existing provider cache warm across idle gaps (Anthropic's
5-min/1-hr TTL, OpenAI's 30-min explicit cache, xAI, Azure, OpenCode Go).

"Reliable source" signals:

- Four explicit non-negotiable safety rules: **exact payload replay only**
  (never rebuilds from live session), strict capability verification,
  **hard invalidation** on prefix drift (compaction, model switch,
  thinking-level change), and **no invented pricing** (reports `n/a` when
  model cost fields are missing).
- Read-only capture on `before_provider_request`; never rewrites real turns.
- Honestly marks xAI's 4-min cadence as an "operational heuristic, not a
  provider TTL guarantee."
- Per-provider strategy table with explicit "verified / manual-only / never
  probes" distinctions.

This is the one that reads most like safety-first engineering. It makes
**no big savings claims** — it just keeps caches warm and reports honestly.
It complements (not replaces) a rewriter like pi-cache-optimizer.

### 3b. Most measurable mechanism: `@rohaquinlop/pi-deepseek-cache`

- **Author:** `rohaquinlop` · v0.5.1 (Jun 2026) · 531 dl/mo
- **pi.dev:** <https://pi.dev/packages/@rohaquinlop/pi-deepseek-cache>
- **repo:** <https://github.com/rohaquinlop/pi-deepseek-cache>

DeepSeek-specific. Its root-cause fix is real and well-documented: pi
injects `Current date: YYYY-MM-DD` and `Current working directory: <cwd>`
into the system prompt, and DeepSeek's prefix cache requires
**byte-identical prefix from position 0** — so those dynamic lines silently
bust the whole cache. This extension freezes them at session start. That
is a genuine, citable problem (DeepSeek's own KV-cache docs require prefix
identity), and the fix is the obvious one.

Comes with `/cache-stats` and `/cache-graph` telemetry, SHA-256 prefix-break
tracking, and cache-stable compaction (deterministic summary at temp 0,
SHA-cached).

Caveat: the marketing numbers ("Reduce costs by 95%+", "$3.00 → $0.025/M")
are aggressive projections, not measured A/B — same class of claim you
should distrust in any of these. But the *mechanism* is the most concretely
verifiable of the bunch, and it's scoped to DeepSeek only (won't touch your
other providers).

### 3c. Built on a real research engine: `pi-tscg`

- **Author:** `Nick-Wolf-HLK` · v0.2.4 (Apr 2026) · 189 dl/mo
- **pi.dev:** <https://pi.dev/packages/pi-tscg>
- **repo:** <https://github.com/Nick-Wolf-HLK/pi-tscg>

Tool-schema compression + tool-result compression + provider-aware cache
markers, built on **TSCG** by Furkan Sakizli (SKZL-AI), a deterministic
compression engine with 8 named operators from a paper. That gives it a
more citable foundation than most. Reports real measured numbers from a
session (8.3% schema savings, 62% result savings on a qwen3.5:9b run).

⚠️ **Big caveat for this repo's setup:** the README says to install
`@mariozechner/pi-coding-agent` (Mario Zechner's **pi-mono** — the
omp/badlogic lineage, **not** `@earendil-works/pi-coding-agent` that
`impulso-pi` is built on). The hooks it uses (`before_provider_request`,
`tool_result`, `session_start`) exist in both, so it *might* work, but it's
authored/tested against pi-mono. Verify before relying on it.

### 3d. Observability only: `pi-cache-graph`

- **Author:** championswimmer · v1.0.2
- **pi.dev:** <https://pi.dev/packages/pi-cache-graph>

Companion to `pi-context-prune`. Doesn't optimize anything — it visualizes
cache hit-rate over turns so you can **measure** whether any optimizer is
actually helping. If you want "reliable evidence," install this alongside
whatever optimizer you pick and verify with your own eyes.

### 3e. Avoid: `pi-better-messages-cache`

- **Author:** mcowger · <https://github.com/mcowger/pi-better-messages-cache>

The author's own README says **"Deprecated for pi 0.80.6+. Remove this
extension unless you specifically need its MiniMax/Kimi dual-cache-breakpoint
workaround."** It replaces pi's built-in Anthropic provider and bypasses
newer transport/caching/retry/thinking support. Not recommended.

---

## 4. The "reliable source" you may be overlooking: pi core itself

A lot of what these extensions do is already in `@earendil-works/pi-coding-agent`:

| Pi version | Built-in cache feature |
| --- | --- |
| 0.79+ | Footer `CH` marker for per-turn cache hit rate |
| 0.80.6+ | Owns Anthropic cache breakpoints, raw SSE parsing, malformed tool-call JSON repair (this is why `pi-better-messages-cache` deprecated) |
| 0.82+ | Generates a session `prompt_cache_key` for the built-in `llama.cpp` provider when cache retention is enabled |
| 0.83+ | Native Opus 5 catalogs include adaptive-thinking compat |

So before stacking third-party extensions, make sure you're on a recent pi
and check `/cache-optimizer doctor`-style diagnostics — several of the
"fixes" are already handled.

---

## 5. Recommendation for `impulso-pi`

Given this repo runs on `@earendil-works/pi-coding-agent` and curates
extensions via `profiles.jsonc` (see [PROFILES.md](PROFILES.md)):

1. **If you use DeepSeek**: `@rohaquinlop/pi-deepseek-cache` has the most
   targeted, verifiable mechanism (date/CWD freeze) — but ignore the "95%"
   marketing and read the actual code. Add as an `npm:` resource scoped to
   the profile(s) that use DeepSeek.
2. **If you have long idle gaps busting your cache**: `pi-warm-cache` is the
   most conservatively/honestly engineered of the lot. Tag it `core` if you
   want it everywhere, or per-profile.
3. **Pair either with `pi-cache-graph`** to measure whether it's actually
   helping in *your* workload — that's the only "reliable benchmark" you'll
   get.
4. **Skip `pi-tscg`** unless you confirm it works on earendil-works pi (it
   targets pi-mono), and **skip `pi-better-messages-cache`** outright.

### If we adopt one in `profiles.jsonc`

Resource key form (per [PROFILES.md](PROFILES.md) §"Adding a resource"):

```jsonc
"resources": {
  // DeepSeek prefix-cache fix (date/CWD freeze). Scoped to DeepSeek-using
  // profiles only — it declares appliesToModels: ["deepseek-*", "deepseek"]
  // so non-DeepSeek providers pass through unchanged.
  "npm:@rohaquinlop/pi-deepseek-cache": { "tags": ["work-dev", "personal-dev"] },

  // Keepalive probes for long-idle sessions. Safety-first, no rewrites.
  "npm:pi-warm-cache": { "tags": ["core"] },

  // Observability — measure whether the above actually help.
  "npm:pi-cache-graph": { "tags": ["core"] }
}
```

Then `./install.sh <target>` (or `--all`) to sync.

---

## 6. Open questions / follow-ups

- **No A/B benchmark exists.** If we adopt any of these, we should run our
  own: pick a representative workload, run N turns with the extension
  `disable`d, then N turns `enable`d, and compare `/cache-optimizer stats`
  / `CH` marker / `pi-cache-graph` for our specific provider. Document the
  result here.
- **`pi-tscg` on earendil-works pi?** Untested. Worth a spike if tool-schema
  compression is interesting — the TSCG engine itself is provider-agnostic
  and the hooks exist in both pi lineages.
- **Interaction with `pi-droid-styling` footer.** This repo already uses
  `pi-droid-styling` for footer status widgets (see [EXTENSIONS.md](EXTENSIONS.md)).
  `pi-cache-optimizer` and `pi-warm-cache` both publish footer status via
  pi's native `setStatus()` with a `·` ownership prefix — should coexist,
  but verify visually after install.
