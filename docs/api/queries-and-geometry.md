# Queries & Geometry API

## Spatial & Semantic Queries

All query methods accept `QueryOptions<M, K>`:

```ts
interface QueryOptions<M extends object, K extends string> {
    readonly kind?: K;
    readonly where?: Partial<Metadata<M, K>>;
    readonly tags?: readonly string[];
    readonly filter?: (metadata: Metadata<M, K>) => boolean;
}
```

Passing `kind` narrows every yielded `SearchResult` or `DistanceResult` to that kind at compile time.

| Method | Signature | Description |
| --- | --- | --- |
| `search` | `(region?: Region, options?: SearchOptions) => IterableIterator<SearchResult>` | Yield matching attachments (default `region = ALL`, `overlap = false`). |
| `searchContent` | `(region?: Region, options?: SearchOptions) => IterableIterator<SearchResult>` | Deduplicated `search` yielding each matching content ID once. |
| `nearest` | `(xyz: Vec3, options?: NearestOptions) => IterableIterator<DistanceResult>` | Yield up to `limit` (default `1`) nearest matching attachments. |
| `nearestContent` | `(xyz: Vec3, options?: NearestOptions) => IterableIterator<DistanceResult>` | Nearest unique matching content IDs by minimum placement distance. |
| `radius` | `(xyz: Vec3, radius: number, options?: QueryOptions) => IterableIterator<DistanceResult>` | Yield all matching attachments within Euclidean `radius`. |
| `radiusContent` | `(xyz: Vec3, radius: number, options?: QueryOptions) => IterableIterator<DistanceResult>` | Unique matching content IDs within Euclidean `radius`. |

## Geometry & Region Helpers

`ALL` is the unrestricted root address `['', '', '']`.

| Method | Signature | Description |
| --- | --- | --- |
| `encode` | `(value: number) => string` | Encode a signed integer coordinate into a `bits`-length binary string. |
| `decode` | `(prefix: string) => Interval` | Decode a binary prefix into its inclusive `[lo, hi]` integer interval. |
| `point` | `(xyz: Vec3) => Address` | Encode an integer 3D point into an exact cell `Address`. |
| `bounds` | `(address: Address) => Bounds` | Decode a cell `Address` into its inclusive 3D `Bounds`. |
| `decompose` | `(region: Region, options?: BoxOptions) => readonly Address[]` | Decompose any `Region` into an exact disjoint set of aligned cell addresses. |
| `cover` | `(region: Region) => Address` | Return the single tightest aligned cell `Address` enclosing `region`. |
