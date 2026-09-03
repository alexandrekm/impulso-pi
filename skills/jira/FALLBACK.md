# Jira REST API Fallbacks

Load this file only when `acli` is unavailable or fails, or for operations `acli` doesn't support (sprint-add, story points, createmeta, transition ID discovery, setting/changing an epic parent on an existing work item).

## Prerequisites

```bash
export JIRA_EMAIL="alexandre.mendonca@gomotive.com"
export ATLASSIAN_API_KEY="$ATLASSIAN_API_KEY"  # already in env
```

All requests use Basic Auth against `https://k2labs.atlassian.net`. Use `/rest/api/2/` (not v3) for plain-text `description` fields — v3 requires ADF.

## Search (JQL)

```bash
curl -s "https://k2labs.atlassian.net/rest/api/2/search?jql=<URL_ENCODED_JQL>&maxResults=20" \
  -u "${JIRA_EMAIL}:${ATLASSIAN_API_KEY}" | python3 -c "import json,sys; [print(f'{i[\"key\"]:15s} {i[\"fields\"][\"issuetype\"][\"name\"]:10s} {i[\"fields\"][\"status\"][\"name\"]:15s} {i[\"fields\"][\"summary\"][:60]}') for i in json.load(sys.stdin).get('issues',[])]"
```

## View ticket

```bash
curl -s "https://k2labs.atlassian.net/rest/api/2/issue/<KEY>?fields=key,issuetype,summary,status,priority,assignee,reporter,description" \
  -u "${JIRA_EMAIL}:${ATLASSIAN_API_KEY}"
```

## Create ticket

```bash
curl -s -X POST "https://k2labs.atlassian.net/rest/api/2/issue" \
  -u "${JIRA_EMAIL}:${ATLASSIAN_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"fields":{"project":{"key":"<PROJECT_KEY>"},"summary":"<summary>","description":"<description>","issuetype":{"name":"Task"},"assignee":{"accountId":"<ACCOUNT_ID>"},"parent":{"key":"<EPIC_KEY>"},"labels":["mlp"]}}'
```

Get your account ID: `curl -s "https://k2labs.atlassian.net/rest/api/2/myself" -u "${JIRA_EMAIL}:${ATLASSIAN_API_KEY}" | python3 -c "import json,sys; print(json.load(sys.stdin)['accountId'])"`

## Edit ticket

```bash
curl -s -X PUT "https://k2labs.atlassian.net/rest/api/2/issue/<KEY>" \
  -u "${JIRA_EMAIL}:${ATLASSIAN_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"fields":{"description":"<updated description>"}}'
```

## Set / change epic parent (existing ticket)

`acli jira workitem edit` has **no `--parent` flag** — not even via `--from-json` (`json: unknown field "parent"`). `--parent` exists only on `workitem create`. `workitem link create` is the wrong tool too — it makes "Blocks/Relates"-style links, not epic parentage. One-shot REST:

```bash
curl -s -X PUT "https://k2labs.atlassian.net/rest/api/2/issue/<KEY>" \
  -u "${JIRA_EMAIL}:${ATLASSIAN_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"fields":{"parent":{"key":"<EPIC_KEY>"}}}' -w "\nHTTP %{http_code}\n"
```

Empty body + HTTP 204 = success. **Verify via REST** (`GET /rest/api/2/issue/<KEY>?fields=parent`) — `acli jira workitem view --json` omits `parent` from its default field set, so it reports the old/no parent unless you pass `--fields "*all"`. To *remove* a parent, send `"parent": null`.

## Transition (discover + execute)

```bash
# 1. List available transitions
curl -s "https://k2labs.atlassian.net/rest/api/2/issue/<KEY>/transitions" \
  -u "${JIRA_EMAIL}:${ATLASSIAN_API_KEY}" | \
  python3 -c "import json,sys; [print(f'{t[\"id\"]:10s} {t[\"name\"]}') for t in json.load(sys.stdin)['transitions']]"

# 2. Transition using the discovered ID
curl -s -X POST "https://k2labs.atlassian.net/rest/api/2/issue/<KEY>/transitions" \
  -u "${JIRA_EMAIL}:${ATLASSIAN_API_KEY}" -H "Content-Type: application/json" \
  -d '{"transition":{"id":"<ID>"}}'
```

## Add to sprint

`acli` has no direct command. Uses Jira Agile REST API:

```bash
# 1. Find board ID
BOARD_ID=$(curl -s "https://k2labs.atlassian.net/rest/agile/1.0/board?projectKeyOrId=<PROJECT_KEY>&type=scrum" \
  -u "${JIRA_EMAIL}:${ATLASSIAN_API_KEY}" | python3 -c "import json,sys; print(json.load(sys.stdin)['values'][0]['id'])")

# 2. Get active sprint ID
SPRINT_ID=$(curl -s "https://k2labs.atlassian.net/rest/agile/1.0/board/${BOARD_ID}/sprint?state=active" \
  -u "${JIRA_EMAIL}:${ATLASSIAN_API_KEY}" | python3 -c "import json,sys; print(json.load(sys.stdin)['values'][0]['id'])")

# 3. Add issue to sprint
curl -s -X POST "https://k2labs.atlassian.net/rest/agile/1.0/sprint/${SPRINT_ID}/issue" \
  -u "${JIRA_EMAIL}:${ATLASSIAN_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"issues\": [\"<JIRA_KEY>\"]}"
```

Empty response (204) = success.

## Story points

`acli` has no `--story-points` flag. `customfield_10004` = Story Points field in k2labs Jira.

```bash
# Set story points
curl -s -X PUT "https://k2labs.atlassian.net/rest/api/2/issue/<KEY>" \
  -u "${JIRA_EMAIL}:${ATLASSIAN_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"fields":{"customfield_10004": 3}}'

# Verify
curl -s "https://k2labs.atlassian.net/rest/api/2/issue/<KEY>?fields=customfield_10004" \
  -u "${JIRA_EMAIL}:${ATLASSIAN_API_KEY}"
```

`workitem view` does not display story points. `additionalAttributes` works on create via `--from-json` only, not on `workitem edit --from-json`.

## Createmeta (discover required fields)

Use when `workitem create` fails with required-field errors (e.g. AICPE Epics need EOPC Goal, Key Project, EOQ Goal, Project's Reason, Tech Debt Project):

```bash
curl -s "https://k2labs.atlassian.net/rest/api/2/issue/createmeta?projectKeys=<PROJECT_KEY>&issuetypeNames=Epic&expand=projects.issuetypes.fields" \
  -u "${JIRA_EMAIL}:${ATLASSIAN_API_KEY}" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); [print(f'{k}: {v[\"name\"]}') for t in d.get('projects',[]) for k,v in t.get('issuetypes',[])[0].get('fields',{}).items() if v.get('required')]"
```

Provide required fields via `acli jira workitem create --from-json` (see REFERENCE.md).

## List projects

```bash
curl -s "https://k2labs.atlassian.net/rest/api/2/project" \
  -u "${JIRA_EMAIL}:${ATLASSIAN_API_KEY}" | python3 -c "import json,sys; [print(f'{p[\"key\"]:15s} {p[\"name\"]}') for p in json.load(sys.stdin)]"
```
