import { describe, it, expect } from 'vitest';
import { toHtml } from './html.js';
import type { RunReport } from '../schemas/report.js';

// ---------------------------------------------------------------------------
// Minimal RunReport factory
// ---------------------------------------------------------------------------

function makeReport(overrides?: Partial<RunReport['findings'][number]>): RunReport {
  const base = {
    id: 'f-deadbeef01234567' as const,
    fingerprint: 'deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567',
    ruleId: 'BS-TEST-001',
    source: 'ast' as const,
    surface: 'static' as const,
    vulnClass: 'injection' as const,
    severity: 'high' as const,
    baseSeverity: 'high' as const,
    confidence: 'probable' as const,
    target: { kind: 'repo' as const, name: 'test-repo', commit: 'abc123' },
    location: { path: 'src/test.ts', symbol: 'GET /api/test', startLine: 1 },
    evidence: { snippet: '', cvss: null, raw: {} },
    reachability: 'unknown' as const,
    correlatedWith: [],
    externalRefs: [],
    firstSeen: '2026-06-13T00:00:00.000Z',
    suppressed: false,
    suppression: null,
    note: null,
  };
  const finding = (
    overrides !== undefined ? { ...base, ...overrides } : base
  ) as RunReport['findings'][number];
  return {
    runId: '2026-06-13T00-00-00Z-test',
    date: '2026-06-13',
    findings: [finding],
    targets: [{ kind: 'repo', name: 'test-repo', commit: 'abc123', coverageGaps: [] }],
    meta: {
      status: 'success',
      failures: [],
      scannerStatus: [{ target: 'test-repo', family: 'ast', state: 'complete' }],
      startedAt: '2026-06-13T00:00:00.000Z',
      finishedAt: '2026-06-13T00:00:01.000Z',
      toolVersion: 'audit-tool/1.0.0',
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers for the inert-text assertions
// ---------------------------------------------------------------------------

/** Extract the visible evidence container text (inside <pre><code> elements). */
function evidenceTextContent(html: string): string {
  // Match content between <code class="evidence-text"> and </code>
  const m = html.match(/<code class="evidence-text">([\s\S]*?)<\/code>/);
  return m !== null ? m[1] ?? '' : '';
}

// ---------------------------------------------------------------------------
// §10 HTML evidence inert-text matrix
// ---------------------------------------------------------------------------

describe('toHtml — §10 HTML evidence inert-text matrix guardrail', () => {
  // ── <script> tag in evidence ─────────────────────────────────────────────

  it('evidence containing <script>alert(1)</script> appears only as escaped text', () => {
    const malicious = '<script>alert(1)</script>';
    const report = makeReport({ evidence: { snippet: malicious, cvss: null, raw: {} } });
    const html = toHtml(report);

    // The raw payload must not appear as a live tag pair
    expect(html).not.toMatch(/<script>alert\(1\)<\/script>/);
    // It appears escaped in the evidence container
    const evidenceText = evidenceTextContent(html);
    expect(evidenceText).toContain('&lt;script&gt;');
    expect(evidenceText).toContain('&lt;/script&gt;');
  });

  // ── <style> tag in evidence ──────────────────────────────────────────────

  it('evidence containing <style> tag appears only as escaped text', () => {
    const malicious = '<style>body{display:none}</style>';
    const report = makeReport({ evidence: { snippet: malicious, cvss: null, raw: {} } });
    const html = toHtml(report);

    expect(html).not.toMatch(/<style>body\{display:none\}<\/style>/);
    const evidenceText = evidenceTextContent(html);
    expect(evidenceText).toContain('&lt;style&gt;');
  });

  // ── <template> tag in evidence ───────────────────────────────────────────

  it('evidence containing <template> tag appears only as escaped text', () => {
    const malicious = '<template id="xss"><script>alert(2)</script></template>';
    const report = makeReport({ evidence: { snippet: malicious, cvss: null, raw: {} } });
    const html = toHtml(report);

    expect(html).not.toMatch(/<template id=/);
    const evidenceText = evidenceTextContent(html);
    expect(evidenceText).toContain('&lt;template');
  });

  // ── <meta> tag in evidence ───────────────────────────────────────────────

  it('evidence containing <meta> tag appears only as escaped text', () => {
    const malicious = '<meta http-equiv="refresh" content="0;url=https://evil.example">';
    const report = makeReport({ evidence: { snippet: malicious, cvss: null, raw: {} } });
    const html = toHtml(report);

    expect(html).not.toMatch(/<meta http-equiv="refresh"/);
    const evidenceText = evidenceTextContent(html);
    expect(evidenceText).toContain('&lt;meta');
  });

  // ── <link> tag in evidence ───────────────────────────────────────────────

  it('evidence containing <link> tag appears only as escaped text', () => {
    const malicious = '<link rel="stylesheet" href="https://evil.example/x.css">';
    const report = makeReport({ evidence: { snippet: malicious, cvss: null, raw: {} } });
    const html = toHtml(report);

    expect(html).not.toMatch(/<link rel="stylesheet"/);
    const evidenceText = evidenceTextContent(html);
    expect(evidenceText).toContain('&lt;link');
  });

  // ── HTML comment in evidence ─────────────────────────────────────────────

  it('evidence containing HTML comment appears only as escaped text', () => {
    const malicious = '<!-- inject --><script>evil()</script>';
    const report = makeReport({ evidence: { snippet: malicious, cvss: null, raw: {} } });
    const html = toHtml(report);

    // Raw comment syntax must not appear unescaped in evidence position
    expect(html).not.toMatch(/<!--\s*inject\s*-->/);
    const evidenceText = evidenceTextContent(html);
    expect(evidenceText).toContain('&lt;!--');
  });

  // ── aria-* attribute injection in evidence ───────────────────────────────

  it('evidence containing aria-* attributes appears only as escaped text', () => {
    const malicious = '<div aria-label="x" aria-hidden="false">secret</div>';
    const report = makeReport({ evidence: { snippet: malicious, cvss: null, raw: {} } });
    const html = toHtml(report);

    // Must not produce a live <div aria-label=...> outside the evidence container
    expect(html).not.toMatch(/<div aria-label=/);
    const evidenceText = evidenceTextContent(html);
    expect(evidenceText).toContain('aria-label=');
    // Confirms it's escaped (no live angle bracket before div)
    expect(evidenceText).toContain('&lt;div');
  });

  // ── data-* attribute injection in evidence ───────────────────────────────

  it('evidence containing data-* attributes appears only as escaped text', () => {
    const malicious = '<span data-secret="password123">text</span>';
    const report = makeReport({ evidence: { snippet: malicious, cvss: null, raw: {} } });
    const html = toHtml(report);

    expect(html).not.toMatch(/<span data-secret=/);
    const evidenceText = evidenceTextContent(html);
    expect(evidenceText).toContain('&lt;span');
  });

  // ── Event-handler attribute injection in evidence ────────────────────────

  it('evidence containing event-handler attributes appears only as escaped text', () => {
    const malicious = '<img src="x" onerror="alert(3)" onload="steal()">';
    const report = makeReport({ evidence: { snippet: malicious, cvss: null, raw: {} } });
    const html = toHtml(report);

    expect(html).not.toMatch(/onerror="alert/);
    const evidenceText = evidenceTextContent(html);
    expect(evidenceText).toContain('onerror=');
    expect(evidenceText).toContain('&lt;img');
  });

  // ── <input type="hidden"> in evidence ────────────────────────────────────

  it('evidence containing <input type="hidden"> appears only as escaped text', () => {
    const malicious = '<input type="hidden" name="csrf" value="stolen">';
    const report = makeReport({ evidence: { snippet: malicious, cvss: null, raw: {} } });
    const html = toHtml(report);

    expect(html).not.toMatch(/<input type="hidden"/);
    const evidenceText = evidenceTextContent(html);
    expect(evidenceText).toContain('&lt;input');
    expect(evidenceText).toContain('type=');
  });

  // ── display:none / visibility:hidden hidden subtrees in evidence ─────────

  it('evidence containing display:none subtree appears only as escaped text', () => {
    const malicious = '<div style="display:none">hidden payload</div>';
    const report = makeReport({ evidence: { snippet: malicious, cvss: null, raw: {} } });
    const html = toHtml(report);

    expect(html).not.toMatch(/<div style="display:none"/);
    const evidenceText = evidenceTextContent(html);
    expect(evidenceText).toContain('display:none');
    expect(evidenceText).toContain('&lt;div');
  });

  it('evidence containing visibility:hidden appears only as escaped text', () => {
    const malicious = '<span style="visibility:hidden">hidden</span>';
    const report = makeReport({ evidence: { snippet: malicious, cvss: null, raw: {} } });
    const html = toHtml(report);

    expect(html).not.toMatch(/<span style="visibility:hidden"/);
    const evidenceText = evidenceTextContent(html);
    expect(evidenceText).toContain('visibility:hidden');
  });

  it('evidence containing aria-hidden subtree appears only as escaped text', () => {
    const malicious = '<div aria-hidden="true">secret</div>';
    const report = makeReport({ evidence: { snippet: malicious, cvss: null, raw: {} } });
    const html = toHtml(report);

    expect(html).not.toMatch(/<div aria-hidden="true"/);
    const evidenceText = evidenceTextContent(html);
    expect(evidenceText).toContain('aria-hidden=');
  });

  // ── Off-viewport position injection in evidence ──────────────────────────

  it('evidence containing off-viewport absolute position appears only as escaped text', () => {
    const malicious = '<div style="position:absolute;left:-9999px">offscreen</div>';
    const report = makeReport({ evidence: { snippet: malicious, cvss: null, raw: {} } });
    const html = toHtml(report);

    expect(html).not.toMatch(/<div style="position:absolute;left:-9999px"/);
    const evidenceText = evidenceTextContent(html);
    expect(evidenceText).toContain('position:absolute');
  });

  // ── Literal </script> in evidence (data-island escape) ───────────────────

  it('evidence containing literal </script> appears only as escaped text, never breaking out of context', () => {
    const malicious = '</script><script>alert("breakout")</script>';
    const report = makeReport({ evidence: { snippet: malicious, cvss: null, raw: {} } });
    const html = toHtml(report);

    // The raw breakout sequence must not appear unescaped in the evidence block
    // (it would need to be literally </script> followed by live HTML to be dangerous)
    const evidenceText = evidenceTextContent(html);
    expect(evidenceText).toContain('&lt;/script&gt;');
    // The data island (which uses safeJsonIsland encoding) must not contain
    // a literal unescaped </script> that could break the JSON script block
    const dataIslandMatch = html.match(/<script id="audit-data" type="application\/json">([\s\S]*?)<\/script>/);
    expect(dataIslandMatch).not.toBeNull();
    // No raw </script inside the data island content (safeJsonIsland encoding replaces it)
    const islandContent = dataIslandMatch?.[1] ?? '';
    expect(islandContent).not.toMatch(/<\/script/i);
  });

  // ── No evidence in <script> or <style> context ───────────────────────────

  it('evidence text never appears inside a <script> block', () => {
    const uniqueSnippet = 'UNIQUE_EVIDENCE_MARKER_xyz987';
    const report = makeReport({ evidence: { snippet: uniqueSnippet, cvss: null, raw: {} } });
    const html = toHtml(report);

    // Find all <script> blocks
    const scriptBlocks = html.match(/<script[\s\S]*?<\/script>/gi) ?? [];
    for (const block of scriptBlocks) {
      // The data island script may contain JSON with summary counts but NOT evidence
      expect(block).not.toContain(uniqueSnippet);
    }
  });

  it('evidence text never appears inside a <style> block', () => {
    const uniqueSnippet = 'UNIQUE_STYLE_MARKER_abc123';
    const report = makeReport({ evidence: { snippet: uniqueSnippet, cvss: null, raw: {} } });
    const html = toHtml(report);

    const styleBlocks = html.match(/<style[\s\S]*?<\/style>/gi) ?? [];
    for (const block of styleBlocks) {
      expect(block).not.toContain(uniqueSnippet);
    }
  });

  // ── Evidence only in the visible <pre><code> container ───────────────────

  it('evidence text appears in the visible <pre><code> evidence container', () => {
    const snippet = 'db.execute(sql`SELECT * FROM users WHERE id = ${req.params.id}`)';
    const report = makeReport({ evidence: { snippet, cvss: null, raw: {} } });
    const html = toHtml(report);

    const evidenceText = evidenceTextContent(html);
    // The snippet is HTML-escaped — angle brackets become &lt;/&gt;; backtick becomes &#x60;
    // But the alphanumeric parts survive intact
    expect(evidenceText).toContain('db.execute');
    expect(evidenceText).toContain('req.params.id');
  });

  // ── Redaction-pass assertion on the HTML surface (§10) ───────────────────
  //
  // The HTML emitter applies redact(report) over the whole report object before
  // rendering. Redaction is key-driven: fields whose key matches a credential
  // pattern (e.g. 'secret', 'token', 'authorization', 'set-cookie') are
  // replaced with [redacted:<8hex>] placeholders.
  //
  // The HTML template only renders evidence.snippet (as HTML-escaped inert
  // text) and does not render evidence.raw. Credential-keyed raw fields are
  // thus doubly safe: redacted in the data AND not rendered to the page.
  //
  // If a snippet contains a pre-redacted placeholder (as normalizers produce
  // when they detect a credential at scan time), that placeholder must survive
  // HTML escaping and appear as visible text.

  it('redaction-pass: credential-keyed fields in evidence.raw do not appear verbatim in HTML output', () => {
    const rawSecret = 'EXAMPLE-generic-secret-value-htmltest';
    const report = makeReport({
      evidence: {
        snippet: 'secret found in source',
        cvss: null,
        // 'secret' and 'token' are credential keys — they will be redacted by redact()
        raw: { secret: rawSecret, token: rawSecret },
      },
    });
    const html = toHtml(report);

    // The raw credential value must not appear anywhere in the HTML
    expect(html).not.toContain(rawSecret);
  });

  it('redaction-pass: authorization header in evidence.raw does not appear verbatim in HTML output', () => {
    const tokenPayload = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig';
    const report = makeReport({
      evidence: {
        snippet: 'auth header captured',
        cvss: null,
        raw: { authorization: `Bearer ${tokenPayload}` },
      },
    });
    const html = toHtml(report);

    // The raw bearer token must not appear verbatim in the HTML
    expect(html).not.toContain(tokenPayload);
  });

  it('redaction-pass: a pre-redacted placeholder in snippet survives HTML escaping as visible text', () => {
    // Normalizers produce [redacted:8hex] placeholders in the snippet field.
    // The HTML export must preserve the placeholder text (it is safe, not a secret).
    const preRedacted = '[redacted:ab12cd34]';
    const report = makeReport({
      evidence: {
        snippet: `Authorization: Bearer ${preRedacted}`,
        cvss: null,
        raw: {},
      },
    });
    const html = toHtml(report);

    // The placeholder appears in the visible evidence container (not stripped or re-escaped
    // into something unrecognisable — the bracket chars are not HTML-special).
    const evidenceText = evidenceTextContent(html);
    expect(evidenceText).toContain(preRedacted);
  });

  // ── Data island contains no evidence text ────────────────────────────────

  it('the JSON data island contains only severity counts and colours — no evidence text', () => {
    const snippet = 'SECRET_EVIDENCE_SHOULD_NOT_BE_IN_ISLAND';
    const report = makeReport({ evidence: { snippet, cvss: null, raw: {} } });
    const html = toHtml(report);

    const dataIslandMatch = html.match(/<script id="audit-data" type="application\/json">([\s\S]*?)<\/script>/);
    expect(dataIslandMatch).not.toBeNull();
    const islandContent = dataIslandMatch?.[1] ?? '';
    expect(islandContent).not.toContain(snippet);
    // Island must only reference counts and colors
    expect(islandContent).toContain('"counts"');
    expect(islandContent).toContain('"colors"');
  });

  // ── Zero findings path ────────────────────────────────────────────────────

  it('renders a valid page with no findings', () => {
    const report: RunReport = {
      runId: '2026-06-13T00-00-00Z-empty',
      date: '2026-06-13',
      findings: [],
      targets: [],
      meta: {
        status: 'success',
        failures: [],
        scannerStatus: [],
        startedAt: '2026-06-13T00:00:00.000Z',
        finishedAt: '2026-06-13T00:00:01.000Z',
        toolVersion: 'audit-tool/1.0.0',
      },
    };
    const html = toHtml(report);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('No findings');
  });

  // ── Structural self-containedness ─────────────────────────────────────────

  it('HTML output contains no external network references (zero network deps)', () => {
    const report = makeReport();
    const html = toHtml(report);

    // No src= pointing to external URLs on script or img
    expect(html).not.toMatch(/src="https?:/);
    // No link rel=stylesheet pointing to external URLs
    expect(html).not.toMatch(/href="https?:/);
    // No @import in inline style
    expect(html).not.toMatch(/@import\s+url/);
  });

  it('HTML output is a valid self-contained document with doctype, head, body', () => {
    const report = makeReport();
    const html = toHtml(report);

    expect(html).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toContain('<html');
    expect(html).toContain('<head>');
    expect(html).toContain('<body>');
    expect(html).toContain('</html>');
  });
});
