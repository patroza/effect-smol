import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Option, Queue, Schema } from "effect"
import { Rpc, RpcClient, RpcGroup, RpcServer } from "effect/unstable/rpc"
import type { FromClientEncoded, FromServerEncoded } from "effect/unstable/rpc/RpcMessage"

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
  it.effect("RpcClient.make accepts parseOptions concurrency", () =>
    Effect.gen(function*() {
      const sent = yield* Deferred.make<FromClientEncoded>()
      const client = yield* RpcClient.make(ParseOptionsGroup, {
        parseOptions: {
          concurrency: "unbounded"
        }
      }).pipe(
        Effect.provideService(
          RpcClient.Protocol,
          RpcClient.Protocol.of({
            run: () => Effect.never,
            send: (_clientId, request) => Deferred.succeed(sent, request),
            supportsAck: true,
            supportsTransferables: false
          })
        )
      )
      yield* client.Ping({ value: "ok" }, { discard: true })
      const request = yield* Deferred.await(sent)
      assert.strictEqual(request._tag, "Request")
      assert.deepStrictEqual(request.payload, { value: "ok" })
    }).pipe(Effect.scoped))

  it.effect("RpcServer.make accepts parseOptions concurrency", () =>
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
          concurrency: "unbounded"
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
      assert.deepStrictEqual(response.exit, { _tag: "Success", value: "ok" })
    }).pipe(Effect.scoped))
})
