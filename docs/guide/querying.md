# Querying

Substratum lets you query by **region**, by **nearest neighbours**, or by **Euclidean radius**, and combine any spatial query with semantic metadata filters.

## The Six Query Methods

| Method | Spatial Input | Returns |
| --- | --- | --- |
| `search(region?, options?)` | Any `Region` (default `ALL`) | Matching attachments |
| `searchContent(region?, options?)` | Any `Region` (default `ALL`) | Unique matching `ContentId`s |
| `nearest(xyz, options?)` | `Vec3` origin | Up to `limit` (default `1`) nearest attachments |
| `nearestContent(xyz, options?)` | `Vec3` origin | Up to `limit` nearest unique `ContentId`s |
| `radius(xyz, radius, options?)` | `Vec3` origin + `radius` | All attachments within Euclidean `radius` |
| `radiusContent(xyz, radius, options?)` | `Vec3` origin + `radius` | Unique `ContentId`s within Euclidean `radius` |

All six return lazy `IterableIterator`s. If you plan to mutate `world` while iterating, materialise the results first (`[...world.search(...)]`).

## Filtering Results (`QueryOptions`)

Every query accepts semantic filters:

```ts
const hits = world.radiusContent([10, 0, 10], 32, {
    kind: 'resource',
    where: { faction: 'guild' },
    tags: ['wood'],
    filter: meta => (meta.confidence ?? 0) >= 0.8,
});
```

- `kind`: matches attachments of a specific content kind (always indexed, and narrows TypeScript result types automatically).
- `where`: exact scalar equality on attachment metadata fields.
- `tags`: requires all listed strings to be present in `metadata.tags`.
- `filter`: arbitrary predicate `(metadata) => boolean` run on candidates.

### Indexing for Speed

By default, only `kind` is indexed. If you frequently filter by specific metadata fields or tags in large worlds, enable them in the constructor:

```ts
const world = new Substratum<Content, Metadata>({
    indexedFields: ['faction', 'confidence'],
    indexedTags: true,
});
```

## Querying Cells Directly

To inspect `CellMetadata` (or cells without attachments), use `getCell(address)` or `searchCells(region?, { overlap?, filter? })`:

```ts
for (const cell of world.searchCells([[0, 16], [0, 0], [0, 16]])) {
    console.log(cell.address, cell.metadata, cell.attachments.length);
}
```
