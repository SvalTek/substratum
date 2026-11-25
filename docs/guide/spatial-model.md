# Spatial Model

Substratum operates on a **signed 3D integer lattice**. By default `bits = 16`, giving coordinates in `[-32768, 32767]` inclusive on X, Y, and Z. You can configure `bits` from `1` to `32`.

## Regions

Queries (`search`, `searchContent`, `searchCells`), scoped subscriptions (`on`), `emitAt`, `decompose`, and `cover` accept any `Region`:

```ts
type Address = readonly [string, string, string];
type Interval = readonly [number, number];
type Bounds = readonly [Interval, Interval, Interval];
interface BoxRegion {
    readonly at: readonly [number, number, number];
    readonly extent?: number | readonly [number, number, number];
}
type Region = Address | Bounds | BoxRegion;
```

1. **Canonical cell `Address`**: three independent binary prefixes `[x, y, z]`. Empty strings leave an axis unrestricted — ideal for slices and layers:
   ```ts
   const floor0 = ['', world.encode(0), ''] as const;
   const eastHalf = ['1', '', ''] as const;
   ```
2. **Inclusive integer `Bounds`**: rectangular boxes matching `world.bounds(addr)`:
   ```ts
   const room: Bounds = [[0, 64], [0, 0], [-32, 32]];
   for (const hit of world.searchContent(room, { overlap: true })) {
       console.log(hit.id, hit.content);
   }
   ```
3. **`BoxRegion`**: an integer anchor plus optional full dimensions (`extent`, default `1`):
   ```ts
   const sensor = { at: [10, 0, 10] as const, extent: [16, 1, 16] as const };
   const nearby = [...world.searchContent(sensor, { kind: 'hazard', overlap: true })];
   ```

## Containment, Overlap & Extents

- **Containment** (`overlap: false`, the default) matches stored cells completely contained within the query region.
- **Overlap** (`overlap: true`) matches any stored cell that intersects the query region, including larger cells that enclose the query.
- **Extents** specify full widths (not radii) centred on the integer anchor. Even widths include one extra unit on the negative side (e.g., anchor `0` with width `4` covers `[-2, 1]`).

### Exact Decomposition vs Coarse Cover

A single logical object placed with an extent is decomposed into an exact, disjoint set of canonical aligned cells via `decompose(region)`:

```ts
const exactCells = world.decompose({ at: [8, 0, 8], extent: [8, 1, 8] });
```

Unaligned 3D boxes can decompose into many cells (the Cartesian product of 1D dyadic intervals per axis). Substratum never approximates implicitly, and gives you two explicit tools:

- **`maxBoxes` guard**: pass `{ maxBoxes: 32 }` to `decompose`, `putPoint`, `attachPoint`, `moveContent`, or `emitAt` to throw a `RangeError` *before* allocating or mutating if fragmentation exceeds your budget.
- **Explicit enclosing cell (`cover`)**: `world.cover(region)` returns the single tightest aligned cell `Address` that completely contains `region`.

```ts
// Guard against unexpected 3D fragmentation
world.putPoint([1, 1, 1], { kind: 'hazard' }, payload, {
    extent: [8, 8, 8],
    maxBoxes: 16, // throws RangeError (64 > 16) with zero side effects
});

// Or explicitly place at the single enclosing cell
world.put(world.cover([[0, 12], [0, 0], [0, 12]]), { kind: 'hazard' }, payload);
```

## Distances

- Distances are **Euclidean** distances from a (possibly fractional) 3D origin to the nearest inclusive lattice position of each cell.
- `nearest()` and `radius()` yield matching attachments; `nearestContent()` and `radiusContent()` deduplicate by content ID, reporting the minimum distance over all matching placements of each entity.
- Query generators are live views — materialise results (`[...world.search(...)]`) before mutating the runtime during iteration.

## Content, Attachments & Cells

Substratum separates three orthogonal layers:

| Layer | Identity | Role |
| --- | --- | --- |
| **Content** | `ContentId<K>` | Typed payload of a fixed kind. Live JS reference; can be shared across disjoint cells or exist unattached (orphan). |
| **Attachment** | `(Address, ContentId)` | Places a content ID at a cell with its own recursively frozen plain-data metadata (`kind`, optional `tags`, custom fields). |
| **Cell** | `Address` | A spatial location itself, with independent `CellMetadata` (`setCellMetadata`, `getCell`, `searchCells`, `clearCell`). Can exist with zero attachments. |

```ts
// Cell metadata exists independently of attached entities
const pos = world.point([4, 0, 4]);
world.setCellMetadata(pos, { terrain: 'wet-concrete', friction: 0.3 });
console.log(world.getCell(pos)?.metadata);

// Manage placements and unattached content explicitly
const id = world.createContent('resource', { name: 'Ore', quantity: 50, renewable: false });
world.attachPoint([4, 0, 4], id, { kind: 'resource' });
world.detachAll(id);         // retains payload as an orphan
world.collectOrphans();      // removes unattached content records
```
