import { assert, describe, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Option, Queue, Schema } from "effect"
import { Rpc, RpcClient, RpcGroup, RpcServer } from "effect/unstable/rpc"
import type { FromServerEncoded } from "effect/unstable/rpc/RpcMessage"

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

      const payloadWithExcessProperty: { readonly value: string; readonly extra: string } = { value: "ok", extra: "x" }
      const exit = yield* Effect.exit(client.Ping(payloadWithExcessProperty))
      assert.strictEqual(exit._tag, "Failure")
      const defect = Cause.squash(exit.cause)
      assert.match(String(defect), /extra/)
    }))

  it.effect("RpcServer.make applies parseOptions when decoding payloads", () =>
    Effect.gen(function*() {
      const sent = yield* Deferred.make<FromServerEncoded>()
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
      if (response._tag !== "Exit") {
        assert.fail(`Expected Exit response, got ${response._tag}`)
      }
      assert.strictEqual(response.exit._tag, "Failure")
      assert.match(JSON.stringify(response.exit), /extra/)
    }).pipe(Effect.scoped))
})
