# Orchestration: OMP, Pi extensions, and Orca

Subagent orchestration is the biggest architectural divergence between omp, pi community extensions, and Orca. Three approaches, each with different tradeoffs:

## OMP: in-process orchestration

OMP's built-in `task` tool spawns subagent sessions via `createAgentSession` — **same Bun process**, own session/tools/model. The `hub` tool provides peer messaging over a process-global mailbox bus, background-job control, and shared long-running process supervision. `vibe mode` turns the top-level session into a **director** that orchestrates persistent **in-process worker sessions** (`vibe_spawn`/`vibe_send`/`vibe_wait`/`vibe_kill`/`vibe_list`).

- **Strengths**: fast spawn, shared state (eval kernels, tool sessions, hub bus), `parallel()`/`pipeline()` in eval, tight coupling
- **Weaknesses**: no process isolation, no git-worktree isolation, no visual monitoring of individual workers, no mobile/federation, a crash in a subagent is caught but can affect the process

## Pi community extensions: in-process + subprocess

[`pi-subagent-in-memory`](https://github.com/ross-jill-ws/pi-subagent-in-memory) — in-process subagent sessions with TUI card widgets, JSONL logging, nesting depth limits, timeout management. Closest to omp's `task` tool but with richer visualization and no shared hub bus.

[`pi-fork`](https://github.com/bmxburner/pi-toolbox) (from pi-toolbox) — context offload via child `pi` processes inheriting the session branch. The `fork` tool spawns a child pi in a new pane to handle a subtask, then the parent continues. Lighter than agent-fleet's `supervised` mode — no orchestration tracking, just context offload.

[`pi-flow`](https://github.com/bmxburner/pi-toolbox) (from pi-toolbox) — multi-backend subagent dispatch (`run_agent`/`run_workflow`) supporting pi, Codex, and Claude as worker backends, plus a workflow engine. Broader agent support than agent-fleet (which is pi-only) but without Orca's git-worktree isolation.

[`agent-fleet`](https://github.com/bmxburner/pi-toolbox) (from [pi-toolbox](https://github.com/bmxburner/pi-toolbox)) — spawns **real child pi processes** in terminal panes managed by a multiplexer (cmux or Orca). Three isolation tiers. Exposes Orca's decision gates (`gateCreate`/`gateResolve`) and `orca_ask` bridge — workers can ask blocking questions surfaced in the sidebar. Sidebar visualization (status dots, click-to-focus, peek, abort, gate resolve) requires [`pi-compositor`](https://github.com/bmxburner/pi-toolbox) (also from pi-toolbox) — without it, agent-fleet works but has no dashboard UI.

| Mode | Backend | Isolation | Orca equivalent |
|---|---|---|---|
| `fork` | cmux or orca | Lightweight pane, no tracking | `orca terminal send` |
| `worktree` | orca only | Git-worktree isolation — child's cwd is a fresh worktree, can't pollute main checkout | `orca worktree create` + terminal |
| `supervised` | orca only | Full orchestration: Run/Task/Dispatch lifecycle, `worker_done` handshake, decision gates via `orca_ask`, heartbeats, status tracking | `orca orchestration worker-start` |

## Orca: CLI-based external orchestration

[Orca](https://www.onorca.dev) is a terminal multiplexer with a built-in agent orchestration layer. You don't need agent-fleet or any pi extension to use it — the `orca orchestration` CLI is a standalone orchestration system that works with any agent (pi, Codex, Claude, Cursor, Gemini). A pi extension just wraps it; the orchestration primitives are Orca's own.

**Core model**:
- **Run** — durable namespace with a coordinator inbox. Never schedules workers; it's the ownership boundary.
- **Task** — work item with spec, dependencies, and status (`pending` → `ready` → `dispatched` → `completed`/`failed`/`blocked`). Supports DAGs.
- **Dispatch** — one attempt of a task on a terminal. Lifecycle authority for `worker_done` / heartbeats.
- **Worker** — a child agent running in a terminal pane, given a contract: send `worker_done` exactly once with `--outcome succeeded|failed`, include task+dispatch IDs, send heartbeats, use `orca orchestration ask` for blocking questions.
- **Decision gate** — a coordinator-owned question that blocks a task until resolved (`gate-create` / `gate-resolve`).

**What Orca gives you without any pi extension**:

```bash
# Create a run (namespace + coordinator inbox)
orca orchestration run-create --objective "Split checkout QA and summarize blockers" --json

# Create tasks — independent and with dependencies (DAG)
orca orchestration task-create --spec "Audit billing settings" --task-title "Billing audit" --json
orca orchestration task-create --spec "Fix billing layout" --deps '["<auditTaskId>"]' --json
orca orchestration task-create --spec "Write billing tests" --deps '["<auditTaskId>"]' --json
orca orchestration task-create --spec "Update docs" --deps '["<fixTaskId>","<testTaskId>"]' --parent "<fixTaskId>" --json

# List tasks that are ready to dispatch (deps satisfied)
orca orchestration task-list --ready --json

# Start a supervised worker (in a new git worktree, using Codex)
orca orchestration worker-start --task <taskId> --worktree new-child --name billing-audit --agent codex --setup run --json

# Wait for worker completion, escalation, or questions
orca orchestration check --wait --types worker_done,escalation,question --timeout-ms 900000 --json
orca orchestration check --ack <deliveryId> --wait --types worker_done,escalation,question --json

# Worker sends completion from inside its terminal
orca orchestration send --type worker_done --subject "Done" --body "Fixed footer overlap" \
  --task-id <taskId> --dispatch-id <dispatchId> --outcome succeeded --files-modified "src/Billing.tsx" --json

# Coordinator asks a blocking question to a worker
orca orchestration ask --to <coordinatorHandle> --question "Shared or page-only?" --options "shared,page-only" --json

# Create a decision gate that blocks a task
orca orchestration gate-create --task <taskId> --question "Merge the shared change?" --options '["yes","no"]' --json
orca orchestration gate-resolve --id <gateId> --resolution "yes" --json

# Federated workers on other machines
orca orchestration worker-start --task <taskId> --on windows --worktree new-top-level --repo <repo> --agent codex --json

# Group messaging
orca orchestration send --to @all --subject "Pausing dispatches" --body "Review in progress." --json
orca orchestration send --to @idle --subject "Anyone free?" --json
orca orchestration send --to @codex --subject "Codex agents only" --json
```

**How a pi agent uses Orca directly**: the pi agent calls `orca orchestration` commands through its `bash` tool. It creates a Run, creates Tasks, starts Workers (each worker is a separate terminal running another pi/agent), waits for `worker_done` messages, and reads results via `worker-read`. No pi extension is needed — just the `orca` CLI on PATH. agent-fleet makes this ergonomic by wrapping the CLI calls into a native pi tool with sidebar visualization.

**Comparison: OMP vs Orca orchestration**:

| Aspect | OMP `task`/`hub`/`vibe` | Orca orchestration |
|---|---|---|
| Architecture | In-process `createAgentSession` | Real child processes in terminal panes |
| State sharing | Shared process (eval kernels, hub bus, tool sessions) | No shared state — coordination via CLI messages |
| Messaging | `hub` tool: peer-to-peer mailbox bus | `orchestration send`/`check`: typed FIFO messages with ack |
| Parallelism | `parallel()`/`pipeline()` in eval | Multiple workers dispatched, `check --wait` for any to settle |
| Isolation | Same process — subagent crash is caught | Process isolation — crashed worker doesn't affect coordinator |
| Git isolation | None — subagents share cwd | `worktree` mode: full git-worktree isolation |
| Visual monitoring | TUI cards or Agent Hub table | Live terminals + compositor sidebar with status dots |
| Mobile monitoring | No | Yes — Orca's mobile app shows all terminals |
| Federation | No | `--on windows`/`--on <remote>` — workers on other machines |
| DAG support | No | Tasks with `--deps <json_array>` and `--parent <task_id>` (`pending`/`ready`/`dispatched`/`completed`/`failed`/`blocked`); `task-list --ready` shows dispatchable tasks; blocked status can be set via `task-update --status blocked` |
| Decision gates | `ask` tool (in-process) | `gate-create`/`gate-resolve` (CLI, blocks task) |
| Completion contract | Tool result returned to parent | `worker_done` with `--outcome`, `--files-modified`, task+dispatch IDs |
| Spawn cost | Fast — in-process session | Heavier — spawns a real process + terminal |

**When to use which**:
- **OMP's in-process subagents** — tight parallel work inside one codebase where speed and state sharing matter
- **Orca orchestration** — long-running or risky work where you want process isolation, git-worktree safety, visual monitoring, mobile access, or federation
- **agent-fleet** — a pi extension that makes Orca orchestration ergonomic from inside pi, with sidebar visualization (requires pi-compositor) and three isolation tiers (fork/worktree/supervised). Exposes decision gates and `orca_ask` bridge. Pi-only and doesn't expose Orca's federated workers (`--on <remote>`) or DAG task dependencies. Use Orca directly if you need those.

Install agent-fleet:

```bash
# From the pi-toolbox repo (source-built, no npm)
git clone https://github.com/bmxburner/pi-toolbox.git ~/code/pi-toolbox
mkdir -p ~/.pi/agent/extensions/agent-fleet
ln -sf ~/code/pi-toolbox/agent-fleet/index.js ~/.pi/agent/extensions/agent-fleet/index.js
# Restart pi
```

OMP plugins that declare the legacy `pi.extensions` field (e.g. ponytail, plannotator, impulso) are installable in pi; ones that only declare `omp.extensions` are not. OMP-specific extensions importing `@oh-my-pi/*` packages are not pi-compatible without porting.
