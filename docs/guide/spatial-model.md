# Spatial Model

Substratum operates on a **signed 3D integer lattice**. Stored cell coordinates on X, Y, and Z are integers (by default 16-bit signed: `[-32768, 32767]`, configurable from `1` to `32` bits via `{ bits }`), while distance-query origins (`nearest`, `radius`) may be fractional `Vec3` coordinates.

## Ways to Describe a `Region`

Most spatial methods (`search`, `searchContent`, `searchCells`, `on`, `emitAt`, `decompose`, `cover`) accept a `Region`. There are three ways to write one—start with the first two for everyday use:

### 1. `BoxRegion` (Point + Dimensions)

An integer anchor `at: [x, y, z]` and an optional `extent` (width along each axis, defaulting to `1`):

```ts
// A 1x1x1 point at [10, 0, 10]
const point = { at: [10, 0, 10] as const };

// A 16x1x16 box centred on [10, 0, 10]
const sensorZone = { at: [10, 0, 10] as const, extent: [16, 1, 16] as const };
```

> **Extents are full widths, not radii.** Even widths include one extra unit on the negative side (for example, anchor `0` with width `4` covers `[-2, 1]`).

### 2. `Bounds` (Inclusive Min/Max Ranges)

Explicit inclusive `[min, max]` integer intervals for X, Y, and Z:

```ts
import type { Bounds } from '@svaltek/substratum';

const room: Bounds = [[0, 64], [0, 0], [-32, 32]];
for (const hit of world.searchContent(room, { overlap: true })) {
    console.log(hit.id, hit.content);
}
```

### 3. Canonical `Address` (Binary Prefix Slices)

Internally, Substratum encodes coordinates into `bits`-length binary strings. An `Address` is a 3-tuple `[xPrefix, yPrefix, zPrefix]`. An empty string `''` leaves an axis completely unrestricted—useful for querying an entire floor or half-space:

```ts
import { ALL } from '@svaltek/substratum';

const floor0 = ['', world.encode(0), ''] as const; // all X and Z where Y === 0
const eastHalf = ['1', '', ''] as const;           // all X >= 0
// ALL is ['', '', '']
```

## Containment vs. Overlap

Region queries take an optional `overlap` flag:

- **`overlap: false`** *(default)*: matches stored cells **completely contained** inside the query region.
- **`overlap: true`**: matches any stored cell that **intersects** the query region, including larger cells that enclose it.

## Multi-Cell Extents & Fragmentation

When you place an item with an extent (`putPoint` / `attachPoint` / `moveContent`), Substratum decomposes that box into an exact, disjoint set of aligned cells via `decompose(region)`:

```ts
const exactCells = world.decompose({ at: [8, 0, 8], extent: [8, 1, 8] });
```

Unaligned 3D boxes can decompose into many cells (the product of 1D intervals along X, Y, and Z). Substratum gives you two explicit safeguards:

1. **`maxBoxes`**: pass `{ maxBoxes: 32 }` to throw a `RangeError` *before* mutating if a box would split into too many cells:
   ```ts
   world.putPoint([1, 1, 1], { kind: 'hazard' }, payload, {
       extent: [8, 8, 8],
       maxBoxes: 16, // throws RangeError with zero side effects
   });
   ```
2. **`cover(region)`**: returns the single tightest aligned cell `Address` that encloses `region`, when an approximate bounding cell is all you need:
   ```ts
   world.put(world.cover([[0, 12], [0, 0], [0, 12]]), { kind: 'hazard' }, payload);
   ```
