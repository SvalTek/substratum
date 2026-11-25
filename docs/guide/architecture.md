# Architecture & Limits

Substratum keeps its entire runtime compact, synchronous, and auditable. Every internal structure is cross-checked by `world.validate()`.

## Internal Indexes

### `RegionIndex` (Containment, Overlap & Event Routing)

`RegionIndex` indexes stored cells and scoped subscriptions independently along X, Y, and Z using 1D canonical dyadic intervals:

- A stored cell (`Address`) has 1 span per axis.
- A scoped subscription (`Bounds`) decomposes into at most `2 * bits - 2` 1D spans per axis — **never** a cubic 3D Cartesian product.
- Queries pick the **single cheapest restricted axis** via `plan()` in O(bits), then filter candidates using exact integer `Bounds` containment or overlap.
- Cached region queries use an LRU cache (bounded by entry count and total cached keys) with selective `Bounds`-based invalidation on cell creation or pruning.

### `ProximityIndex` (Best-First Distance Traversal)

`ProximityIndex` organizes occupied cells in a 3-axis hierarchical partition structure using compact numeric radix-27 step codes (`0..26`) and flat 6-number bounding boxes on min-heap traversal entries. It yields cells in exact ascending Euclidean distance order using bounding-box lower bounds.

### Direct Semantic & Placement Indexes

- `fieldIndex` (`field → scalarKey → Set<Attachment>`) and optional `tagIndex` (`tag → Set<Attachment>`) store live attachment object references directly — zero string-key serialization or parsing on query paths.
- `placementIndex` tracks all cell keys occupied by each `ContentId`, powering `placements()`, `detachAll()`, `orphans()`, and reverse-routed `spatial:change` events on shared payload updates.

## Query Planners

- **Region queries (`search` / `searchContent`)**:
  1. Empty semantic bucket → O(1) immediate return.
  2. Exact point query (`!overlap` on a 1×1×1 cell) → O(1) direct `cells.get(key)` lookup, bypassing both indexes and the query cache.
  3. Otherwise compares the smallest indexed semantic bucket size against the spatial candidate count (from cache or `RegionIndex.plan()`) and chooses the cheaper scan path.
- **Distance queries (`nearest` / `radius`)**:
  1. Empty semantic bucket → O(1) immediate return.
  2. Sparse indexed semantic bucket → scores matching attachments directly with `distanceSquared()` and sorts, avoiding a full proximity traversal when looking for rare entities in a dense world.
  3. Otherwise traverses `ProximityIndex` best-first.

## Invariant Checking (`validate()`)

Calling `world.validate()` verifies every internal invariant against ground truth:

- Every cell's key, address, bounds, attachments, and non-empty status
- Every `RegionIndex` exact and prefix posting bucket (both cells and scoped subscriptions)
- Every `ProximityIndex` partition count and leaf key set
- Full rebuild comparison of `placementIndex`, `fieldIndex`, `tagIndex`, and cached query results

## Known Limits & Design Boundaries

- **Exact 3D extent fragmentation**: placing large unaligned 3D boxes decomposes into the Cartesian product of 1D intervals per axis. Use `maxBoxes` to guard against surprises or `cover(region)` for an explicit single-cell placement.
- **Synchronous & in-memory**: no persistence, worker threads, distributed consensus, or async middleware/batches are built in.
- **Not a security sandbox**: plugins and middleware run in-process with full access to the `Substratum` instance.
- **Live payloads**: metadata is deep-copied and frozen, while content payloads and custom event data remain live references for zero-copy ergonomics.
- **Discrete/rule-driven throughput**: optimized for multi-agent simulations, spatial blackboards, turn-based/tactical rule engines, robotics/warehouse state, and geofencing rather than 60fps continuous physics over tens of thousands of moving bodies.
