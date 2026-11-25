# Core Concepts

Before diving into regions, queries, and events, it helps to understand the three layers Substratum uses to represent space: **Content**, **Attachments**, and **Cells**.

| Layer | Identified By | What It Holds |
| --- | --- | --- |
| **Content** | `ContentId<K>` | Your domain payload (`C[K]`). Exists independently of where it is placed. |
| **Attachment** | `(Address, ContentId)` | Places a `ContentId` at a specific cell with placement-specific `metadata` (`kind`, `tags`, etc.). |
| **Cell** | `Address` | A location in 3D space. Can hold `CellMetadata` (terrain, friction, etc.) even when nothing is attached to it. |

## Why Separate Content from Attachments?

In many spatial engines, an object is stored at a single `[x, y, z]` coordinate. In Substratum:

1. **One content record can occupy many cells.** A forest or a large hazard zone can be attached to an entire box of cells while still sharing **one** `ContentId` and **one** payload.
2. **Updating the payload updates it everywhere.** Calling `world.setContent(forestId, nextPayload)` updates the shared record once—no need to hunt down every cell it touches.
3. **Content can exist unattached (as an orphan).** You can `createContent()` before placing it, or `detachAll(id)` without losing the payload.

```ts
// 1. Create content without placing it anywhere yet
const ore = world.createContent('resource', { name: 'Iron Ore', quantity: 50 });

// 2. Attach it at [4, 0, 4] with attachment metadata
world.attachPoint([4, 0, 4], ore, { kind: 'resource', tags: ['mineral'] });

// 3. Move it atomically to [10, 0, 10]
world.moveContent(ore, [10, 0, 10]);

// 4. Detach it everywhere while keeping the payload alive
world.detachAll(ore);
console.log(world.orphans()); // [ore]

// 5. Explicitly clean up unattached records when ready
world.collectOrphans();
```

## Attachment Scope vs. Content Scope

Because one `ContentId` can be attached to multiple cells, Substratum offers two flavours of every query:

- **Attachment-level** (`search`, `nearest`, `radius`): yields **one result per matching cell attachment**. Useful when you care about *every* cell a large object occupies.
- **Content-level** (`searchContent`, `nearestContent`, `radiusContent`): deduplicates by `ContentId` so each matching entity is yielded **at most once** (and for distance queries, reports the minimum distance across its placements).

## Cell Metadata

Cells themselves can carry metadata unrelated to any attached entity—for example, floor terrain or room properties:

```ts
const cell = world.point([4, 0, 4]);
world.setCellMetadata(cell, { terrain: 'wet-concrete', friction: 0.3 });

console.log(world.getCell(cell)?.metadata); // { terrain: 'wet-concrete', friction: 0.3 }
```

Use `world.clearCell(cell)` (or `world.clearPoint([4, 0, 4])`) to remove all attachments and metadata at that exact cell.
