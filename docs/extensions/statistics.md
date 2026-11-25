# Statistics & Information Theory (`@svaltek/substratum/statistics`)

Compute descriptive statistics, spatial density, and information-theoretic measures over any Substratum `Region` — either on demand with `analyse()` or reactively with `observeStatistics()`.

```ts
import { analyse, observeStatistics } from '@svaltek/substratum/statistics';
```

## One-Shot Analysis (`analyse`)

```ts
const stats = analyse(world, region, {
    kind: 'observation',
    groupBy: hit => hit.content.category,
    value: hit => hit.content.confidence,
    metrics: ['count', 'mean', 'variance', 'entropy', 'dominance', 'centroid', 'density'],
});
```

### Supported Metrics

| Metric | Required Extractor | Description |
| --- | --- | --- |
| `'count'` | — | Number of matching hits (always included) |
| `'density'` | — | `count / volume`, where `volume` is the lattice volume of `region` |
| `'centroid'` | — | Mean `[x, y, z]` center of matching cell bounds |
| `'mean'`, `'variance'`, `'stdDev'` | `value` | Distribution of numeric values |
| `'histogram'` | `value` | Binned counts, edges, and probabilities (`bins`, `range`) |
| `'entropy'`, `'dominance'` | `groupBy` | Category diversity (Shannon entropy, base 2) and dominant share, plus `groups` counts |
| `'covariance'`, `'correlation'` | `pair` | Linear relationship between `[x, y]` numeric pairs |
| `'mutualInformation'` | `variables` | Statistical dependence between discrete `[x, y]` pairs |

Pass `scope: 'content'` to deduplicate multi-cell content IDs before computing statistics (default is `'attachment'`).

## Reactive Observation (`observeStatistics`)

`observeStatistics` subscribes to `spatial:change` scoped to `region` and invokes `onChange(statistics, event)` whenever matching attachments or their content payloads change inside the region:

```ts
const stop = observeStatistics(world, region, {
    kind: 'observation',
    groupBy: hit => hit.content.category,
    value: hit => hit.content.confidence,
    emitInitial: true,
    onChange: stats => {
        console.log('Updated mean:', stats.mean, 'entropy:', stats.entropy);
    },
});

// Later:
stop();
```
