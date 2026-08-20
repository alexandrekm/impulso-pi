---
name: datadog
description: Use Datadog via the pup CLI — dashboards, metrics, monitors, logs, SLOs, synthetics, APM.
author: alexandre.mendonca
tags: [datadog, observability, metrics, dashboards, pup]
---

# Datadog (pup CLI)

Use Datadog via the **`pup` CLI** — DataDog's AI-agent-ready CLI that exposes the full Datadog API surface with structured JSON output. Install/auth/site setup lives in `skill://datadog/REFERENCE.md`.

Announce at start: "I'm using the datadog skill to <task>."

## Usage

Command pattern: `pup <domain> <action> [options]` or `pup <domain> <subgroup> <action> [options]`. Run `pup <domain> <action> --help` for exact flags.

Key global flags: `--read-only` (block writes), `--jq '<expr>'` (filter the raw payload — write `.[]`, not `.data[]`), `-o table|yaml`, `--site`, `--org <name>`.

## Feature files (load on demand)

Each area is a self-contained file — `read skill://datadog/<FILE>` only when the task needs it.

| Need | Load |
|------|------|
| **Dashboards** (list · get · edit · create · url) | `skill://datadog/DASHBOARDS.md` |
| **Metrics** (query · timeseries/formulas · list · submit) | `skill://datadog/METRICS.md` |
| Monitors (alert rules: list, get, create, update, diff, delete, search) | `skill://datadog/MONITORS.md` |
| Logs (search, aggregate, patterns, saved views) | `skill://datadog/LOGS.md` |
| Events (post, list, search, get) | `skill://datadog/EVENTS.md` |
| SLOs (list, get, status, create, diff) | `skill://datadog/SLOS.md` |
| Synthetics (tests, locations, suites, downtime) | `skill://datadog/SYNTHETICS.md` |
| APM / Traces / Service Catalog | `skill://datadog/APM.md` |
| Install + auth + sites + full command reference | `skill://datadog/REFERENCE.md` |
| Common mistakes | `skill://datadog/TROUBLESHOOTING.md` |
