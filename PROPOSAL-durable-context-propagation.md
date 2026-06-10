# Proposal: Propagate request context across the durable boundary (Workflow + Entity)

## Summary

Make ambient **request context travel with durable executions** the same way it
already travels with non-durable RPCs — via request **headers** + `RpcMiddleware`.

Entities already persist headers and run middleware across the durable boundary,
so context propagation works there today (if a little manually). Workflows do
**not**: `ClusterWorkflowEngine` hard-codes `headers: Headers.empty` when it runs
the workflow body, so every bit of ambient context (auth principal, tenant /
store id, locale, feature flags, trace baggage) is lost the moment you call
`workflow.execute`. The only workaround is to fold that context into every
workflow's payload schema by hand.

This proposal closes the gap and unifies the story:

- **A (core fix):** `Workflow.execute` captures headers (explicit + ambient
  `RpcClient.CurrentHeaders`), the engine persists them and sets them on the
  `run` / `activity` / `resume` / clock envelopes instead of `Headers.empty`,
  and the workflow body can read them back (deterministically, because headers
  are already persisted by `MessageStorage`).
- **B (unification):** allow attaching `RpcMiddleware` to a `Workflow` (forwarded
  to the internal `run` entity rpc), so the *same* middleware that provides
  services from headers on an entity also works on a workflow.
- **C (ergonomics, optional):** a small reusable middleware constructor that
  relays a single `Context` service value through a header — encode on the
  client, decode + provide on the server — since everyone reimplements this.

## Motivation / real-world evidence

We hit this in a production app (warehouse scanner) that runs durable packing /
printing workflows on cluster, and needs end-to-end (E2E) test flags, tenant id,
and locale to reach the worker. Because there is no first-class mechanism we had
to hand-roll two wrappers:

- A `Workflow.make` wrapper that injects a `context: { storeId, locale, e2eFlags }`
  field into every payload and re-provides those services in `toLayer`. The
  context leaks into `idempotencyKey`, the payload schema, and persisted message
  decoding (a breaking schema change every time the context shape changes).
- An `Entity` wrapper that sets an `x-e2e-flags` header on the client and reuses
  our existing HTTP `RpcMiddleware` to decode it on the worker.

The entity wrapper is ~20 lines and rides entirely on existing primitives — good
evidence the entity side only needs *ergonomics*. The workflow wrapper is the
painful one, purely because the engine refuses to carry headers.

## Current state (precise)

Propagation primitive already exists and is used by `RpcClient`:

```ts
// packages/effect/src/unstable/rpc/RpcClient.ts:812
export const CurrentHeaders = Context.Reference<Headers.Headers>(
  "effect/rpc/RpcClient/CurrentHeaders", { defaultValue: () => Headers.empty }
)
// each outgoing request merges CurrentHeaders + per-call headers (RpcClient.ts:381, :489)
```

Entity side (works today):

- `Entity.Request.headers: Headers.Headers` is delivered to handlers
  (`Envelope.ts:84`, `RpcServer.ts:259`).
- Headers are **persisted**: `SqlMessageStorage` writes
  `headers: JSON.stringify(envelope.headers)` and reads them back, so they
  survive the durable boundary and replay.
- The cluster builds an `RpcServer` per entity from `entity.protocol`
  (`internal/entityManager.ts`), so any `RpcMiddleware` attached to an rpc runs
  with the (persisted) request headers — including across replay.

Workflow side (broken):

```ts
// packages/effect/src/unstable/cluster/ClusterWorkflowEngine.ts:168-185
const payload = (options.rpc.payloadSchema as any).make(options.payload)
const envelope = Envelope.makeRequest<any>({
  ...,
  payload,
  headers: Headers.empty,   // <-- ambient context dropped here
})
```

- `Workflow.execute(payload, { discard? })` has no `headers` option
  (`Workflow.ts:80`).
- `Workflow.toLayer((payload, executionId) => ...)` never sees headers
  (`Workflow.ts:123`).
- The internal `run` rpc is `Persisted` + `Uninterruptible`
  (`ClusterWorkflowEngine.ts:687`), so if we *did* set headers on its envelope
  they would be persisted and replay-stable — exactly what determinism needs.

## Proposal

### Part A — Workflow header propagation (core)

1. **Capture at execute.** Extend `Workflow.execute` (and `executionId` stays
   pure) to accept headers and default to the ambient ones:

   ```ts
   readonly execute: <Discard extends boolean = false>(
     payload: Payload["~type.make.in"],
     options?: { readonly discard?: Discard; readonly headers?: Headers.Input }
   ) => Effect.Effect<...>
   ```

   At execution time merge `RpcClient.CurrentHeaders` (ambient, already populated
   for nested RPC calls) with the explicit `headers`. This means apps that
   already propagate headers via `RpcClient.withHeaders` get workflow propagation
   for free; others opt in explicitly.

2. **Persist + set on envelopes.** In `ClusterWorkflowEngine`, thread the
   captured headers into the `run` envelope (replace `Headers.empty` at line
   174) and the child `activity` / `resume` / clock envelopes. They are already
   persisted by `MessageStorage`, so they are restored verbatim on replay →
   deterministic.

3. **Expose in the body.** The `run` handler already has `request.headers`
   (`ClusterWorkflowEngine.ts:355`). Surface it to user code. Two options:
   - **(preferred) a service:** add `headers` to `WorkflowEngine.WorkflowInstance`
     (already provided into the body) and/or a `Workflow.CurrentHeaders`
     reference, so activities and nested executes can read/propagate it.
   - **(or) widen `toLayer`:** `toLayer((payload, executionId, headers) => ...)`.

   The service approach composes better (activities + nested workflows inherit
   it without re-threading), so it is preferred.

### Part B — `RpcMiddleware` on workflows (unification)

Let a workflow declare middleware that is forwarded to its internal `run` rpc:

```ts
Workflow.make({ name, payload, success, error, idempotencyKey })
  .middleware(TenantContext)   // an RpcMiddleware.Tag, same as on entities
```

Because the workflow body already runs as an entity rpc, this is mostly
plumbing `middleware` onto `makeWorkflowEntity`'s `run` rpc and surfacing the
middleware services in `toLayer`'s requirement set. The payoff: the identical
"decode header → `provideService`" middleware works for **non-durable RPC,
entity RPC, and workflow** with no per-call code.

### Part C — generic header⇄service relay (ergonomics, optional)

Most uses of A/B are "carry one `Context` value across the wire." Ship a
constructor so nobody hand-writes encode/decode/provide again:

```ts
// sketch
export const headerContext = <Self, Service, A>(options: {
  readonly tag: Context.Tag<Service, A>
  readonly header: string
  readonly schema: Schema.Schema<A, string>
  readonly allow?: Effect.Effect<boolean>   // e.g. gate on env !== "prod"
}): {
  readonly middleware: RpcMiddleware.Tag<Self, { provides: Service }>
  readonly layerServer: Layer.Layer<Self>   // decode header -> provideService
  readonly layerClient: Layer.Layer<...>     // read Service -> set header
}
```

This is exactly the `E2EFlags` pattern generalized; it makes A and B
two-liners at call sites.

## Determinism & backwards compatibility

- **Deterministic:** headers are persisted with the `run` envelope and restored
  on replay; the body reads the same `request.headers` every time. No wall-clock
  / random involved.
- **Backwards compatible:** `headers` defaults to empty (current behavior). No
  signature is removed; the new `execute` option and `.middleware` are additive.
  `toLayer` keeps its 2-arg form (the service approach in A.3 avoids a breaking
  signature change).

## Alternatives considered

- **Fold context into the payload (status quo workaround).** Verbose, leaks into
  `idempotencyKey` and persisted schema, breaks message decoding on every context
  change, and doesn't compose with the existing header/middleware machinery.
- **A workflow-specific context channel separate from headers.** Rejected:
  entities already standardize on headers + middleware; a second mechanism would
  fragment the model. Headers are the right shared vehicle.

## Suggested PR breakdown

1. **PR 1 (A):** `execute` headers option + merge `CurrentHeaders`; engine sets
   headers on `run`/`activity`/`resume`/clock envelopes; expose
   `WorkflowInstance.headers` / `Workflow.CurrentHeaders`. Tests: a workflow that
   reads a header set at execute, across suspend/resume and replay.
2. **PR 2 (B):** `Workflow.middleware(...)` forwarded to the `run` rpc; surface
   middleware services in `toLayer`. Tests: an `RpcMiddleware` providing a service
   from a header to a workflow body + activity.
3. **PR 3 (C):** `headerContext` (or similarly named) relay constructor + docs.

## Open questions

- Naming: `Workflow.CurrentHeaders` vs `WorkflowInstance.headers` vs both.
- Should `execute` *always* merge `CurrentHeaders`, or only when opted in? (Lean:
  always merge — matches `RpcClient` semantics.)
- Header redaction: reuse `Headers.CurrentRedactedNames` for persisted workflow
  headers so secrets aren't written to `MessageStorage` in the clear.
- Do child workflows (`payloadParentKey` path) inherit parent headers by default?
  (Lean: yes, unless overridden.)
