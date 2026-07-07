---
name: logging-observability
description: Use when adding logging, metrics, or instrumentation — structured logging, correlation IDs, log levels, lifecycle-event emission, counters, or deciding what to log where. What to emit, at which level, at which point in the code, and what must never be logged.
---

# Logging and observability

A log line is an API for future debugging sessions. Unstructured, mis-levelled, or lying logs are worse than none — they burn the reader's trust exactly when it matters.

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

## Tests

- Log-based assertions in tests are brittle — they pin message text and emission order that legitimately change. Assert on state (the row, the return value, the recorded call); reserve log assertions for contracts where the log line IS the product (audit trails, machine-scraped summaries).

Failure-path-specific observability (audit rows in-transaction, failure-summary constants, drift detectors, truncation warnings): see the fail-loud skill.
