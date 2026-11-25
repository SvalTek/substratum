# Reactivity & Events

Substratum routes both custom domain events and transactional `spatial:change` notifications through a synchronous, region-indexed event bus.

## Global & Region-Scoped Listeners

Every `on()` call returns an idempotent disposer. Custom events and `'spatial:change'` accept an optional `{ region }` scope (any `Address`, `Bounds`, or `BoxRegion`):

```ts
const zone = [[0, 64], [0, 0], [0, 64]] as const;

const stop = world.on(
    'observation',
    event => {
        console.log(event.data.observer, event.regions);
    },
    { region: zone },
);

world.emitAt('observation', world.point([12, 0, 8]), {
    observer: 'Atlas',
    confidence: 0.8,
});

stop();
```

- `emit(name, data)` delivers to global subscribers only (`event.regions` is `[]`).
- `emitAt(name, region, data, options?)` delivers to global subscribers and every scoped subscriber whose region intersects `region`.
- Scoped subscribers receive **at most one delivery per event**, even across multi-cell emits, with `event.regions` filtered to only the intersecting addresses.
- Lifecycle events other than `'spatial:change'` (such as `'update'` or `'mutation:before'`) cannot be spatially scoped — enforced at both compile time and runtime.

## `spatial:change` & Lazy `transitions`

When an outer write or `batch()` commits, Substratum emits one consolidated `'spatial:change'` event containing:

- `event.regions`: union of all affected cell addresses (filtered for scoped listeners).
- `event.changes`: ordered list of raw `Mutation` records (`content`, `attachment`, `cell`).
- `event.transitions`: a **lazy, memoized, discriminated-union summary** grouped by content ID.

Each transition entry narrows on `t.kind`:

```ts
world.on('spatial:change', event => {
    for (const t of event.transitions) {
        if (t.kind !== 'hazard') continue;

        // t.id is narrowed to ContentId<'hazard'>
        if (t.added.length && !t.removed.length) {
            console.log('Hazard entered territory:', t.id);
        } else if (t.removed.length && !t.added.length) {
            console.log('Hazard left territory:', t.id);
        } else if (t.contentChanged) {
            console.log('Hazard updated in territory:', t.contentOperation);
        }
    }
}, { region: territory });
```

Because `transitions` is computed lazily on first access, listeners that only inspect `event.changes` or `event.regions` pay zero grouping overhead.

Updating a shared payload (`setContent` / `touchContent`) uses the placement index automatically, so scoped subscribers watching *any* disconnected placement of that content ID are notified.

## Delivery Semantics & Error Handling

- **Synchronous FIFO queue**: reentrant events emitted by post-commit listeners are queued and delivered in FIFO order after the current delivery finishes.
- **Cascade bound**: `maxEvents` (default `10000`) bounds cascaded deliveries to prevent infinite feedback loops.
- **Post-commit failures (`EventDispatchError`)**: if an observer throws or `maxEvents` is exceeded, `EventDispatchError` is thrown (with the original error as `cause`). **Committed writes remain committed**, and undelivered queued events are discarded.
- **Lifecycle events**:
  - Immediate pre-commit: `'mutation:before'`, `'mutation:veto'` (cannot initiate writes).
  - Post-commit: `'mutation:add'`, `'mutation:update'`, `'mutation:remove'`, `'mutation:after'`, `'spatial:change'`.
  - Driven by `world.update(dt)`: `'update:before'`, `'update'`, `'update:after'`.
