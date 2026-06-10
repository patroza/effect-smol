/**
 * Durable, resumable retry of a failing step — "try again tomorrow" without
 * losing the steps already completed.
 *
 * Scenario: a 6-step order workflow. Step 4 (charge payment) hits a transient
 * error. We want to wait a day and try again, up to N times, WITHOUT re-running
 * steps 1-3 and without burning a process while we wait.
 *
 * Why the obvious approaches don't work
 * -------------------------------------
 *  - Starting a NEW workflow run (new idempotencyKey) re-runs everything. Wrong.
 *  - Letting the error escape makes the execution terminal: the failure Exit is
 *    persisted and re-executing the same id just replays that failure.
 *  - `Effect.retry` / `Activity.retry` sleep IN MEMORY — a day-long wait dies
 *    with the process and doesn't survive a restart.
 *  - Re-running the same activity is a no-op: an activity result is cached by
 *    `executionId / activityName / attempt`, so a failed attempt replays its
 *    failure. To actually re-run, the ATTEMPT number must change.
 *
 * The pattern
 * -----------
 * One workflow, one durable execution (stable idempotencyKey). A retry LOOP
 * where:
 *
 *   - the loop index feeds `Activity.CurrentAttempt`, so each try is a fresh
 *     cache key and the activity genuinely re-runs;
 *   - the wait between tries is `DurableClock.sleep`, which SUSPENDS the whole
 *     workflow (parked, no polling, survives restarts);
 *   - the loop index is replay-stable: on resume the body replays top-to-bottom,
 *     already-completed activities and already-elapsed clocks return instantly,
 *     so we land back at exactly the attempt we parked on.
 *
 * Net effect: steps 1-3 are never redone, step 4 retries once per day, and a
 * server restart mid-wait changes nothing.
 */
import { Cause, Context, type Duration, Effect, Exit, Layer, Option, Schema } from "effect"
import { Activity, DurableClock, Workflow, WorkflowEngine } from "effect/unstable/workflow"

// ---------------------------------------------------------------------------
// Generic helper: durable retry of a single Activity
// ---------------------------------------------------------------------------

/**
 * Re-attempt an `Activity` with a DURABLE delay between tries.
 *
 *  - Each attempt runs with a distinct `CurrentAttempt`, so the activity's
 *    persisted-result cache does not pin a previous failure.
 *  - Between attempts the workflow parks via `DurableClock.sleep` (durable,
 *    restart-safe). The clock name embeds the attempt so each wait caches
 *    independently and replay fast-forwards through elapsed ones.
 *  - Only failures matching `while` are retried; anything else (permanent
 *    business errors, defects, interrupts) propagates and stays terminal.
 */
const durableRetry = <S extends Schema.Top, E extends Schema.Top, R>(
  activity: Activity.Activity<S, E, R>,
  options: {
    readonly times: number
    readonly delay: Duration.Input
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
      const exit = yield* Effect.exit(
        Effect.provideService(activity, Activity.CurrentAttempt, attempt)
      )
      if (Exit.isSuccess(exit)) {
        return exit.value
      }
      const error = Cause.findErrorOption(exit.cause)
      const retryable = attempt < options.times &&
        Option.isSome(error) &&
        options.while(error.value)
      if (!retryable) {
        // out of attempts, or not a transient error -> terminal
        return yield* exit
      }
      yield* Effect.logWarning(
        `[${activity.name}] attempt ${attempt} failed, parking ${options.delay}`
      )
      // DURABLE wait. Unique name per attempt so each caches separately and
      // replay treats an already-elapsed wait as done.
      yield* DurableClock.sleep({
        name: `${activity.name}-retry-${attempt}`,
        duration: options.delay
      })
    }
  }) as any

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

class PaymentError extends Schema.ErrorClass<PaymentError>("PaymentError")({
  message: Schema.String,
  // a hint the caller sets so we know whether retrying tomorrow can help
  transient: Schema.Boolean
}) {}

class OrderStore extends Context.Service<OrderStore>()("OrderStore", {
  make: Effect.succeed({
    record: (orderId: string, step: string) => Effect.log(`order ${orderId}: ${step} ✓`)
  })
}) {
  static readonly layer = Layer.effect(OrderStore, this.make)
}

// stand-in for a flaky external payment gateway
class PaymentGateway extends Context.Service<PaymentGateway>()("PaymentGateway", {
  make: Effect.succeed({
    charge: (orderId: string) =>
      Effect.gen(function*() {
        const attempt = yield* Activity.CurrentAttempt
        if (attempt < 3) {
          return yield* new PaymentError({
            message: `gateway timeout for ${orderId} (attempt ${attempt})`,
            transient: true
          })
        }
        return { paymentId: `pay_${orderId}_${attempt}` }
      })
  })
}) {
  static readonly layer = Layer.effect(PaymentGateway, this.make)
}

// ---------------------------------------------------------------------------
// Workflow — 6 steps, the 4th retries durably
// ---------------------------------------------------------------------------

const OrderWorkflow = Workflow.make({
  name: "OrderWorkflow",
  payload: {
    orderId: Schema.String
  },
  success: Schema.Struct({ orderId: Schema.String, paymentId: Schema.String }),
  error: PaymentError,
  idempotencyKey: (payload) => payload.orderId
})

const OrderWorkflowLayer = OrderWorkflow.toLayer(
  Effect.fnUntraced(function*(payload) {
    const store = yield* OrderStore
    const gateway = yield* PaymentGateway

    // a plain step = its own activity, so replay skips it once done
    const step = (name: string) =>
      Activity.make({ name, execute: store.record(payload.orderId, name) })

    yield* step("1-Validated")
    yield* step("2-Reserved")
    yield* step("3-Invoiced")

    // STEP 4 — the flaky one. Wrapped so it parks a day and retries, instead of
    // failing the whole workflow. Steps 1-3 above stay cached across every park.
    const chargePayment = Activity.make({
      name: "4-ChargePayment",
      success: Schema.Struct({ paymentId: Schema.String }),
      error: PaymentError,
      execute: gateway.charge(payload.orderId)
    })
    const { paymentId } = yield* durableRetry(chargePayment, {
      times: 5,
      delay: "1 day",
      while: (e) => e.transient // only retry transient gateway errors
    })

    yield* step("5-Shipped")
    yield* step("6-Delivered")

    return { orderId: payload.orderId, paymentId }
  })
).pipe(Layer.provide([OrderStore.layer, PaymentGateway.layer]))

// ---------------------------------------------------------------------------
// What happens
// ---------------------------------------------------------------------------
//
//   const result = yield* OrderWorkflow.execute({ orderId: "order-123" })
//
//   day 0: steps 1-3 run + persist. Step 4 attempt 1 fails (transient) ->
//          DurableClock parks the execution for 1 day. Process is free.
//   day 1: engine wakes "order-123". Body replays: steps 1-3 return cached
//          results (NOT re-run), retry-1 clock is elapsed (instant), attempt 2
//          runs, fails -> park again.
//   day 2: same replay, attempt 3 succeeds -> steps 5-6 run -> workflow done.
//
//   Restart at any point during a park: identical replay, nothing redone.
//
// Permanent error (transient: false) or exceeding `times`: the failure escapes
// `durableRetry` and the workflow completes terminally with that error — which
// is the right outcome for "retrying tomorrow can't help".

export { OrderWorkflow, OrderWorkflowLayer, PaymentError }
