# Activation & Message Passing (`@svaltek/substratum/propagation`)

A step-based spreading-activation engine for propagating numerical signals across Substratum content relationships without turning synchronous event cascades into unbounded loops.

```ts
import {
    createPropagation,
    createPropagationPlugin,
} from '@svaltek/substratum/propagation';
```

## Stepping Activation

```ts
const network = createPropagation(world, {
    decay: 0.1,
    threshold: 0.05,
    maxIterations: 32,
    aggregation: 'sum',
    activation: 'tanh',
    radius: 16,
});

network.activate(contentId, 1.0);
network.step(); // advance one synchronous round
// or: network.run(32, 1e-4);

const active = network.getActive();
```

By default, neighbours are resolved spatially via `world.radiusContent` (memoized and automatically invalidated on `spatial:change`), weighted by `1 / (1 + distance)`. You can supply any custom graph via `neighbors(id, world)` — for example, reading edges from `@svaltek/substratum/associations`:

```ts
const network = createPropagation(world, {
    neighbors: id => associations.related(id).map(e => ({ id: e.target, weight: e.weight })),
});
```

## Driving Propagation on `world.update(dt)`

Use `createPropagationPlugin(network, { stepsPerUpdate })` to advance propagation automatically on each `update` tick:

```ts
const stop = world.use(createPropagationPlugin(network, { stepsPerUpdate: 1 }));
world.update(0.016);
```

### Options Reference

| Option | Default | Description |
| --- | --- | --- |
| `decay` | `0.1` | Fraction of retained activation decayed each step (`[0, 1]`) |
| `threshold` | `0.05` | Minimum `\|activation\|` retained after a step |
| `maxIterations` | `32` | Default iteration cap for `run()` |
| `aggregation` | `'sum'` | How incoming neighbour messages are combined: `'sum' \| 'mean' \| 'max'` |
| `activation` | `'tanh'` | Transfer function: `'tanh' \| 'relu' \| 'sigmoid' \| 'linear'` or custom `(x) => number` |
| `radius` | `16` | Radius used by the default spatial neighbour resolver |
| `neighbors` | spatial radius | Custom `(id, world) => NeighborLink[]` resolver |
| `onStep` | — | Hook called with `(activeMap, iteration)` after each step |
