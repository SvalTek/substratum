# Events, Middleware & Plugins API

## Events & Subscriptions

| Method | Signature | Description |
| --- | --- | --- |
| `on` | `(name, handler, options?: { region?: Region }) => Dispose` | Subscribe globally or to a `Region` (spatial events only). |
| `emit` | `(name, data) => void` | Broadcast a custom non-spatial event. |
| `emitAt` | `(name, region: Region, data, options?: BoxOptions) => void` | Emit a custom event routed to global and intersecting scoped listeners. |

### Built-in Lifecycle Events

- **Pre-commit (immediate, cannot initiate writes):** `'mutation:before'`, `'mutation:veto'`
- **Post-commit (queued FIFO):** `'mutation:add'`, `'mutation:update'`, `'mutation:remove'`, `'mutation:after'`, `'spatial:change'`
- **Frame/step tick (driven by `update(dt)`):** `'update:before'`, `'update'`, `'update:after'`

## Middleware, Transactions & Plugins

| Method | Signature | Description |
| --- | --- | --- |
| `middleware` | `(handler: Middleware<C, M>) => Dispose` | Register synchronous validation/transformation middleware. |
| `batch` | `<T>(run: () => T) => T` | Execute a synchronous atomic transaction with nested savepoints. |
| `use` | `(installer: Plugin<C, M, E>) => Dispose` | Install a synchronous plugin with automatic reverse-order teardown. |
| `update` | `(dt: number) => void` | Drive `'update:before'`, `'update'`, and `'update:after'` phases. |
| `stats` | `() => Stats` | Snapshot of `cells`, `attachments`, `contents`, `orphans`, `partitions`, `subscriptions`, `scopedSubscriptions`, `cachedQueries`, `semanticBuckets`. |
| `validate` | `() => void` | Assert internal consistency across all indexes and caches; throws on mismatch. |

## Errors

- **`MutationRejected`**: thrown when middleware vetoes a write (carries `.mutation`).
- **`EventDispatchError`**: thrown when a post-commit observer throws or cascade exceeds `maxEvents` (carries `.cause`; committed state remains intact).
