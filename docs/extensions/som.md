# Self-Organising Maps (`@svaltek/substratum/som`)

Project high-dimensional numerical vectors (such as embeddings or sensor feature vectors) onto an addressable 3D integer lattice inside Substratum.

```ts
import { createSOM } from '@svaltek/substratum/som';
```

## Creating & Training a Map

```ts
const map = createSOM(world, {
    region: [[0, 15], [0, 15], [0, 15]],
    dimensions: [16, 16, 16],
    inputDimensions: 384,
    learningRate: 0.1,
    neighbourhoodRadius: 4,
    metric: 'cosine',
});

map.train(embedding);
const position = map.project(embedding);

// Attach existing content at its learned topological position
map.place(contentId, embedding, { kind: 'observation' });
```

During `train(vector)`, the map finds the Best Matching Unit (BMU) in `inputDimensions`-space and updates nearby lattice prototypes using a 3D Gaussian neighbourhood kernel in lattice coordinates.

## Persisting Lattice Nodes

Pass `nodeKind` and `createNodePayload` to materialise each lattice cell as Substratum content so other systems can query or subscribe to learned prototypes spatially:

```ts
const map = createSOM(world, {
    dimensions: [8, 8, 4],
    inputDimensions: 128,
    nodeKind: 'somNode',
    createNodePayload: (weights, coords) => ({ coords, weights }),
});

// Later: detach and remove persisted lattice nodes if desired
map.dispose(true);
```

### Options Reference

| Option | Default | Description |
| --- | --- | --- |
| `region` | `[0,0,0]` origin | Lower corner of `region` sets the lattice origin in world space |
| `dimensions` | *(required)* | `[nx, ny, nz]` integer lattice size |
| `inputDimensions` | *(required)* | Input vector dimensionality |
| `learningRate` | `0.1` | Initial learning rate $\alpha$ |
| `neighbourhoodRadius` | `max(dimensions) / 2` | Initial Gaussian neighbourhood radius $\sigma$ in lattice units |
| `learningDecay` / `radiusDecay` | `0` / `0` | Per-step exponential decay rates |
| `metric` | `'euclidean'` | `'euclidean'` or `'cosine'` vector comparison |
| `seed` | `0x5eed1234` | Deterministic PRNG seed for initial weights |

> **Transaction boundaries:** If persisting lattice nodes fails during `train()` or `dispose(true)`, internal weights and `stepCount` are restored. However, if an enclosing caller `world.batch()` throws *after* `train()` returns, private SOM weights do not automatically roll back. Also note that `createSOM()` initialises fresh weights and does not reload previously persisted nodes on construction.
