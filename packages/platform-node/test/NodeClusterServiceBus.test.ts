import { NodeClusterServiceBus } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Sharding from "effect/unstable/cluster/Sharding"

describe("NodeClusterServiceBus", () => {
  it.effect("wakes storage polling from topic notifications", () =>
    Effect.gen(function*() {
      let processMessage: (() => Promise<void>) | undefined
      let polls = 0
      let receiverClosed = false
      let subscriptionClosed = false

      const client = {
        createReceiver(topicName: string, subscriptionName: string, options: { readonly receiveMode?: string }) {
          assert.strictEqual(topicName, "cluster-notifications")
          assert.strictEqual(subscriptionName, "runner-a")
          assert.strictEqual(options.receiveMode, "receiveAndDelete")
          return {
            subscribe(handlers: { readonly processMessage: () => Promise<void> }) {
              processMessage = handlers.processMessage
              return {
                close() {
                  subscriptionClosed = true
                  return Promise.resolve()
                }
              }
            },
            close() {
              receiverClosed = true
              return Promise.resolve()
            }
          }
        }
      }

      const sharding = Sharding.Sharding.of(
        {
          pollStorage: Effect.sync(() => {
            polls++
          })
        } as Sharding.Sharding["Service"]
      )

      yield* Effect.scoped(
        NodeClusterServiceBus.makeStoragePoller({
          topicName: "cluster-notifications",
          subscriptionName: "runner-a"
        }).pipe(
          Effect.andThen(Effect.promise(() => processMessage!())),
          Effect.andThen(Effect.sync(() => assert.strictEqual(polls, 1)))
        )
      ).pipe(
        Effect.provide(NodeClusterServiceBus.layerClientFrom(client as any)),
        Effect.provide(Layer.succeed(Sharding.Sharding)(sharding))
      )

      assert.strictEqual(subscriptionClosed, true)
      assert.strictEqual(receiverClosed, true)
    }))
})
