# BS-UPLOAD-001 — multer route without file-size limit or type filter

**Engine:** semgrep (pattern match)
**Base severity:** medium
**vulnClass:** misconfiguration

## What it flags

`multer({...})` calls that are missing either:

1. A `limits.fileSize` option (no cap on uploaded file size), or
2. A `fileFilter` function (no MIME-type or extension validation).

Both conditions are flagged — the two sub-rules fire independently so that
a configuration with only one protection in place is still flagged for the
missing one.

## Why it matters

Without a file-size limit, an attacker can upload arbitrarily large files
to exhaust disk space or trigger out-of-memory conditions in the process
that buffers the upload. Without a type filter, an attacker can upload any
file — including server-side scripts — that may later be executed if the
storage path is web-accessible or processed by downstream tooling.

## Fix pattern

```ts
import multer from 'multer';

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Safe: both fileSize limit and fileFilter present
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    cb(null, ALLOWED.has(file.mimetype));
  },
});
```

## Acceptance criteria

The finding must no longer fire on re-scan: `ruleId: BS-UPLOAD-001` with the
same fingerprint must be absent from the next `audit run` output.

## Fixture

- Vulnerable: `benchmark/corpus/static/BS-UPLOAD-001/vulnerable/`
- Clean: `benchmark/corpus/static/BS-UPLOAD-001/clean/`
