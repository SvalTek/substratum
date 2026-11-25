# Density-Based Clustering (`@svaltek/substratum/clustering`)

Discover spatial populations using **DBSCAN** (`dbscan`) and optionally materialise them back into Substratum as reactive cluster content (`createClusterPlugin`).

```ts
import { dbscan, createClusterPlugin } from '@svaltek/substratum/clustering';
```

## Running `dbscan()`

`dbscan(world, options)` collects matching entries in `region` (default `ALL`), indexes them with a 3D spatial hash grid of cell size `epsilon`, and groups dense neighbourhoods into clusters while separating isolated points as `noise`:

```ts
const { clusters, noise } = dbscan(world, {
    region,
    kind: 'observation',
    epsilon: 16,
    minSamples: 5,
    multiPlacement: 'first',
});

for (const cluster of clusters) {
    console.log(cluster.id, cluster.count, cluster.centroid, cluster.bounds);
}
```

### Multi-Placement Policy

When a `ContentId` has multiple placements:

| `multiPlacement` | Behaviour |
| --- | --- |
| `'first'` *(default)* | Deduplicates by `ContentId` using its first matched placement |
| `'centroid'` | Deduplicates by `ContentId` using the mean center of all its placements |
| `'all-attachments'` | Treats every attachment cell as an independent point |

### Result Shape

- `clusters`: array of `{ id, members, memberIds, centroid, bounds, count, density }`.
- `noise`: array of `{ hit, point }` entries that did not belong to any dense cluster.

## Materialising Clusters (`createClusterPlugin`)

`createClusterPlugin(options)` installs a `spatial:change` listener that recomputes `dbscan()` whenever matching non-cluster entries change and writes one Substratum record per cluster at its rounded centroid inside `world.batch()`:

```ts
const dispose = world.use(createClusterPlugin({
    kind: 'observation',
    clusterKind: 'cluster',
    epsilon: 16,
    minSamples: 5,
    createPayload: cl => ({ clusterId: cl.id, count: cl.count, centroid: cl.centroid }),
    removeOnDispose: true,
}));
```

By default `removeOnDispose` is `false`, so uninstalling the plugin stops automatic updates without deleting previously materialised cluster records.

Pass `preserveIdentity: true` (and optional `identityThreshold`, default `0.5`) to match clusters across recomputations by Jaccard membership similarity and update matched clusters in place via `moveContent()` and `setContent()` instead of recreating them. Materialised cluster placements are owned by the clustering plugin—because `moveContent()` replaces all placements of a cluster `ContentId`, other plugins should not attach extra placements to materialised cluster records.
