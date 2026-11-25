# Content & Cells API

Methods for managing shared content payloads, cell attachments, and cell-level metadata.

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

## Placements & Attachments

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

## Cells

| Method | Signature | Description |
| --- | --- | --- |
| `getCell` | `(address: Address) => CellSnapshot<C, M> \| undefined` | Inspect a cell's metadata and attachments. |
| `searchCells` | `(region?: Region, options?: { overlap?: boolean; filter? }) => IterableIterator<CellSnapshot<C, M>>` | Iterate occupied cells matching a region and optional metadata filter. |
| `setCellMetadata` | `(address: Address, metadata: CellMetadata) => Address` | Set or clear (`{}`) metadata belonging to a cell itself. |
| `clearCell` | `(address: Address) => boolean` | Detach all content and clear cell metadata at an exact cell (descendants remain). |
| `clearPoint` | `(xyz: Vec3) => boolean` | Convenience wrapper around `clearCell(point(xyz))`. |
