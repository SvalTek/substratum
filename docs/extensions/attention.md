# Weighted Queries & Attention (`@svaltek/substratum/attention`)

Substratum's core queries find matching candidates quickly; `@svaltek/substratum/attention` scores, ranks, normalizes, and aggregates them.

```ts
import {
    attend,
    gaussian,
    softmax,
    weightedAggregate,
} from '@svaltek/substratum/attention';
```

## Querying with `attend()`

`attend(world, target, options?)` accepts either a `Vec3` point or any `Region`:

- When `target` is a `Vec3`:
  - Pass `radius` to query via `world.radius` / `world.radiusContent`.
  - Pass `nearest` to query via `world.nearest` / `world.nearestContent`.
  - Omit both to search the whole world and compute Euclidean distance from `target` to each hit.
- When `target` is a `Region`, `attend()` queries via `world.search` / `world.searchContent`.

```ts
const results = attend(world, [10, 20, 30], {
    radius: 128,
    kind: 'observation',
    score: hit =>
        gaussian(hit.distance ?? 0, 32) *
        (hit.metadata.confidence ?? 1),
    normalize: softmax(0.7),
    limit: 20,
});

for (const { hit, score, weight } of results) {
    console.log(hit.id, score, weight);
}
```

### Attachment vs. Identity Ranking

Because a single `ContentId` can be attached to multiple cells, `attend()` lets you choose how duplicates are handled:

- `scope: 'attachment'` (default): every matching attachment is scored and ranked independently.
- `scope: 'content'` without `combine`: uses `radiusContent` / `nearestContent` / `searchContent` (closest/first placement).
- `scope: 'content'` with `combine`: scores all placements of each `ContentId` and combines them with `'max' | 'sum' | 'mean' | 'min'` or a custom `(scores, hits) => number` reducer.

### Options Reference

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `radius` / `nearest` | `number` | — | Spatial cutoff or neighbor count when `target` is a `Vec3` |
| `overlap` | `boolean` | `false` | Include intersecting multi-cell matches when `target` is a `Region` |
| `kind`, `where`, `tags`, `filter` | `QueryOptions` | — | Standard Substratum semantic filters |
| `scope` | `'attachment' \| 'content'` | `'attachment'` | Rank per-attachment or deduplicate by `ContentId` |
| `combine` | `'max' \| 'sum' \| 'mean' \| 'min' \| fn` | `'max'` | How multi-placement scores are combined when `scope: 'content'` |
| `score` | `(hit) => number` | `gaussian(hit.distance ?? 0, 1)` | Raw scoring function |
| `normalize` | `(scores) => number[] \| false` | `l1Normalize` | Applied after top-K `limit`; pass `false` to keep raw scores |
| `limit` | `number` | — | Maximum number of top-ranked results to return |

## Aggregating Results

`weightedAggregate(results, value)` computes a weighted sum over either scalar numbers or numeric vectors (`readonly number[]`) using each result's normalized `weight`:

```ts
const expectedConfidence = weightedAggregate(results, r => r.hit.content.confidence);
const blendedEmbedding = weightedAggregate(results, r => r.hit.content.embedding);
```
