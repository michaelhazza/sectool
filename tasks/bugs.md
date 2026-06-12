# Bugs

Holding pen for bugs surfaced during dev sessions that aren't being fixed in the current task. Captured by `triage-agent` or routed from review agents. Triaged at natural breaks.

## Item shape

```markdown
- **<short title>** (captured <YYYY-MM-DD>)
  Symptom: one sentence.
  Suspected cause: one sentence (optional, only if known).
  Reproducibility: always | sometimes | unknown.
```

If a bug is critical (production broken, data corruption, auth bypass) it should NOT live here — invoke `hotfix` immediately.

---

## Open

[Items here are awaiting triage or fix.]

## Resolved

[Items fixed. Keep title + commit / PR pointer.]
