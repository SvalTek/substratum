# API Reference

All exports are available from the package root (`@svaltek/substratum` or `./src/mod.ts`).

## Exports

```ts
export { Substratum, MutationRejected } from './substratum.ts';
export { EventDispatchError } from './internal/events.ts';
export { Geometry, ALL } from './geometry.ts';
export type * from './types.ts';
```

## `new Substratum<C, M, E>(options?)`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `bits` | `number` | `16` | Signed coordinate bit width (`1`–`32`). Domain is `[-2^(bits-1), 2^(bits-1) - 1]`. |
| `indexedFields` | `readonly (keyof M \| 'kind')[]` | `['kind']` | Scalar attachment metadata fields to index for equality queries (`'kind'` is always indexed). |
| `indexedTags` | `boolean` | `false` | Enable inverted tag indexing for `tags` queries. |
| `maxEvents` | `number` | `10000` | Maximum cascaded reentrant event deliveries per dispatch cycle. |
| `idFactory` | `() => string` | `crypto.randomUUID` | Custom content ID generator (must return unique non-empty strings). |

---

## Geometry & Region Helpers

| Method | Signature | Description |
| --- | --- | --- |
| `encode` | `(value: number) => string` | Encode a signed integer coordinate into a `bits`-length binary string. |
| `decode` | `(prefix: string) => Interval` | Decode a binary prefix into its inclusive `[lo, hi]` integer interval. |
| `point` | `(xyz: Vec3) => Address` | Encode an integer 3D point into an exact cell `Address`. |
| `bounds` | `(address: Address) => Bounds` | Decode a cell `Address` into its inclusive 3D `Bounds`. |
| `decompose` | `(region: Region, options?: BoxOptions) => readonly Address[]` | Decompose any `Region` into an exact disjoint set of aligned cell addresses. |
| `cover` | `(region: Region) => Address` | Return the single tightest aligned cell `Address` enclosing `region`. |

`ALL` is the unrestricted root address `['', '', '']`.

---

## Content Store

| Method | Signature | Description |
| --- | --- | --- |
| `createContent` | `<K>(kind: K, payload: C[K]) => ContentId<K>` | Create an unattached content record. |
| `getContent` | `<K>(id: ContentId<K>) => C[K]` | Read a live payload (type inferred from branded ID). |
| `hasContent` | `(id: ContentId) => boolean` | Check whether a content ID exists. |
| `setContent` | `<K>(id: ContentId<K>, payload: C[K]) => ContentId<K>` | Replace a payload in place; routes `spatial:change` to all placements. |
| `touchContent` | `<K>(id: ContentId<K>) => ContentId<K>` | Announce an in-place payload mutation (cannot be rolled back). |
| `removeContent` | `(id: ContentId) => boolean` | Delete an unattached content record (throws if still attached). |
| `orphans` | `() => readonly ContentId<Kind<C>>[]` | List all currently unattached content IDs. |
| `collectOrphans` | `() => readonly ContentId<Kind<C>>[]` | Delete all unattached content IDs in one batch and return them. |

---

## Placement & Cells

| Method | Signature | Description |
| --- | --- | --- |
| `put` | `<K>(address: Address, metadata, payload) => ContentId<K>` | Create content and attach it at `address` atomically. |
| `putPoint` | `<K>(xyz: Vec3, metadata, payload, options?: ExtentOptions) => ContentId<K>` | Create content and attach it across an exact box (`extent`, `maxBoxes`). |
| `attach` | `<K>(address: Address, id: ContentId<K>, metadata) => ContentId<K>` | Attach existing content to a cell address. |
| `attachPoint` | `<K>(xyz: Vec3, id: ContentId<K>, metadata, options?: ExtentOptions) => ContentId<K>` | Attach existing content across an exact box. |
| `updateAttachment` | `<K>(address: Address, id: ContentId<K>, metadata) => ContentId<K>` | Replace attachment metadata at an existing placement. |
| `detach` | `(address: Address, id: ContentId) => boolean` | Remove one attachment at an exact cell address. |
| `detachAll` | `(id: ContentId) => number` | Remove all placements of a content ID while retaining its payload. |
| `placements` | `(id: ContentId) => readonly Address[]` | List all cell addresses currently occupied by a content ID. |
| `moveContent` | `<K>(id: ContentId<K>, xyz: Vec3, options?: MoveOptions<M, K>) => ContentId<K>` | Atomically replace all placements with a new exact box, reusing unchanged cells. |
| `getCell` | `(address: Address) => CellSnapshot<C, M> \| undefined` | Inspect a cell's metadata and attachments. |
| `searchCells` | `(region?: Region, options?: { overlap?: boolean; filter? }) => IterableIterator<CellSnapshot<C, M>>` | Iterate occupied cells matching a region and optional metadata filter. |
| `setCellMetadata` | `(address: Address, metadata: CellMetadata) => Address` | Set or clear (`{}`) metadata belonging to a cell itself. |
| `clearCell` | `(address: Address) => boolean` | Detach all content and clear cell metadata at an exact cell (descendants remain). |
| `clearPoint` | `(xyz: Vec3) => boolean` | Convenience wrapper around `clearCell(point(xyz))`. |

---

## Queries

All query methods accept `QueryOptions<M, K>`: `{ kind?, where?, tags?, filter? }`. Passing `kind` narrows yielded results at compile time.

| Method | Signature | Description |
| --- | --- | --- |
| `search` | `(region?: Region, options?: SearchOptions) => IterableIterator<SearchResult>` | Yield matching attachments (default `region = ALL`, `overlap = false`). |
| `searchContent` | `(region?: Region, options?: SearchOptions) => IterableIterator<SearchResult>` | Deduplicated `search` yielding each matching content ID once. |
| `nearest` | `(xyz: Vec3, options?: NearestOptions) => IterableIterator<DistanceResult>` | Yield up to `limit` (default `1`) nearest matching attachments. |
| `nearestContent` | `(xyz: Vec3, options?: NearestOptions) => IterableIterator<DistanceResult>` | Nearest unique matching content IDs by minimum placement distance. |
| `radius` | `(xyz: Vec3, radius: number, options?: QueryOptions) => IterableIterator<DistanceResult>` | Yield all matching attachments within Euclidean `radius`. |
| `radiusContent` | `(xyz: Vec3, radius: number, options?: QueryOptions) => IterableIterator<DistanceResult>` | Unique matching content IDs within Euclidean `radius`. |

---

## Events, Middleware, Plugins & Transactions

| Method | Signature | Description |
| --- | --- | --- |
| `on` | `(name, handler, options?: { region?: Region }) => Dispose` | Subscribe globally or to a `Region` (spatial events only). |
| `emit` | `(name, data) => void` | Broadcast a custom non-spatial event. |
| `emitAt` | `(name, region: Region, data, options?: BoxOptions) => void` | Emit a custom event routed to global and intersecting scoped listeners. |
| `middleware` | `(handler: Middleware<C, M>) => Dispose` | Register synchronous validation/transformation middleware. |
| `batch` | `<T>(run: () => T) => T` | Execute a synchronous atomic transaction with nested savepoints. |
| `use` | `(installer: Plugin<C, M, E>) => Dispose` | Install a synchronous plugin with automatic reverse-order teardown. |
| `update` | `(dt: number) => void` | Drive `'update:before'`, `'update'`, and `'update:after'` phases. |
| `stats` | `() => Stats` | Snapshot of `cells`, `attachments`, `contents`, `orphans`, `partitions`, `subscriptions`, `scopedSubscriptions`, `cachedQueries`, `semanticBuckets`. |
| `validate` | `() => void` | Assert internal consistency across all indexes and caches; throws on mismatch. |

## Errors

- **`MutationRejected`**: thrown when middleware vetoes a write (carries `.mutation`).
- **`EventDispatchError`**: thrown when a post-commit observer throws or cascade exceeds `maxEvents` (carries `.cause`; committed state remains intact).
