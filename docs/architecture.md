# Architecture

Group Message Manager is a lightweight pnpm monorepo containing four independently runnable applications and one contract package.

```text
React console ── REST / WebSocket ── API ── HTTP / SSE ── mock gateway
                                      └──── tool protocol ── mock agent
                         │
                    PostgreSQL
```

The API is intentionally the only application with database access. The mock services behave as external systems and cannot import API internals. `packages/contracts` contains communication schemas only; it does not expose repositories or business services.

## Reliability model

- Gateway SSE delivery is at-least-once. Raw events are persisted in `gateway_events` before business effects are applied.
- Outbound messages are persisted before calling the gateway. An `inflight` dispatch marker distinguishes a local queue item from an uncertain external effect.
- A crashed inflight send becomes `unknown` and is reconciled through the gateway's by-client-id endpoint before any retry.
- WebSocket events are stored in PostgreSQL before publication, so their sequence is monotonic and replayable.
- PostgreSQL partial unique indexes enforce one running Agent per group across API instances.
