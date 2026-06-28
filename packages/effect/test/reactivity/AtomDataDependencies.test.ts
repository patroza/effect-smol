/**
 * Worked example: derive query invalidation from recorded data dependencies, then
 * await the refetch with `Atom.invalidateAndAwait`.
 *
 * This is the pattern an application layer would wire on top of `@effect/rpc` /
 * `Atom.AtomRpc`, but reduced to plain atoms so the moving parts are visible:
 *
 *   1. A request-scoped `DataDependencyRecorder` records which repositories a
 *      handler READS (queries) and WRITES (mutations).
 *   2. Each query atom records the repos it read, keyed by its reactivity key, and
 *      registers under that key via `withReactivity`.
 *   3. A mutation records its writes, finds every query whose reads intersect those
 *      writes, and calls `invalidateAndAwait` on their keys — so the affected
 *      queries refetch and the mutation resolves only once they are fresh.
 *
 * The benefit: no hand-maintained `reactivityKeys` lists. Add a repo read to a
 * handler and any mutation that writes that repo will invalidate it automatically,
 * precisely (only queries that actually read it), and awaitably.
 */
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Ref } from "effect"
import { Atom, AtomRegistry } from "effect/unstable/reactivity"

// --- the recorder ------------------------------------------------------------

class DataDependencyRecorder extends Context.Service<DataDependencyRecorder, {
  readonly read: (repo: string) => Effect.Effect<void>
  readonly write: (repo: string) => Effect.Effect<void>
}>()("example/DataDependencyRecorder") {}

// A fresh recorder per request, exposing the read/write sets it collected.
const makeRecorder = Effect.gen(function*() {
  const reads = yield* Ref.make(new Set<string>())
  const writes = yield* Ref.make(new Set<string>())
  const service = DataDependencyRecorder.of({
    read: (repo) => Ref.update(reads, (s) => new Set(s).add(repo)),
    write: (repo) => Ref.update(writes, (s) => new Set(s).add(repo))
  })
  return { service, reads, writes } as const
})

const intersects = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
  for (const x of a) if (b.has(x)) return true
  return false
}

describe("Atom data-dependency invalidation example", () => {
  it("a mutation auto-invalidates and awaits the queries whose reads it wrote", async () => {
    // reactivityKey -> repos that query read on its last fetch
    const queryReads = new Map<string, ReadonlySet<string>>()

    // --- domain repos: each records the dependency it touches -----------------
    let users: ReadonlyArray<string> = ["alice"]
    const UserRepo = {
      all: DataDependencyRecorder.use((r) =>
        Effect.gen(function*() {
          yield* r.read("User")
          return users
        })
      ),
      add: (name: string) =>
        DataDependencyRecorder.use((r) =>
          Effect.gen(function*() {
            users = [...users, name]
            yield* r.write("User")
          })
        )
    }

    const runtime = Atom.runtime(Layer.empty)

    // A query atom: provides a fresh recorder, runs the handler, remembers the
    // repos it read keyed by reactivity key, and registers under that key.
    const makeQuery = <A>(key: string, handler: Effect.Effect<A, never, DataDependencyRecorder>) =>
      runtime.atom(Effect.gen(function*() {
        const recorder = yield* makeRecorder
        const result = yield* handler.pipe(Effect.provideService(DataDependencyRecorder, recorder.service))
        queryReads.set(key, yield* Ref.get(recorder.reads))
        return result
      })).pipe(Atom.withReactivity([key]), Atom.keepAlive)

    // A mutation: runs the handler with a recorder, then derives + awaits the
    // affected queries from its writes ∩ each query's recorded reads.
    const runMutation = <A>(handler: Effect.Effect<A, never, DataDependencyRecorder>) =>
      Effect.gen(function*() {
        const recorder = yield* makeRecorder
        const result = yield* handler.pipe(Effect.provideService(DataDependencyRecorder, recorder.service))
        const written = yield* Ref.get(recorder.writes)
        const affected = [...queryReads]
          .filter(([, reads]) => intersects(reads, written))
          .map(([key]) => key)
        yield* Effect.forEach(affected, (key) => Atom.invalidateAndAwait([key]), { discard: true })
        return result
      })

    const r = AtomRegistry.make()
    const usersQuery = makeQuery("users", UserRepo.all)
    const unmount = r.mount(usersQuery)

    // initial fetch records the read of "User"
    let result = await Effect.runPromise(
      Atom.getResult(usersQuery).pipe(
        Effect.provideService(AtomRegistry.AtomRegistry, r)
      )
    )
    assert.deepStrictEqual(result, ["alice"])
    assert.deepStrictEqual([...queryReads.get("users")!], ["User"])

    // the mutation never names "users" — invalidation is derived from {User}
    await Effect.runPromise(
      runMutation(UserRepo.add("bob")).pipe(
        Effect.provideService(AtomRegistry.AtomRegistry, r)
      )
    )

    // invalidateAndAwait already settled the refetch, so the cached query is fresh
    result = await Effect.runPromise(
      Atom.getResult(usersQuery).pipe(
        Effect.provideService(AtomRegistry.AtomRegistry, r)
      )
    )
    assert.deepStrictEqual(result, ["alice", "bob"])

    unmount()
  })
})
