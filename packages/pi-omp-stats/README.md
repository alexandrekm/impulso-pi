# pi-omp-stats

A standalone, lightweight HTTP dashboard for **pi** AI usage statistics —
tokens, cost, cache, latency, tools, and behavior — parsed directly from pi
session JSONL files on disk.

It is a **Node.js port of [`@oh-my-pi/omp-stats`](https://omp.sh)** (© Can
Boluk, MIT). Like the omp original, it runs as its own process and does **not**
depend on a running pi process or import anything from pi at runtime — it only
reads session JSONL files. It targets sessions written by
[`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi-coding-agent),
but because it only reads files it works for any pi fork that writes the same
JSONL shape.

- **Zero runtime dependencies** — uses only Node built-ins (`node:sqlite`,
  `node:http`, `node:fs`).
- **`node:sqlite`** stores aggregates (requires **Node ≥ 22.5**).
- **Single-file dashboard** — vanilla JS + Chart.js (CDN, with a local-inline
  option for a zero-CDN build).
- **Loopback by default** — binds `127.0.0.1`; `--host` is required to expose.

## Install

```bash
npm i -g pi-omp-stats     # then: pi-omp-stats
# or
npx pi-omp-stats
```

From a checkout of this repo:

```bash
cd packages/pi-omp-stats
npm install        # dev deps (typescript, @types/node, tsx)
npm run build      # tsc + copy dashboard.html -> dist/
npm start          # node dist/index.js
# or run from source (Node ≥ 23.6 strips types natively):
node src/index.ts
```

## CLI

```
pi-omp-stats [options]

Options:
  -p, --port <port>           Port for the dashboard server (default: 3847)
      --host <host>           Bind address (default: 127.0.0.1)
  -j, --json                  Output stats as JSON and exit
  -s, --sync                  Sync session files and print a summary, no server
      --sessions-dir <path>   Override the sessions directory
  -h, --help                  Show help
```

Default action (no flags): sync then start the server and print
`Dashboard available at: http://127.0.0.1:<port>`.

```bash
pi-omp-stats                 # sync + start dashboard
pi-omp-stats --json          # print aggregates as JSON, exit
pi-omp-stats --sync          # print a human summary, exit
pi-omp-stats --port 8080     # custom port
PI_CODING_AGENT_DIR=/x pi-omp-stats --sync   # read /x/sessions/
```

## Environment variables

The sessions directory is resolved, first match wins:

1. `PI_STATS_SESSIONS_DIR` — this package's own override
2. `PI_CODING_AGENT_SESSION_DIR` — pi's own session-dir override
3. `<PI_CODING_AGENT_DIR>/sessions` — when `PI_CODING_AGENT_DIR` is set
4. `~/.pi/agent/sessions` — default

A leading `~/` is expanded against `os.homedir()`. Point this at any
pi-lineage sessions dir and it works.

The SQLite database lives at `<statsDir>/pi-omp-stats.db`, where `statsDir` is
`PI_STATS_DIR` or `~/.pi/agent`.

## HTTP API

All read endpoints accept a `?range=` query (`1h` / `24h` / `7d` / `30d` / `90d`
/ `all`; default `24h`). Shapes are byte-compatible with omp-stats where
portable.

| Method | Path                       | Returns |
|--------|---------------------------|---------|
| GET    | `/api/stats`              | full `DashboardStats` |
| GET    | `/api/stats/overview`      | `{ overall, byAgentType, timeSeries }` |
| GET    | `/api/stats/models`       | `byModel[]` |
| GET    | `/api/stats/folders`       | `byFolder[]` |
| GET    | `/api/stats/timeseries`    | `timeSeries[]` |
| GET    | `/api/stats/model-dashboard` | `{ byModel, modelSeries, modelPerformanceSeries }` |
| GET    | `/api/stats/costs`         | `{ costSeries }` |
| GET    | `/api/stats/tools`         | `ToolDashboardStats` |
| GET    | `/api/stats/behavior`      | `BehaviorDashboardStats` |
| GET    | `/api/stats/providers`     | `ProviderDashboardStats` (portable subset) |
| GET    | `/api/stats/recent`        | recent `MessageStats[]` (`?limit=`) |
| GET    | `/api/stats/errors`        | error `MessageStats[]` (`?limit=`) |
| GET    | `/api/request/:id`         | `RequestDetails` |
| POST   | `/api/sync`               | incremental resync → `{ processed, files, totalMessages }` |

Not implemented (omp-specific): `/api/stats/gain` (snapcompact) and the
provider usage-window/subscription analytics (auth-broker).

## Dashboard

The dashboard is one self-contained `dashboard.html` served at `/`. Charts use
[Chart.js](https://www.jsdelivr.net/package/chart.js) loaded from the jsdelivr
CDN by default. For a **zero-CDN** build, drop a local copy of Chart.js at
`dist/chart.min.js` (or `src/chart.min.js`) next to the server — the page tries
`./chart.min.js` first and only falls back to the CDN if it is absent. Tables
render even when Chart.js is unavailable.

Sections: **Overview** (metric cards + time-series), **Models**, **Folders**,
**Tools**, **Behavior** (port of omp's "rage" analytics), **Costs**,
**Providers**, **Requests**, **Errors**.

> **Note on latency/TTFT:** as of this port, earendil-works pi does not record
> `duration` / `ttft` on assistant messages, so the Avg Latency, Avg TTFT, and
> Tokens/s cards render as `-` for that lineage. The columns are retained and
> will populate for forks that do emit them.

## Security

The server binds to **`127.0.0.1`** by default. Use `--host 0.0.0.0` to expose
the dashboard on other interfaces — **anyone reachable on that interface can
read your usage stats and trigger syncs**, so only do this on a trusted
network. There is no telemetry; all parsing and aggregation is local. The only
outbound network call is the optional CDN Chart.js fetch (which the local-inline
option removes).

## Origin & license

MIT — see [LICENSE](./LICENSE) and [NOTICES.md](./NOTICES.md). This is a port
of `@oh-my-pi/omp-stats` (© Can Boluk); the original copyright is preserved on
ported source files.
