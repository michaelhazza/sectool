#!/usr/bin/env tsx
/**
 * harness-metrics.ts
 *
 * Review-harness metrics aggregator (I/O module). Run from a CONSUMER repo root.
 * Processes every `coordinator-decisions-*.jsonl` under `tasks/review-logs/` at
 * run time, groups metrics per build slug (primary unit) plus a rolling 30-day
 * summary, and writes a dated markdown report and a jsonl report to
 * `tasks/review-logs/metrics/`. Every machine key defined in
 * references/harness-metrics.md (F12) appears in the output — derivable keys with
 * real values, unsupported keys with a `not-derivable` marker. Nothing is faked.
 *
 * The pure parsing/aggregation core lives in harness-metricsPure.ts and is
 * vitest-tested. This module owns directory scans, file reads, and report writes.
 *
 * Usage:
 *   npx tsx scripts/harness-metrics.ts            # scan cwd/tasks/review-logs
 *   npx tsx scripts/harness-metrics.ts <repoRoot> # scan <repoRoot>/tasks/review-logs
 *
 * Exit codes: 0 ok · 1 no coordinator-decisions logs found · 2 usage error.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { aggregate, parseDecisionsFile, METRIC_KEYS, type ParsedFile, type MetricValue } from './harness-metricsPure.js';

const DECISIONS_RE = /^coordinator-decisions-.*\.jsonl$/i;
const REVIEW_LOG_MD_RE = /review.*\.md$/i;

function main(argv: string[]): number {
  const repoRoot = resolve(argv[2] ?? process.cwd());
  const logsDir = join(repoRoot, 'tasks', 'review-logs');
  if (!existsSync(logsDir)) {
    process.stderr.write(`harness-metrics: no tasks/review-logs/ under ${repoRoot}\n`);
    return 1;
  }

  const entries = readdirSync(logsDir, { withFileTypes: true });
  const decisionFiles = entries
    .filter((e) => e.isFile() && DECISIONS_RE.test(e.name))
    .map((e) => e.name)
    .sort();
  const reviewLogMdCount = entries.filter(
    (e) => e.isFile() && REVIEW_LOG_MD_RE.test(e.name),
  ).length;

  if (decisionFiles.length === 0) {
    process.stderr.write(`harness-metrics: no coordinator-decisions-*.jsonl in ${logsDir}\n`);
    return 1;
  }

  const parsed: ParsedFile[] = decisionFiles.map((name) => {
    const content = readFileSync(join(logsDir, name), 'utf8');
    return parseDecisionsFile(name, content);
  });

  const report = aggregate(parsed);

  const outDir = join(logsDir, 'metrics');
  mkdirSync(outDir, { recursive: true });

  const runIso = new Date().toISOString();
  const stamp = runIso.replace(/[:.]/g, '-');
  const mdPath = join(outDir, `harness-metrics-${stamp}.md`);
  const jsonlPath = join(outDir, `harness-metrics-${stamp}.jsonl`);

  writeFileSync(mdPath, renderMarkdown(report, { runIso, reviewLogMdCount, decisionFiles }));
  writeFileSync(jsonlPath, renderJsonl(report, { runIso, reviewLogMdCount, decisionFiles }));

  process.stdout.write(`harness-metrics: wrote\n  ${mdPath}\n  ${jsonlPath}\n`);
  process.stdout.write(
    `corpus: ${report.header.fileCount} decision file(s), ${report.header.recordCount} record(s), ` +
      `${report.header.malformedSkipped} malformed skipped; slugs: ${report.header.slugs.join(', ') || '(none)'}\n`,
  );
  return 0;
}

// ── rendering ──────────────────────────────────────────────────────────────

interface RunMeta {
  runIso: string;
  reviewLogMdCount: number;
  decisionFiles: string[];
}

function fmtMetricValue(m: MetricValue): string {
  if (m.status !== 'ok') return `_${m.status}_ — ${m.note}`;
  if (m.value === null) return `_no-data_ — ${m.note}`;
  if (typeof m.value === 'number') {
    const v = Number.isInteger(m.value) ? String(m.value) : m.value.toFixed(4);
    return `\`${v}\` — ${m.note}`;
  }
  // per-reviewer map
  const parts = Object.entries(m.value).map(([k, v]) => `${k}=${v}`);
  return `\`${parts.join(', ') || '(empty)'}\` — ${m.note}`;
}

function renderMetricsBlock(metrics: Record<string, MetricValue>): string {
  const lines: string[] = ['| Metric key | Value / status |', '|---|---|'];
  for (const key of METRIC_KEYS) {
    const m = metrics[key] ?? { value: null, status: 'no-data', note: 'key missing' };
    lines.push(`| \`${key}\` | ${fmtMetricValue(m)} |`);
  }
  return lines.join('\n');
}

function renderMarkdown(
  report: ReturnType<typeof aggregate>,
  meta: RunMeta,
): string {
  const h = report.header;
  const out: string[] = [];
  out.push('# Harness metrics report');
  out.push('');
  out.push(`Generated: ${meta.runIso}`);
  out.push('');
  out.push('## Corpus');
  out.push('');
  out.push(`- Coordinator-decisions files processed: **${h.fileCount}**`);
  out.push(`- Decision records: **${h.recordCount}**`);
  out.push(`- Malformed lines skipped: **${h.malformedSkipped}**`);
  out.push(`- Corpus range: **${h.earliestTs ?? '(none)'}** → **${h.latestTs ?? '(none)'}**`);
  out.push(`- Build slugs: ${h.slugs.length ? h.slugs.map((s) => `\`${s}\``).join(', ') : '(none)'}`);
  out.push(`- Review-log markdown files present (informational, not parsed for metrics): ${meta.reviewLogMdCount}`);
  out.push('');
  out.push('Metric definitions and owners: `references/harness-metrics.md`.');
  out.push('');

  for (const b of report.builds) {
    out.push(`## Build: \`${b.slug}\``);
    out.push('');
    out.push(`Files: ${b.fileCount} · Records: ${b.recordCount}`);
    out.push('');
    out.push(renderMetricsBlock(b.metrics));
    out.push('');
  }

  const w = report.window30d;
  out.push('## Rolling 30-day summary');
  out.push('');
  out.push(`Anchor (latest source ts): ${w.anchorTs ?? '(none)'} · Window from: ${w.fromTs ?? '(none)'}`);
  out.push(`Records in window: ${w.recordCount} · Undated records excluded: ${w.undatedExcluded}`);
  out.push('');
  out.push(renderMetricsBlock(w.metrics));
  out.push('');
  return out.join('\n');
}

function renderJsonl(report: ReturnType<typeof aggregate>, meta: RunMeta): string {
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      type: 'corpus-header',
      generated_at: meta.runIso,
      ...report.header,
      review_log_md_count: meta.reviewLogMdCount,
      metric_keys: METRIC_KEYS,
    }),
  );
  for (const b of report.builds) {
    lines.push(JSON.stringify({ type: 'build-metrics', ...b }));
  }
  lines.push(JSON.stringify({ type: 'window-30d-summary', ...report.window30d }));
  return lines.join('\n') + '\n';
}

process.exit(main(process.argv));
