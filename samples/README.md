# Workflow samples — `effect/unstable/workflow`

Runnable, heavily-commented examples for modelling durable, resumable processes
with `Workflow` / `Activity` / `DurableDeferred` / `DurableClock`.

Typecheck them all:

```sh
npx tsc -p samples/tsconfig.json --noEmit
```

## Samples

| File | Shows |
|---|---|
| [`workflow-state-machine.ts`](./workflow-state-machine.ts) | Durable, resumable state machine. One activity per state transition; awaits external events via `DurableDeferred`; tokens recomputed from payload (nothing stashed). |
| [`workflow-durable-retry.ts`](./workflow-durable-retry.ts) | Auto "retry tomorrow". `durableRetry` parks the workflow on `DurableClock.sleep` between attempts and re-runs the step on a fresh attempt. |
| [`workflow-park-for-human.ts`](./workflow-park-for-human.ts) | Operator-gated retry. `retryWithApproval` parks on a per-attempt `DurableDeferred` until a human approves retry or aborts. Plus the `SuspendOnFailure` caveat. |
| [`workflow-external-drift.ts`](./workflow-external-drift.ts) | External state drift. Re-read at point of use + version-guarded write + compensation + cancellation-as-interrupt. |

## Findings — the mental model

These samples exist because the durable-execution mechanics are easy to get
wrong. The engine guarantees **determinism**, not **freshness**.

### Replay & caching

- A workflow body is **replayed top-to-bottom** on every resume. It must be
  deterministic — every side effect lives inside an `Activity`.
- An activity result is cached by `executionId / activityName / attempt`. On
  replay a completed activity is **not re-run** — its persisted result is returned.
- One workflow = **one durable execution** (stable `idempotencyKey`). Reuse the
  execution to continue; a new `idempotencyKey` is a new execution that re-runs
  **everything**. Never start a new run just to "retry".

### Errors & retry

- An uncaught error makes the execution **terminal**: the failure `Exit` is
  persisted, and re-executing the same id just replays that failure.
- Re-running a failed step requires a **new attempt number** — a cached failed
  attempt replays its failure. Both retry helpers drive `Activity.CurrentAttempt`
  from a **replay-stable loop index**.
- "Wait until tomorrow" must be **durable**: `DurableClock.sleep` (timed) or
  `DurableDeferred.await` (external event). Never `Effect.sleep` /
  `Activity.retry`'s in-memory schedule for long waits — they die with the process.
- Don't go terminal for transient errors: catch in-loop, park, retry; let
  permanent errors escape.
- `Workflow.SuspendOnFailure` parks the whole workflow on any uncaught error, but
  does **not** retry the failed step on its own (the cached failure replays).
  Use it as a safety net for unexpected defects, paired with a fresh-attempt
  mechanism for the step that should actually re-run.

### External state drift

An activity caches the **result of a side effect, not the world**. While a
workflow is parked, external systems mutate the objects earlier steps touched.
On resume the workflow trusts its snapshot — which is now stale. Defences:

| Activity kind | Risk | Rule |
|---|---|---|
| Read for a *later* decision | stale snapshot | re-read in a fresh activity at point of use |
| Write / command | clobber newer state | idempotent + version-guarded (optimistic concurrency) |
| Long hold (reservation) | released externally | re-assert before use, or have external release send an interrupt/event |
| Expected external change | drift | model as `DurableDeferred`, not a cached read |

- Cancellation = **interrupt** (`Workflow.interrupt`), not a flag read later —
  so a parked workflow never wakes and acts on dead assumptions. Interrupt runs
  finalizers + compensations.
- `Workflow.withCompensation` undoes earlier work on workflow failure (saga). It
  applies to **top-level** workflow effects only, not nested activities.

### One-line rules of thumb

- Cache facts that are immutable; re-fetch facts that mutate.
- Guard every write (optimistic version / idempotency key).
- Route external state changes through **interrupt** or a **`DurableDeferred`**.
- A parked workflow reacts to the world only via interrupt or an awaited
  deferred — nothing else.
