---
"effect": minor
---

unstable/rpc: add per-value response headers for streaming RPCs

Streaming handlers can now attach headers to individual emissions, in
addition to the chunk/call-level `Rpc.setResponseHeader` API.

Handlers wrap any value with `Rpc.withValueHeaders`. The server strips
the wrapper before schema encoding and forwards the headers through the
new optional `valueHeaders` parallel array on `ResponseChunk(Encoded)`.

```ts
import { Effect, Schema, Stream } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"

const group = RpcGroup.make(
  Rpc.make("Counter", {
    payload: { count: Schema.Number },
    success: Schema.Number,
    stream: true
  })
)

const handlers = group.toLayer({
  Counter: (req) =>
    Stream.range(1, req.count).pipe(
      Stream.map((n) => Rpc.withValueHeaders(n, { "x-seq": String(n) }))
    )
})
```

Clients opt in per-call with `withValueHeaders: true`. Each emission is
exposed as `{ value, headers }`:

```ts
const stream = client.Counter({ count: 3 }, { withValueHeaders: true })
yield *
  Stream.runForEach(stream, ({ value, headers }) => Effect.log(`value=${value} seq=${Headers.get(headers, "x-seq")}`))
```

When the client does not opt in, values flow through unchanged. When the
handler does not wrap, the client sees empty headers per value. Both
channels (chunk-level `setResponseHeader` and per-value
`withValueHeaders`) compose freely.

### Wire format

`ResponseChunkEncoded` gains an optional
`valueHeaders?: ReadonlyArray<ReadonlyArray<[string, string]>>` field
parallel to `values`. Omitted when no element carried headers, so existing
serialized payloads are unaffected.
