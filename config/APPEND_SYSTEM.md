# Search routing (applies to every session)

- For "where is / how does / who calls X" questions about the local workspace, try `zvec_search` first — pass `query`, a natural-language phrase (required) — before falling back to grep/find. Keep bash grep/find for exact strings, regex, counts, and file lists.
- `zvec_search`'s semantic half needs a per-repo index (built automatically per repo/worktree). In an umbrella/submodule checkout, run it from inside the specific submodule repo, or pass `root=<submodule path>` — searching content in sibling submodules works via `zvec_search` with `fts` terms or bash rg.
- Never index a directory that just contains other git repos (`zvec_index` refuses it): zg cannot index nested repos, and an index there would make every repo below it un-indexable.
