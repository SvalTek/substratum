# Transactions

Every public write method (`put`, `putPoint`, `moveContent`, `setContent`, `clearCell`, etc.) executes inside an atomic transaction with respect to all internal stores and indexes.

## `batch()` & Nested Savepoints

Use `batch()` to group multiple operations into a single atomic unit with nested savepoints and one consolidated `'spatial:change'` notification:

```ts
world.batch(() => {
    world.putPoint([1, 0, 1], { kind: 'resource' }, { name: 'Wood', quantity: 1, renewable: false });

    try {
        world.batch(() => {
            world.putPoint([2, 0, 2], { kind: 'resource' }, { name: 'Stone', quantity: 5, renewable: false });
            throw new Error('abort inner savepoint');
        });
    } catch {
        // Only the inner savepoint rolled back; [1, 0, 1] remains staged.
    }
});
// Outer commit succeeds and emits one 'spatial:change' for [1, 0, 1].
```

Multi-cell operations like `putPoint` and `moveContent` are themselves batched: if middleware vetoes box 3 of a 4-box placement, the entire operation — including the newly created content record — is rolled back with zero orphaned data and zero emitted post-commit events.

## Rollback Guarantees & Boundaries

| Rolled back on exception / veto | Not rolled back |
| --- | --- |
| Content store additions, updates, removals | External side effects (logs, I/O, external state) |
| Cell attachments & cell metadata | `on()` / `middleware()` / `use()` registrations |
| `RegionIndex`, `ProximityIndex`, placement & semantic indexes | IDs returned by `idFactory` |
| Query cache consistency (invalidated on undo) | Prior query cache evictions |
| Deferred post-commit events | In-place mutations to live payload objects |

## Event Ordering Around Commits

1. **Pre-commit (immediate)**: `'mutation:before'` fires before middleware; `'mutation:veto'` fires immediately if middleware rejects the write (before `MutationRejected` is thrown). Pre-commit listeners cannot initiate writes.
2. **Commit**: when the outermost `batch()` returns cleanly without throwing, internal state is finalized and the undo log is cleared.
3. **Post-commit (queued FIFO)**: deferred `'mutation:add'`, `'mutation:update'`, `'mutation:remove'`, `'mutation:after'`, and the consolidated `'spatial:change'` are dispatched. Post-commit listeners may initiate new writes.
4. **Observer failure**: if a post-commit listener throws, `EventDispatchError` is raised, committed writes stay committed, and remaining queued events are discarded.
