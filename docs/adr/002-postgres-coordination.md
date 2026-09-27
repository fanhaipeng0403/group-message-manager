# ADR 002: PostgreSQL as persistence and coordinator

## Decision

Use PostgreSQL rows, leases, transactions and unique indexes for background work instead of adding Redis or Kafka.

## Why

The workload is modest, every task must survive restart, and most state transitions already require database transactions. A second durability system would add failure modes without improving the assignment's guarantees.

## Trade-off

This is not intended for very high event throughput. If gateway volume grows beyond PostgreSQL worker capacity, the durable inbox/outbox boundaries allow a broker to be introduced later.
