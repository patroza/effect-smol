import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Exit, Layer, Option, Schema } from "effect"
import { Activity, DurableClock, Workflow, WorkflowEngine } from "effect/unstable/workflow"

describe("WorkflowEngine", () => {
  const IncrementWorkflow = Workflow.make("WorkflowEngine/IncrementWorkflow", {
    payload: { value: Schema.Number },
    success: Schema.Number,
    idempotencyKey: ({ value }) => String(value)
  })

  const IncrementWorkflowLayer = IncrementWorkflow.toLayer(({ value }) => Effect.succeed(value + 1))

  class ClassWorkflow extends Workflow.make("WorkflowEngine/ClassWorkflow", {
    payload: { value: Schema.Number },
    success: Schema.Number,
    idempotencyKey: ({ value }) => String(value)
  }) {}

  const ClassWorkflowLayer = ClassWorkflow.toLayer(({ value }) => Effect.succeed(value + 1))

  it.effect("layer executes and polls workflows", () =>
    Effect.gen(function*() {
      const executionId = yield* IncrementWorkflow.execute({ value: 1 }, { discard: true })
      const result = yield* IncrementWorkflow.execute({ value: 1 })
      const polled = yield* IncrementWorkflow.poll(executionId)

      assert.strictEqual(result, 2)
      assert(Option.isSome(polled) && polled.value._tag === "Complete" && Exit.isSuccess(polled.value.exit))
      assert.strictEqual(polled.value.exit.value, 2)
    }).pipe(
      Effect.provide(IncrementWorkflowLayer.pipe(
        Layer.provideMerge(WorkflowEngine.layerMemory)
      ))
    ))

  it.effect("discard returns the deterministic execution ID", () =>
    Effect.gen(function*() {
      const executionId = yield* IncrementWorkflow.executionId({ value: 1 })
      const discardedExecutionId = yield* IncrementWorkflow.execute({ value: 1 }, { discard: true })

      assert.strictEqual(discardedExecutionId, executionId)
    }).pipe(
      Effect.provide(IncrementWorkflowLayer.pipe(
        Layer.provideMerge(WorkflowEngine.layerMemory)
      ))
    ))

  it.effect("supports class extension", () =>
    Effect.gen(function*() {
      const result = yield* ClassWorkflow.execute({ value: 1 })

      assert.strictEqual(ClassWorkflow._tag, "WorkflowEngine/ClassWorkflow")
      assert.strictEqual(result, 2)
    }).pipe(
      Effect.provide(ClassWorkflowLayer.pipe(
        Layer.provideMerge(WorkflowEngine.layerMemory)
      ))
    ))
})

// Reproduction of https://github.com/ivan-puzyrny/effect-workflow-parallel-bug-repro
//
// A parent workflow uses Activity.make to wrap an Effect.forEach that fans out
// child workflows concurrently. Each child durably suspends via DurableClock.sleep
// (inMemoryThreshold < duration forces the durable path). The parent should
// suspend correctly while children are sleeping and complete once they wake up —
// it must NOT hang.
describe("parallel child workflow fan-out (repro)", () => {
  const ChildWorkflow = Workflow.make("ParallelRepro/ChildWorkflow", {
    payload: { id: Schema.Number },
    success: Schema.Void,
    idempotencyKey: ({ id }) => String(id)
  })

  // Each child uses a very short durable sleep (50 ms real time).
  // Duration.zero threshold forces even tiny durations down the durable path,
  // which is the condition that triggers the bug.
  const ChildWorkflowLayer = ChildWorkflow.toLayer(({ id }) =>
    DurableClock.sleep({
      name: `sleep-${id}`,
      duration: "50 millis",
      inMemoryThreshold: Duration.zero
    })
  )

  const ParentWorkflow = Workflow.make("ParallelRepro/ParentWorkflow", {
    payload: {},
    success: Schema.Array(Schema.Void),
    idempotencyKey: () => "parent"
  })

  // The fan-out: Activity wrapping Effect.forEach with concurrency > 1.
  // All three required conditions from the bug report are present:
  //   1. Activity.make wrapping the fan-out
  //   2. Effect.forEach with concurrency: 3 inside that activity
  //   3. Each child durably suspends (inMemoryThreshold < duration)
  const fanoutActivity = Activity.make({
    name: "ParallelRepro/fanout",
    success: Schema.Array(Schema.Void),
    execute: Effect.forEach([1, 2, 3], (id) => ChildWorkflow.execute({ id }), { concurrency: 3 })
  })

  const ParentWorkflowLayer = ParentWorkflow.toLayer(() => fanoutActivity)

  const TestLayer = ParentWorkflowLayer.pipe(
    Layer.provideMerge(ChildWorkflowLayer),
    Layer.provideMerge(WorkflowEngine.layerMemory)
  )

  it.effect("parent suspends (does not hang) when Activity fans out concurrent children that durably suspend", () =>
    Effect.gen(function*() {
      // Launch parent — it will fan out 3 children, each of which durably
      // suspends for 50 ms.  If the bug is present the parent hangs forever.
      // We join with a 5-second timeout to detect the hang.
      const result = yield* ParentWorkflow.execute({}).pipe(
        Effect.timeout("5 seconds")
      )

      assert(Option.isSome(result), "parent should complete within timeout (bug: parent hangs when children durably suspend concurrently)")
      assert.deepStrictEqual(result.value, [undefined, undefined, undefined])
    }).pipe(Effect.provide(TestLayer))
  )
})
