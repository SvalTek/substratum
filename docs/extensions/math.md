# Math Primitives (`@svaltek/substratum/math`)

Pure numerical, vector, kernel, normalization, and statistical primitives with **zero dependency on Substratum**. Every other analytical extension builds on this module, and you can import it standalone.

```ts
import {
    cosineSimilarity,
    gaussian,
    softmax,
    WelfordAccumulator,
} from '@svaltek/substratum/math';
```

## Vectors & Similarity

All vector functions accept `Vector` (`readonly number[]`) and throw `RangeError` if two vectors have different lengths.

| Function | Description |
| --- | --- |
| `dot(a, b)` | Inner product $\sum a_i b_i$ |
| `norm(v)` / `squaredNorm(v)` | Euclidean ($L_2$) norm and squared norm |
| `normalizeVector(v)` | Unit-length $L_2$ copy (returns a zero vector if `norm(v) === 0`) |
| `add(a, b)` / `subtract(a, b)` | Element-wise addition / subtraction |
| `scale(v, factor)` | Scalar multiplication |
| `lerp(a, b, t)` | Linear interpolation $a + t(b - a)$ |
| `euclideanDistance(a, b)` | $L_2$ distance |
| `squaredDistance(a, b)` | Squared $L_2$ distance |
| `manhattanDistance(a, b)` | $L_1$ distance |
| `cosineSimilarity(a, b)` | Cosine similarity in $[-1, 1]$ (returns `0` if either vector has zero norm) |
| `cosineDistance(a, b)` | `1 - cosineSimilarity(a, b)` |
| `vectorDistance(a, b, metric?)` | Dispatch across `'euclidean' \| 'squaredEuclidean' \| 'cosine' \| 'manhattan'` |

## Kernels & Weighting

| Function | Signature | Description |
| --- | --- | --- |
| `gaussian` | `(distance: number, sigma = 1) => number` | $\exp(-d^2 / (2\sigma^2))$ |
| `inverseDistance` | `(distance: number, power = 1, epsilon = 1e-6) => number` | $(d + \epsilon)^{-p}$ |
| `epanechnikov` | `(distance: number, bandwidth = 1) => number` | Compact-support kernel returning `0` for $\|d\| \ge \text{bandwidth}$ |

## Normalizers

| Function | Signature | Description |
| --- | --- | --- |
| `softmax` | `(temperature = 1) => (scores: readonly number[]) => number[]` | Returns a numerically stable (max-shifted) softmax normalizer |
| `softmaxWeights` | `(scores: readonly number[], temperature = 1) => number[]` | Direct softmax computation |
| `l1Normalize` | `(values: readonly number[]) => number[]` | Divides by $\sum \|v_i\|$ |
| `l2Normalize` | `(values: readonly number[]) => number[]` | Alias for `normalizeVector` |
| `minMaxNormalize` | `(values: readonly number[]) => number[]` | Scales values to $[0, 1]$ |

## Batch & Online Statistics

| Function / Class | Description |
| --- | --- |
| `mean(values)` | Arithmetic mean (`0` for empty input) |
| `variance(values, sample = false)` | Population (`sample = false`) or Bessel-corrected sample variance |
| `stdDev(values, sample = false)` | Square root of `variance` |
| `covariance(xs, ys, sample = false)` | Population or sample covariance |
| `correlation(xs, ys)` | Pearson correlation coefficient in $[-1, 1]$ |
| `histogram(values, bins = 10, range?)` | Returns `{ counts, edges, probabilities }` |
| `entropy(countsOrProbs, base = 2)` | Shannon entropy in `base` (auto-normalizes raw counts) |
| `dominance(countsOrProbs)` | Berger-Parker dominance ($\max p_i$) in $[0, 1]$ |
| `mutualInformation(xs, ys, base = 2)` | Discrete mutual information between two parallel observation arrays |
| `WelfordAccumulator` | Online mean/variance accumulator with `push(value)`, `reset()`, and `snapshot()` |
