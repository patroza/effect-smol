---
"effect": patch
---

Schema.Class now falls back to validating non-instance values against the underlying struct schema instead of relying on the class type-id property check.
