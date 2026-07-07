# Lessons

After-action notes from completed work. Lighter-weight than KNOWLEDGE.md (which is canonical patterns and gotchas) — this is "what we learned during THIS task that might inform future tasks."

## When to write

- After completing a non-trivial task.
- After resolving a hotfix.
- After a review pass that surfaced a class of issue you hadn't seen before.

## Item shape

```markdown
## <YYYY-MM-DD> — <task title>

**Context:** what we were doing.
**Surprise:** what didn't go as expected.
**Takeaway:** what we'd do differently next time. If durable, promote to `KNOWLEDGE.md` or write an ADR.
```

---

## Entries

## 2026-07-05 — full-audit close-out (PR #3)

**Context:** Full-mode security audit → 7 findings fixed across two external
PR-review rounds, merged to main.

**Surprise:** (1) The first token-hardening fix moved `AUDIT_GITHUB_READ_TOKEN`
off argv but used a *global* `http.extraHeader`, which git sends to whatever host
`gitUrl` names — and the schema allows any https host — so a malicious registry
`gitUrl` could exfiltrate the token. A "comment says it's safe, code doesn't
enforce it" gap. (2) The real-`git` integration suites flaked hard on Windows
under load — not parallelism (config already sets `fileParallelism:false`) but
`EBUSY`-at-rmdir teardown and too-tight timeouts, and the failure count scaled
with machine load, not code. (3) The audit close-out itself was left unfinished:
`current-focus.md` stayed at `MERGE_READY` for an already-merged build.

**Takeaway:** When injecting a credential into a subprocess that talks to a
config-controlled URL, scope it to the exact expected origin (host-gate + URL-
scoped header) — never a global header. Pin the subprocess transport
(`GIT_ALLOW_PROTOCOL`) as belt-and-braces. For Windows real-`git` tests, retry
`rm` teardowns (`maxRetries`) and give hooks the same timeout as test bodies. And
finish the close-out: release the `current-focus.md` lock when a build lands.
(Durable specifics already promoted to `KNOWLEDGE.md`.)
