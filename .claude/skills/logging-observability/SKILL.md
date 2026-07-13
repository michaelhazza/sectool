---
name: logging-observability
description: Use when adding logging, metrics, alerts, or instrumentation — structured logging, correlation IDs, log levels, lifecycle-event emission, counters, metric label design, alert thresholds, or deciding what to log where. What to emit, at which level, at which point in the code, what must never be logged, and how to design metrics and alerts that stay diagnosable.
---

> **Repo-specific addenda:** if `.claude/context/skill-context.md` exists and has a `## logging-observability` section, read it — it carries repo-specific failure modes, anti-patterns, and corrections for this skill.

# Logging and observability

A log line is an API for future debugging sessions. Unstructured, mis-levelled, or lying logs are worse than none — they burn the reader's trust exactly when it matters.

## Instrument to a question

- Telemetry without a question is noise. Before instrumenting a feature, write the 2-4 questions on-call will ask about it ("what fraction succeed after retry?", "when it fails permanently, why?", "is the provider slower than usual?") — every signal added must answer one of them. If the questions can't be named, the instrumentation will log everything and explain nothing.
- Signal selection: metrics say THAT something is wrong (aggregate rate/latency), traces say WHERE (which hop), logs say WHY (the specific case's fields). Don't answer an aggregate question with log lines or a per-case question with a counter.
- Instrumentation ships WITH the feature, not after — "after" becomes "after the first incident", the most expensive moment to discover you're blind.

## Structure

- Every log goes through the structured logger with correlating entity ids (tenant, run, job, request) and an outcome discriminator (`outcome: 'sent' | 'suppressed' | 'failed'`) — `console.*` writes outside the observability pipeline are never found.
- Stable, greppable event codes over prose: consumers filter on the code field; message text is for humans and free to change. Substring-matching on messages breaks on the first rewording — classify on the structured field the emitter owns.
- Correlation IDs propagate across queue/webhook/process boundaries IN THE PAYLOAD — a new context on the consumer side severs the trace exactly where the interesting failures live. The producer stamps it at enqueue; the consumer adopts it before its first log line.

## Levels

- Log levels carry intent: `error` = a human should act; `warn` = degraded but self-healing or needs eventual attention; `info` = lifecycle fact; `debug` = development detail. An `error` nobody would page on belongs at `warn` — level inflation trains operators to ignore the channel.
- One failure, one error log — logging the same exception at every layer of the call stack quadruples noise and makes one incident read as four.

## What never to log

- Never log secrets, tokens, credentials, or PII — including via object spreads of request/config objects that happen to contain them, and raw provider error bodies that echo token material. Route through the single redaction boundary: see the security-hardening skill.
- Durable/user-visible sinks get closed enums and counts, never verbatim upstream-derived strings — the producer's content hygiene is not the consumer's guarantee.

## Placement

- One log line per lifecycle transition, emitted at the state-transition choke-point, not per-caller — per-caller logging means the next caller silently doesn't log, and the choke-point line is the one consumers can rely on existing.
- Logs describing persisted state changes emit AFTER the write succeeds — a "flipped/reset" line before a failed write lies to every downstream observer. Log-then-act is only correct for attempt lines explicitly phrased as attempts.
- When an exit-code or status vocabulary can't carry all states, emit an always-present machine-scrapeable summary line per state — absence of a line is indistinguishable from "never ran".

## Metrics and events

- Counters/metrics bind to committed state, not emissions — count the durable row/transition, never the "about to do X" log line, or retries and rollbacks inflate the number (self-validating-detector and counting-predicate rules: see the ci-gate-integrity skill).
- Paired `*_started`/`*_completed` events need a stable identity on both ends; an end with no matching start is drop-and-warn, never paired to an unrelated open. Worst case must be under-count, never mis-attribution.
- Every metric names its unit in the name (`duration_ms`, `size_bytes`) — unitless numbers get mis-graphed and mis-alerted.
- Cardinality is THE metric failure mode: every unique label combination is a separate time series. Labels come only from small fixed sets (route template, `status_class: '5xx'` not `'503'`, provider name) — never user ids, raw URLs, request ids, or error message text; unbounded values belong in logs and traces.
- Request-driven surfaces get RED per endpoint and per external dependency (Rate, Errors, Duration); resources (queues, pools, workers) get USE (Utilization, Saturation, Errors — e.g. queue depth + processing duration per worker).
- Latency is a histogram read at p50/p95/p99, never an average — the average hides the 1% having a terrible time.
- Sampling: head-based at a low rate by default; keep 100% of errors when the backend supports tail sampling — sampled-away failures are the ones you'll be asked about.

## Alerting

- Alert on symptoms users feel (error rate, p99 latency, queue age), never on causes (CPU, disk, a pod restart) — cause alerts page when nothing is wrong and miss the failures nobody predicted; causes go to dashboards.
- Every alert must be actionable (if the response is "ignore, it self-heals", delete it), must link a runbook (even three lines: what it means, first query, escalation), and must justify its threshold and duration from an SLO or historical data, not a guess.
- Exactly two severities: page (user-facing, act now) and ticket (degraded, act this week). A third tier becomes noise that trains operators to ignore all of them.
- Test-fire every new alert once (temporarily lower the threshold) and confirm it reaches the right channel with a working runbook link — an alert that has never fired is untested code on the most critical path.

## Verify the telemetry itself

- Instrumentation is code and can be wrong. Before done: force a failure in staging and locate it by correlation id from telemetry alone, without reading source; confirm new metric series appear with the expected labels; confirm log fields are structured (not `[object Object]`).
- Pre-launch instrumentation gate for a new production surface: logs flowing, RED visible, at least one symptom alert test-fired, one request traceable end-to-end, and on-call knows where the runbook lives.

## Tests

- Log-based assertions in tests are brittle — they pin message text and emission order that legitimately change. Assert on state (the row, the return value, the recorded call); reserve log assertions for contracts where the log line IS the product (audit trails, machine-scraped summaries).

Failure-path-specific observability (audit rows in-transaction, failure-summary constants, drift detectors, truncation warnings): see the fail-loud skill.

> Instrument-to-a-question, RED/USE, cardinality, alerting, and telemetry-verification rules adapted from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) `observability-and-instrumentation` at commit `98967c4` (MIT licensed).
