# acli Jira Command Reference

Full reference for `acli jira`. Use `acli jira <command> --help` for the most up-to-date flags.

**Common flags:** `--json` (JSON output), `--csv` (CSV, where supported), `--yes` (skip prompts), `--ignore-errors` (continue past failures on bulk ops).

**Bulk targeting:** Many write commands accept `--key` (comma-separated), `--jql`, `--filter`, or `--from-file` to target multiple items.

## Auth

| Command | Example |
|---------|---------|
| `acli auth login` | `acli auth login` |
| `acli auth logout` | `acli auth logout` |
| `acli auth status` | `acli auth status` |
| `acli auth switch` | `acli auth switch` |

## Parsing `--json` output

`acli` emits JSON on stdout; **prefer `jq`** over hand-rolled `python3 -c` parsers, which break on Jira's nested field shapes. Errors go to stderr; exit 1 on failure.

```bash
# One ticket's fields, cleanly
acli jira workitem view AICPE-107 --json | jq '.fields'

# Search → key + status name + summary (status is an OBJECT, not a list)
acli jira workitem search --jql "assignee = currentUser()" --json \
  | jq -r '.[] | [.key, .fields.status.name, .fields.summary] | @tsv'
```

**Shape gotchas** (these caused real fallbacks in past sessions):
- `fields.status` is an **object** `{ "name": "In Progress", ... }` — use `.fields.status.name`. Indexing it like a list (`fields.status[0]`) raises `TypeError: unhashable type: 'slice'`.
- `fields.issuetype` is likewise an object — `.fields.issuetype.name`.
- `fields.customfield_10020` (Sprint) is a **list** of sprint objects — `.fields.customfield_10020[].name`; it is `null`/empty when the ticket isn't on a sprint, so guard it.
- `fields.assignee` is `null` when unassigned — `.fields.assignee.name // "Unassigned"`.
- `fields.parent` (epic) is **absent from the default `view --json` field set** — pass `--fields "*all"` to see it, or check via REST `GET /rest/api/2/issue/<KEY>?fields=parent`.

If you must use Python, read stdin and walk the shapes above; never assume a field is a list vs object — inspect with `jq 'keys'` first.

## Work Items

| Command | Key Flags |
|---------|-----------|
| `acli jira workitem search` | `--jql`, `--fields` (valid: issuetype,key,assignee,priority,status,summary — **not** `project`), `--json`, `--csv`, `--limit`, `--paginate`, `--count`, `--filter`, `--web` |
| `acli jira workitem view [key]` | `--fields` (default: key,issuetype,summary,status,assignee,description; use `*all` or `*navigable`), `--json`, `--web` |
| `acli jira workitem create` | `--summary`, `--project`, `--type` (Epic/Story/Task/Bug), `--assignee` (`@me`/email/`default`), `--description`, `--description-file`, `--label`, `--parent`, `--editor`, `--from-file`, `--from-json`, `--generate-json`, `--json` |
| `acli jira workitem create-bulk` | `--from-json`, `--from-csv`, `--generate-json`, `--ignore-errors`, `--yes` |
| `acli jira workitem edit` | `--key`, `--jql`, `--filter`, `--summary`, `--description`, `--description-file`, `--assignee`, `--type`, `--labels`, `--remove-labels`, `--remove-assignee`, `--from-json`, `--generate-json`, `--json`, `--yes` (**no `--parent`** — parent only settable on `create`; re-parent via REST in `FALLBACK.md`) |
| `acli jira workitem transition` | `--key`, `--jql`, `--filter`, `--status`, `--json`, `--ignore-errors`, `--yes` |
| `acli jira workitem assign` | `--key`, `--jql`, `--filter`, `--from-file`, `--assignee` (`@me`/email/`default`), `--remove-assignee`, `--json`, `--ignore-errors`, `--yes` |
| `acli jira workitem clone` | `--key`, `--jql`, `--filter`, `--from-file`, `--to-project`, `--to-site`, `--json`, `--ignore-errors`, `--yes` |
| `acli jira workitem archive` | `--key`, `--jql`, `--filter`, `--from-file`, `--json`, `--ignore-errors`, `--yes` |
| `acli jira workitem unarchive` | `--key`, `--from-file`, `--json`, `--ignore-errors`, `--yes` |
| `acli jira workitem delete` | `--key`, `--jql`, `--filter`, `--from-file`, `--json`, `--ignore-errors`, `--yes` |

## Work Item Comments

| Command | Key Flags |
|---------|-----------|
| `acli jira workitem comment create` | `--key`, `--jql`, `--filter`, `--body`, `--body-file`, `--editor`, `--edit-last`, `--json`, `--ignore-errors` |
| `acli jira workitem comment list` | `--key`, `--json`, `--limit` (default 50), `--order` (+created/-created/+updated/-updated), `--paginate` |
| `acli jira workitem comment update` | `--key`, `--id`, `--body`, `--body-file`, `--body-adf`, `--visibility-role`, `--visibility-group`, `--notify` |
| `acli jira workitem comment delete` | `--key`, `--id` |
| `acli jira workitem comment visibility` | `--role` (requires `--project`), `--group` |

## Work Item Links

| Command | Key Flags |
|---------|-----------|
| `acli jira workitem link create` | `--out` (outward key), `--in` (inward key), `--type` (e.g. Blocks), `--from-json`, `--from-csv`, `--generate-json`, `--ignore-errors`, `--yes` |
| `acli jira workitem link list` | `--key`, `--json` |
| `acli jira workitem link delete` | `--id`, `--from-json`, `--from-csv`, `--ignore-errors`, `--yes` |
| `acli jira workitem link type` | `--json` |

## Work Item Attachments

| Command | Key Flags |
|---------|-----------|
| `acli jira workitem attachment list` | `--key`, `--json` |
| `acli jira workitem attachment delete` | `--id` |

## Work Item Watchers

| Command | Key Flags |
|---------|-----------|
| `acli jira workitem watcher list` | `--key`, `--json` |
| `acli jira workitem watcher remove` | `--key`, `--user` (account ID) |

## Sprints

| Command | Key Flags |
|---------|-----------|
| `acli jira sprint create` | `--name`, `--board` (required), `--start`, `--end` (ISO 8601), `--goal`, `--json` |
| `acli jira sprint view` | `--id`, `--json` |
| `acli jira sprint update` | `--id`, `--name`, `--goal`, `--start`, `--end`, `--state` (future/active/closed), `--complete-date`, `--board`, `--json` |
| `acli jira sprint delete` | `--id` (comma-separated), `--yes` |
| `acli jira sprint list-workitems` | `--sprint` (required), `--board` (required), `--fields`, `--jql`, `--json`, `--csv`, `--limit` (default 50), `--paginate` |

## Boards

| Command | Key Flags |
|---------|-----------|
| `acli jira board search` | `--name`, `--project`, `--type` (scrum/kanban/simple), `--filter`, `--order-by`, `--limit` (default 50), `--paginate`, `--private`, `--json`, `--csv` |
| `acli jira board get` | `--id`, `--json` |
| `acli jira board create` | `--name`, `--type` (scrum/kanban), `--filter-id`, `--location-type` (project/user), `--project`, `--json` |
| `acli jira board delete` | `--id` (comma-separated), `--yes` |
| `acli jira board list-sprints` | `--id` (board ID), `--state` (future/active/closed, comma-separated), `--limit` (default 50), `--paginate`, `--json`, `--csv` |
| `acli jira board list-projects` | `--id`, `--limit` (default 50), `--paginate`, `--json`, `--csv` |

## Projects

| Command | Key Flags |
|---------|-----------|
| `acli jira project list` | `--json`, `--limit` (default 30), `--paginate`, `--recent` (up to 20) |
| `acli jira project view` | `--key`, `--json` |
| `acli jira project create` | `--key`, `--name`, `--from-project` (clone), `--description`, `--lead-email`, `--url`, `--from-json`, `--generate-json` |
| `acli jira project update` | `--project-key`, `--key` (new key), `--name`, `--description`, `--lead-email`, `--url`, `--from-json`, `--generate-json` |
| `acli jira project delete` | `--key` |
| `acli jira project archive` | `--key` |
| `acli jira project restore` | `--key` |

## Filters

| Command | Key Flags |
|---------|-----------|
| `acli jira filter search` | `--name`, `--owner` (email), `--limit` (default 30), `--paginate`, `--json`, `--csv` |
| `acli jira filter get` | `--id`, `--json`, `--web` |
| `acli jira filter list` | `--my`, `--favourite`, `--json` |
| `acli jira filter update` | `--id`, `--name`, `--description`, `--jql`, `--share-permissions`, `--edit-permissions`, `--json` |
| `acli jira filter add-favourite` | `--filter-id` |
| `acli jira filter get-columns` | `--id` |
| `acli jira filter reset-columns` | `--id` |
| `acli jira filter change-owner` | `--id`, `--owner` |

## Dashboards

| Command | Key Flags |
|---------|-----------|
| `acli jira dashboard search` | `--name`, `--owner` (email), `--limit` (default 30), `--paginate`, `--json`, `--csv` |

## Fields

| Command | Key Flags |
|---------|-----------|
| `acli jira field create` | `--name`, `--type`, `--description`, `--searcher-key`, `--json` |
| `acli jira field delete` | `--id` |
| `acli jira field cancel-delete` | `--id` |
