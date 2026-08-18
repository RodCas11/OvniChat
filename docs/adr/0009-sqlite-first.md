# ADR 0009: SQLite first

## Status

Accepted for the T0 foundation. SQLite is the intended first persistence adapter; T0 contains no
application schema, driver, migration, or database behavior.

## Context

The first self-hosted realtime service needs durable text-channel and message state without making a
separate database service a prerequisite for a small installation. The design must still leave a
credible path to a client/server database if measured concurrency or availability needs exceed a
single-node SQLite deployment.

## Decision

**Accepted:** use SQLite first for text channels, messages, and basic server configuration when T7
introduces persistence. Keep the database with the realtime service and place it behind a narrow
storage boundary shaped by domain operations and required transactions. The boundary must not leak
SQLite primitives or pretend to be a lowest-common-denominator PostgreSQL API.

**Hypotheses, not accepted implementation:** driver, query builder or ORM, schema, identifiers,
migration tooling, journal/synchronous settings, busy handling, retention, database path, encryption,
backup procedure, and the threshold or process for moving to PostgreSQL remain T7 decisions backed
by tests and operational evidence.

## Consequences

- A small deployment needs no separately operated database server and can back up one explicitly
  owned database artifact.
- The realtime service owns migrations, integrity checks, transactional correctness, safe shutdown,
  backup/restore documentation, and recovery tests.
- SQLite's single-writer and single-node characteristics may limit write concurrency and high
  availability. Measurements, not speculative portability layers, will trigger reassessment.
- A later adapter is possible, but migration will still require deliberate schema, data, transaction,
  and operational work.

## Alternatives

- **PostgreSQL from the first persistent slice:** rejected for the initial small self-hosted target
  because it adds an operational prerequisite before evidence requires it.
- **In-memory or JSON-file persistence:** rejected because T7 requires transactional durable history,
  migrations, and reliable backup behavior.
- **A broad database-neutral abstraction designed in T0:** rejected because there are no real domain
  queries yet; T7 will derive the smallest useful boundary from implemented use cases.
