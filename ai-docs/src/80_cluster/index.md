## Building distributed applications with cluster

The cluster modules let you model stateful services as entities and distribute
them across multiple machines.

### Operating SQL-backed cluster storage

When you persist cluster messages with the SQL-backed storage layer, plan for
the storage tables as part of normal production operations. The cluster stores
persisted entity requests, replies, durable workflow messages, durable clock
wakeups, and cron runs in SQL so that work can survive restarts and shard
movement.

The SQL storage is indexed for the main runtime lookups. In particular, stored
messages are queried by shard, processing state, recent read timestamp, and
delivery time, while replies are queried by request id. This keeps ordinary
polling focused on messages that are still eligible to be processed instead of
every historical row.

Those indexes are not a retention policy. Successful persisted requests are
marked as processed, but their message and reply rows remain in the tables.
Long-running clusters with many persisted cron jobs, entity messages, and
workflow executions should therefore expect table and index growth over time.
Failed, suspended, abandoned, or never-woken work can also remain unprocessed
and continue to be considered by storage polling after its read timeout expires.

For clusters that run for months, add operational checks around the storage
tables:

- Monitor row counts and index size for the cluster message and reply tables.
- Inspect unprocessed rows by shard and entity type when polling latency grows.
- Use database `EXPLAIN` / `EXPLAIN ANALYZE` with production-shaped data for the
  unprocessed-message query.
- Add an application-specific archival or deletion process for processed rows
  once they are no longer needed for idempotency, duplicate detection, or
  observability.
- Treat long-lived suspended workflows and stale durable clock messages as
  operational state that needs an owner, not as rows that will disappear on
  their own.

For high-volume deployments, validate the retention and polling behavior before
assuming a year-old cluster will behave like a fresh one. The storage layer is
durable first; production retention and historical cleanup should be designed
around your application's replay, audit, and idempotency requirements.
