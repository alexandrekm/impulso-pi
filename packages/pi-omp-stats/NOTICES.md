# Notices

This package, `pi-omp-stats`, is a Node.js port of
[`@oh-my-pi/omp-stats`](https://omp.sh) (the `omp-stats` package within the
[oh-my-pi](https://github.com/can1357/oh-my-pi) monorepo).

## Origin

- **Original work:** © Can Boluk, released under the MIT License as part of
  `@oh-my-pi/omp-stats`.
- **Port:** This Node port is part of the `impulso-pi` repository. The parser,
  database schema/queries, and aggregation logic are adapted from the omp
  original; the behavioral metrics (`user-metrics.ts`) are ported verbatim.

## What changed in the port

- Runtime switched from **Bun** to **Node.js** (`node:sqlite`, `node:http`,
  `node:fs/promises`).
- **No pi imports at runtime.** The sessions directory is resolved from
  environment variables; the small `Usage` / `AssistantMessage` / `ToolCall` /
  `ToolResultMessage` type shapes are inlined locally.
- **Dropped omp-specific features:** the snapcompact *gain* aggregator, the
  auth-broker *usage-window* / subscription analytics, the `service_tier_change`
  / premium-request accounting, the sync worker pool, the port-reuse/reclaim
  logic, and the embedded React + Tailwind + Chart.js client.
- **Web client:** a single self-contained `dashboard.html` (vanilla JS +
  Chart.js, loaded from a CDN by default with a local-inline option).

The HTTP API response shapes are kept byte-compatible with omp-stats where
portable, so a future client swap is trivial.

## License

MIT — see [LICENSE](./LICENSE). The original copyright notice is preserved
on ported source files and in the license.
