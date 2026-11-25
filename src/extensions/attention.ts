import {
    ALL,
    type Bounds,
    type ContentId,
    type Kind,
    type QueryOptions,
    type Region,
    type SearchResult,
    type Substratum,
    type Vec3,
} from '../mod.ts';
import {
    cosineSimilarity,
    dot,
    epanechnikov,
    gaussian,
    inverseDistance,
    l1Normalize,
    l2Normalize,
    minMaxNormalize,
    softmax,
    softmaxWeights,
    type Normalizer,
    type Vector,
} from './math.ts';

export {
    cosineSimilarity,
    dot,
    epanechnikov,
    gaussian,
    inverseDistance,
    l1Normalize,
    l2Normalize,
    minMaxNormalize,
    softmax,
    softmaxWeights,
};

export type AttendHit<C extends object, M extends object, K extends Kind<C> = Kind<C>> =
    SearchResult<C, M, K> & {
        readonly distance?: number;
    };

export type ScoreCombiner<C extends object, M extends object, K extends Kind<C> = Kind<C>> =
    | 'max'
    | 'sum'
    | 'mean'
    | 'min'
    | ((scores: readonly number[], hits: readonly AttendHit<C, M, K>[]) => number);

export interface AttendOptions<C extends object, M extends object, K extends Kind<C> = Kind<C>>
    extends QueryOptions<M, K> {
    /** Spatial search radius when target is a Vec3. */
    readonly radius?: number;
    /** Nearest-neighbor limit when target is a Vec3 (ignored if radius is set). */
    readonly nearest?: number;
    /** Include intersecting multi-cell matches when target is a Region. */
    readonly overlap?: boolean;
    /** Whether to rank individual attachments or deduplicate by ContentId. Default: 'attachment'. */
    readonly scope?: 'attachment' | 'content';
    /** How multiple attachment scores for the same ContentId are combined when scope is 'content'. Default: 'max'. */
    readonly combine?: ScoreCombiner<C, M, K>;
    /** Scoring function for each candidate hit. Default: gaussian(hit.distance ?? 0, 1). */
    readonly score?: (hit: AttendHit<C, M, K>) => number;
    /** Weight normalizer applied after top-K selection. Pass false to keep raw scores as weights. Default: l1Normalize. */
    readonly normalize?: Normalizer | false;
    /** Maximum number of ranked results to return. */
    readonly limit?: number;
}

export interface AttentionResult<C extends object, M extends object, K extends Kind<C> = Kind<C>> {
    readonly hit: AttendHit<C, M, K>;
    readonly score: number;
    readonly weight: number;
}

function isVec3(target: Vec3 | Region): target is Vec3 {
    return Array.isArray(target) && target.length === 3 && typeof target[0] === 'number';
}

function distanceToBounds(xyz: Vec3, b: Bounds): number {
    let d2 = 0;
    for (let i = 0; i < 3; i++) {
        const v = xyz[i]!;
        const [lo, hi] = b[i]!;
        if (v < lo) d2 += (lo - v) * (lo - v);
        else if (v > hi) d2 += (v - hi) * (v - hi);
    }
    return Math.sqrt(d2);
}

function combineScores<C extends object, M extends object, K extends Kind<C>>(
    scores: readonly number[],
    hits: readonly AttendHit<C, M, K>[],
    combiner: ScoreCombiner<C, M, K>,
): number {
    if (typeof combiner === 'function') return combiner(scores, hits);
    switch (combiner) {
        case 'max': {
            let m = -Infinity;
            for (let i = 0; i < scores.length; i++) if (scores[i]! > m) m = scores[i]!;
            return m;
        }
        case 'min': {
            let m = Infinity;
            for (let i = 0; i < scores.length; i++) if (scores[i]! < m) m = scores[i]!;
            return m;
        }
        case 'sum': {
            let s = 0;
            for (let i = 0; i < scores.length; i++) s += scores[i]!;
            return s;
        }
        case 'mean': {
            let s = 0;
            for (let i = 0; i < scores.length; i++) s += scores[i]!;
            return scores.length ? s / scores.length : 0;
        }
    }
}

/**
 * Query Substratum around a point or region, score candidates, rank top-K, and normalize weights.
 */
export function attend<
    C extends object,
    M extends object,
    E extends object,
    K extends Kind<C> = Kind<C>,
>(
    world: Substratum<C, M, E>,
    target: Vec3 | Region,
    options: AttendOptions<C, M, K> = {},
): readonly AttentionResult<C, M, K>[] {
    const scope = options.scope ?? 'attachment';
    const combiner = options.combine ?? 'max';
    const scorer = options.score ?? ((hit: AttendHit<C, M, K>) => gaussian(hit.distance ?? 0, 1));
    const queryOpts: QueryOptions<M, K> = {
        kind: options.kind,
        where: options.where,
        tags: options.tags,
        filter: options.filter,
    };

    const rawHits: AttendHit<C, M, K>[] = [];
    if (isVec3(target)) {
        if (options.radius !== undefined) {
            const iter = scope === 'content' && options.combine === undefined
                ? world.radiusContent(target, options.radius, queryOpts as QueryOptions<M, Kind<C>>)
                : world.radius(target, options.radius, queryOpts as QueryOptions<M, Kind<C>>);
            for (const h of iter) rawHits.push(h as unknown as AttendHit<C, M, K>);
        } else if (options.nearest !== undefined) {
            const iter = scope === 'content' && options.combine === undefined
                ? world.nearestContent(target, { ...(queryOpts as QueryOptions<M, Kind<C>>), limit: options.nearest })
                : world.nearest(target, { ...(queryOpts as QueryOptions<M, Kind<C>>), limit: options.nearest });
            for (const h of iter) rawHits.push(h as unknown as AttendHit<C, M, K>);
        } else {
            const iter = scope === 'content' && options.combine === undefined
                ? world.searchContent(ALL, { ...(queryOpts as QueryOptions<M, Kind<C>>), overlap: options.overlap })
                : world.search(ALL, { ...(queryOpts as QueryOptions<M, Kind<C>>), overlap: options.overlap });
            for (const h of iter) {
                const distance = distanceToBounds(target, world.bounds(h.address));
                rawHits.push({ ...(h as unknown as SearchResult<C, M, K>), distance });
            }
        }
    } else {
        const iter = scope === 'content' && options.combine === undefined
            ? world.searchContent(target, { ...(queryOpts as QueryOptions<M, Kind<C>>), overlap: options.overlap })
            : world.search(target, { ...(queryOpts as QueryOptions<M, Kind<C>>), overlap: options.overlap });
        for (const h of iter) rawHits.push(h as unknown as AttendHit<C, M, K>);
    }

    if (!rawHits.length) return [];

    let entries: { hit: AttendHit<C, M, K>; score: number }[];
    if (scope === 'content' && options.combine !== undefined) {
        const grouped = new Map<ContentId, { hits: AttendHit<C, M, K>[]; scores: number[] }>();
        for (let i = 0; i < rawHits.length; i++) {
            const hit = rawHits[i]!;
            const s = scorer(hit);
            let group = grouped.get(hit.id);
            if (!group) {
                group = { hits: [], scores: [] };
                grouped.set(hit.id, group);
            }
            group.hits.push(hit);
            group.scores.push(s);
        }
        entries = [];
        for (const group of grouped.values()) {
            let bestIdx = 0;
            for (let i = 1; i < group.scores.length; i++) {
                if (group.scores[i]! > group.scores[bestIdx]!) bestIdx = i;
            }
            entries.push({
                hit: group.hits[bestIdx]!,
                score: combineScores(group.scores, group.hits, combiner),
            });
        }
    } else {
        entries = rawHits.map(hit => ({ hit, score: scorer(hit) }));
    }

    entries.sort((a, b) => b.score - a.score);
    if (options.limit !== undefined) {
        if (!Number.isSafeInteger(options.limit) || options.limit < 0) {
            throw RangeError('limit must be a nonnegative integer');
        }
        entries = entries.slice(0, options.limit);
    }
    if (!entries.length) return [];

    const rawScores = entries.map(e => e.score);
    const weights = options.normalize === false
        ? rawScores
        : (options.normalize ?? l1Normalize)(rawScores);

    return entries.map((e, i) => Object.freeze({
        hit: e.hit,
        score: e.score,
        weight: weights[i] ?? 0,
    }));
}

/** Compute a weighted sum over scalar or vector values extracted from attention results. */
export function weightedAggregate<C extends object, M extends object, K extends Kind<C>>(
    results: readonly AttentionResult<C, M, K>[],
    value: (result: AttentionResult<C, M, K>) => number,
): number;
export function weightedAggregate<C extends object, M extends object, K extends Kind<C>>(
    results: readonly AttentionResult<C, M, K>[],
    value: (result: AttentionResult<C, M, K>) => Vector,
): number[];
export function weightedAggregate<C extends object, M extends object, K extends Kind<C>>(
    results: readonly AttentionResult<C, M, K>[],
    value: (result: AttentionResult<C, M, K>) => number | Vector,
): number | number[] {
    if (!results.length) return 0;
    const first = value(results[0]!);
    if (typeof first === 'number') {
        let sum = results[0]!.weight * first;
        for (let i = 1; i < results.length; i++) {
            sum += results[i]!.weight * (value(results[i]!) as number);
        }
        return sum;
    }
    const out = new Array<number>(first.length).fill(0);
    for (let i = 0; i < results.length; i++) {
        const w = results[i]!.weight;
        const vec = value(results[i]!) as Vector;
        if (vec.length !== out.length) {
            throw RangeError(`Vector dimension mismatch: ${vec.length} !== ${out.length}`);
        }
        for (let j = 0; j < vec.length; j++) {
            out[j]! += w * vec[j]!;
        }
    }
    return out;
}
