# Troubleshooting

## Error Handling

| Scenario | Action |
|----------|--------|
| No argument | Stop — ask for a PR number or URL; never infer from the current branch |
| PR not found | Check repo scoping: `gh pr view <n> --repo <owner/name>`; the number may be an issue, not a PR |
| `gh` unauthenticated | Run `gh auth login` |
| Bare number outside a repo | Ask for `owner/repo` or a full URL |
| 422 "line must be part of the diff" | Move that comment into the review body as `path:line` + text, retry once |
| 422 on `commit_id` | Re-fetch `headRefOid` — the PR head moved since step 2 |
| 403 / review not created | Token lacks pull-request write scope; check `gh auth status` |
| Rate limited | Report and suggest waiting; the draft is preserved — re-run from step 7 |
| Existing pending review | GitHub publishes/merges it into the POSTed review; still succeeds — report the review URL |

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Reviewing before the walkthrough | Step 3 (show-me pass) always comes first — the user must see the PR before any findings |
| Inferring the PR from the branch | The argument is required; other people's PRs rarely match your own branch |
| `gh pr checkout` to read files | Read-only flow — fetch file contents at `headRefOid` via the contents API |
| Posting comment-by-comment | One `POST .../reviews` call with `comments[]` — no drip |
| Commenting on non-diff lines | GitHub rejects them (422); fold them into the body as `path:line` references |
| Posting without explicit confirmation | Draft → confirm → post. The confirm step is not optional |
| Reviewing lock/generated files line-by-line | Skim them and mark as skipped in the walkthrough |
| REQUEST_CHANGES with no blocking findings | Match the event to the severity of the selected findings |
