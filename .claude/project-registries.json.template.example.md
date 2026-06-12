# project-registries.json.template — sibling_repos[] example

The `sibling_repos[]` field in `.claude/project-registries.json` (added in framework v2.13.0) configures the `cross-repo-scout` agent's local and GitHub search paths.

The field is an array of objects, each with four required fields:

| Field | Type | Description |
|---|---|---|
| `name` | string | Short slug for the sibling repo. Used in cross-repo-scout output. |
| `github` | string | `owner/repo` form for `gh search code --repo <owner>/<repo>` fallback. Scoped by `--repo` (not `--owner`) so only this sibling's matches are returned. |
| `local_path` | string | Absolute path to a local working copy. Cross-repo-scout's local mode reads files from here via Glob/Grep. Use forward slashes regardless of OS. |
| `is_framework_aligned` | boolean | `true` if the sibling repo uses claude-code-framework. Increases scoring weight in cross-repo-scout's rankAndTrim helper (Contract 2). |

Example entry:

```json
{
  "name": "altessa",
  "github": "michaelhazza/altessa",
  "local_path": "c:/Files/Projects/altessa",
  "is_framework_aligned": true
}
```

Full configuration in `.claude/project-registries.json`:

```json
{
  ...other fields...
  "sibling_repos": [
    {
      "name": "altessa",
      "github": "michaelhazza/altessa",
      "local_path": "c:/Files/Projects/altessa",
      "is_framework_aligned": true
    },
    {
      "name": "release-control",
      "github": "michaelhazza/release-control",
      "local_path": "c:/Files/Projects/release-control",
      "is_framework_aligned": true
    }
  ]
}
```

When the array is empty (`"sibling_repos": []`), cross-repo-scout has no data to search — `spec-coordinator` Step 3a and `architect` Step 2 silently skip the cross-repo prior-art surface.

See `.claude/agents/cross-repo-scout.md` for the full caller contract and scoring rubric details.
