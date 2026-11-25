# Getting Started

## What is Substratum?

**Substratum** is a synchronous, in-memory **3D spatial runtime** for TypeScript and JavaScript. Think of it as a shared 3D integer grid combined with a typed object store and a region-aware event bus.

You use it when multiple independent parts of your program—simulation agents, safety rules, sensors, analytics, UI—need to read, write, query, and react to the same 3D space without coupling directly to one another.

Substratum gives you three building blocks:

1. **A 3D integer space** where you place items at points `[x, y, z]` or across rectangular boxes.
2. **Fast spatial + attribute queries** (`search`, `nearest`, `radius`) that find what is inside a region or near a point.
3. **Synchronous reactivity & rules** (`on`, `middleware`, `batch`) so listeners react to spatial changes and rules can transform or veto invalid writes before they commit.

## Your First World

You don't need any configuration to start. Create a `Substratum` instance, place an item at `[x, y, z]`, query nearby items, and update it:

```ts
import { Substratum } from '@svaltek/substratum';

const world = new Substratum();

// Place a resource at [40, 0, 24]
const tree = world.putPoint(
    [40, 0, 24],
    { kind: 'resource', tags: ['wood'] },
    { name: 'Oak', quantity: 120 },
);

// Find the closest item within 50 units of [0, 0, 0]
for (const hit of world.radiusContent([0, 0, 0], 50, { kind: 'resource' })) {
    console.log(hit.distance, hit.content);
}

// Update the resource's payload in place
world.setContent(tree, { name: 'Oak', quantity: 110 });
```

Notice the three arguments to `putPoint(xyz, metadata, payload)`:
- `xyz`: where to place it (`[40, 0, 24]`).
- `metadata`: small searchable labels (`kind`, `tags`, and any custom fields).
- `payload`: the domain object itself (`{ name: 'Oak', quantity: 120 }`).

Next, [Core Concepts](/guide/core-concepts) explains why Substratum separates **content**, **attachments**, and **cells**.

## Adding Compile-Time Type Safety

Once your domain grows, you can pass three optional TypeScript interfaces to `new Substratum<Content, Metadata, Events>(options)`:

```ts
import { Substratum } from '@svaltek/substratum';

interface Content {
    resource: { name: string; quantity: number };
    hazard: { name: string; active: boolean };
}

interface Metadata {
    confidence?: number;
    faction?: string;
}

interface Events {
    alarm: { name: string };
}

const world = new Substratum<Content, Metadata, Events>({
    indexedFields: ['confidence', 'faction'],
    indexedTags: true,
});
```

With those interfaces in place:
- Returned IDs are **branded by kind** (`ContentId<'resource'>`), so `world.getContent(tree)` is automatically typed as `{ name: string; quantity: number }`.
- Passing `{ kind: 'resource' }` to any query automatically narrows `hit.content` to `{ name: string; quantity: number }`.
- Setting `indexedFields` and `indexedTags: true` tells Substratum to maintain fast lookup indexes for `where` and `tags` filters.

> **Note:** TypeScript interfaces are compile-time contracts. To validate untrusted data at runtime, use [Middleware & Plugins](/guide/middleware-and-plugins).

## Runtimes & Installation

Install `@svaltek/substratum` in your project:

```sh
bun add @svaltek/substratum
# or: npm install @svaltek/substratum
```

Substratum has zero runtime dependencies and uses standard ES2022 APIs (`globalThis.crypto.randomUUID()` by default, overridable via `idFactory`).

| Runtime | How to Run |
| --- | --- |
| **Bun** | Imports `@svaltek/substratum` TypeScript source directly |
| **Node.js 22.6+** | Runs TypeScript source with `node --experimental-strip-types`; installed consumers use `@svaltek/substratum/bundle` |
| **Node.js 20+** | Imports the prebuilt ESM bundle `@svaltek/substratum/bundle` |
| **Deno** | Imports TypeScript source directly |
| **Browsers** | Uses your bundler or `@svaltek/substratum/bundle` |

### Repository Development Commands

If you are working from a local checkout of the repository:

```sh
bun install
bun run test          # typecheck + runtime & extension tests
bun run example       # run examples/warehouse.ts
bun run benchmark     # run core microbenchmarks
bun run build:bundle  # emit dist/substratum.esm.js + dist/extensions/*.js
```
