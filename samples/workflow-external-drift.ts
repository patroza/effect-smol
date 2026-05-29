/**
 * Handling EXTERNAL state drift — when the world mutates the objects a workflow
 * already touched in earlier steps.
 *
 * A durable workflow replays deterministically from cached activity results. An
 * activity caches the RESULT of a side effect, NOT the world. So while a
 * workflow is parked (a retry wait, a human approval, an awaited event), the
 * external system can move underneath it: inventory released, order cancelled,
 * address changed, price updated. On resume the workflow does NOT re-observe the
 * world for completed steps — it trusts the snapshot. That snapshot is now stale.
 *
 * The engine guarantees determinism, not freshness. You model freshness. This
 * sample combines the three defences:
 *
 *   1. RE-READ at point of use — a fresh activity reads current state right
 *      before the step that depends on it, instead of trusting an old cached read.
 *   2. VERSION-GUARDED write — the write activity is conditional on the current
 *      version (optimistic concurrency); a stale command is rejected by the store
 *      instead of clobbering a newer external change.
 *   3. COMPENSATION — `withCompensation` undoes earlier work (release the
 *      reservation) if the workflow ultimately fails because of drift.
 *
 * Also noted: cancellation as INTERRUPT (don't let a parked workflow wake and
 * proceed on dead assumptions).
 */
import { Cause, Context, Effect, Exit, Layer, Option, Schema } from "effect"
import { Activity, DurableClock, Workflow, WorkflowEngine } from "effect/unstable/workflow"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// Drift the workflow can detect itself (inventory gone while parked).
class InventoryError extends Schema.ErrorClass<InventoryError>("InventoryError")({
  message: Schema.String,
  transient: Schema.Boolean
}) {}

// Optimistic-concurrency conflict: the store moved past the version we expected.
class ConflictError extends Schema.ErrorClass<ConflictError>("ConflictError")({
  message: Schema.String,
  expected: Schema.Number,
  actual: Schema.Number
}) {}

const OrderError = Schema.Union([InventoryError, ConflictError])
type OrderError = typeof OrderError.Type

// ---------------------------------------------------------------------------
// Store — the authoritative, externally-mutable state. Carries a version so
// writes can be guarded. `shipIfVersion` is the optimistic-concurrency gate.
// ---------------------------------------------------------------------------

interface OrderRecord {
  version: number
  reserved: boolean
  available: boolean
  shipped: boolean
}

class OrderStore extends Context.Service<OrderStore>()("OrderStore", {
  make: Effect.sync(() => {
    const orders = new Map<string, OrderRecord>()
    const get = (id: string) => {
      let r = orders.get(id)
      if (!r) {
        r = { version: 1, reserved: false, available: true, shipped: false }
        orders.set(id, r)
      }
      return r
    }
    return {
      // fresh read of current state (NOT cached across steps)
      snapshot: (id: string) =>
        Effect.sync(() => {
          const r = get(id)
          return { version: r.version, available: r.available, reserved: r.reserved }
        }),
      reserve: (id: string) =>
        Effect.sync(() => {
          const r = get(id)
          r.reserved = true
          r.version++
        }),
      release: (id: string) =>
        Effect.sync(() => {
          const r = get(id)
          r.reserved = false
          r.version++
        }),
      // GUARDED write: only ships if the caller's expected version still holds.
      shipIfVersion: (id: string, expected: number) =>
        Effect.gen(function*() {
          const r = get(id)
          if (r.version !== expected) {
            return yield* new ConflictError({
              message: `version moved for ${id}`,
              expected,
              actual: r.version
            })
          }
          if (!r.available) {
            return yield* new InventoryError({
              message: `inventory gone for ${id}`,
              transient: false
            })
          }
          r.shipped = true
          r.version++
        }),
      log: (id: string, step: string) => Effect.log(`order ${id}: ${step} ✓`),
      // --- test seams: simulate an external actor mutating a parked order ---
      externalRelease: (id: string) =>
        Effect.sync(() => {
          const r = get(id)
          r.reserved = false
          r.available = false
          r.version++
        })
    }
  })
}) {
  static readonly layer = Layer.effect(OrderStore, this.make)
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

const OrderWorkflow = Workflow.make({
  name: "OrderWorkflow",
  payload: {
    orderId: Schema.String
  },
  success: Schema.Struct({ orderId: Schema.String }),
  error: OrderError,
  idempotencyKey: (payload) => payload.orderId
})

const OrderWorkflowLayer = OrderWorkflow.toLayer(
  Effect.fnUntraced(function*(payload) {
    const store = yield* OrderStore
    const id = payload.orderId

    const step = (name: string) =>
      Activity.make({ name, execute: store.log(id, name) })

    // STEP 1 — validate
    yield* step("1-Validated")

    // STEP 2 — reserve inventory, WITH COMPENSATION. If the workflow later
    // fails (e.g. drift detected at ship), this releases the reservation.
    // Compensation is registered on the top-level workflow effect (not nested
    // activities), so we attach it to the activity yielded here.
    yield* Activity.make({
      name: "2-Reserve",
      execute: store.reserve(id)
    }).pipe(
      OrderWorkflow.withCompensation((_value, cause) =>
        Effect.gen(function*() {
          yield* Effect.logWarning(`compensating reserve for ${id}: ${Cause.pretty(cause)}`)
          yield* store.release(id)
        })
      )
    )

    // --- PARK. A retry wait / approval / awaited event goes here. While parked,
    // an external actor may release or sell the inventory out from under us. ---
    yield* DurableClock.sleep({ name: "settle", duration: "1 day" })

    // STEP 3 — RE-READ current state in a FRESH activity. The step-2 snapshot is
    // a day old and not trustworthy; this reads the world as it is now.
    const live = yield* Activity.make({
      name: "3-RecheckState",
      success: Schema.Struct({ version: Schema.Number, available: Schema.Boolean, reserved: Schema.Boolean }),
      execute: store.snapshot(id)
    })
    if (!live.available || !live.reserved) {
      // drift detected -> fail -> compensation (step 2) releases the reservation
      return yield* new InventoryError({
        message: `state drifted while parked (available=${live.available}, reserved=${live.reserved})`,
        transient: false
      })
    }

    // STEP 4 — GUARDED write. Pass the freshly-read version; the store rejects
    // the ship if anything bumped the version since we re-read it. This closes
    // the race between the recheck above and the write here.
    yield* Activity.make({
      name: "4-Ship",
      error: OrderError,
      execute: store.shipIfVersion(id, live.version)
    })

    return { orderId: id }
  })
).pipe(Layer.provide(OrderStore.layer))

// ---------------------------------------------------------------------------
// Cancellation — model an external "cancel" as an INTERRUPT, not a flag the
// workflow reads later. Interrupt runs finalizers + compensations; the parked
// workflow never wakes to act on dead assumptions.
// ---------------------------------------------------------------------------

const cancelOrder = (orderId: string) =>
  Effect.gen(function*() {
    const executionId = yield* OrderWorkflow.executionId({ orderId })
    yield* OrderWorkflow.interrupt(executionId)
  })

// ---------------------------------------------------------------------------
// Helper reused from the retry sample — kept here so this file stands alone.
// Re-attempt a transient-failing activity with a durable wait between tries.
// ---------------------------------------------------------------------------

const durableRetry = <S extends Schema.Top, E extends Schema.Top, R>(
  activity: Activity.Activity<S, E, R>,
  options: {
    readonly times: number
    readonly delay: Parameters<typeof DurableClock.sleep>[0]["duration"]
    readonly while: (error: E["Type"]) => boolean
  }
): Effect.Effect<
  S["Type"],
  E["Type"],
  | R
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance
  | S["DecodingServices"]
  | E["DecodingServices"]
> =>
  Effect.gen(function*() {
    let attempt = 0
    while (true) {
      attempt++
      const exit = yield* Effect.exit(Effect.provideService(activity, Activity.CurrentAttempt, attempt))
      if (Exit.isSuccess(exit)) return exit.value
      const error = Cause.findErrorOption(exit.cause)
      const retryable = attempt < options.times && Option.isSome(error) && options.while(error.value)
      if (!retryable) return yield* exit
      yield* DurableClock.sleep({ name: `${activity.name}-retry-${attempt}`, duration: options.delay })
    }
  }) as any

// ---------------------------------------------------------------------------
// What happens
// ---------------------------------------------------------------------------
//
//   const fiber = yield* OrderWorkflow.execute({ orderId: "order-123" })
//
//   - steps 1-2 run + persist; reservation taken; workflow parks for "settle".
//   - EXTERNAL drift while parked, e.g.:
//       yield* store.externalRelease("order-123")   // sells the stock elsewhere
//   - on wake, step 3 (fresh re-read) sees available=false -> InventoryError ->
//     workflow fails -> step-2 compensation releases the (already-gone) reservation
//     cleanly. No stale "shipped" command is ever issued.
//
//   - No drift: step 3 confirms state, step 4 ships guarded by the live version.
//     If something nudged the version between step 3 and step 4, shipIfVersion
//     raises ConflictError instead of overwriting the newer state.
//
//   - Cancellation: `cancelOrder("order-123")` interrupts the parked execution;
//     compensation releases the reservation; the workflow never ships.
//
// Mental model:
//   - cache facts that are immutable;
//   - re-fetch facts that mutate (fresh activity at point of use);
//   - guard every write (optimistic version / idempotency);
//   - route external state changes through interrupt or a DurableDeferred.
// A parked workflow reacts to the world ONLY via interrupt or an awaited
// deferred — nothing else.

export {
  cancelOrder,
  ConflictError,
  durableRetry,
  InventoryError,
  OrderError,
  OrderWorkflow,
  OrderWorkflowLayer
}
