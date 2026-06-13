import type { RunReport } from '../schemas/report.js';
import type { Finding } from '../schemas/finding.js';
import { redact } from './redaction.js';
import { sortFindings } from './json.js';

// ---------------------------------------------------------------------------
// HTML entity escaping — all evidence content passes through this.
// Covers the full set of characters that browsers interpret as markup.
// ---------------------------------------------------------------------------

function esc(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/`/g, '&#x60;');
}

// ---------------------------------------------------------------------------
// </script>-safe JSON data island encoding.
// Replaces every "</script" (case-insensitive) with a split that browsers
// do not treat as a closing tag, so the inline JSON cannot break out of
// the <script> block.
// ---------------------------------------------------------------------------

function safeJsonIsland(value: unknown): string {
  return JSON.stringify(value).replace(/<\/script/gi, '<\\/script');
}

// ---------------------------------------------------------------------------
// Severity labels + colours (§5.2 visual language)
// ---------------------------------------------------------------------------

const SEVERITY_LABEL: Record<string, string> = {
  critical: 'Fix now (Critical)',
  high: 'Fix soon (High)',
  medium: 'Plan it (Medium)',
  low: 'Low risk (Low)',
};

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#dc2626',
  high: '#ea580c',
  medium: '#d97706',
  low: '#65a30d',
};

function severityColor(s: string): string {
  return SEVERITY_COLOR[s] ?? '#6b7280';
}

function severityLabel(s: string): string {
  return SEVERITY_LABEL[s] ?? s;
}

// ---------------------------------------------------------------------------
// Status label
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<string, string> = {
  success: 'Complete',
  partial: 'Some checks did not finish',
  failed: 'Failed',
};

// ---------------------------------------------------------------------------
// Location + target helpers (evidence-free — these render metadata only)
// ---------------------------------------------------------------------------

function locationHtml(f: Finding): string {
  if (f.surface === 'static') {
    const line = f.location.startLine !== undefined ? `:${f.location.startLine}` : '';
    return `${esc(f.location.path)}${esc(line)} — <code>${esc(f.location.symbol)}</code>`;
  }
  const param = f.location.parameter ? ` (param: <code>${esc(f.location.parameter)}</code>)` : '';
  return `${esc(f.location.method)} ${esc(f.location.url)}${param}`;
}

function targetHtml(f: Finding): string {
  if (f.target.kind === 'repo') {
    const commit = f.target.commit ? ` @ ${esc(f.target.commit.slice(0, 8))}` : '';
    return esc(f.target.name) + commit;
  }
  return esc(f.target.host);
}

// ---------------------------------------------------------------------------
// Finding card
// ---------------------------------------------------------------------------

function renderFindingHtml(f: Finding, idx: number): string {
  const color = severityColor(f.severity);
  const label = severityLabel(f.severity);
  const surface = f.surface === 'static' ? 'In the code' : 'On the live test site';

  let extraMeta = '';
  if (f.suppressed && f.suppression !== null) {
    extraMeta += `<p class="meta-note"><strong>Acknowledged risk</strong> — ${esc(f.suppression.justification)} (approved by ${esc(f.suppression.approvedBy)}, expires ${esc(f.suppression.expiry)})</p>`;
  }
  if (f.note !== null) {
    extraMeta += `<p class="meta-note"><strong>Note:</strong> ${esc(f.note)}</p>`;
  }
  if (f.correlatedWith.length > 0) {
    extraMeta += `<p class="meta-row"><strong>Correlated with:</strong> ${f.correlatedWith.map(esc).join(', ')}</p>`;
  }
  if (f.externalRefs.length > 0) {
    const links = f.externalRefs
      .map((u) => `<a href="${esc(u)}" rel="noopener noreferrer">${esc(u)}</a>`)
      .join(', ');
    extraMeta += `<p class="meta-row"><strong>Fix request:</strong> ${links}</p>`;
  }

  // Evidence snippet — HTML-entity-escaped, rendered in a visible <pre><code> container.
  // The snippet is redaction-passed before we reach this point (redact() runs on the whole
  // report at the top of toHtml). We still HTML-escape it here as the anti-XSS layer.
  let evidenceHtml = '';
  const snippet = f.evidence.snippet;
  if (snippet !== undefined && snippet !== '') {
    evidenceHtml = `
    <details class="evidence-block">
      <summary>Evidence</summary>
      <pre class="evidence-pre"><code class="evidence-text">${esc(snippet)}</code></pre>
    </details>`;
  }

  return `
  <div class="finding-card" id="finding-${idx}">
    <div class="finding-header" style="border-left: 4px solid ${color}">
      <span class="finding-num">#${idx}</span>
      <span class="severity-badge" style="background:${color}">${esc(label)}</span>
      <span class="rule-id">${esc(f.ruleId)}</span>
      <span class="display-id">${esc(f.id)}</span>
    </div>
    <div class="finding-body">
      <p class="meta-row"><strong>Surface:</strong> ${esc(surface)}</p>
      <p class="meta-row"><strong>Target:</strong> ${targetHtml(f)}</p>
      <p class="meta-row"><strong>Location:</strong> ${locationHtml(f)}</p>
      <p class="meta-row"><strong>Vulnerability class:</strong> ${esc(f.vulnClass)}</p>
      <p class="meta-row"><strong>Confidence:</strong> ${esc(f.confidence)}${f.reachability !== 'unknown' ? ` / Reachability: ${esc(f.reachability)}` : ''}</p>
      ${f.suppressed ? '<p class="meta-row"><strong>Status:</strong> Acknowledged risk (suppressed)</p>' : ''}
      ${extraMeta}
      <p class="meta-row"><strong>First seen:</strong> ${esc(f.firstSeen)}</p>
      <p class="meta-row"><strong>Fingerprint:</strong> <code>${esc(f.fingerprint)}</code></p>
      ${evidenceHtml}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Summary counts
// ---------------------------------------------------------------------------

function buildCounts(findings: readonly Finding[]): Record<string, number> {
  const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    if (f.severity in counts) (counts[f.severity] as number)++;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Inline CSS
// ---------------------------------------------------------------------------

const INLINE_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #f9fafb; color: #111827; line-height: 1.5; }
  .container { max-width: 960px; margin: 0 auto; padding: 2rem 1rem; }
  h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
  h2 { font-size: 1.2rem; margin: 1.5rem 0 0.5rem; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.25rem; }
  .run-meta { color: #6b7280; font-size: 0.875rem; margin-bottom: 1rem; }
  .run-meta span { margin-right: 1.5rem; }
  .summary-bar { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
  .sev-chip { padding: 0.4rem 0.8rem; border-radius: 4px; font-weight: 600; color: #fff; font-size: 0.875rem; }
  .finding-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 6px; margin-bottom: 1rem; overflow: hidden; }
  .finding-header { display: flex; align-items: center; gap: 0.75rem; padding: 0.6rem 1rem; background: #f3f4f6; flex-wrap: wrap; }
  .finding-num { color: #9ca3af; font-size: 0.8rem; }
  .severity-badge { padding: 0.15rem 0.5rem; border-radius: 3px; color: #fff; font-size: 0.8rem; font-weight: 600; }
  .rule-id { font-family: monospace; font-size: 0.85rem; }
  .display-id { font-family: monospace; font-size: 0.8rem; color: #9ca3af; }
  .finding-body { padding: 0.75rem 1rem; }
  .meta-row { margin-bottom: 0.3rem; font-size: 0.875rem; }
  .meta-note { margin: 0.5rem 0; padding: 0.4rem 0.75rem; background: #fef3c7; border-left: 3px solid #f59e0b; font-size: 0.875rem; }
  .evidence-block { margin-top: 0.75rem; }
  .evidence-block summary { cursor: pointer; font-size: 0.875rem; color: #4b5563; margin-bottom: 0.4rem; }
  .evidence-pre { background: #1e293b; color: #e2e8f0; padding: 0.75rem; border-radius: 4px; overflow-x: auto; font-size: 0.8rem; }
  .evidence-text { font-family: monospace; white-space: pre-wrap; word-break: break-all; }
  .chart-wrap { margin: 1rem 0; }
  canvas { max-width: 100%; }
  .no-findings { color: #6b7280; font-style: italic; padding: 1rem 0; }
  .scanner-table { width: 100%; border-collapse: collapse; font-size: 0.875rem; margin-top: 0.5rem; }
  .scanner-table th, .scanner-table td { text-align: left; padding: 0.35rem 0.5rem; border: 1px solid #e5e7eb; }
  .scanner-table th { background: #f9fafb; }
  @media (max-width: 600px) { .summary-bar { flex-direction: column; } }
`;

// ---------------------------------------------------------------------------
// Fixed build-time chart renderer (runs over the escaped JSON data island).
// This script is a literal string written at build time — it does NOT use eval,
// does NOT use innerHTML for evidence, and does NOT derive any executable
// code from finding evidence content.
// ---------------------------------------------------------------------------

const CHART_SCRIPT = `
(function() {
  var dataIsland = document.getElementById('audit-data');
  if (!dataIsland) return;
  var data;
  try { data = JSON.parse(dataIsland.textContent || '{}'); } catch(e) { return; }
  var counts = data.counts || {};
  var canvas = document.getElementById('sev-chart');
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');
  var labels = Object.keys(counts);
  var values = labels.map(function(k){ return counts[k] || 0; });
  var colors = data.colors || {};
  var barH = 28, pad = 40, labelW = 90, maxVal = Math.max.apply(null, values.concat([1]));
  canvas.height = labels.length * (barH + 8) + pad;
  canvas.width = 480;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  labels.forEach(function(label, i) {
    var y = pad / 2 + i * (barH + 8);
    var barW = Math.round((values[i] / maxVal) * (canvas.width - labelW - 50));
    ctx.fillStyle = colors[label] || '#6b7280';
    ctx.fillRect(labelW, y, barW, barH);
    ctx.fillStyle = '#111827';
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(label, labelW - 6, y + barH / 2 + 5);
    ctx.fillStyle = '#374151';
    ctx.textAlign = 'left';
    ctx.fillText(String(values[i]), labelW + barW + 6, y + barH / 2 + 5);
  });
})();
`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produce a self-contained single-file HTML report.
 *
 * Safety contract (§5.2 / §10):
 * 1. Redaction runs FIRST (§5.4) on the full report data.
 * 2. All evidence text is HTML-entity-escaped via esc() before being placed
 *    in any DOM carrier — never injected as markup.
 * 3. Evidence appears ONLY inside visible <pre><code> containers.
 *    It is never placed in: <script>, <style>, <template>, <meta>, <link>,
 *    HTML comments, attribute values, hidden containers, or off-viewport elements.
 * 4. The inline <script> is a fixed build-time chart renderer over a JSON data
 *    island. The data island is encoded via safeJsonIsland() (</script>-safe)
 *    and contains ONLY pre-escaped counts and colour strings — no evidence text.
 * 5. No eval, no innerHTML of evidence, no evidence-derived script.
 */
export function toHtml(report: RunReport): string {
  // Step 1: redaction first (§5.4 — anti-XSS escaping is not a substitute)
  const r = redact(report) as RunReport;

  const sorted = sortFindings(r.findings);
  const counts = buildCounts(sorted);

  const statusLabel = STATUS_LABEL[r.meta.status] ?? r.meta.status;

  // Build the data island — ONLY severity counts and safe colour strings.
  // No evidence text or attacker-controlled strings enter the data island.
  const dataIsland = safeJsonIsland({
    counts,
    colors: {
      critical: '#dc2626',
      high: '#ea580c',
      medium: '#d97706',
      low: '#65a30d',
    },
  });

  // Summary chips
  const summaryChips = ['critical', 'high', 'medium', 'low']
    .map(
      (s) =>
        `<span class="sev-chip" style="background:${severityColor(s)}">${esc(severityLabel(s))}: ${counts[s] ?? 0}</span>`,
    )
    .join('\n      ');

  // Finding cards
  const findingCards =
    sorted.length === 0
      ? '<p class="no-findings">No findings.</p>'
      : sorted.map((f, i) => renderFindingHtml(f, i + 1)).join('\n');

  // Scanner status table
  let scannerRows = '';
  for (const s of r.meta.scannerStatus) {
    scannerRows += `<tr><td>${esc(s.target)}</td><td>${esc(s.family)}</td><td>${esc(s.state)}</td></tr>\n`;
  }
  const scannerTable =
    r.meta.scannerStatus.length > 0
      ? `<table class="scanner-table"><thead><tr><th>Target</th><th>Family</th><th>State</th></tr></thead><tbody>${scannerRows}</tbody></table>`
      : '';

  // Targets section
  let targetsHtml = '';
  for (const t of r.targets) {
    const commit = t.commit !== undefined ? ` @ <code>${esc(t.commit.slice(0, 8))}</code>` : '';
    targetsHtml += `<p class="meta-row">${esc(t.kind)}: <strong>${esc(t.name)}</strong>${commit}</p>`;
    for (const gap of t.coverageGaps) {
      targetsHtml += `<p class="meta-note">Coverage gap: ${esc(gap)}</p>`;
    }
  }

  // Failures section
  let failuresHtml = '';
  for (const f of r.meta.failures) {
    failuresHtml += `<p class="meta-note"><strong>${esc(f.target)}</strong> (${esc(f.family)}): ${esc(f.reason)}</p>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Audit Report — ${esc(r.runId)}</title>
  <style>${INLINE_CSS}</style>
</head>
<body>
<div class="container">
  <h1>Audit Report — ${esc(r.runId)}</h1>
  <div class="run-meta">
    <span><strong>Date:</strong> ${esc(r.date)}</span>
    <span><strong>Status:</strong> ${esc(statusLabel)}</span>
    <span><strong>Tool:</strong> ${esc(r.meta.toolVersion)}</span>
    <span><strong>Started:</strong> ${esc(r.meta.startedAt)}</span>
    <span><strong>Finished:</strong> ${esc(r.meta.finishedAt)}</span>
  </div>

  ${r.targets.length > 0 ? `<h2>Targets</h2>${targetsHtml}` : ''}
  ${r.meta.failures.length > 0 ? `<h2>Failures</h2>${failuresHtml}` : ''}

  <h2>Summary</h2>
  <div class="summary-bar">
    ${summaryChips}
  </div>
  <div class="chart-wrap">
    <canvas id="sev-chart" aria-label="Severity distribution chart" role="img"></canvas>
  </div>

  <h2>Findings</h2>
  ${findingCards}

  ${r.meta.scannerStatus.length > 0 ? `<h2>Scanner status</h2>${scannerTable}` : ''}
</div>

<script id="audit-data" type="application/json">${dataIsland}</script>
<script>${CHART_SCRIPT}</script>
</body>
</html>`;
}
