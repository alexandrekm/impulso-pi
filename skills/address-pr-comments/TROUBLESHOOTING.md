# Troubleshooting

## Error Handling

| Scenario | Action |
|----------|--------|
| No PR on branch | Stop — "No open PR found for this branch" |
| No comments | Report and stop |
| `gh` unauthenticated | Run `gh auth login` |
| Copilot login varies | Try `copilot`, `copilot[bot]`, filter `user.type == "Bot"` |
| Rate limited | Report, suggest waiting |

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Blindly fixing every suggestion | Evaluate each technically first |
| Editing during iteration | Collect all decisions, then batch-apply |
| One commit per fix | Single commit for all fixes |
| Skipping commit convention | `git log --oneline -5` first; `type(JIRA-123): address PR review feedback` |
| Addressing replies not root thread | Group threads — address the parent |
| Leaving a comment unreplied | Every comment gets a reply — fixed, skipped, or invalid |
