import {
    ALL,
    type Address,
    type ChangeEvent,
    type Dispose,
    type Kind,
    type Region,
    type SearchOptions,
    type SearchResult,
    type Substratum,
    type Vec3,
} from '../mod.ts';
import {
    correlation,
    covariance,
    dominance,
    entropy,
    histogram,
    mean,
    mutualInformation,
    stdDev,
    variance,
    type HistogramResult,
} from './math.ts';

export {
    correlation,
    covariance,
    dominance,
    entropy,
    histogram,
    mean,
    mutualInformation,
    stdDev,
    variance,
};

export type StatisticMetric =
    | 'count'
    | 'mean'
    | 'variance'
    | 'stdDev'
    | 'entropy'
    | 'dominance'
    | 'density'
    | 'centroid'
    | 'histogram'
    | 'covariance'
    | 'correlation'
    | 'mutualInformation';

export interface AnalyseOptions<C extends object, M extends object, K extends Kind<C> = Kind<C>>
    extends SearchOptions<M, K> {
    /** Deduplicate by ContentId ('content') or include every attachment ('attachment'). Default: 'attachment'. */
    readonly scope?: 'attachment' | 'content';
    /** Category extractor for entropy, dominance, and group counts. */
    readonly groupBy?: (hit: SearchResult<C, M, K>) => string | number;
    /** Numeric value extractor for mean, variance, stdDev, and histogram. */
    readonly value?: (hit: SearchResult<C, M, K>) => number | undefined;
    /** Numeric pair extractor for covariance and correlation. */
    readonly pair?: (hit: SearchResult<C, M, K>) => readonly [number, number] | undefined;
    /** Categorical/discrete pair extractor for mutualInformation. */
    readonly variables?: (hit: SearchResult<C, M, K>) => readonly [string | number, string | number] | undefined;
    /** Number of histogram bins (default 10). */
    readonly bins?: number;
    /** Explicit [min, max] range for histogram. */
    readonly range?: readonly [number, number];
    /** Metrics to compute. Defaults to ['count', 'mean', 'variance', 'entropy', 'dominance']. */
    readonly metrics?: readonly StatisticMetric[];
}

export interface StatisticsResult {
    readonly count: number;
    readonly mean?: number;
    readonly variance?: number;
    readonly stdDev?: number;
    readonly entropy?: number;
    readonly dominance?: number;
    readonly density?: number;
    readonly centroid?: Vec3;
    readonly histogram?: HistogramResult;
    readonly covariance?: number;
    readonly correlation?: number;
    readonly mutualInformation?: number;
    readonly groups?: Readonly<Record<string, number>>;
}

export interface ObserveStatisticsOptions<C extends object, M extends object, K extends Kind<C> = Kind<C>>
    extends AnalyseOptions<C, M, K> {
    /** Called when statistics are initialized (if emitInitial is true) and whenever the region changes. */
    readonly onChange: (statistics: StatisticsResult, event?: ChangeEvent<C, M>) => void;
    /** Whether to invoke onChange immediately with the initial snapshot. Default: false. */
    readonly emitInitial?: boolean;
}

const DEFAULT_METRICS: readonly StatisticMetric[] = ['count', 'mean', 'variance', 'entropy', 'dominance'];

function cellCenter<C extends object, M extends object, E extends object>(
    world: Substratum<C, M, E>,
    address: Address,
): Vec3 {
    const b = world.bounds(address);
    return [
        (b[0][0] + b[0][1]) * 0.5,
        (b[1][0] + b[1][1]) * 0.5,
        (b[2][0] + b[2][1]) * 0.5,
    ];
}

function regionVolume<C extends object, M extends object, E extends object>(
    world: Substratum<C, M, E>,
    region: Region,
): number {
    const b = world.geometry.boundsOf(region);
    return (b[0][1] - b[0][0] + 1) * (b[1][1] - b[1][0] + 1) * (b[2][1] - b[2][0] + 1);
}

/** Compute statistical and information-theoretic properties over a Substratum region. */
export function analyse<
    C extends object,
    M extends object,
    E extends object,
    K extends Kind<C> = Kind<C>,
>(
    world: Substratum<C, M, E>,
    region: Region = ALL,
    options: AnalyseOptions<C, M, K> = {},
): StatisticsResult {
    const metrics = new Set(options.metrics ?? DEFAULT_METRICS);
    const scope = options.scope ?? 'attachment';
    const searchOpts: SearchOptions<M, Kind<C>> = {
        kind: options.kind,
        where: options.where,
        tags: options.tags,
        filter: options.filter as ((m: unknown) => boolean) | undefined,
        overlap: options.overlap,
    };

    const hits: SearchResult<C, M, K>[] = [];
    const iter = scope === 'content'
        ? world.searchContent(region, searchOpts)
        : world.search(region, searchOpts);
    for (const hit of iter) hits.push(hit as unknown as SearchResult<C, M, K>);

    const out: {
        count: number;
        mean?: number;
        variance?: number;
        stdDev?: number;
        entropy?: number;
        dominance?: number;
        density?: number;
        centroid?: Vec3;
        histogram?: HistogramResult;
        covariance?: number;
        correlation?: number;
        mutualInformation?: number;
        groups?: Record<string, number>;
    } = { count: hits.length };

    if (metrics.has('density')) {
        const vol = regionVolume(world, region);
        out.density = vol > 0 ? hits.length / vol : 0;
    }

    if (metrics.has('centroid')) {
        if (!hits.length) {
            out.centroid = [0, 0, 0];
        } else {
            let sx = 0;
            let sy = 0;
            let sz = 0;
            for (let i = 0; i < hits.length; i++) {
                const [x, y, z] = cellCenter(world, hits[i]!.address);
                sx += x;
                sy += y;
                sz += z;
            }
            out.centroid = [sx / hits.length, sy / hits.length, sz / hits.length];
        }
    }

    if (options.value && (metrics.has('mean') || metrics.has('variance') || metrics.has('stdDev') || metrics.has('histogram'))) {
        const values: number[] = [];
        for (let i = 0; i < hits.length; i++) {
            const v = options.value(hits[i]!);
            if (v !== undefined && Number.isFinite(v)) values.push(v);
        }
        if (metrics.has('mean')) out.mean = mean(values);
        if (metrics.has('variance')) out.variance = variance(values);
        if (metrics.has('stdDev')) out.stdDev = stdDev(values);
        if (metrics.has('histogram')) out.histogram = histogram(values, options.bins, options.range);
    }

    if (options.groupBy && (metrics.has('entropy') || metrics.has('dominance'))) {
        const groups = Object.create(null) as Record<string, number>;
        for (let i = 0; i < hits.length; i++) {
            const key = String(options.groupBy(hits[i]!));
            groups[key] = (groups[key] ?? 0) + 1;
        }
        const counts = Object.values(groups);
        out.groups = Object.freeze(groups);
        if (metrics.has('entropy')) out.entropy = entropy(counts);
        if (metrics.has('dominance')) out.dominance = dominance(counts);
    }

    if (options.pair && (metrics.has('covariance') || metrics.has('correlation'))) {
        const xs: number[] = [];
        const ys: number[] = [];
        for (let i = 0; i < hits.length; i++) {
            const p = options.pair(hits[i]!);
            if (p && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
                xs.push(p[0]);
                ys.push(p[1]);
            }
        }
        if (metrics.has('covariance')) out.covariance = covariance(xs, ys);
        if (metrics.has('correlation')) out.correlation = correlation(xs, ys);
    }

    if (options.variables && metrics.has('mutualInformation')) {
        const xs: (string | number)[] = [];
        const ys: (string | number)[] = [];
        for (let i = 0; i < hits.length; i++) {
            const v = options.variables(hits[i]!);
            if (v) {
                xs.push(v[0]);
                ys.push(v[1]);
            }
        }
        out.mutualInformation = mutualInformation(xs, ys);
    }

    return Object.freeze(out);
}

/**
 * Subscribe to regional population changes and emit updated statistics whenever
 * matching attachments or their content payloads change inside the region.
 */
export function observeStatistics<
    C extends object,
    M extends object,
    E extends object,
    K extends Kind<C> = Kind<C>,
>(
    world: Substratum<C, M, E>,
    region: Region,
    options: ObserveStatisticsOptions<C, M, K>,
): Dispose {
    const off = world.on(
        'spatial:change',
        event => {
            const relevant = event.changes.some(c => {
                if (c.target === 'cell') return false;
                return options.kind === undefined || c.kind === options.kind;
            });
            if (!relevant) return;
            options.onChange(analyse(world, region, options), event);
        },
        { region },
    );
    if (options.emitInitial) {
        try {
            options.onChange(analyse(world, region, options));
        } catch (error) {
            off();
            throw error;
        }
    }
    return off;
}
