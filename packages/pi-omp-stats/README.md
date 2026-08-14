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
- **Loopback by default in the foreground CLI** — `pi-omp-stats` binds
  `127.0.0.1`; pass `--host` to expose. The background **service** (see
  below) defaults to `0.0.0.0` since it's meant to run unattended.

## Install

The package is **not yet published to npm**, so build it from a checkout:

```bash
cd packages/pi-omp-stats
npm install        # dev deps (typescript, @types/node, tsx)
npm run build      # tsc + copy dashboard.html -> dist/  (also chmod +x dist/index.js)
npm start          # node dist/index.js  ->  http://127.0.0.1:3847
# or run from source (Node >= 23.6 strips types natively):
node src/index.ts
```

The build step also marks `dist/index.js` executable, because `tsc` does not
carry the `+x` bit from `src/index.ts` and the npm `bin` symlink invokes it
directly via its `#!/usr/bin/env node` shebang — without `+x` the global
`pi-omp-stats` command fails with `Permission denied`.

To get the `pi-omp-stats` command on your `PATH` from the checkout:

```bash
npm i -g .         # builds dist/ via `prepare`, links the bin
pi-omp-stats
```

Once it is published to npm, the registry install will work the same way:

```bash
npm i -g pi-omp-stats     # then: pi-omp-stats
# or
npx pi-omp-stats
```

## CLI

```
pi-omp-stats [options]
pi-omp-stats service <action> [options]

Options:
  -p, --port <port>           Port for the dashboard server (default: 3847)
      --host <host>           Bind address (default: 127.0.0.1)
  -j, --json                  Output stats as JSON and exit
  -s, --sync                  Sync session files and print a summary, no server
      --sessions-dir <path>   Override the sessions directory
  -h, --help                  Show help

Service actions:
  install                     Register + start a user service (launchd on macOS,
                              systemd --user on Linux) that auto-runs on boot.
  uninstall                   Stop + remove the service.
  status                      Show whether the service is running (exit 0 = up).
  start | stop | restart      Control an already-installed service.
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

### Run as a background service (always on)

`pi-omp-stats service install` registers a **user-level** daemon so the
dashboard stays up across reboots without needing a terminal. It auto-detects
the platform's service manager:

- **macOS** → launchd `~/Library/LaunchAgents/dev.pi.omp-stats.plist`
  (`RunAtLoad` + `KeepAlive`, logs at `~/.pi/agent/pi-omp-stats.log`).
  Manage with `launchctl list dev.pi.omp-stats` / `pi-omp-stats service ...`.
- **Linux** → systemd user unit `~/.config/systemd/user/pi-omp-stats.service`
  (`Restart=always`, `WantedBy=default.target`).
  Logs: `journalctl --user -u pi-omp-stats.service -f`.

```bash
pi-omp-stats service install                    # register + start (port 3847, host 0.0.0.0)
pi-omp-stats service install --port 8080        # register on a custom port
pi-omp-stats service install --host 127.0.0.1   # keep the daemon loopback-only
pi-omp-stats service status                     # is it up? (exit 0 = running)
pi-omp-stats service restart                    # pick up a rebuilt dist/index.js
pi-omp-stats service stop                       # suspend (KeepAlive may relaunch)
pi-omp-stats service uninstall                  # stop + remove the service
```

The service runs `node <dist/index.js> --port <P> --host <H>` and forwards the
`PI_STATS_*` / `PI_CODING_AGENT_*` env vars that are set at install time, so the
daemon reads the same sessions dir the installer does. No root required — it's
a user service. Unlike the ad-hoc foreground run (loopback-only by default),
`service install` defaults to **`--host 0.0.0.0`** since it's meant to run
unattended and be reachable from other machines — anyone on that interface can
read your usage stats, so pass `--host 127.0.0.1` if you only ever access it
locally.

> Rebuilding `dist/` (e.g. `npm run build` or `npm i -g .`) after an install
> is fine; the service references the absolute `dist/index.js` path, so a
> `pi-omp-stats service restart` picks up the new code. Re-run `service
> install` only if you change `--port` / `--host` or the forwarded env vars.

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

The foreground CLI (`pi-omp-stats`) binds to **`127.0.0.1`** by default; pass
`--host 0.0.0.0` to expose it on other interfaces. The background **service**
(`pi-omp-stats service install`) instead defaults to **`0.0.0.0`**, since it's
meant to run unattended and be reached from other machines — pass
`--host 127.0.0.1` at install time to keep it loopback-only. Either way,
**anyone reachable on the bound interface can read your usage stats and
trigger syncs**, so only bind `0.0.0.0` on a trusted network. There is no
telemetry; all parsing and aggregation is local. The only outbound network
call is the optional CDN Chart.js fetch (which the local-inline option
removes).

## Origin & license

MIT — see [LICENSE](./LICENSE) and [NOTICES.md](./NOTICES.md). This is a port
of `@oh-my-pi/omp-stats` (© Can Boluk); the original copyright is preserved on
ported source files.
