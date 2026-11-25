import {
    type ContentId,
    type Plugin,
    type Substratum,
} from '../mod.ts';

export interface NeighborLink {
    readonly id: ContentId;
    readonly weight?: number;
}

export type AggregationMode = 'sum' | 'mean' | 'max';
export type ActivationFn = 'tanh' | 'relu' | 'sigmoid' | 'linear' | ((value: number) => number);

export interface PropagationOptions<C extends object, M extends object, E extends object> {
    /** Fraction of activation lost each step. Default: 0.1. */
    readonly decay?: number;
    /** Minimum absolute activation retained after a step. Default: 0.05. */
    readonly threshold?: number;
    /** Default iteration cap for run(). Default: 32. */
    readonly maxIterations?: number;
    /** How incoming neighbour messages are combined. Default: 'sum'. */
    readonly aggregation?: AggregationMode;
    /** Activation transfer function applied after aggregation. Default: 'tanh'. */
    readonly activation?: ActivationFn;
    /** Spatial radius used by the default proximity neighbour resolver. Default: 16. */
    readonly radius?: number;
    /** Custom neighbour resolver for spreading activation across relationships. */
    readonly neighbors?: (id: ContentId, world: Substratum<C, M, E>) => readonly NeighborLink[];
    /** Optional hook invoked after each propagation step. */
    readonly onStep?: (active: ReadonlyMap<ContentId, number>, iteration: number) => void;
}

export interface PropagationNetwork {
    activate(id: ContentId, amount: number): void;
    step(): number;
    run(maxIterations?: number, tolerance?: number): number;
    getActive(minActivation?: number): ReadonlyMap<ContentId, number>;
    getActivation(id: ContentId): number;
    reset(): void;
    dispose(): void;
}

function applyActivation(fn: ActivationFn, x: number): number {
    if (typeof fn === 'function') return fn(x);
    switch (fn) {
        case 'tanh': return Math.tanh(x);
        case 'relu': return x > 0 ? x : 0;
        case 'sigmoid': return 1 / (1 + Math.exp(-x));
        case 'linear': return x;
    }
}

/**
 * Create a step-based spreading-activation and message-passing engine
 * operating over Substratum content identities.
 */
export function createPropagation<
    C extends object,
    M extends object,
    E extends object,
>(
    world: Substratum<C, M, E>,
    options: PropagationOptions<C, M, E> = {},
): PropagationNetwork {
    const decay = options.decay ?? 0.1;
    const threshold = options.threshold ?? 0.05;
    const defaultMaxIter = options.maxIterations ?? 32;
    const aggregation = options.aggregation ?? 'sum';
    const activationFn = options.activation ?? 'tanh';
    const radius = options.radius ?? 16;

    if (!Number.isFinite(decay) || decay < 0 || decay > 1) throw RangeError('decay must be finite and in [0, 1]');
    if (!Number.isFinite(threshold) || threshold < 0) throw RangeError('threshold must be finite and nonnegative');
    if (!Number.isSafeInteger(defaultMaxIter) || defaultMaxIter < 0) {
        throw RangeError('maxIterations must be a nonnegative integer');
    }
    if (!Number.isFinite(radius) || radius < 0) throw RangeError('radius must be finite and nonnegative');

    const neighborCache = new Map<ContentId, readonly NeighborLink[]>();
    const offSpatial = options.neighbors
        ? undefined
        : world.on('spatial:change', () => {
            neighborCache.clear();
        });

    const defaultNeighbors = (id: ContentId): readonly NeighborLink[] => {
        const cached = neighborCache.get(id);
        if (cached) return cached;
        if (!world.hasContent(id)) return [];
        const places = world.placements(id);
        if (!places.length) return [];
        const seen = new Map<ContentId, number>();
        for (let i = 0; i < places.length; i++) {
            const b = world.bounds(places[i]!);
            const center = [
                Math.round((b[0][0] + b[0][1]) * 0.5),
                Math.round((b[1][0] + b[1][1]) * 0.5),
                Math.round((b[2][0] + b[2][1]) * 0.5),
            ] as const;
            for (const hit of world.radiusContent(center, radius)) {
                if (hit.id === id) continue;
                const w = 1 / (1 + hit.distance);
                const prev = seen.get(hit.id);
                if (prev === undefined || w > prev) seen.set(hit.id, w);
            }
        }
        const links = [...seen.entries()].map(([nid, weight]) => ({ id: nid, weight }));
        neighborCache.set(id, links);
        return links;
    };

    const resolveNeighbors = options.neighbors ?? defaultNeighbors;
    let state = new Map<ContentId, number>();
    let iteration = 0;
    let disposed = false;

    const assertAlive = () => {
        if (disposed) throw Error('PropagationNetwork has been disposed');
    };

    return {
        activate(id, amount) {
            assertAlive();
            if (!Number.isFinite(amount)) throw RangeError('activation amount must be finite');
            const next = (state.get(id) ?? 0) + amount;
            if (Math.abs(next) < threshold) state.delete(id);
            else state.set(id, next);
        },
        step() {
            assertAlive();
            const incoming = new Map<ContentId, { sum: number; count: number; max: number }>();
            for (const [id, act] of state) {
                if (Math.abs(act) < threshold) continue;
                const links = resolveNeighbors(id, world);
                for (let i = 0; i < links.length; i++) {
                    const link = links[i]!;
                    const w = link.weight ?? 1;
                    if (!Number.isFinite(w)) throw RangeError('neighbour weight must be finite');
                    const msg = act * w;
                    let acc = incoming.get(link.id);
                    if (!acc) {
                        acc = { sum: msg, count: 1, max: msg };
                        incoming.set(link.id, acc);
                    } else {
                        acc.sum += msg;
                        acc.count++;
                        if (Math.abs(msg) > Math.abs(acc.max)) acc.max = msg;
                    }
                }
            }

            const next = new Map<ContentId, number>();
            const participants = new Set<ContentId>([...state.keys(), ...incoming.keys()]);
            for (const id of participants) {
                const retained = (state.get(id) ?? 0) * (1 - decay);
                const inc = incoming.get(id);
                let agg = 0;
                if (inc) {
                    if (aggregation === 'sum') agg = inc.sum;
                    else if (aggregation === 'mean') agg = inc.sum / inc.count;
                    else agg = inc.max;
                }
                const combined = inc ? applyActivation(activationFn, retained + agg) : retained;
                if (!Number.isFinite(combined)) throw RangeError('activation output must be finite');
                if (Math.abs(combined) >= threshold) {
                    next.set(id, combined);
                }
            }

            state = next;
            iteration++;
            options.onStep?.(state, iteration);
            return state.size;
        },
        run(maxIterations = defaultMaxIter, tolerance = 1e-4) {
            assertAlive();
            if (!Number.isSafeInteger(maxIterations) || maxIterations < 0) {
                throw RangeError('maxIterations must be a nonnegative integer');
            }
            if (!Number.isFinite(tolerance) || tolerance < 0) {
                throw RangeError('tolerance must be finite and nonnegative');
            }
            let steps = 0;
            for (let i = 0; i < maxIterations; i++) {
                const prev = state;
                this.step();
                steps++;
                let maxDiff = 0;
                const keys = new Set<ContentId>([...prev.keys(), ...state.keys()]);
                for (const k of keys) {
                    const d = Math.abs((state.get(k) ?? 0) - (prev.get(k) ?? 0));
                    if (d > maxDiff) maxDiff = d;
                }
                if (maxDiff <= tolerance) break;
            }
            return steps;
        },
        getActive(minActivation = threshold) {
            const out = new Map<ContentId, number>();
            for (const [id, val] of state) {
                if (Math.abs(val) >= minActivation) out.set(id, val);
            }
            return out;
        },
        getActivation(id) {
            return state.get(id) ?? 0;
        },
        reset() {
            state.clear();
            iteration = 0;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            offSpatial?.();
            neighborCache.clear();
            state.clear();
        },
    };
}

/** Optional Substratum plugin that advances a PropagationNetwork on each world.update(). */
export function createPropagationPlugin<C extends object, M extends object, E extends object>(
    network: PropagationNetwork,
    options: { readonly stepsPerUpdate?: number } = {},
): Plugin<C, M, E> {
    const steps = options.stepsPerUpdate ?? 1;
    return world => world.on('update', () => {
        for (let i = 0; i < steps; i++) network.step();
    });
}
