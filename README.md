# Substratum

**A reactive spatial runtime for composable systems.**

Substratum combines a typed shared content store, dual region/proximity spatial indexes, and a synchronous plugin runtime. Place content across positions or regions, discover what applies nearby, and let independent systems coordinate and enforce rules through a shared spatial context.

The indexing structures are implementation details. The public abstraction is a programmable environment.

## Development

The library uses standard TypeScript and ECMAScript APIs, with no runtime dependencies. Bun is the intended local development runtime; no Bun-specific APIs are used in the library.

```sh
bun install
bun run typecheck
bun run test
bun run example
bun run benchmark
```

`bun run test` executes the portable assertion suite and checks the compile-time type contracts. The suite is deliberately not dependent on a runtime-specific test framework.

The package root exports the TypeScript source. `bun run build:bundle` is optional and creates the standalone ESM bundle under `dist/` for runtimes that cannot load the source directly or need an offline artifact.

Node.js 22.6+ with type stripping enabled can run the same source tests:

```sh
npm install
npm run test:node
node --experimental-strip-types examples/warehouse.ts
```

Deno can run the source directly (`deno run examples/warehouse.ts`); use `deno check src/mod.ts` for an additional runtime-specific check. The package root resolves to `src/mod.ts` for TypeScript-aware runtimes and toolchains. Node.js 22.6+ can run checkout source with type stripping, but Node.js refuses to strip TypeScript files inside `node_modules`; installed Node.js consumers should import `@svaltek/substratum/bundle`. The standalone ESM bundle is optional: build it explicitly when a runtime cannot load TypeScript source or needs an offline artifact. Browser apps need a build tool or the bundle. Default ID creation requires `globalThis.crypto.randomUUID()`; an `idFactory` can supply IDs in other environments.

The package and JSR manifests use the intended name `@svaltek/substratum`. This source distribution is **not published**. Package scope ownership, registry availability and a project licence must be confirmed before publication. No licence has been assigned in this draft.

## Quickstart

The package root `@svaltek/substratum` exports the TypeScript source at `./src/mod.ts`. For local source development, importing from `./src/mod.ts` is also supported. The optional standalone ESM artifact is available at `@svaltek/substratum/bundle` after running `bun run build:bundle`.

```ts
import { Substratum } from './src/mod.ts';

interface Content {
    resource: { name: string; quantity: number; renewable: boolean };
    hazard: { name: string; active: boolean };
}
interface Metadata {
    confidence?: number;
    faction?: string;
}
interface Events {
    observation: { observer: string; confidence: number };
}

const world = new Substratum<Content, Metadata, Events>({
    indexedFields: ['confidence', 'faction'],
    indexedTags: true,
});

const forest = world.putPoint(
    [40, 0, 24],
    { kind: 'resource', tags: ['wood', 'forest'], confidence: 0.95 },
    { name: 'Oak woodland', quantity: 120, renewable: true },
    { extent: [32, 1, 32] },
);

for (const result of world.nearestContent([0, 0, 0], {
    kind: 'resource', tags: ['wood'], limit: 5,
})) {
    console.log(result.distance, result.content.quantity);
    // result.content.active is a compile-time error.
}

world.setContent(forest, {
    name: 'Oak woodland', quantity: 110, renewable: true,
});
```

The three generic parameters define the content schema (kind to payload), shared attachment metadata and custom events respectively. `kind` and `tags` are built-in metadata fields. Content IDs are branded by kind; `getContent(forest)` therefore returns the resource payload without a cast. A `kind` query narrows its result automatically; without one, results are discriminated unions that narrow using `result.kind`.

Schema declarations are compile-time contracts, not runtime payload validators. Middleware can validate untrusted inputs. Use `Substratum<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>` for an open, dynamically typed schema, or omit generic arguments if no custom events are needed.

## Spatial model

A cell `Address` is `readonly [string, string, string]`, with independent binary prefixes for X, Y and Z. Empty prefixes leave an axis unrestricted. The default 16-bit signed coordinate domain is -32768 to 32767 inclusive; configure `bits` from 1 to 32. Coordinates are integer lattice positions, not continuous volumes. Each additional digit halves its axis interval.

Queries, subscriptions and `emitAt` accept any `Region`:
- a canonical cell `Address` (e.g., `['', world.encode(0), '']` for floor 0, `['1', '', '']` for the eastern half),
- inclusive integer `Bounds` (e.g., `[[0, 64], [0, 0], [-64, 64]]`), or
- a `BoxRegion` (`{ at: [x, y, z], extent?: Extent }`).

```ts
const ground = ['', world.encode(0), ''] as const;
for (const result of world.searchContent(ground, { overlap: true })) {
    console.log(result.kind, result.content);
}
for (const result of world.searchContent([[0, 64], [0, 0], [0, 64]], { overlap: true })) {
    console.log(result.kind, result.content);
}
```

Containment is the default. `overlap: true` includes intersecting cells, including larger cells containing the query. Extents specify full dimensions, not radii, and are centred on the integer anchor (even widths include one extra unit on the negative side). `decompose(region)` returns a disjoint exact cover of aligned cells (with an optional `maxBoxes` guard to prevent unexpected 3D fragmentation). `cover(region)` returns the single tightest enclosing cell address when an explicit coarse cover is desired. A single logical object may occupy multiple cells.

Distances are Euclidean distances to the nearest inclusive lattice position of a cell. Fractional origins are supported; stored positions are integer. `nearest()` and `radius()` yield attachments; their `Content` variants yield unique content IDs. The distance of an entity is the minimum distance over its matching placements. Ties and ordinary query order are unspecified. Use materialised results before changing the runtime during iteration.

### Content, attachments and cells

- A `ContentId` refers to a payload of a fixed kind. Payloads can be shared across disjoint cells.
- An attachment couples one content ID to one cell address with its own metadata. Different IDs at the same cell do not overwrite each other. A single ID can have different metadata at different cells.
- Cell metadata belongs to a cell itself, independent of attached content. A cell with metadata can exist without attachments.

`put` and `putPoint` create new content and attach it atomically. `createContent` creates an unattached payload; `attach` and `attachPoint` place an existing ID. Metadata is copied and recursively frozen. It must consist of plain, acyclic objects, arrays and scalar values. Payloads are arbitrary JavaScript values and remain live references. `touchContent(id)` announces an in-place edit, but cannot undo that edit.

## Reactive behaviour

```ts
const stop = world.on('observation', event => {
    console.log(event.data.observer, event.regions);
}, { region: [[0, 64], [0, 0], [0, 64]] });

world.emitAt('observation', world.point([12, 0, 8]), {
    observer: 'Atlas', confidence: 0.8,
});
stop();
```

`emit` broadcasts a non-spatial custom event to global subscribers. `emitAt` sends one event to global subscribers and spatial subscribers whose region intersects the event region. Scoped listeners receive only matching cell addresses, not clipped intersection boxes, and are delivered at most once per event even across multi-cell regions. All subscriptions return idempotent disposers.

A successful outer transaction emits one `spatial:change` containing the union of affected addresses, the raw `changes` list, and a lazy, typed `transitions` array grouped per content ID (`added`, `updated`, `removed`, `contentChanged`, `contentOperation`). Shared payload updates use the placement index, so disconnected placements are included automatically. A scoped listener receives only changes, regions and transitions intersecting its subscription. Changes without any spatial addresses still have their ordinary mutation lifecycle events.

## Middleware and plugins

Plugins are installers. They can register middleware, events and nested plugins. They are not tick functions. `use()` owns registrations made synchronously during installation, and returns an idempotent disposer that releases registrations in reverse order. Optional installer cleanup is supported. Later registrations and state created by an installer remain caller-managed. Installation is not a data transaction.

```ts
const uninstall = world.use(space => {
    space.middleware((ctx, next) => {
        if (ctx.target === 'attachment' && ctx.operation !== 'remove') {
            if ((ctx.metadata.confidence ?? 1) < 0) return; // veto
        }
        next();
    });

    space.on('update', dt => {
        // dt is a number; the caller supplies its time unit.
        console.log('Tick', dt);
    });
});
world.update(0.016);
uninstall();
```

`world.update(dt)` drives three synchronous lifecycle phases in order: `'update:before'`, `'update'`, and `'update:after'`.

Mutation contexts are discriminated by `target` (`'content' | 'attachment' | 'cell'`), `operation` and (for content and attachments) `kind`. A middleware continuation must be called once, synchronously, or omitted to reject the mutation. Return values are ignored. A continuation may replace the proposed value using a typed patch:

```ts
world.middleware((ctx, next) => {
    if (ctx.target === 'content' && ctx.kind === 'resource' && ctx.operation !== 'remove') {
        next({ target: 'content', kind: 'resource', payload: {
            ...ctx.payload, quantity: Math.max(0, ctx.payload.quantity),
        }});
        return;
    }
    next();
});
```

A patch must match the target and kind of the proposal; it cannot redirect addresses, IDs or operations. Middleware may inspect provisional state, but cannot initiate writes. Post-commit listeners can initiate writes. Event delivery is synchronous with FIFO queuing for reentrant events; `maxEvents` bounds additional cascade deliveries (default 10,000). Keep callbacks synchronous; async callbacks and concurrent access are not supported.

The complete `examples/warehouse.ts` demonstrates independent alarm and safety plugins, shared hazards, rejected movement and recovery after clearing a hazard.

## Transactions

Every public write is atomic with respect to internal data and indexes. `batch()` adds nested savepoints and consolidates spatial notifications:

```ts
try {
    world.batch(() => {
        world.putPoint([1, 0, 1], { kind: 'resource' }, {
            name: 'Wood', quantity: 1, renewable: false,
        });
        throw new Error('cancel');
    });
} catch { /* the insertion was rolled back */ }
```

A middleware veto throws `MutationRejected`. Transaction exceptions roll back internal data and discard deferred events. A nested exception caught inside the outer callback rolls back only the nested savepoint. External side effects, registration changes, generated IDs, query-cache eviction and in-place payload mutations are not rolled back. Pre-commit `mutation:before` and `mutation:veto` are immediate; `mutation:add`, `mutation:update`, `mutation:remove`, `mutation:after` and `spatial:change` are delivered after the outer commit. A post-commit observer exception throws `EventDispatchError`; the committed data remains committed, and undelivered queued events are discarded.

## API reference

| Method | Purpose |
| --- | --- |
| `encode`, `decode`, `point`, `bounds`, `decompose`, `cover` | Convert coordinates, bounds, regions and aligned cells |
| `put`, `putPoint` | Create content with an attachment or an extent |
| `createContent`, `getContent`, `hasContent`, `setContent`, `touchContent`, `removeContent` | Manage typed shared payloads |
| `attach`, `attachPoint`, `updateAttachment`, `detach`, `detachAll` | Place, update, or detach content across cells |
| `placements`, `moveContent` | Inspect or atomically relocate all placements of a content ID |
| `getCell`, `setCellMetadata`, `searchCells`, `clearCell`, `clearPoint` | Inspect, annotate, or clear cells |
| `search`, `searchContent` | Query attachments or unique payloads across any `Region` |
| `nearest`, `nearestContent`, `radius`, `radiusContent` | Distance queries with optional semantic criteria |
| `orphans`, `collectOrphans` | Discover or explicitly delete unattached payloads |
| `on`, `emit`, `emitAt` | Global and region-scoped event handling |
| `middleware`, `batch` | Validation, transformation and atomic operations |
| `use`, `update` | Install plugins and drive update lifecycle phases |
| `stats`, `validate` | Inspect runtime sizes and check index consistency |

Queries accept `kind`, `where` (exact field equality), `tags` (all requested tags must match) and arbitrary `filter(metadata)`. The kind index is always enabled. Configure `indexedFields` for additional scalar equality indexes and `indexedTags` for tag indexing. Unindexed fields and non-scalar values still work through predicates/equality checks. `nearest` variants take `limit` (default 1). `search` variants take an optional `Region` (default `ALL`). Query results include `address`, `id`, `kind`, `metadata`, and `content`; distance results add `distance`.

`moveContent` replaces **all** placements with one exact new extent and preserves the ID and payload. Unchanged cells are reused. Heterogeneous attachment metadata or unattached content requires explicit replacement metadata. `detachAll` removes all placements but retains content. `removeContent` refuses to delete attached content. `clearCell` clears all attachments and cell metadata at exactly the supplied address; descendants remain.

## Internals and limits

- `RegionIndex` maintains independent 1D axis postings so containment and overlap queries select candidates from the cheapest restricted axis without cubic 3D blowup on arbitrary `Bounds` queries or subscriptions. The same reusable index routes scoped subscriptions.
- `ProximityIndex` maintains hierarchical 3-axis numeric partitions (radix 27) for best-first distance traversal using flat bounding-box lower bounds; sparse semantic queries short-circuit directly to indexed attachment sets.
- Semantic indexes store live attachment references directly (no string-key serialization on query paths). The placement index tracks all cells occupied by each content ID. Cached region queries use exact `Bounds` invalidation.
- Exact extent decomposition can produce many cells for poorly aligned 3D extents. No approximation is applied implicitly; pass `maxBoxes` to guard against unexpected fragmentation or use `cover(region)` for an explicit enclosing cell.
- This is an in-memory, synchronous runtime. No persistence, worker coordination, distributed state or domain-specific behaviour is built in. It is not an authorisation sandbox for untrusted plugins.
- `idFactory`, if supplied, must return globally unique nonempty strings for the lifetime of IDs; duplicate currently stored IDs are rejected. Branded IDs are compile-time types, not capabilities.
- Custom event data and payloads are not deep-frozen or copied. Consumers should treat event payloads as shared values. Query generators should not be used as stable snapshots across writes.

## Benchmarks

Measured with Bun 1.3.14 via `bun run benchmark` and `bun run benchmark:extensions`:

### Core Runtime (`benchmarks/index.ts`)

| Benchmark | Result |
| --- | --- |
| 10,000 point inserts | `571.96 ms` |
| Cold layer query (628 results) | `5.893 ms` |
| Warm layer query (median) | `0.391 ms` |
| Point query median (with kind / without kind) | `0.0128 ms` / `0.0117 ms` |
| Cold unaligned 3D `Bounds` query (319 results) | `3.985 ms` |
| Nearest 10 in 10k world | `2.110 ms` |
| Rare kind nearest 2 (median) | `0.0132 ms` |
| 200 agents x 60 ticks (12,000 `moveContent` calls) | `775.67 ms` (`12.93 ms/tick`) |
| `emitAt` with 0 / 100 / 1,000 / 5,000 nonmatching subscribers | `7.068` / `10.568` / `11.087` / `8.210 µs/event` |

### Computational Extensions (`benchmarks/extensions.ts`)

| Benchmark | Median Time |
| --- | --- |
| `math`: 10,000 x 384-D `cosineSimilarity` | `3.118 ms` |
| `math`: 1,000 x `softmax(0.7)` over 1,000 scores | `11.620 ms` |
| `attention`: `attend(radius=64, limit=20)` on 10k world | `2.557 ms` |
| `statistics`: `analyse(6 metrics)` over ~1.5k hits in 10k world | `10.627 ms` |
| `statistics`: `observeStatistics` across 200 batched inserts | `6.930 ms` |
| `clustering`: `dbscan(1,000 points, eps=6, minSamples=4)` | `18.948 ms` |
| `associations`: 5,000 `reinforce` + 500 `related` + `decay` | `5.851 ms` |
| `som`: 200 `train()` steps on 8x8x4 (256 nodes) x 128-D | `7.305 ms` |
| `som`: 500 `project()` calls on 256 nodes x 128-D | `13.741 ms` |
| `propagation`: 10 `step()` rounds over 500 spatial nodes | `3.944 ms` |
| `persisted associations`: 500 `reinforce` + `decay` (content + attachments) | `1.961 ms` |
| `persisted som`: 50 `train()` steps on 256 persisted nodes x 64-D | `9.462 ms` |
| `composed clustering` (`preserveIdentity`): 20 moves across 200 pts | `6.004 ms` |
| `composed pipeline`: `associations` → `propagation(5 steps)` → `attend` | `0.886 ms` |

## Verification

Verified with Bun 1.3.14, Node.js 22.23.1, and TypeScript 5.8.3, covering strict type contracts with intentional negative assertions, 19 runtime tests, 8 extension test groups, 100 exact extent-cover checks, 200 differential `Bounds`/`BoxRegion` spatial checks, 400 differential spatial/proximity checks, 50 sparse semantic distance checks, 100 differential `Address` subscription-routing checks, and 100 differential `Bounds`/`BoxRegion` subscription-routing checks.
