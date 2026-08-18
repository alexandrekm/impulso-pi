# Troubleshooting

## Common mistakes

| Mistake | Fix |
|---------|-----|
| Silently picking a ticket | Present candidates, wait for user confirmation — never auto-select |
| Skipping sprint search | Check sprint first — those tickets are highest priority |
| Creating ticket without `--description` | Some projects (e.g. AICPE) require `--description` on all issue types — always include it |
| Creating ticket without epic | Always find and confirm an epic before `workitem create` |
| Forgetting to transition | Always move to In Progress after resolving |
| Hardcoding transition IDs | `acli` resolves status names automatically; if it fails, discover IDs via REST (see FALLBACK.md) |
| Using `project` in `--fields` on search | Not allowed — infer from key prefix |
