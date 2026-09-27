# Reliability invariants

| Invariant                                               | Enforcement                                                           |
| ------------------------------------------------------- | --------------------------------------------------------------------- |
| One gateway event produces at most one business effect  | `gateway_events.event_id` primary key and durable processing status   |
| One inbound message appears once                        | unique `(group_id, msg_id)`                                           |
| One local outbound intent has one identity              | unique `client_msg_id` created before gateway I/O                     |
| An uncertain 504 is never retried before reconciliation | `unknown` state plus by-client-id lookup                              |
| At most one running Agent exists per group              | partial unique index on `agent_runs(group_id)`                        |
| Agent sends are idempotent within a run                 | primary key `(run_id, idempotency_key)`                               |
| Terminal account cleanup is atomic                      | status, membership, queued messages and WS event use one transaction  |
| A pushed state is already committed                     | WS event is stored in the same transaction and published after commit |
| Cursor pagination is stable while new messages arrive   | keyset cursor `(sent_at, id)`                                         |

These properties are preferred over process-local locks because they continue to hold after restarts and with multiple API instances.
