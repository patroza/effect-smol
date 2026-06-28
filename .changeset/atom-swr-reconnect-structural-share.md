---
"effect": patch
---

Atom: add stale-while-revalidate on network reconnect plus structural sharing.

- `Atom.networkReconnectSignal` and `Atom.refreshOnReconnect`: browser `online`-event signal mirroring `windowFocusSignal` / `refreshOnWindowFocus`.
- `Atom.swr` now accepts `revalidateOnReconnect` (and an optional `reconnectSignal` override). When `revalidateOnFocus`/`revalidateOnReconnect` are enabled the trigger defaults to `windowFocusSignal` / `networkReconnectSignal`, so the common case needs no wiring.
- `Atom.combineSignals` folds several numeric signal atoms into one.
- `Atom.structuralShare` / `Atom.replaceEqualDeep`: reuse references of unchanged sub-trees across refreshes (leaves compared with `Equal.equals`, so equal decoded instances are shared too).
- `windowFocusSignal` is now SSR-safe (stays `0` and registers no listener when `window` is undefined).
