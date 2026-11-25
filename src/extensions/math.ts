/** Pure numerical, vector, kernel, and statistical primitives with no Substratum dependency. */

export type Vector = readonly number[];
export type DistanceMetric = 'euclidean' | 'squaredEuclidean' | 'cosine' | 'manhattan';
export type Normalizer = (scores: readonly number[]) => number[];

export interface HistogramResult {
    readonly counts: readonly number[];
    readonly edges: readonly number[];
    readonly probabilities: readonly number[];
}

export interface WelfordSnapshot {
    readonly count: number;
    readonly mean: number;
    readonly m2: number;
    readonly variance: number;
    readonly sampleVariance: number;
    readonly stdDev: number;
}

function assertSameLength(a: Vector, b: Vector): void {
    if (a.length !== b.length) {
        throw RangeError(`Vector dimension mismatch: ${a.length} !== ${b.length}`);
    }
}

export function dot(a: Vector, b: Vector): number {
    assertSameLength(a, b);
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
    return sum;
}

export function squaredNorm(v: Vector): number {
    let sum = 0;
    for (let i = 0; i < v.length; i++) {
        const x = v[i]!;
        sum += x * x;
    }
    return sum;
}

export function norm(v: Vector): number {
    return Math.sqrt(squaredNorm(v));
}

export function normalizeVector(v: Vector): number[] {
    const n = norm(v);
    if (n === 0) return v.map(() => 0);
    const out = new Array<number>(v.length);
    for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
    return out;
}

export function add(a: Vector, b: Vector): number[] {
    assertSameLength(a, b);
    const out = new Array<number>(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i]! + b[i]!;
    return out;
}

export function subtract(a: Vector, b: Vector): number[] {
    assertSameLength(a, b);
    const out = new Array<number>(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i]! - b[i]!;
    return out;
}

export function scale(v: Vector, factor: number): number[] {
    const out = new Array<number>(v.length);
    for (let i = 0; i < v.length; i++) out[i] = v[i]! * factor;
    return out;
}

export function lerp(a: Vector, b: Vector, t: number): number[] {
    assertSameLength(a, b);
    const out = new Array<number>(a.length);
    for (let i = 0; i < a.length; i++) {
        const ai = a[i]!;
        out[i] = ai + (b[i]! - ai) * t;
    }
    return out;
}

export function squaredDistance(a: Vector, b: Vector): number {
    assertSameLength(a, b);
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        const d = a[i]! - b[i]!;
        sum += d * d;
    }
    return sum;
}

export function euclideanDistance(a: Vector, b: Vector): number {
    return Math.sqrt(squaredDistance(a, b));
}

export function manhattanDistance(a: Vector, b: Vector): number {
    assertSameLength(a, b);
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
    return sum;
}

export function cosineSimilarity(a: Vector, b: Vector): number {
    assertSameLength(a, b);
    let ab = 0;
    let aa = 0;
    let bb = 0;
    for (let i = 0; i < a.length; i++) {
        const ai = a[i]!;
        const bi = b[i]!;
        ab += ai * bi;
        aa += ai * ai;
        bb += bi * bi;
    }
    const denom = Math.sqrt(aa) * Math.sqrt(bb);
    return denom === 0 ? 0 : ab / denom;
}

export function cosineDistance(a: Vector, b: Vector): number {
    return 1 - cosineSimilarity(a, b);
}

export function vectorDistance(a: Vector, b: Vector, metric: DistanceMetric = 'euclidean'): number {
    switch (metric) {
        case 'euclidean': return euclideanDistance(a, b);
        case 'squaredEuclidean': return squaredDistance(a, b);
        case 'cosine': return cosineDistance(a, b);
        case 'manhattan': return manhattanDistance(a, b);
    }
}

export function gaussian(distance: number, sigma = 1): number {
    if (!Number.isFinite(sigma) || sigma <= 0) {
        throw RangeError('sigma must be finite and positive');
    }
    const ratio = distance / sigma;
    return Math.exp(-0.5 * ratio * ratio);
}

export function inverseDistance(distance: number, power = 1, epsilon = 1e-6): number {
    if (!Number.isFinite(epsilon) || epsilon <= 0) {
        throw RangeError('epsilon must be finite and positive');
    }
    return 1 / Math.pow(Math.max(0, distance) + epsilon, power);
}

export function epanechnikov(distance: number, bandwidth = 1): number {
    if (!Number.isFinite(bandwidth) || bandwidth <= 0) {
        throw RangeError('bandwidth must be finite and positive');
    }
    const u = Math.abs(distance) / bandwidth;
    return u >= 1 ? 0 : 0.75 * (1 - u * u);
}

export function softmaxWeights(scores: readonly number[], temperature = 1): number[] {
    if (!Number.isFinite(temperature) || temperature <= 0) {
        throw RangeError('temperature must be finite and positive');
    }
    if (!scores.length) return [];
    let max = -Infinity;
    for (let i = 0; i < scores.length; i++) {
        const s = scores[i]! / temperature;
        if (s > max) max = s;
    }
    const exps = new Array<number>(scores.length);
    let sum = 0;
    for (let i = 0; i < scores.length; i++) {
        const e = Math.exp(scores[i]! / temperature - max);
        exps[i] = e;
        sum += e;
    }
    if (sum === 0) return scores.map(() => 1 / scores.length);
    for (let i = 0; i < exps.length; i++) exps[i]! /= sum;
    return exps;
}

/** Returns a softmax normalizer function for use in attention and ranking pipelines. */
export function softmax(temperature = 1): Normalizer {
    if (!Number.isFinite(temperature) || temperature <= 0) {
        throw RangeError('temperature must be finite and positive');
    }
    return scores => softmaxWeights(scores, temperature);
}

export function l1Normalize(values: readonly number[]): number[] {
    if (!values.length) return [];
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += Math.abs(values[i]!);
    if (sum === 0) return values.map(() => 0);
    return values.map(v => v / sum);
}

export function l2Normalize(values: readonly number[]): number[] {
    return normalizeVector(values);
}

export function minMaxNormalize(values: readonly number[]): number[] {
    if (!values.length) return [];
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < values.length; i++) {
        const v = values[i]!;
        if (v < min) min = v;
        if (v > max) max = v;
    }
    const span = max - min;
    if (span === 0) return values.map(() => 0);
    return values.map(v => (v - min) / span);
}

export function mean(values: readonly number[]): number {
    if (!values.length) return 0;
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[i]!;
    return sum / values.length;
}

export function variance(values: readonly number[], sample = false): number {
    const n = values.length;
    if (n === 0 || (sample && n < 2)) return 0;
    const acc = new WelfordAccumulator();
    for (let i = 0; i < n; i++) acc.push(values[i]!);
    return sample ? acc.sampleVariance : acc.variance;
}

export function stdDev(values: readonly number[], sample = false): number {
    return Math.sqrt(variance(values, sample));
}

export function covariance(xs: readonly number[], ys: readonly number[], sample = false): number {
    assertSameLength(xs, ys);
    const n = xs.length;
    if (n === 0 || (sample && n < 2)) return 0;
    const mx = mean(xs);
    const my = mean(ys);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += (xs[i]! - mx) * (ys[i]! - my);
    return sum / (sample ? n - 1 : n);
}

export function correlation(xs: readonly number[], ys: readonly number[]): number {
    assertSameLength(xs, ys);
    if (xs.length < 2) return 0;
    const mx = mean(xs);
    const my = mean(ys);
    let num = 0;
    let dx2 = 0;
    let dy2 = 0;
    for (let i = 0; i < xs.length; i++) {
        const dx = xs[i]! - mx;
        const dy = ys[i]! - my;
        num += dx * dy;
        dx2 += dx * dx;
        dy2 += dy * dy;
    }
    const denom = Math.sqrt(dx2 * dy2);
    return denom === 0 ? 0 : num / denom;
}

export function histogram(
    values: readonly number[],
    bins = 10,
    range?: readonly [number, number],
): HistogramResult {
    if (!Number.isSafeInteger(bins) || bins < 1) {
        throw RangeError('bins must be a positive integer');
    }
    const counts = new Array<number>(bins).fill(0);
    if (!values.length && !range) {
        return { counts, edges: new Array<number>(bins + 1).fill(0), probabilities: counts.slice() };
    }
    let min = range ? range[0] : Infinity;
    let max = range ? range[1] : -Infinity;
    if (!range) {
        for (let i = 0; i < values.length; i++) {
            const v = values[i]!;
            if (v < min) min = v;
            if (v > max) max = v;
        }
    }
    const span = max - min;
    const width = span === 0 ? 1 : span / bins;
    const edges = new Array<number>(bins + 1);
    for (let i = 0; i <= bins; i++) edges[i] = min + i * width;

    for (let i = 0; i < values.length; i++) {
        const v = values[i]!;
        if (v < min || v > max) continue;
        let idx = span === 0 ? 0 : Math.floor((v - min) / width);
        if (idx >= bins) idx = bins - 1;
        if (idx < 0) idx = 0;
        counts[idx]!++;
    }
    const total = counts.reduce((a, b) => a + b, 0);
    const probabilities = total > 0 ? counts.map(c => c / total) : counts.map(() => 0);
    return { counts, edges, probabilities };
}

export function entropy(countsOrProbs: readonly number[], base = 2): number {
    if (!Number.isFinite(base) || base <= 1) {
        throw RangeError('log base must be finite and > 1');
    }
    let total = 0;
    for (let i = 0; i < countsOrProbs.length; i++) {
        const v = countsOrProbs[i]!;
        if (v > 0) total += v;
    }
    if (total === 0) return 0;
    const logBase = Math.log(base);
    let h = 0;
    for (let i = 0; i < countsOrProbs.length; i++) {
        const v = countsOrProbs[i]!;
        if (v <= 0) continue;
        const p = v / total;
        h -= p * (Math.log(p) / logBase);
    }
    return h;
}

export function dominance(countsOrProbs: readonly number[]): number {
    let total = 0;
    let max = 0;
    for (let i = 0; i < countsOrProbs.length; i++) {
        const v = countsOrProbs[i]!;
        if (v <= 0) continue;
        total += v;
        if (v > max) max = v;
    }
    return total === 0 ? 0 : max / total;
}

export function mutualInformation(
    xs: readonly (string | number)[],
    ys: readonly (string | number)[],
    base = 2,
): number {
    if (xs.length !== ys.length) {
        throw RangeError(`Sample length mismatch: ${xs.length} !== ${ys.length}`);
    }
    if (!Number.isFinite(base) || base <= 1) {
        throw RangeError('log base must be finite and > 1');
    }
    const n = xs.length;
    if (n === 0) return 0;

    const xCounts = new Map<string | number, number>();
    const yCounts = new Map<string | number, number>();
    const joint = new Map<string, number>();

    for (let i = 0; i < n; i++) {
        const x = xs[i]!;
        const y = ys[i]!;
        xCounts.set(x, (xCounts.get(x) ?? 0) + 1);
        yCounts.set(y, (yCounts.get(y) ?? 0) + 1);
        const key = `${typeof x}:${String(x)}\0${typeof y}:${String(y)}`;
        joint.set(key, (joint.get(key) ?? 0) + 1);
    }

    const logBase = Math.log(base);
    let mi = 0;
    for (let i = 0; i < n; i++) {
        const x = xs[i]!;
        const y = ys[i]!;
        const key = `${typeof x}:${String(x)}\0${typeof y}:${String(y)}`;
        const jc = joint.get(key);
        if (jc === undefined) continue;
        joint.delete(key); // process each unique pair once
        const pxy = jc / n;
        const px = xCounts.get(x)! / n;
        const py = yCounts.get(y)! / n;
        mi += pxy * (Math.log(pxy / (px * py)) / logBase);
    }
    return Math.max(0, mi);
}

/** Online numerically stable mean and variance accumulator (Welford's algorithm). */
export class WelfordAccumulator {
    private n = 0;
    private mu = 0;
    private sumSq = 0;

    get count(): number { return this.n; }
    get mean(): number { return this.mu; }
    get m2(): number { return this.sumSq; }
    get variance(): number { return this.n > 0 ? this.sumSq / this.n : 0; }
    get sampleVariance(): number { return this.n > 1 ? this.sumSq / (this.n - 1) : 0; }
    get stdDev(): number { return Math.sqrt(this.variance); }

    push(value: number): void {
        this.n++;
        const delta = value - this.mu;
        this.mu += delta / this.n;
        const delta2 = value - this.mu;
        this.sumSq += delta * delta2;
    }

    reset(): void {
        this.n = 0;
        this.mu = 0;
        this.sumSq = 0;
    }

    snapshot(): WelfordSnapshot {
        return {
            count: this.n,
            mean: this.mu,
            m2: this.sumSq,
            variance: this.variance,
            sampleVariance: this.sampleVariance,
            stdDev: this.stdDev,
        };
    }
}
