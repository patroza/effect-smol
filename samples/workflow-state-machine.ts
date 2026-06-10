/**
 * Modelling a durable, resumable state machine with `effect/unstable/workflow`.
 *
 * The example pushes an order through 4 states:
 *
 *   Validated -> PaymentReceived* -> Shipped -> Delivered*
 *
 * where `*` means the workflow first awaits an external event via a
 * `DurableDeferred` before recording the new state.
 *
 * Key ideas:
 *
 *  - The workflow body is REPLAYED top-to-bottom on every resume (e.g. after a
 *    server restart). It must be deterministic, so every side effect and every
 *    state transition lives inside an `Activity`. Completed activities are not
 *    re-run on replay — their persisted result is returned instead.
 *
 *  - Awaiting an external event uses `DurableDeferred.await`, which SUSPENDS the
 *    workflow (the execution is parked, no busy-polling). It survives restarts
 *    and only resumes when someone calls `DurableDeferred.done` with the token.
 *
 *  - The token is derived deterministically from
 *    (workflow name, executionId, deferred name), so the external caller can
 *    recompute it from the original payload — nothing needs to be stashed.
 */
import { Context, Effect, Exit, Layer, Schema } from "effect"
import { Activity, DurableDeferred, Workflow } from "effect/unstable/workflow"

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

const OrderState = Schema.Literals([
  "Validated",
  "PaymentReceived",
  "Shipped",
  "Delivered"
])
type OrderState = typeof OrderState.Type

class PaymentError extends Schema.ErrorClass<PaymentError>("PaymentError")({
  message: Schema.String
}) {}

// Your own persistence of the object's materialized state (a read model). The
// workflow engine already persists activity results; this store exists so the
// rest of your system can observe the order's current state.
class OrderStore extends Context.Service<OrderStore>()("OrderStore", {
  make: Effect.succeed({
    setState: (orderId: string, state: OrderState) =>
      Effect.log(`order ${orderId} -> ${state}`)
  })
}) {
  static readonly layer = Layer.effect(OrderStore, this.make)
}

// ---------------------------------------------------------------------------
// Durable deferreds for the 2 awaited states
// ---------------------------------------------------------------------------

const PaymentReceived = DurableDeferred.make("PaymentReceived", {
  success: Schema.Struct({ paymentId: Schema.String }),
  error: PaymentError
})

const DeliveryConfirmed = DurableDeferred.make("DeliveryConfirmed", {
  success: Schema.Struct({ signedBy: Schema.String })
})

// ---------------------------------------------------------------------------
// Workflow definition
// ---------------------------------------------------------------------------

const OrderWorkflow = Workflow.make({
  name: "OrderWorkflow",
  payload: {
    orderId: Schema.String,
    customer: Schema.String
  },
  success: Schema.Struct({
    orderId: Schema.String,
    signedBy: Schema.String
  }),
  error: PaymentError,
  // Stable idempotency key -> deterministic executionId. Executing twice with
  // the same orderId targets the same running workflow.
  idempotencyKey: (payload) => payload.orderId
})

const OrderWorkflowLayer = OrderWorkflow.toLayer(
  Effect.fnUntraced(function*(payload) {
    const store = yield* OrderStore

    // One activity per state transition: run-once and persisted, so replay
    // skips already-completed transitions.
    const transition = (name: string, state: OrderState) =>
      Activity.make({
        name,
        execute: store.setState(payload.orderId, state)
      })

    // STATE 1 — validate (pure activity)
    yield* transition("Validated", "Validated")

    // STATE 2 — wait for external payment webhook, then record the state.
    // `await` suspends the workflow until `DurableDeferred.done` is called.
    // On restart this stays suspended; no polling, no wasted resources.
    const payment = yield* DurableDeferred.await(PaymentReceived)
    yield* transition("PaymentReceived", "PaymentReceived")
    yield* Effect.log(`order ${payload.orderId} paid via ${payment.paymentId}`)

    // STATE 3 — ship (wrap any external call in an activity to make it durable)
    yield* transition("Shipped", "Shipped")

    // STATE 4 — wait for delivery confirmation, then record the state.
    const delivery = yield* DurableDeferred.await(DeliveryConfirmed)
    yield* transition("Delivered", "Delivered")

    return { orderId: payload.orderId, signedBy: delivery.signedBy }
  })
).pipe(Layer.provide(OrderStore.layer))

// ---------------------------------------------------------------------------
// Completing the deferreds from the outside (e.g. webhook handlers)
//
// These can run in any process. The token is recomputed from the original
// payload, so the workflow never has to expose or store it.
// ---------------------------------------------------------------------------

const onPaymentWebhook = (
  orderId: string,
  customer: string,
  paymentId: string
) =>
  Effect.gen(function*() {
    const token = yield* DurableDeferred.tokenFromPayload(PaymentReceived, {
      workflow: OrderWorkflow,
      payload: { orderId, customer }
    })
    yield* DurableDeferred.done(PaymentReceived, {
      token,
      exit: Exit.succeed({ paymentId })
    })
  })

const onDeliveryConfirmed = (
  orderId: string,
  customer: string,
  signedBy: string
) =>
  Effect.gen(function*() {
    const token = yield* DurableDeferred.tokenFromPayload(DeliveryConfirmed, {
      workflow: OrderWorkflow,
      payload: { orderId, customer }
    })
    yield* DurableDeferred.done(DeliveryConfirmed, {
      token,
      exit: Exit.succeed({ signedBy })
    })
  })

// ---------------------------------------------------------------------------
// Kicking it off
// ---------------------------------------------------------------------------
//
// const result = yield* OrderWorkflow.execute({ orderId: "order-123", customer: "alice" })
//
// What happens on restart:
//   1. Server dies while the workflow is parked at `await PaymentReceived`.
//   2. On boot, the engine resumes execution "order-123".
//   3. The body replays from the top: the `Validated` activity is NOT re-run —
//      its persisted result is returned. Execution reaches `await PaymentReceived`
//      again; if `done` hasn't been called it suspends once more, otherwise it
//      loads the result and continues.
//
// Notes:
//   - `done` may be called before the workflow reaches `await`; the engine
//     stores the result and the later `await` picks it up. No race.
//   - Make external-effecting activities idempotent: a crash mid-activity
//     re-runs it on resume.
//   - For timed waits (not external events) use `DurableClock.sleep` inside an
//     activity instead of a deferred.
//   - To park (instead of crash) on failure, annotate the workflow with
//     `Workflow.SuspendOnFailure(true)` and later `OrderWorkflow.resume(executionId)`.

export {
  DeliveryConfirmed,
  onDeliveryConfirmed,
  onPaymentWebhook,
  OrderWorkflow,
  OrderWorkflowLayer,
  PaymentReceived
}
