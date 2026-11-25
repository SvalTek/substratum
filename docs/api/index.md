# API Reference

The Substratum API is organized into three domain references plus the optional computational extensions:

- **[Content & Cells](/api/content-and-cells)** — creating, updating, placing, moving, detaching, and inspecting content and cell metadata.
- **[Queries & Geometry](/api/queries-and-geometry)** — `search`, `nearest`, `radius`, `QueryOptions`, and `Region` / `Geometry` helpers.
- **[Events, Middleware & Plugins](/api/events-and-plugins)** — `on`, `emit`, `emitAt`, `middleware`, `batch`, `use`, `update`, `stats`, `validate`, and error classes.
- **[Computational Extensions](/extensions/)** — `@svaltek/substratum/math`, `/attention`, `/statistics`, `/clustering`, `/associations`, `/som`, `/propagation`.

## Root Exports (`@svaltek/substratum`)

```ts
export { Substratum, MutationRejected } from './substratum.ts';
export { EventDispatchError } from './internal/events.ts';
export { Geometry, ALL } from './geometry.ts';
export type * from './types.ts';
```

## `new Substratum<C, M, E>(options?)`

Creates an isolated, synchronous spatial runtime.

- `C`: mapping of content kind name → payload type (defaults to `Record<string, unknown>`).
- `M`: shared attachment metadata fields (defaults to `Record<string, unknown>`).
- `E`: custom event name → event data type (defaults to `Record<never, never>`).

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `bits` | `number` | `16` | Signed coordinate bit width (`1`–`32`). Domain is `[-2^(bits-1), 2^(bits-1) - 1]`. |
| `indexedFields` | `readonly (keyof M \| 'kind')[]` | `['kind']` | Scalar attachment metadata fields to index for equality queries (`'kind'` is always indexed). |
| `indexedTags` | `boolean` | `false` | Enable inverted tag indexing for `tags` queries. |
| `maxEvents` | `number` | `10000` | Maximum cascaded reentrant event deliveries per dispatch cycle. |
| `idFactory` | `() => string` | `crypto.randomUUID` | Custom content ID generator (must return unique non-empty strings). |
