---
"effect": patch
---

Atom: add `invalidateAndAwait`.

`Reactivity.invalidate` returns `void`, so a mutation cannot wait for the queries it invalidates to refetch. `Atom.invalidateAndAwait(keys)` invalidates the keys and resolves once every atom registered under them through `withReactivity` has settled (left the `waiting` state). Atoms are tracked while alive — mounted or cached within their idle TTL — so cached-but-unmounted queries are awaited too. A failing query result does not reject; completion reports that the invalidation settled. The runtime factory exposes the same as `factory.invalidateAndAwait`.
