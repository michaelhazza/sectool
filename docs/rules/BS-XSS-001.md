# BS-XSS-001 — User-supplied HTML rendered/stored without sanitize-html

**Engine:** ts-morph
**Base severity:** high
**vulnClass:** xss

## What it flags

Functions where a request-derived value (`req.body.*`, `req.query.*`,
`req.params.*`, or a local variable assigned from them) is:

1. Passed directly to `res.send()`, `res.end()`, `res.write()`, or similar
   response-emission methods, OR
2. Assigned to `.innerHTML` in a DOM/React context

WITHOUT a `sanitizeHtml(...)`, `sanitize(...)`, `DOMPurify.sanitize(...)`, or
equivalent sanitization call present in the same function body.

## Why it matters

Reflected and stored XSS arise when attacker-controlled content is embedded in
an HTML response without sanitization. Even a single unsanitized `res.send()`
of user input can allow script injection, cookie theft, or account takeover.

## Fix pattern

Always sanitize user-supplied content before embedding it in an HTML response:

```ts
import sanitizeHtml from 'sanitize-html';

// Vulnerable
router.post('/api/comments', (req, res) => {
  const content = req.body.content;
  res.send(`<div>${content}</div>`);
});

// Safe: sanitize before emitting HTML
router.post('/api/comments', (req, res) => {
  const content = sanitizeHtml(req.body.content, {
    allowedTags: ['b', 'i', 'em', 'strong'],
    allowedAttributes: {},
  });
  res.send(`<div>${content}</div>`);
});
```

For JSON APIs that return data later rendered in the browser, prefer returning
structured data and letting the front-end framework (React's JSX, Handlebars'
triple-escape) handle escaping rather than constructing HTML strings server-side.

## Acceptance criteria

The finding must no longer fire on re-scan: `ruleId: BS-XSS-001` with the same
fingerprint must be absent from the next `audit run` output.

## Fixture

- Vulnerable: `benchmark/corpus/static/BS-XSS-001/vulnerable/`
- Clean: `benchmark/corpus/static/BS-XSS-001/clean/`
