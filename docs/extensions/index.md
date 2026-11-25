# Computational Extensions

Substratum's core stays small and unopinionated. When you need scoring, statistics, clustering, adaptive memory, learned spatial maps, or activation spreading, you can opt into independent subpath modules under `@svaltek/substratum/*`.

## Available Modules

| Import | Purpose | Pattern |
| --- | --- | --- |
| `@svaltek/substratum/math` | Vector math, similarity metrics, kernels, normalizers, batch & online statistics | Pure functions + `WelfordAccumulator` |
| `@svaltek/substratum/attention` | Distance/semantic scoring, top-K ranking, softmax normalization, weighted aggregation | Stateless query helper |
| `@svaltek/substratum/statistics` | Regional population analysis and reactive `spatial:change` statistics observers | Stateless function + reactive observer |
| `@svaltek/substratum/clustering` | DBSCAN density-based clustering and optional cluster materialisation plugin | Stateless function + optional plugin |
| `@svaltek/substratum/associations` | Hebbian-style weighted relationships with reinforcement, weakening, and decay | Stateful manager + optional persistence |
| `@svaltek/substratum/som` | 3D Self-Organising Map projecting high-dimensional vectors onto Substratum coordinates | Stateful learner + optional persistence |
| `@svaltek/substratum/propagation` | Step-based spreading activation and message passing across content relationships | Stateful engine + optional `update` plugin |

## Usage Patterns

1. **Stateless operations** — compute a result directly from the current state of `world`:
   ```ts
   import { attend, gaussian, softmax } from '@svaltek/substratum/attention';
   const hits = attend(world, [10, 0, 10], {
       radius: 64,
       score: h => gaussian(h.distance ?? 0, 16),
       normalize: softmax(0.5),
   });
   ```
2. **Stateful computational objects** — maintain an explicit model over `world` with an explicit `dispose()` lifecycle:
   ```ts
   import { createSOM } from '@svaltek/substratum/som';
   const som = createSOM(world, { dimensions: [8, 8, 4], inputDimensions: 128 });
   ```
3. **Reactive plugins** — attach automatic behaviour via `world.use(...)`:
   ```ts
   import { createClusterPlugin } from '@svaltek/substratum/clustering';
   const stop = world.use(createClusterPlugin({ /* ... */ }));
   ```

> **Bundle imports:** For browser or Node.js consumers that cannot import TypeScript source directly, prebuilt ESM bundles are available under `@svaltek/substratum/bundle/<name>` (for example `@svaltek/substratum/bundle/attention`) after running `bun run build:bundle`.
