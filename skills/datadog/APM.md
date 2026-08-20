# APM, Traces & Service Catalog

Service-level APM stats, trace-span search, and the Service/Software Catalog via `pup apm`, `pup traces`, and `pup service-catalog` / `pup idp`. Reads need `apm_read` / `trace_read` / service-catalog read on your app key.

## APM services (`--env` is required on `list`)
```bash
pup apm services list --env=production          # payload: {"data":{"attributes":{"services":["name", ...]}}} — jq '.data.attributes.services[]'
pup apm services stats --service web --env=production          # hits, errors, latency p95/p99
pup apm services operations --service web --env=production
pup apm services resources --service web --env=production
```
Service list entries are **service-name strings**, not objects. The env tag is your APM primary env (often `production`, `staging`, `none`) — check the Datadog UI APM Services page for yours.

## Entities, dependencies, flow map
```bash
pup apm entities list
pup apm dependencies list
pup apm flow-map
pup apm troubleshooting list
# also: service-config, service-library-config, service-remapping, sampling-rules, adaptive-sampling
```

## Traces (spans)
```bash
pup traces search --query="service:web @duration:>2s" --from="1h"
pup traces aggregate --query="service:web" --from="1h"   # check --help for compute/group-by flags
pup traces metrics list                                  # configured span-based metrics
pup traces metrics get <METRIC_ID>
pup traces metrics create --file metric.json
pup traces metrics update <METRIC_ID> --file metric.json
pup traces metrics delete <METRIC_ID>
```

## Service Catalog (registry + agent-native context)
```bash
pup service-catalog list
pup service-catalog get <service-name>

pup idp find web                  # search entities by name
pup idp assist web                # owner, on-call, health, deps, gaps, next actions
pup idp owner web                 # ownership + on-call responders
pup idp deps web                  # upstream/downstream dependencies
pup idp register service.datadog.yaml   # POST a service definition
```
