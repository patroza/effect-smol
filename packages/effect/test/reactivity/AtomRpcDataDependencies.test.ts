/**
 * Worked example: full-stack derived cache invalidation over native Effect RPC +
 * AtomRpc — the effect v4 native equivalent of effect-app's router + api-client.
 *
 * The mechanism, mirroring effect-app (`DataDependencies` + `rpc/Invalidation` +
 * `routing` + `apiClientFactory`):
 *
 *   - Every RPC's success schema is transparently enhanced to `{ payload, deps }`
 *     by `dataRpc` — the contract author writes the plain success type and never
 *     sees the envelope (HIDDEN).
 *   - On the SERVER, a per-request recorder is installed around each handler by
 *     `recordingHandlers`. Repositories call `Recorder.read` / `Recorder.write`;
 *     the recorder is drained into `deps` and piggybacked on the response. The
 *     handler author just returns the value (HIDDEN).
 *   - On the CLIENT, `dataQuery` / `dataMutation` unwrap `payload` for the caller
 *     and consume `deps` internally: a query registers the repos it READ under its
 *     key; a mutation takes the repos it WROTE, finds every query whose reads
 *     intersect them, and `invalidateAndAwait`s those — refetching over RPC and
 *     waiting for them to settle (HIDDEN).
 *
 * Crucially the recorder lives only on the server, per request; the dependency
 * sets reach the client solely through the RPC response message, not a shared
 * in-process service. Swapping `RpcTest` for an HTTP/WebSocket protocol changes
 * nothing.
 */
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Ref, Schema } from "effect"
import { AsyncResult, Atom, AtomRegistry, AtomRpc } from "effect/unstable/reactivity"
import { Rpc, RpcGroup, RpcTest } from "effect/unstable/rpc"

// ===========================================================================
// framework: dependency piggyback (hidden from contract / handler / UI authors)
// ===========================================================================

const Deps = Schema.Struct({
  reads: Schema.Array(Schema.String),
  writes: Schema.Array(Schema.String)
})

/** Enhance a success schema to carry recorded data dependencies alongside the value. */
const WithDeps = <S extends Schema.Top>(success: S) => Schema.Struct({ payload: success, deps: Deps })

/** Define an RPC whose success transparently carries dependencies. */
const dataRpc = <const Tag extends string, S extends Schema.Top, P extends Schema.Struct.Fields>(
  tag: Tag,
  options: { readonly success: S; readonly payload?: P }
) =>
  Rpc.make(tag, {
    success: WithDeps(options.success),
    ...(options.payload ? { payload: options.payload } : {})
  })

// server-side, request-scoped recorder
class Recorder extends Context.Service<Recorder, {
  readonly read: (repo: string) => Effect.Effect<void>
  readonly write: (repo: string) => Effect.Effect<void>
}>()("example/Recorder") {}

/** Run a handler with a fresh recorder and drain it into the response envelope. */
const recording = <A, E>(handler: Effect.Effect<A, E, Recorder>) =>
  Effect.gen(function*() {
    const reads = yield* Ref.make<ReadonlyArray<string>>([])
    const writes = yield* Ref.make<ReadonlyArray<string>>([])
    const append = (ref: Ref.Ref<ReadonlyArray<string>>) => (repo: string) =>
      Ref.update(ref, (xs) => xs.includes(repo) ? xs : [...xs, repo])
    const payload = yield* handler.pipe(
      Effect.provideService(Recorder, Recorder.of({ read: append(reads), write: append(writes) }))
    )
    return { payload, deps: { reads: yield* Ref.get(reads), writes: yield* Ref.get(writes) } }
  })

/** Wrap every handler so it records its reads/writes — the author returns a plain value. */
const recordingHandlers = <H extends Record<string, (...args: Array<any>) => Effect.Effect<any, any, Recorder>>>(
  handlers: H
): {
  [K in keyof H]: (...args: Parameters<H[K]>) => Effect.Effect<{
    readonly payload: Effect.Success<ReturnType<H[K]>>
    readonly deps: { readonly reads: ReadonlyArray<string>; readonly writes: ReadonlyArray<string> }
  }>
} =>
  Object.fromEntries(
    Object.entries(handlers).map(([tag, handler]) => [tag, (...args: Array<any>) => recording(handler(...args))])
  ) as any

// client-side: which repos each live query last read (effect-app's dependencyMetadata)
const clientReads = new Map<string, ReadonlyArray<string>>()
const derive = (writes: ReadonlyArray<string>): ReadonlyArray<string> => {
  const keys: Array<string> = []
  for (const [key, reads] of clientReads) {
    if (reads.some((repo) => writes.includes(repo))) keys.push(key)
  }
  return keys
}

// ===========================================================================
// application: contract, repository, handlers, client — none touch the envelope
// ===========================================================================

class User extends Schema.Class<User>("User")({ id: Schema.String, name: Schema.String }) {}

const UsersRpc = RpcGroup.make(
  dataRpc("GetUsers", { success: Schema.Array(User) }),
  dataRpc("CreateUser", { success: User, payload: { name: Schema.String } })
)

// the repository records every dependency it touches via the request-scoped Recorder
const makeUserRepo = Effect.gen(function*() {
  const ref = yield* Ref.make<ReadonlyArray<User>>([new User({ id: "1", name: "alice" })])
  let nextId = 2
  return {
    all: Recorder.use((rec) => Effect.andThen(rec.read("User"), Ref.get(ref))),
    create: (name: string) =>
      Recorder.use((rec) =>
        Effect.gen(function*() {
          const user = new User({ id: String(nextId++), name })
          yield* Ref.update(ref, (users) => [...users, user])
          yield* rec.write("User")
          return user
        })
      )
  }
})

const HandlersLive = UsersRpc.toLayer(Effect.gen(function*() {
  const repo = yield* makeUserRepo
  // the `{ payload, deps }` envelope is produced by `recordingHandlers`; the handler
  // bodies just return plain values, never touching it.
  return recordingHandlers({
    GetUsers: () => repo.all,
    CreateUser: (payload: { readonly name: string }) => repo.create(payload.name)
  })
}))

const Client = AtomRpc.Service()("UsersClient", {
  group: UsersRpc,
  protocol: HandlersLive,
  makeEffect: RpcTest.makeClient(UsersRpc, { flatten: true })
})

// Reusable client helpers — the "for now" mechanism. Both hide the `{ payload, deps }`
// envelope from callers; the mutation additionally auto-invalidates. (Handled "higher
// up" this would live inside a wrapped `AtomRpc.Service` whose `.query`/`.mutation`
// apply this to every RPC automatically, so application code never unwraps or lists keys.)

type Envelope<A> = {
  readonly payload: A
  readonly deps: { readonly reads: ReadonlyArray<string>; readonly writes: ReadonlyArray<string> }
}

/** A cached query that returns the plain value and records the repos it read under `key`. */
const dataQuery = <A>(
  tag: string,
  payload: unknown,
  key: string
): Atom.Atom<AsyncResult.AsyncResult<A, any>> =>
  Client.runtime.atom(
    Client.use((client) =>
      Effect.map(client(tag as any, payload as any) as Effect.Effect<Envelope<A>, any>, (env) => {
        clientReads.set(key, env.deps.reads)
        return env.payload
      })
    )
  ).pipe(
    Atom.withReactivity([key]),
    (atom) =>
      Atom.transform(atom, (get) => {
        get.addFinalizer(() => clientReads.delete(key))
        return get(atom)
      }, { initialValueTarget: atom }),
    Atom.keepAlive
  )

/** A mutation that returns the plain value and invalidates+awaits every query whose reads it wrote. */
const dataMutation = <A, P>(tag: string) =>
  Client.runtime.fn(
    Effect.fnUntraced(function*(payload: P) {
      const env = (yield* Client.use((client) => client(tag as any, payload as any))) as Envelope<A>
      const keys = derive(env.deps.writes)
      if (keys.length > 0) yield* Atom.invalidateAndAwait(keys)
      return env.payload
    })
  )

describe("AtomRpc derived invalidation (deps piggybacked over RPC)", () => {
  it.effect("a mutation invalidates the query whose reads it wrote, end-to-end", () => {
    const r = AtomRegistry.make()
    clientReads.clear()
    return Effect.gen(function*() {
      const usersQuery = dataQuery<ReadonlyArray<User>>("GetUsers", undefined, "GetUsers")
      const unmount = r.mount(usersQuery)

      const initial = yield* Atom.getResult(usersQuery, { suspendOnWaiting: true })
      assert.deepStrictEqual(initial.map((u) => u.name), ["alice"])
      // the query collected its server-side read, carried back on the response
      assert.deepStrictEqual(clientReads.get("GetUsers"), ["User"])

      // drive the mutation; the contract never named "GetUsers" — the server
      // recorded a write of "User", the client derived the dependent query
      const createUser = dataMutation<User, { readonly name: string }>("CreateUser")
      r.set(createUser, { name: "bob" })
      const created = yield* Atom.getResult(createUser, { suspendOnWaiting: true })
      assert.strictEqual(created.name, "bob")

      // invalidateAndAwait ran inside the mutation, so the query is already fresh
      const after = r.get(usersQuery)
      assert(AsyncResult.isSuccess(after))
      assert.deepStrictEqual(after.value.map((u) => u.name), ["alice", "bob"])

      unmount()
    }).pipe(Effect.provideService(AtomRegistry.AtomRegistry, r))
  })
})
