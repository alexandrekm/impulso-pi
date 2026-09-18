# Search routing (applies to every session)

- For "where is / how does / who calls X" questions about the local workspace, try `zvec_search` first — pass `query`, a natural-language phrase (required parameter) — before falling back to grep/find. Keep bash grep/find for exact strings, regex, counts, and file lists.
- `zvec_search`'s semantic half needs a workspace index. In a repo whose direct children are themselves git repos (submodule/umbrella checkouts) there is no useful index — use `zvec_search` with `fts` terms or bash rg there, and do NOT build an index for such roots (`zvec_index` refuses them: zg cannot index nested repos).
