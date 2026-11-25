# Getting Started

Substratum is a synchronous, in-memory, reactive spatial runtime with zero runtime dependencies. It combines a typed shared content store, dual region/proximity spatial indexes, transactional middleware, and region-scoped events.

> **Core idea:** The indexing structures are implementation details. The public abstraction is a programmable spatial environment.

## Runtimes & Installation

Substratum uses standard TypeScript and ES2022 APIs (`globalThis.crypto.randomUUID()` by default, overridable via `idFactory`).

| Runtime | Source / Build Usage |
| --- | --- |
| **Bun** | Runs `./src/mod.ts` directly; intended local dev runtime |
| **Node.js 22.6+** | Runs source directly via `node --experimental-strip-types`, or consumes ESM from `dist/` |
| **Node.js 20+** | Consumes compiled ESM (`dist/mod.js`) or single-file bundle (`dist/substratum.esm.js`) |
| **Deno / Browsers** | Runs `./src/mod.ts` or imports the single-file ESM bundle |

### Local development commands

```sh
bun install
bun run typecheck   # strict TypeScript + negative type contract tests
bun run test        # typecheck + portable runtime & differential test suite
bun run example     # run examples/warehouse.ts
bun run benchmark   # run microbenchmarks
bun run build       # compile ESM modules & .d.ts declarations into dist/
bun run build:bundle # emit single-file dist/substratum.esm.js + sourcemap
```

Node.js 22+ equivalents:

```sh
npm install
npm run test:node
npm run build
node --experimental-strip-types examples/warehouse.ts
```

## Quickstart

Define three compile-time schema interfaces — **content** (kind → payload), shared **attachment metadata**, and custom **events** — then construct a `Substratum` instance:

```ts
import { Substratum } from '@svaltek/substratum';

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

// Create shared content and attach it over a 32x1x32 extent
const forest = world.putPoint(
    [40, 0, 24],
    { kind: 'resource', tags: ['wood', 'forest'], confidence: 0.95 },
    { name: 'Oak woodland', quantity: 120, renewable: true },
    { extent: [32, 1, 32] },
);

// Query nearest unique matching content
for (const result of world.nearestContent([0, 0, 0], {
    kind: 'resource',
    tags: ['wood'],
    limit: 5,
})) {
    console.log(result.distance, result.content.quantity);
    // result.content.active -> compile-time error
}

// Update shared payload once; all placements reflect the update
world.setContent(forest, {
    name: 'Oak woodland',
    quantity: 110,
    renewable: true,
});
```

## Schema Contracts & Type Narrowing

- `kind` and `tags` are built-in metadata fields; the `kind` index is always enabled.
- `ContentId<K>` is branded by kind: `getContent(forest)` returns the `resource` payload directly with no cast.
- Passing `kind` to `search`, `searchContent`, `nearest`, `nearestContent`, `radius`, or `radiusContent` narrows every yielded result automatically.
- Without `kind`, results are discriminated unions that narrow cleanly on `result.kind`.
- Schema interfaces are **compile-time contracts**, not runtime validators. Use [middleware](/guide/middleware-and-plugins) to validate untrusted inputs.
- For an open, dynamically typed runtime, use `new Substratum()` (defaults to `Record<string, unknown>`).
