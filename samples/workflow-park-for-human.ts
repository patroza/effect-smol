/**
 * Park a workflow on failure and wait for a HUMAN to decide — retry or abort —
 * without losing completed steps.
 *
 * Same 6-step order workflow as `workflow-durable-retry.ts`, but step 4 does not
 * auto-retry on a timer. Instead, when it fails the execution PARKS until an
 * operator explicitly approves a retry (or aborts). Use this when "try again"
 * needs a judgement call: a fraud hold, a manual fix in an upstream system, a
 * cost approval, etc.
 *
 * Two mechanisms are shown:
 *
 *   1. APPROVAL-GATED RETRY (the workhorse, `retryWithApproval` below).
 *      A retry loop that parks on a `DurableDeferred` after each failure. The
 *      loop index drives `Activity.CurrentAttempt`, so when the operator approves
 *      a retry the activity genuinely re-runs (a new attempt = a new cache key).
 *      The loop index is replay-stable: prior awaits replay as already-done, so
 *      we resume at exactly the attempt we parked on.
 *
 *   2. `Workflow.SuspendOnFailure` (the coarse safety net, see notes at bottom).
 *      An annotation that parks the whole workflow on ANY uncaught error. Good
 *      for halting on unexpected defects so a human can inspect. IMPORTANT
 *      caveat about retrying is documented at the end.
 *
 * Why a plain "fail then resume" does NOT retry the step
 * ------------------------------------------------------
 * An activity result is cached by `executionId / activityName / attempt`. A
 * failed attempt persists its failure. Resuming the execution replays that same
 * attempt -> same failure -> re-parks forever. To actually re-run a step its
 * ATTEMPT number must advance — which is exactly what the loop below does, and
 * what bare `SuspendOnFailure` does NOT do on its own.
 */
import { Cause, Context, Effect, Exit, Layer, Option, Schema } from "effect"
import { Activity, DurableDeferred, Workflow, WorkflowEngine } from "effect/unstable/workflow"

// ---------------------------------------------------------------------------
// Operator decision carried by each approval deferred
// ---------------------------------------------------------------------------

const Decision = Schema.Struct({
  action: Schema.Literals(["retry", "abort"]),
  note: Schema.optional(Schema.String)
})
type Decision = typeof Decision.Type

// ---------------------------------------------------------------------------
// Generic helper: retry an Activity, parking for human approval between tries
// ---------------------------------------------------------------------------

/**
 * Run `activity`; on a retryable failure, PARK until an operator completes the
 * approval deferred for that attempt.
 *
 *  - `approvals[i]` is awaited after attempt `i + 1` fails. Provide as many as
 *    the maximum number of retries you want to allow.
 *  - Operator sends `{ action: "retry" }` to try again, or `{ action: "abort" }`
 *    to give up (the original failure becomes terminal).
 *  - Each attempt runs under a distinct `CurrentAttempt`, so approval actually
 *    re-runs the work instead of replaying the cached failure.
 */
const retryWithApproval = <S extends Schema.Top, E extends Schema.Top, R>(
  activity: Activity.Activity<S, E, R>,
  approvals: ReadonlyArray<DurableDeferred.DurableDeferred<typeof Decision>>,
  options: {
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
      const canAsk = attempt <= approvals.length &&
        Option.isSome(error) &&
        options.while(error.value)
      if (!canAsk) {
        return yield* exit // not retryable, or no approval slot left -> terminal
      }
      yield* Effect.logWarning(
        `[${activity.name}] attempt ${attempt} failed — parking for operator approval`
      )
      // PARK. The execution suspends here, survives restarts, no polling. It
      // only continues when an operator completes this attempt's deferred.
      const decision = yield* DurableDeferred.await(approvals[attempt - 1])
      if (decision.action === "abort") {
        yield* Effect.logWarning(`[${activity.name}] operator aborted: ${decision.note ?? ""}`)
        return yield* exit
      }
      // "retry" -> loop; attempt++ gives the activity a fresh cache key
    }
  }) as any

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

class PaymentError extends Schema.ErrorClass<PaymentError>("PaymentError")({
  message: Schema.String
}) {}

class OrderStore extends Context.Service<OrderStore>()("OrderStore", {
  make: Effect.succeed({
    record: (orderId: string, step: string) => Effect.log(`order ${orderId}: ${step} ✓`)
  })
}) {
  static readonly layer = Layer.effect(OrderStore, this.make)
}

class PaymentGateway extends Context.Service<PaymentGateway>()("PaymentGateway", {
  make: Effect.succeed({
    charge: (orderId: string) =>
      Effect.gen(function*() {
        const attempt = yield* Activity.CurrentAttempt
        // fails until an operator has (presumably) fixed the upstream problem
        if (attempt < 3) {
          return yield* new PaymentError({
            message: `payment declined for ${orderId} (attempt ${attempt})`
          })
        }
        return { paymentId: `pay_${orderId}_${attempt}` }
      })
  })
}) {
  static readonly layer = Layer.effect(PaymentGateway, this.make)
}

// ---------------------------------------------------------------------------
// Approval deferreds — one per allowed retry (max 5)
// ---------------------------------------------------------------------------

const MAX_RETRIES = 5
const PaymentApprovals = Array.from(
  { length: MAX_RETRIES },
  (_, i) => DurableDeferred.make(`PaymentApproval-${i + 1}`, { success: Decision })
)

// ---------------------------------------------------------------------------
// Workflow
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

    const step = (name: string) =>
      Activity.make({ name, execute: store.record(payload.orderId, name) })

    yield* step("1-Validated")
    yield* step("2-Reserved")
    yield* step("3-Invoiced")

    // STEP 4 — parks for operator approval on each failure. Steps 1-3 stay
    // cached across every park; step 4 re-runs only when an operator says so.
    const chargePayment = Activity.make({
      name: "4-ChargePayment",
      success: Schema.Struct({ paymentId: Schema.String }),
      error: PaymentError,
      execute: gateway.charge(payload.orderId)
    })
    const { paymentId } = yield* retryWithApproval(chargePayment, PaymentApprovals, {
      while: () => true // any payment error is operator-resolvable here
    })

    yield* step("5-Shipped")
    yield* step("6-Delivered")

    return { orderId: payload.orderId, paymentId }
  })
).pipe(Layer.provide([OrderStore.layer, PaymentGateway.layer]))

// ---------------------------------------------------------------------------
// Operator side — complete an approval from a console / admin endpoint
// ---------------------------------------------------------------------------
//
// The token is recomputed from the original payload + which attempt is being
// approved, so the operator tool needs nothing the workflow stashed.

const decideRetry = (orderId: string, attempt: number, decision: Decision) =>
  Effect.gen(function*() {
    const deferred = PaymentApprovals[attempt - 1]
    const token = yield* DurableDeferred.tokenFromPayload(deferred, {
      workflow: OrderWorkflow,
      payload: { orderId }
    })
    yield* DurableDeferred.done(deferred, {
      token,
      exit: Exit.succeed(decision)
    })
  })

// ---------------------------------------------------------------------------
// What happens
// ---------------------------------------------------------------------------
//
//   const result = yield* OrderWorkflow.execute({ orderId: "order-123" })
//
//   - steps 1-3 run + persist; step 4 attempt 1 fails -> workflow PARKS on
//     PaymentApproval-1. No process is held; it survives restarts.
//   - operator investigates, fixes upstream, then:
//       yield* decideRetry("order-123", 1, { action: "retry" })
//     -> workflow resumes, replays 1-3 from cache, runs attempt 2.
//   - attempt 2 still fails -> parks on PaymentApproval-2 -> operator retries ->
//     attempt 3 succeeds -> steps 5-6 run -> done.
//   - at any park the operator may instead:
//       yield* decideRetry("order-123", n, { action: "abort", note: "fraud" })
//     -> the original PaymentError becomes terminal.
//
// ---------------------------------------------------------------------------
// Alternative: Workflow.SuspendOnFailure (coarse, whole-workflow)
// ---------------------------------------------------------------------------
//
//   const W = Workflow.make({ ... }).annotate(Workflow.SuspendOnFailure, true)
//
// On ANY uncaught error (including defects) the whole execution suspends instead
// of completing with a failure; partial progress (cached activities) is kept.
// Later: W.resume(executionId).
//
// CAVEAT — this alone does NOT retry the failed step. The failing activity's
// failure is cached at its attempt, so on resume it replays the same failure and
// re-suspends. SuspendOnFailure is for "halt and preserve so a human can inspect
// / fix external state", typically paired with a fresh-attempt mechanism (like
// retryWithApproval above) for the step that should actually be re-run. Reach for
// it as a safety net against unexpected defects, not as a retry primitive.

export {
  decideRetry,
  OrderWorkflow,
  OrderWorkflowLayer,
  PaymentApprovals,
  PaymentError
}
