# Interview walkthrough

This project is easiest to explain as a reliability layer between an unreliable messaging gateway, an unreliable tool-calling Agent and an operator console. The strongest demo is not the number of pages: it is the fact that failure claims are executable and leave durable evidence.

## A 7-minute walkthrough

1. Open **运行总览** and show that account actions depend on the current state. Explain that transitions use compare-and-set updates, so two operators cannot silently overwrite one another.
2. Open a group and send a normal message. Point out the persisted `queued → accepted → sent` lifecycle and the stable timeline cursor.
3. Open **可靠性实验室**. Run S2, S5 and S6. Each button configures the mocks, injects a real event and waits for the normal workers; the UI then presents evidence read from PostgreSQL and the mock gateway.
4. Open the group again and inspect the Agent steps. Show the raw response, validated tool call, audit result and tool result rather than only the final reply.
5. Stop and restart the API if time permits. Queued messages, SSE cursor, Agent runs and experiment evidence remain because correctness state is in PostgreSQL.

The top navigation also links to **API 文档**. The Swagger UI is generated from the same Zod schemas used for runtime request validation and TypeScript inference. This is an executable contract rather than a separately maintained document; `/docs/json` can be imported into Postman or other OpenAPI tooling.

## The three strongest talking points

### 1. S2: an event may arrive twice, but the business action happens once

The mock gateway deliberately emits the same SSE event twice. The API stores the gateway event ID in a durable inbox under a unique constraint, and message identity also has a database uniqueness boundary. The experiment passes only when the timeline contains one message and exactly one Agent run was created.

This is stronger than an in-memory `Set`: a restart or a second API instance does not forget what was processed.

### 2. S5: timeout does not mean failure

A gateway `504` creates an ambiguous result: resending immediately may duplicate a message that actually landed. Group Message Manager keeps its own message identity first, queries the gateway by `clientMsgId`, and retries only after reconciliation says the message is absent.

At the Agent boundary, `(run_id, idempotency_key)` maps to one local message. If the Agent calls `send_message` again with the same key, Group Message Manager returns the existing delivery result. It does not create a second message and does not repeat the audit. The experiment proves four independent facts: two tool calls, one audit, one idempotency mapping and one gateway message.

### 3. S6: treat model output as hostile input

The Agent is outside the trust boundary. Every response is parsed through a runtime schema; tools have their own input schemas; unknown tools return structured errors; raw responses and steps are retained. A bounded protocol-error budget lets a run recover from a transient malformed response without looping forever.

The experiment intentionally returns malformed JSON, then an unknown tool, then a valid `finish`. Passing requires both errors to be visible in the run history and the run to finish cleanly.

## Architecture choices worth defending

- **One lightweight monorepo:** API, web and mocks are independently buildable, while a shared contracts package prevents API/type drift. For a take-home with atomic frontend/backend changes this is easier to review than two repositories and less ceremony than Nx/Turborepo.
- **PostgreSQL before Kafka:** the required scale does not justify a broker. Row leases, `FOR UPDATE SKIP LOCKED`, partial unique indexes and persisted cursors provide durable coordination with fewer moving pieces. A broker becomes reasonable when throughput or independent consumers demand it.
- **Not multi-tenant by assumption:** the assignment asks for multiple managed service accounts, not multiple customer organizations. Inventing tenant isolation without a requirement would broaden every key, authorization rule and migration. The current boundaries leave room to add `tenant_id` deliberately later.
- **Explicit migrations:** deployment runs migrations as a separate step. The API refuses to start against an older schema, avoiding a half-upgraded process. Migrations are not silently executed by every replica at startup.
- **Demo endpoints are a boundary:** `/api/demo/*` and mock control calls exist only when `DEMO_MODE=true`. They make the take-home reproducible without mixing fault injection into production business endpoints.

## Honest scope

The implementation completes the A-group core and the selected B-group extensions documented in the README: scheduled sequences, group lifecycle recovery, rotating refresh sessions, and persisted WebSocket replay. The intentionally omitted scope is C1 media localization, C2 a real LLM adapter, and C3 Playwright E2E coverage. If more time were available, the next engineering step would be deeper PostgreSQL crash-point integration coverage and batched, per-account-fair worker claiming—not placeholder C-group endpoints.
