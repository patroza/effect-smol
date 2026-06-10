/**
 * Azure Service Bus Topic notifications for Effect Cluster storage polling.
 *
 * This module does not use Service Bus as the durable mailbox. Messages and
 * replies are still persisted through `MessageStorage`; the topic only carries
 * best-effort wake-up hints so remote runners can poll storage immediately
 * instead of waiting for `entityMessagePollInterval`.
 *
 * **Mental model**
 *
 * - Persisted sends are written to `MessageStorage` first
 * - A small notification is published to a Service Bus Topic after the write
 * - Each runner listens on its own topic subscription and calls
 *   `Sharding.pollStorage` when a notification arrives
 * - Periodic polling remains the recovery path for missed notifications
 *
 * **Gotchas**
 *
 * - Use a distinct Service Bus subscription per runner process. Sharing one
 *   subscription makes Service Bus behave like a competing-consumer queue, so
 *   only one runner receives a given wake-up.
 * - Non-persisted remote sends are not supported by this runner layer because
 *   there is no direct runner transport.
 * - The topic and subscriptions must already exist in Azure Service Bus.
 *
 * @since 4.0.0
 */
import {
  ServiceBusClient,
  type ServiceBusClientOptions,
  type ServiceBusMessage,
  type ServiceBusReceiverOptions,
  type ServiceBusSenderOptions,
  type SubscribeOptions
} from "@azure/service-bus"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as ClusterError from "effect/unstable/cluster/ClusterError"
import { Persisted } from "effect/unstable/cluster/ClusterSchema"
import type * as Message from "effect/unstable/cluster/Message"
import type * as MessageStorage from "effect/unstable/cluster/MessageStorage"
import type * as RunnerHealth from "effect/unstable/cluster/RunnerHealth"
import * as Runners from "effect/unstable/cluster/Runners"
import type * as RunnerStorage from "effect/unstable/cluster/RunnerStorage"
import * as Sharding from "effect/unstable/cluster/Sharding"
import type * as ShardingConfig from "effect/unstable/cluster/ShardingConfig"
import * as Snowflake from "effect/unstable/cluster/Snowflake"

/**
 * Service exposing the Azure Service Bus client used by the cluster
 * notification layers.
 *
 * @category services
 * @since 4.0.0
 */
export class NodeClusterServiceBus extends Context.Service<NodeClusterServiceBus, {
  readonly client: ServiceBusClient
}>()("@effect/platform-node/NodeClusterServiceBus") {}

/**
 * Options for publishing cluster storage notifications to a Service Bus Topic.
 *
 * @category models
 * @since 4.0.0
 */
export interface TopicOptions {
  readonly topicName: string
  readonly senderOptions?: ServiceBusSenderOptions | undefined
}

/**
 * Options for subscribing to cluster storage notifications from a Service Bus
 * Topic subscription.
 *
 * @category models
 * @since 4.0.0
 */
export interface SubscriptionOptions extends TopicOptions {
  readonly subscriptionName: string
  readonly receiverOptions?: ServiceBusReceiverOptions | undefined
  readonly subscribeOptions?: SubscribeOptions | undefined
}

/**
 * Body published to Service Bus for storage wake-up notifications.
 *
 * @category models
 * @since 4.0.0
 */
export interface StorageNotification {
  readonly _tag: "EffectClusterStorageNotification"
  readonly envelopeId: string
  readonly requestId: string
  readonly shardId: string
  readonly entityType: string
  readonly entityId: string
}

/**
 * Provides a scoped Azure Service Bus client from a connection string.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerClient = (
  connectionString: string,
  options?: ServiceBusClientOptions | undefined
): Layer.Layer<NodeClusterServiceBus> =>
  Layer.effect(
    NodeClusterServiceBus,
    Effect.acquireRelease(
      Effect.sync(() => NodeClusterServiceBus.of({ client: new ServiceBusClient(connectionString, options) })),
      ({ client }) => Effect.promise(() => client.close()).pipe(Effect.ignore)
    )
  )

/**
 * Provides an existing Azure Service Bus client.
 *
 * **Details**
 *
 * The client is not closed by this layer. Use {@link layerClient} when this
 * module should own the client lifecycle.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerClientFrom = (
  client: ServiceBusClient
): Layer.Layer<NodeClusterServiceBus> => Layer.succeed(NodeClusterServiceBus)(NodeClusterServiceBus.of({ client }))

/**
 * Builds a `Runners` service that uses Service Bus Topic messages as persisted
 * storage wake-up notifications.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeRunners: (
  options: TopicOptions
) => Effect.Effect<
  Runners.Runners["Service"],
  never,
  | NodeClusterServiceBus
  | MessageStorage.MessageStorage
  | ShardingConfig.ShardingConfig
  | Snowflake.Generator
  | Scope.Scope
> = Effect.fnUntraced(function*(options) {
  const serviceBus = yield* NodeClusterServiceBus
  const scope = yield* Effect.scope
  const sender = serviceBus.client.createSender(options.topicName, options.senderOptions)

  yield* Scope.addFinalizer(scope, Effect.promise(() => sender.close()).pipe(Effect.ignore))

  const publish = (message: Message.Outgoing<any>) =>
    Effect.tryPromise({
      try: () => sender.sendMessages(storageNotification(message)),
      catch: (cause) => new ServiceBusPublishError({ cause })
    }).pipe(
      Effect.catch((cause) => Effect.logDebug("Could not publish cluster storage notification", cause))
    )

  return yield* Runners.make({
    ping: (address) => Effect.fail(new ClusterError.RunnerUnavailable({ address })),
    send: ({ address, message }) => {
      const persisted = Context.get(message.rpc.annotations, Persisted)
      return (persisted ? publish(message) : Effect.void).pipe(
        Effect.andThen(Effect.fail(new ClusterError.RunnerUnavailable({ address })))
      )
    },
    notify: ({ message }) => publish(message),
    onRunnerUnavailable: () => Effect.void
  })
})

/**
 * Provides `Runners` backed by Service Bus Topic wake-up notifications.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerRunners = (
  options: TopicOptions
): Layer.Layer<
  Runners.Runners,
  never,
  NodeClusterServiceBus | MessageStorage.MessageStorage | ShardingConfig.ShardingConfig
> =>
  Layer.effect(Runners.Runners, makeRunners(options)).pipe(
    Layer.provide(Snowflake.layerGenerator)
  )

/**
 * Starts a Service Bus Topic subscription that wakes the local storage poller
 * whenever a cluster notification arrives.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeStoragePoller: (
  options: SubscriptionOptions
) => Effect.Effect<void, never, NodeClusterServiceBus | Sharding.Sharding | Scope.Scope> = Effect.fnUntraced(
  function*(options) {
    const serviceBus = yield* NodeClusterServiceBus
    const sharding = yield* Sharding.Sharding
    const scope = yield* Effect.scope
    const receiver = serviceBus.client.createReceiver(
      options.topicName,
      options.subscriptionName,
      {
        receiveMode: "receiveAndDelete",
        ...options.receiverOptions
      }
    )
    const subscription = receiver.subscribe(
      {
        processMessage: () =>
          Effect.runPromise(
            sharding.pollStorage.pipe(
              Effect.catchCause((cause) => Effect.logDebug("Could not wake cluster storage poller", cause))
            )
          ),
        processError: (args) =>
          Effect.runPromise(
            Effect.logDebug("Error receiving cluster storage notification", args.error).pipe(
              Effect.annotateLogs({
                entityPath: args.entityPath,
                errorSource: args.errorSource,
                fullyQualifiedNamespace: args.fullyQualifiedNamespace
              })
            )
          )
      },
      options.subscribeOptions
    )

    yield* Scope.addFinalizer(
      scope,
      Effect.promise(() => subscription.close()).pipe(
        Effect.andThen(Effect.promise(() => receiver.close())),
        Effect.ignore
      )
    )
  }
)

/**
 * Starts a Service Bus Topic subscription that wakes the local storage poller.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerStoragePoller = (
  options: SubscriptionOptions
): Layer.Layer<never, never, NodeClusterServiceBus | Sharding.Sharding> =>
  Layer.effectDiscard(makeStoragePoller(options))

/**
 * Provides `Sharding` and `Runners` for a cluster that uses Service Bus Topic
 * notifications instead of direct runner-to-runner sends.
 *
 * **Details**
 *
 * The returned layer still requires `MessageStorage`, `RunnerStorage`,
 * `RunnerHealth`, and `ShardingConfig`. It also requires
 * `NodeClusterServiceBus`, which can be provided with {@link layerClient}.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (
  options: SubscriptionOptions
): Layer.Layer<
  Sharding.Sharding | Runners.Runners,
  never,
  | NodeClusterServiceBus
  | MessageStorage.MessageStorage
  | RunnerHealth.RunnerHealth
  | RunnerStorage.RunnerStorage
  | ShardingConfig.ShardingConfig
> => {
  const sharding = Sharding.layer.pipe(
    Layer.provideMerge(layerRunners(options))
  )
  return Layer.merge(
    sharding,
    layerStoragePoller(options).pipe(
      Layer.provide(sharding)
    )
  )
}

const storageNotification = (message: Message.Outgoing<any>): ServiceBusMessage => {
  const envelope = message.envelope
  const envelopeId = envelope._tag === "Request" ? envelope.requestId : envelope.id
  const body: StorageNotification = {
    _tag: "EffectClusterStorageNotification",
    envelopeId: String(envelopeId),
    requestId: String(envelope.requestId),
    shardId: envelope.address.shardId.toString(),
    entityType: envelope.address.entityType,
    entityId: envelope.address.entityId
  }
  return {
    body,
    contentType: "application/json",
    correlationId: body.requestId,
    messageId: body.envelopeId,
    subject: body._tag
  }
}

class ServiceBusPublishError extends Data.TaggedError("ServiceBusPublishError")<{
  readonly cause: unknown
}> {}
