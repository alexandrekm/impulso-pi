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
| Leaving a placeholder description | Run B3.c — rewrite template `<...>`/`TODO` descriptions from context and `workitem edit --description` |
| Skipping story points | Run B3.d — check `customfield_10004`; if missing, ask the user with Fibonacci options (1/2/3/5/8/13) |
| Forgetting the PR→Jira comment | After `gh pr create`, post a comment with PR title + URL (jira skill §C) |
| Running B3 only on create | B3 runs for *every* ticket used — found (B1) or created (B2) |
