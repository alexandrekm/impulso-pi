# Scout-first subagents with Orca visibility — implementation plan

## Objective

Add one **read-only `scout` subagent** to every managed Pi profile. The main Pi
session remains the only agent allowed to edit the checkout. A scout gets a
fresh, narrowly scoped assignment, returns evidence, and is visible from Orca
while it runs. Add further roles only after repeated, observed need.


## Decision and compatibility gate

### Selected execution runtime

Use [`pi-subagents`](https://github.com/nicobailon/pi-subagents) as the only
subagent execution/runtime owner.

Reasons:

- It supports a minimal scout-only deployment now and provides a direct path to
  later reviewers, workers, worktrees, workflows, and schedules.
- It discovers project/user Markdown agents, supports strict tool allowlists,
  fresh context, cancellation, artifacts, and observability.
- It has a documented experimental `orcaProgressTabs.enabled` setting that
  creates passive Orca observer tabs without changing Pi child ownership.
- Its built-in `scout` can be shadowed by a deliberately restricted local
  definition.

### Do not install the legacy Orca viewer adapter initially

Do **not** add RogueKernel's `pi-orca-subagents` adapter during this rollout.
Its published package metadata declares a Pi peer range of `>=0.81.0 <0.82.0`,
which is incompatible with the modern Pi versions used by this profile. It
would also compete with pi-subagents' own `orcaProgressTabs` observer.

Keep it as a future research item only if a maintained release explicitly
supports the installed Pi version and the native observer proves insufficient.

### Scope / rollout target

Install the runtime as a **`core` resource** so every managed profile receives
the identical scout contract. It changes the agent's available tools and can
consume additional model quota, but the strict initial role remains read-only,
single-scout, and opt-in: installation adds a delegation tool and does not
start background work automatically.

The existing core Orca integration extensions remain unchanged:

- `extensions/orca-integration/orca-agent-status.ts`
- `extensions/orca-integration/orca-prefill.ts`
- `extensions/orca-integration/orca-titlebar-spinner.ts`
- `extensions/herdr/herdr-agent-state.ts`

They report state for Orca/Herdr-launched Pi processes but are not themselves a
subagent runtime.

## Non-goals for the first release

- No worker, planner, reviewer, oracle, researcher, or autonomous agent team.
- No nested delegation.
- No shared-checkout child edits or Git worktrees.
- No scheduled runs, mission automation, recurring jobs, or workflow scripts.
- No forced “orchestrator-only” parent mode.
- No manual installation outside `profiles.jsonc`.
- No legacy `pi-orca-subagents` adapter.

## Implementation phases

### Phase 0 — preflight and version verification

1. Record the current Pi version and every active managed profile directory.
2. Install `pi-subagents` temporarily or in a disposable profile and verify:
   - its package version exposes `orcaProgressTabs` in its configuration;
   - its runtime discovers the active profile's `agents/` directory under
     `PI_CODING_AGENT_DIR`;
   - child launch works with this repository's overridden `read`, `find`, and
     `grep` tools (`pi-hashline-edit` and FFF);
   - child processes inherit the required profile/provider credentials without
     leaking task text into process arguments unexpectedly.
3. Start a manual, read-only scout smoke run from an Orca-managed terminal.
   Confirm that `orcaProgressTabs` is best-effort: failure to create an Orca
   tab must not fail the scout itself.
4. If the installed pi-subagents release does not support the native Orca
   observer, pause implementation rather than silently adopting the legacy
   adapter. Re-evaluate a maintained Orca-compatible viewer at that point.

**Exit criterion:** a scout can run successfully both inside and outside Orca;
Orca only adds observation, not execution authority.

### Phase 1 — build telemetry before the rollout

Build the telemetry foundation **before** installing `pi-subagents` as a core
resource or running the two-task smoke benchmark. Develop it against the
temporary/disposable installation from Phase 0, then promote it together with
the scout rollout only after the recorder has observed a real completed and a
real stopped child run.

1. Verify the installed package's exact public lifecycle surface in Phase 0,
   including the payloads for `subagent:async-started` and
   `subagent:async-complete`, any synchronous/foreground equivalent needed for
   the benchmark, and the stable fields available in the final run result.
   Record the installed pi-subagents version. Do not start implementation from
   documentation alone.

2. Create a small local extension, for example
   `extensions/subagent-telemetry/subagent-telemetry.ts`. It is an **observer
   only**: it must not register a competing subagent tool, manage a child
   process, change the delegated prompt, or alter completion delivery. When
   pi-subagents is absent or emits an unknown payload version, it must do
   nothing except optionally issue one local diagnostic.

3. On a terminal run, persist a bounded, versioned parent-session custom entry
   such as `impulso.subagent-run.v1` via `pi.appendEntry`. Store only the run
   identity, role, model/context/mode, lifecycle state, start/end/duration,
   child totals (tokens/cost/turns/tools), retry/fallback/timeout/stop flags,
   optional local benchmark tag, and the source package/schema version. Do
   **not** persist the delegated task, child response, transcript, credentials,
   or arbitrary artifact paths. Write terminal rows idempotently: duplicate
   lifecycle events must not create duplicate runs.

4. Implement the corresponding minimal `pi-omp-stats` ingestion before adding
   the scout package to all profiles: parse `impulso.subagent-run.v1`, create a
   `subagent_runs` table with a unique run identity, bump the schema-version
   sentinel for one safe backfill, and expose a small `/api/stats/subagents`
   response. The initial dashboard panel needs only total runs, terminal-state
   counts, total/median duration, tokens, cost, and breakdown by role/model/
   fresh-vs-fork context. Keep child-session linking, dynamic-footer per-turn
   timing, and paired-benchmark charts as later additions.

5. Test locally with fixture JSONL plus the disposable real run. Confirm that
   malformed/unknown custom entries are ignored, records are idempotent after
   resync, existing dashboards still work, and no sensitive task or transcript
   text appears in SQLite/API/dashboard output. Run the package build/typecheck
   and restart the local `pi-omp-stats` service after rebuilding it.

**Exit criterion:** before core rollout, the local dashboard displays one
completed and one stopped disposable child run with correct totals and no raw
delegated content. The telemetry extension is passive, versioned, and safe to
load whether or not pi-subagents is enabled.

### Phase 2 — declare profile resources

Update `profiles.jsonc` with core-tagged resources. The agent is an ordinary
tracked Markdown resource; `pi-subagents` discovers it after `install.sh` copies
it into the active profile directory.

1. Add the package resource:

   ```jsonc
   "npm:pi-subagents": { "tags": ["core"] }
   ```

2. Declare the telemetry observer as a core local extension—for example,
   `extensions/subagent-telemetry/subagent-telemetry.ts` →
   `extensions/subagent-telemetry/index.ts`—so it is loaded alongside the
   runtime on every profile. Keep any recorder configuration profile-scoped and
   default its benchmark tag to empty.

3. Define the canonical scout in this repository at **`agents/scout.md`** and
   declare its destination explicitly:

   ```jsonc
   "agents/scout.md": {
     "tags": ["core"],
     "dest": "agents/scout.md"
   }
   ```

   With pi-profiles, `./install.sh --all` copies that source file to each
   profile's agent directory—for example:

   ```text
   ~/.pi/profiles/personal/agents/scout.md
   ~/.pi/profiles/work/agents/scout.md
   ```

   That is the **user-scope** agent directory because Pi is launched with
   `PI_CODING_AGENT_DIR=~/.pi/profiles/<profile>`. It is not `~/.pi/agents/`.
   Without profiles, the corresponding standard location would be
   `~/.pi/agent/agents/scout.md`. The source in this repository, rather than
   the generated profile copy, is the file to edit and commit.

4. `pi-subagents` resolves an agent name in priority order: built-in package
   role < installed package role < user-scope role < project role. Thus our
   `agents/scout.md` with `name: scout` shadows the package's bundled scout.
   A repository may later add `.pi/agents/scout.md`; that project definition
   would override this core profile definition for that repository only. Do
   **not** add
   such a project override during the first rollout—the point is one stable
   scout contract everywhere.

5. The Markdown file is the role definition, not a skill bundle: YAML
   frontmatter gives the runtime contract and the Markdown body is the child's
   specialist system prompt. Define the initial file as follows:

   ```yaml
   ---
   name: scout
   description: Read-only codebase reconnaissance with evidence and a compact
     handoff for the parent.
   tools: read, grep, find, ls, contact_supervisor
   systemPromptMode: replace
   inheritProjectContext: true
   inheritGlobalContext: false
   inheritSkills: false
   defaultContext: fresh
   async: true
   maxSubagentDepth: 1
   ---

   You are a read-only scout. Investigate only the delegated question and
   return verified evidence, relevant paths/symbols, risks, and focused next
   steps to the parent. Do not modify the workspace or delegate work.
   ```

   `tools` is a strict **invocable tool** allowlist. The runtime coordination
   bridge may also provide `contact_supervisor`; keep it as the one intentional
   non-filesystem capability. It is only for necessary clarification, a material
   blocker, or a concise material progress update—never for authority escalation
   or to broaden the assignment. Do not list `bash`, `write`, `edit`, or
   `subagent`; those tools therefore are unavailable to the child.
   `maxSubagentDepth` is a defense-in-depth ceiling, while the absence of
   `subagent` prevents actual nested dispatch. Normal Pi extensions still load
   by default; preflight must confirm that FFF/hashline resolve the four named
   read/search tools as expected. If we later need to isolate extensions too,
   add an explicit `extensions` allowlist only after verifying the providers it
   must retain.

6. **Skills are selected, not copied or implicitly transferred from the
   parent.** `inheritSkills: false` means the generic scout receives no Pi
   skill catalog—even if the parent had loaded `pi-development` or another
   skill. It does still inherit this repository's `AGENTS.md` instructions
   because `inheritProjectContext: true` is separate from skill inheritance.

   If a future role genuinely needs a skill, select it explicitly in that
   agent's frontmatter:

   ```yaml
   inheritSkills: false
   skills: pi-development
   ```

   `pi-subagents` resolves the named skill from the active profile's standard
   skill roots (here, normally `~/.pi/profiles/<profile>/skills/<name>/SKILL.md`)
   or a project `.pi/skills/` override. It adds only the skill's name,
   description, and absolute `SKILL.md` location to the child prompt; the child
   reads the file on demand with `read`. It does not paste/copy the entire
   skill body into every child. For a role-private skill that must not appear
   in the parent catalog, store it beside the agent source and use `skillPath`
   plus `skills`; relative `skillPath` entries resolve from `agents/scout.md`.
   The generic first scout deliberately has no skills. For an exceptional one
   off Pi-development investigation, pass/select `pi-development` for that
   particular run rather than permanently widening the scout.

7. Add a tracked pi-subagents configuration file only after Phase 0 confirms
   the current package version's exact profile-scoped lookup path and setting
   names. Configure the native Orca observer there, with one-run concurrency
   and a one-level nesting ceiling. Do not invent a config file in the package
   installation directory; it can be replaced by an update.

8. Do not add separate `work` or `personal` tags: `core` already selects the
   package and scout for every managed profile. `--base` receives core resources
   as well; validate it explicitly if the raw global agent directory is used.

**Exit criterion:** `./install.sh --all` installs the package and syncs
`agents/scout.md` declaratively to every managed profile; no manual edits under
`~/.pi/profiles/<profile>` are needed.

### Phase 3 — implement and validate the scout contract

The committed `agents/scout.md` body must require:

1. Investigate only the delegated question; do not broaden it into a whole
   repository audit.
2. Never edit, write, run shell commands, install dependencies, start servers,
   or delegate further work.
3. Cite evidence with repository-relative paths and symbol names. Include
   line/anchor references when the active `read` tool makes them available.
4. Separate verified facts from inferences and unknowns.
5. Report relevant tests, conventions, and likely change surfaces.
6. Return a compact handoff suitable for a parent that will decide the next
   action.
7. Ask the parent for clarification only when the target question cannot be
   made safe or bounded.

Do not grant `bash` in the first version. Add it later only for a demonstrated
need such as Git history inspection, and keep its permitted use narrowly
specified. Do not add a skill merely because the parent happens to have one;
add an explicit skill only when a repeatable scout responsibility depends on
it.

**Exit criterion:** inspecting the child tool list shows `read`, `grep`,
`find`, `ls`, and the intentional coordination-only `contact_supervisor`—no
`bash`, `edit`, `write`, or nested-subagent tool; the child's available-skills
section is empty for the generic scout.

### Phase 4 — expose the feature in `/settings`

Update `extensions/impulso-settings/features.ts`:

1. Add a `package` feature in **Tools & Safety** (or a new “Subagents” group)
   for `npm:pi-subagents`.
2. Describe it accurately as a scout-first background delegation runtime and
   state that `/reload` or a new session applies package loading changes.
3. Do not expose the nested `orcaProgressTabs.enabled` JSON value as a generic
   settings row unless its final profile-scoped config location is known and
   stable. The existing settings-page `config` type handles top-level keys, not
   an arbitrary nested package config safely.
4. If Phase 0 establishes a supported package command for configuration or
   fleet inspection, consider a `launch` row in a later change. Do not invent a
   command.

Run `npm run typecheck && npm run lint` after editing settings features.

**Exit criterion:** `/settings` lets the user disable/enable the installed
package, and the initial settings screen makes no false claim that it controls
all scout runtime settings.

### Phase 5 — sync and smoke test

1. Run `./install.sh status --all`; resolve any resource destination or
   manifest conflict before changing files.
2. Run `./install.sh --all` and restart Pi or use `/reload` as appropriate.
3. From each managed profile, verify package activation and the custom scout
   discovery source.
4. Run these bounded scenarios in a disposable or read-only repository state:

   - **Targeted map:** “Use scout to identify authentication entry points and
     their tests. Do not make changes.”
   - **Narrow symbol trace:** “Use scout to find all call sites of
     `authenticateUser` and summarize the callers.”
   - **Cancellation:** start a deliberately broad scout, then stop it; verify
     the parent survives and receives a clear terminal status.
   - **Outside Orca:** verify the scout works and returns a result without any
     Orca environment variables.
   - **Inside Orca:** verify existing Orca integration remains healthy and a
     passive progress tab appears when supported. Verify viewer failure does
     not fail the run.
   - **Isolation:** verify `git status --short` is unchanged after every scout
     scenario.

5. Inspect the child transcript/output and provider cost before accepting the
   role prompt or choosing a fixed scout model.

**Exit criterion:** all five tests work, no child modifies the checkout, and
no duplicate/competing subagent tool is registered.

### Phase 6 — two-task smoke benchmark and telemetry follow-ups

Run a deliberately small, local **four-run smoke benchmark**. It is not a
statistically significant model evaluation; its purpose is to establish a
bounded cost/latency baseline, verify that the telemetry path works, and catch
an obviously unhelpful scout configuration before normal use.

#### Fixed budget and model policy

- Run **at most two tasks** and exactly one direct/scout comparison for each:
  four agent runs total. Do not repeat trials or add a task in this first pass.
- Pin both the parent and scout to the cheapest acceptable configured model,
  intended to be **GPT Luna** (`openai-codex/gpt-5.6-luna`, subject to its exact
  registered LiteLLM model id). Use the same model and thinking level in all
  four runs; confirm the id in the live model registry before launch rather
  than guessing a provider alias.
- Give each parent run a fixed wall-clock budget and each scout a tighter
  budget. Record a timeout as a result; do not retry it during this smoke
  benchmark.
- Run serially, with fresh sessions and clean worktrees. There is no need to
  control cache warmth beyond recording cache-read/write tokens—the goal is a
  low-cost go/no-go test, not a publishable causal study.

#### The two tasks

1. **Read-only reconnaissance:** use this repository at its current pinned
   commit. Ask for a narrow, verifiable mapping, for example: “Identify how
   `profiles.jsonc` resources are resolved and synced into profile directories;
   cite the responsible files/functions and describe the non-clobber behavior.”
   Compare a direct parent answer with a parent answer informed by one scout.

2. **Real change:** use exactly one small SWE-bench Lite development fixture as
   specified in the next section. Compare a direct parent implementation with a
   parent implementation preceded by one fresh read-only scout. This covers the
   real workflow without committing to a benchmark suite.

For each task, use the same fixed parent prompt and tool policy in both arms:

- **Direct:** parent investigates (and, for task 2, edits/tests) alone.
- **Scout:** parent launches exactly one fresh read-only scout first, consumes
  its handoff, then performs the same work alone.

Do not use the web, Git history, other subagents, parallelism, or hidden
evaluation-test information in either arm. Run the direct arm first for the
reconnaissance task and the scout arm first for the SWE-bench task so neither
treatment always benefits from warmed local dependencies.

#### Record only decision-useful measures

Capture one compact local result row per arm:

| Measure | Notes |
|---|---|
| Outcome / quality | Reconnaissance: manually check cited evidence; real change: official evaluator pass/fail |
| Inclusive tokens and cost | Parent plus child; retain input/output/cache split |
| End-to-end wall time | User submission through final parent answer/patch |
| Scout duration | `pi-subagents` `durationMs`, scout arm only |
| Safety / reliability | Status, timeout/error, and whether the checkout changed unexpectedly |
| Patch result | Real-change arm only: files/lines changed and hidden-harness result |

`pi-omp-stats` and pi-subagents artifacts provide the token/cost and child-run
inputs. Report unavailable TTFT or per-request decode speed as `unknown`; do
not estimate them. A short local Markdown note is sufficient—do not build a
benchmark runner or commit raw transcripts for this four-run smoke test.

**Decision rule:** keep the GPT Luna scout only if it remains read-only and
reliable and produces a handoff the parent actually uses on at least one task
without an unacceptable inclusive cost or wall-time increase. Otherwise disable
the package or revise the scout prompt/model before any broader benchmark or
additional role is considered.

#### Real change task: SWE-bench development lane

Add one **real, executable issue-resolution lane** alongside the read-only
reconnaissance benchmark. The first scout is deliberately read-only, so this
lane measures whether a scout improves the **parent's** implementation—not
whether a worker can edit a repository. The main parent remains the sole
writer and test runner in both arms.

Use exactly one small **SWE-bench Lite development** instance as the real-change
fixture. SWE-bench Lite is a curated collection of real GitHub issue/PR pairs
whose instances are self-contained bug fixes with known test oracles. Select
from its development split, not a hidden/leaderboard test split: this is a
low-cost engineering smoke test for our local orchestration design, not a
claim of benchmark performance. Do not add a second fixture unless the user
explicitly approves a later expanded evaluation. Public historical issues are
susceptible to model-training contamination; record that limitation prominently.

Create a tracked fixture manifest such as
`investigation/benchmarks/swebench-scout-v1.json` that contains only:

```json
{
  "id": "<official-instance-id>",
  "dataset": "SWE-bench/SWE-bench_Lite",
  "split": "dev",
  "repo": "<owner>/<repo>",
  "baseCommit": "<dataset-base-commit>",
  "problemStatementFile": "tasks/<id>/problem.md",
  "expectedTestPatchSha256": "<sha256>",
  "harness": "official-swebench",
  "scoutRole": "scout"
}
```

Commit the issue statement separately only if its upstream licensing/size is
appropriate. Never commit the gold source patch, test patch, target test names,
or an agent-readable hint derived from them. Keep those in a local ignored
fixture cache fetched from the official dataset at evaluation time. Verify the
downloaded test patch against the manifest hash before use.

For each treatment/repetition:

1. Fetch/clone the named upstream repository once into a local benchmark cache,
   then create a **fresh detached worktree at the fixture's exact base commit**
   for every run. Never benchmark against the repository's current `main`
   branch. Verify `git rev-parse HEAD`, clean status, and no untracked files
   before the parent begins.
2. Give the parent only the issue/problem statement and a fixed operating
   contract: modify production code as necessary, do not alter tests, do not
   use the web or Git history to retrieve the original fix, run the project
   tests it discovers, and finish with a patch. The parent gets the same
   model, thinking level, tools, deadline, context mode, and implementation
   prompt in both arms.
3. **Direct arm:** parent investigates, edits, and tests alone.
4. **Scout arm:** before making edits, the identical parent launches exactly
   one fresh read-only `scout` with the issue statement. The scout returns
   likely locations, evidence, constraints, and test guidance; the parent then
   investigates, edits, and tests alone. The scout is not allowed `bash`,
   write/edit tools, a worktree, access to the benchmark cache outside its
   assigned worktree, or a nested subagent.
5. Capture the final uncommitted `git diff --binary` as the candidate patch,
   then destroy the agent worktree. Only after the agent has stopped, make a
   separate clean evaluator worktree at the same base commit, apply the
   **hidden local test patch** and candidate patch, and run the official
   SWE-bench evaluation harness/container. Do not run the evaluator in the
   agent worktree and do not expose evaluator output that reveals hidden tests
   to a later retry.
6. Record pass/fail-to-pass and pass-to-pass results, candidate patch size/files,
   wall time, timeout/error status, and inclusive tokens/cost. Run exactly the
   two prescribed arms once each; do not retry failed arms. A failure to build
   the official environment is an `infrastructure_error`, not a model failure.

This provides a concrete answer to “does a scout help make a real change?”
while maintaining a clean causal boundary: the sole difference between the
arms is the existence of the read-only scout handoff. It also exercises child
startup, result delivery, parent synthesis, implementation, tests, and the
cost accounting that a reconnaissance-only trial cannot.

**Real-task exit criterion:** each run has a pinned repository commit, a clean
isolated agent worktree, a hidden evaluator patch/test oracle, a saved candidate
diff, a reproducible official-harness result, and inclusive parent-plus-child
telemetry.

#### Later telemetry enhancements

Add a **Subagents** panel to `packages/pi-omp-stats`, but only after verifying
the exact installed pi-subagents public lifecycle event/artifact schema in the
Phase 0 disposable-profile preflight. Prefer a small companion local extension
that observes the documented `subagent:async-started` / `subagent:async-complete`
events and writes a bounded durable parent-session custom entry such as
`impulso.subagent-run.v1`. The recorder must write metadata and totals—not raw
task text, transcripts, or paths outside the project/session—and must degrade
silently when pi-subagents is absent.

The event payload/schema is a compatibility boundary: validate it against the
installed package and version it in the custom entry. Do not scrape FleetView
terminal text and do not rely solely on temporary `status.json` files, whose
cleanup/retention makes historical reporting incomplete. Temporary artifacts
can be used during the live benchmark to reconcile a record, but the durable
parent-session entry is the authoritative historical index.

The v1 recorder/schema should include:

- opaque top-level `runId` and parent session id; child session-file identity
  only if it is safely available;
- benchmark tag/task id (optional and locally configured), agent role, mode,
  fresh/fork context, async flag, model attempts, final state, start/end and
  `durationMs`;
- inclusive child `totalTokens`, total provider-reported cost, turn/tool
  counts, child/step count, retry/fallback/timeout/stopped indicators;
- a privacy-preserving task fingerprint or an explicit empty value—not raw
  delegated prompt text—and no child response body;
- schema version and source package version so parsers can fail closed or show
  “unknown” after an incompatible upgrade.

Extend `pi-omp-stats` in stages:

1. Parse the versioned custom entry into a new `subagent_runs` SQLite table and
   expose `/api/stats/subagents` with totals, success rate, duration
   distribution, tokens/cost by role/model/context, child share, and benchmark
   tag comparisons. Bump its schema-version sentinel so existing session files
   backfill once.
2. Add a `subagent_session_links` mapping when the child session identity is
   known. Use it to attribute existing assistant-message usage to `scout`
   rather than `main`, without double-counting it in inclusive totals. Keep
   `unknown/unlinked` explicit rather than guessing from flat session paths.
3. Parse the dynamic footer's existing `obs-turn` custom entries as an optional
   per-request timing supplement. When linked child sessions have these
   entries, surface request wall duration and output/wall-second distributions.
   Leave TTFT as unavailable: Pi does not persist it today. Never label
   output-per-wall-second as model decode speed because tool waits and child
   startup are included.
4. Add a benchmark comparison view that groups only explicitly tagged paired
   trials and reports medians, p25/p75, sample counts, cache split, and quality
   scores entered by the human reviewer. It must never infer “with versus
   without subagents” from arbitrary production sessions.

Keep the initial implementation local-only and read-only with respect to run
execution: it must not own child lifecycle, alter prompts, or become a second
subagent orchestrator.

**Exit criterion:** the benchmark has reproducible task definitions and paired
results; the dashboard accurately distinguishes known from unavailable timing
data, and all reported cost/token totals are inclusive of parent and child
work.

### Phase 7 — observe before expanding

Use the scout alone for a meaningful period. Record only these decisions after
real usage:

| Observed need | Next addition | Preconditions |
|---|---|---|
| Need evidence from independent repository areas | Permit two parallel scout tasks | Cost/concurrency cap chosen; output synthesis is useful |
| Need external facts/docs | Add a read-only `researcher` | Explicit web/tool policy and source citation contract |
| Need a second opinion on a plan/diff | Add read-only `reviewer` or `oracle` | Main agent remains the only writer |
| Need bounded implementation delegation | Add one `worker` | Git worktree isolation, acceptance criteria, tests, and rollback plan |
| Need repeated fixed pipelines | Add a saved workflow | The sequence has been manually repeated and validated |
| Need direct human conversations with a child | Re-evaluate attachable child runtime | Do not stack it with pi-subagents without a documented integration boundary |

Adding further roles, parallelism, or write-capable delegation requires several
successful sessions across profiles, no feature conflicts, and an accepted
model/cost policy.

## Acceptance criteria

- [ ] Only `pi-subagents` owns subagent execution and lifecycle.
- [ ] The initial custom scout cannot mutate files or invoke shell commands.
- [ ] Every scout begins with fresh context unless explicitly changed later.
- [ ] The main session remains usable during a scout run.
- [ ] Scout completion reports evidence, not speculative implementation.
- [ ] The core package and scout definition sync successfully to every managed
      profile; each profile has been smoke-tested.
- [ ] Existing Orca and Herdr integration extensions remain functional.
- [ ] Orca progress viewing is optional and cannot break scout execution.
- [ ] No legacy viewer adapter is installed against an unsupported Pi version.
- [ ] The package has a `/settings` feature entry and validation passes.
- [ ] No worker, reviewer, workflow, scheduler, or multi-agent system is
      enabled as part of this initial change.
- [ ] A paired direct-versus-scout benchmark records inclusive tokens, cost,
      end-to-end wall time, cache split, quality, and safety/reliability before
      any role/model/concurrency expansion.
- [ ] Any new Subagents dashboard uses versioned durable metadata and does not
      scrape terminal UI, store raw delegated prompts/transcripts, or claim
      unavailable TTFT/decode-speed data.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| pi-subagents configuration/docs differ from installed release | Verify paths and keys in a disposable profile before declaring synced config resources |
| Orca observer is experimental or unavailable | Treat it as passive best-effort; preserve normal Pi result/FleetView paths |
| Child inherits too much parent authority/context | Use fresh context, a replace-mode scout prompt, no global context, no skills, and a strict read-only allowlist |
| FFF/hashline tool overrides do not compose in a child | Explicitly smoke test `read`, `grep`, and `find` in every managed profile before acceptance |
| Model costs or latency rise unexpectedly | Start with exactly one scout; use the paired inclusive-cost/end-to-end-time benchmark before setting a role-specific model or permitting parallelism |
| Package update changes an observer/config behavior | Track package release notes; keep observer config in repo; retain a kill switch by disabling `orcaProgressTabs` |
| Multiple subagent packages collide | Install no other subagent runtime while this rollout is active |
