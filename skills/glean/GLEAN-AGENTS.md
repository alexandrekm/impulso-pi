# Agents (Glean AI agents)

Manage and invoke Glean AI agents via `glean agents`. Subcommands: `list`, `get`, `schemas`, `run`.

## Subcommands

| Subcommand | Description |
|------------|-------------|
| `list` | List all available agents |
| `get` | Get details of a specific agent |
| `schemas` | Get input/output schemas for an agent |
| `run` | Run an agent |

`get`/`schemas`/`run` take `--json`; `list` takes `--output`/`--fields`/`--dry-run`.

## list

```bash
glean agents list                       # JSON
glean agents list --output text         # table view
glean agents list --fields "agents.agent_id,agents.name"
```

Payload is an `agents[]` array (each with `agent_id`, `name`, description, etc.). Use `--fields` to pull just IDs/names without `jq`.

## get / schemas

```bash
glean agents get --json '{"agentId":"<id>"}'
glean agents schemas --json '{"agentId":"<id>"}'
```

`schemas` returns the input shape the agent's `run` expects — **always call it before `run`** so you build a valid message body.

## run

```bash
glean agents run --json '{"agentId":"<id>","messages":[{"author":"USER","fragments":[{"text":"summarize Q1 results"}]}]}'
```

Messages use `author` (`USER`/`ASSISTANT`) + `fragments[]` (`{text:"…"}`) — same shape as `glean chat --json`. For multi-turn, include prior messages in the array. Preview with `--dry-run` first.

## Discover the right agent

```bash
glean agents list --fields "agents.agent_id,agents.name" | jq .
# pick an id, then inspect its contract
glean agents schemas --json '{"agentId":"<id>"}'
```
