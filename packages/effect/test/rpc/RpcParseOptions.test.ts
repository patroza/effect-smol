import { assert, describe, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Option, Queue, Schema } from "effect"
import { Rpc, RpcClient, RpcGroup, RpcServer } from "effect/unstable/rpc"

const ParseOptionsGroup = RpcGroup.make(
  Rpc.make("Ping", {
    payload: Schema.Struct({
      value: Schema.String
    }),
    success: Schema.String,
    defect: Schema.String
  })
)

describe("Rpc parseOptions", () => {
  it.effect("RpcClient.make applies parseOptions when encoding payloads", () =>
    Effect.gen(function*() {
      const client = yield* RpcClient.make(ParseOptionsGroup, {
        parseOptions: {
          onExcessProperty: "error"
        }
      }).pipe(
        Effect.provideService(
          RpcClient.Protocol,
          RpcClient.Protocol.of({
            run: () => Effect.never,
            send: () => Effect.void,
            supportsAck: true,
            supportsTransferables: false
          })
        )
      )

      const exit = yield* Effect.exit(client.Ping({ value: "ok", extra: "x" } as any))
      assert.strictEqual(exit._tag, "Failure")
      const defect = Cause.squash(exit.cause)
      assert.strictEqual(String(defect).includes("extra"), true)
    }))

  it.effect("RpcServer.make applies parseOptions when decoding payloads", () =>
    Effect.gen(function*() {
      const sent = yield* Deferred.make<any>()
      const disconnects = yield* Queue.unbounded<number>()

      const request = {
        _tag: "Request",
        id: "1",
        tag: "Ping",
        payload: { value: "ok", extra: "x" },
        headers: []
      } as const

      const server = RpcServer.make(ParseOptionsGroup, {
        parseOptions: {
          onExcessProperty: "error"
        }
      }).pipe(
        Effect.provideService(
          RpcServer.Protocol,
          RpcServer.Protocol.of({
            run: (f) => Effect.andThen(f(0, request), Effect.never),
            disconnects,
            send: (_clientId, response) => Deferred.succeed(sent, response),
            end: () => Effect.void,
            clientIds: Effect.succeed(new Set()),
            initialMessage: Effect.succeed(Option.none()),
            supportsAck: true,
            supportsTransferables: false,
            supportsSpanPropagation: true
          })
        ),
        Effect.provide(ParseOptionsGroup.toLayerHandler("Ping", () => Effect.succeed("ok"))),
        Effect.forkScoped
      )
      yield* server

      const response = yield* Effect.raceFirst(
        Deferred.await(sent),
        Effect.fail("Timed out waiting for RPC response").pipe(Effect.delay("1 second"))
      )
      assert.strictEqual(response._tag, "Exit")
      assert.strictEqual(response.exit._tag, "Failure")
      const defect = response.exit.cause.find((causeEntry: any) => causeEntry._tag === "Die")?.defect
      assert.notStrictEqual(defect, undefined)
      assert.strictEqual(String(defect).includes("extra"), true)
    }).pipe(Effect.scoped))
})
