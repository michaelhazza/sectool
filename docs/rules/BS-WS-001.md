# BS-WS-001 — socket.io handler without auth handshake middleware

**Engine:** ts-morph
**Base severity:** high
**vulnClass:** auth-access-control

## What it flags

`io.on('connection', handler)` and `io.of(namespace).on('connection', handler)`
calls where no auth/JWT middleware appears in a corresponding `io.use(...)` or
`io.of(namespace).use(...)` call within the same source file.

Recognized auth middleware names include: `authenticate`, `verifyToken`,
`jwtMiddleware`, `socketAuth`, `wsAuth`, `verifySocketToken`, and any identifier
containing `auth`, `jwt`, `verify`, or `token`.

## Why it matters

A socket.io `connection` event handler without handshake authentication allows
any unauthenticated WebSocket client to connect and interact with the server.
Unlike HTTP routes, there is no browser same-origin restriction on WebSocket
handshakes, making unauthenticated socket endpoints accessible from any origin.

## Fix pattern

Register an auth middleware on the socket.io server before accepting connections:

```ts
// Vulnerable
io.on('connection', (socket) => {
  socket.on('message', handleMessage);
});

// Safe: auth middleware via io.use() before connection
import { verifyToken } from './auth.js';

io.use(verifyToken);
io.on('connection', (socket) => {
  socket.on('message', handleMessage);
});
```

For namespace-scoped servers:

```ts
const adminNs = io.of('/admin');
adminNs.use(verifyToken);
adminNs.on('connection', (socket) => { ... });
```

## Acceptance criteria

The finding must no longer fire on re-scan: `ruleId: BS-WS-001` with the same
fingerprint must be absent from the next `audit run` output.

## Fixture

- Vulnerable: `benchmark/corpus/static/BS-WS-001/vulnerable/`
- Clean: `benchmark/corpus/static/BS-WS-001/clean/`
