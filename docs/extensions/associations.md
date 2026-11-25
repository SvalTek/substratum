# Adaptive Associations (`@svaltek/substratum/associations`)

Build Hebbian-style weighted relationships between `ContentId`s with reinforcement, weakening, temporal decay, and optional Substratum persistence.

```ts
import { createAssociations } from '@svaltek/substratum/associations';
```

## Basic Usage

```ts
const associations = createAssociations(world, {
    learningRate: 0.05,
    decayRate: 0.001,
    minWeight: 0,
    maxWeight: 1,
});

associations.reinforce(contentA, contentB);
associations.weaken(contentA, contentC);

const related = associations.related(contentA, { minWeight: 0.1, limit: 10 });
associations.decay(1);
```

## Persisting Associations in Substratum

If you supply `kind` and `createPayload` (plus optional `createMetadata`), every edge is mirrored as a Substratum content record (and attached at `source`'s first placement when `createMetadata` is provided). Other plugins can then inspect or query association weights directly:

```ts
const associations = createAssociations(world, {
    kind: 'edge',
    createPayload: edge => edge,
    createMetadata: () => ({ kind: 'edge' }),
    autoDecay: true, // decays automatically on world.update(dt)
});
```

## Options & Methods

| Option | Default | Description |
| --- | --- | --- |
| `learningRate` | `0.05` | Default delta for `reinforce()` and `weaken()` |
| `decayRate` | `0.001` | Weight subtracted per unit `dt` in `decay(dt)` |
| `minWeight` / `maxWeight` | `0` / `1` | Clamping bounds for edge weights |
| `directed` | `false` | When `false`, `(a, b)` and `(b, a)` share one undirected edge |
| `pruneAtMin` | `true` | Remove edges whose weight drops to `<= minWeight` |
| `autoDecay` | `false` | Subscribe to `world.on('update', dt => decay(dt))` |

### Lifecycle Separation

`associations.dispose(removePersisted = false)` unsubscribes any `update` listener while keeping persisted Substratum content intact unless you explicitly pass `true`.
