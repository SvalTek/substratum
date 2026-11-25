import {
    EventDispatchError,
    type ContentId,
    type Dispose,
    type Kind,
    type Metadata,
    type Substratum,
} from '../mod.ts';

export interface AssociationEdge {
    readonly source: ContentId;
    readonly target: ContentId;
    readonly weight: number;
    readonly contentId?: ContentId;
}

export interface AssociationsOptions<
    C extends object,
    M extends object,
    K extends Kind<C> = Kind<C>,
> {
    /** Default increment for reinforce(). Default: 0.05. */
    readonly learningRate?: number;
    /** Decay rate applied per decay(dt) call. Default: 0.001. */
    readonly decayRate?: number;
    /** Minimum allowed weight. Default: 0. */
    readonly minWeight?: number;
    /** Maximum allowed weight. Default: 1. */
    readonly maxWeight?: number;
    /** Whether associations are directed (A -> B != B -> A). Default: false. */
    readonly directed?: boolean;
    /** Remove edges when weight reaches or drops below minWeight. Default: true. */
    readonly pruneAtMin?: boolean;
    /** Optional Substratum content kind used to persist association edges. */
    readonly kind?: K;
    /** Payload builder when persisting association edges in Substratum. */
    readonly createPayload?: (edge: Omit<AssociationEdge, 'contentId'>) => C[K];
    /** Optional metadata builder when attaching persisted edge content at source placements. */
    readonly createMetadata?: (edge: Omit<AssociationEdge, 'contentId'>) => Metadata<M, K>;
    /** Automatically decay on world.update(dt). Default: false. */
    readonly autoDecay?: boolean;
}

export interface AssociationsManager {
    reinforce(a: ContentId, b: ContentId, amount?: number): number;
    weaken(a: ContentId, b: ContentId, amount?: number): number;
    weight(a: ContentId, b: ContentId): number;
    related(id: ContentId, options?: { readonly minWeight?: number; readonly limit?: number }): readonly AssociationEdge[];
    decay(dt?: number): void;
    all(): readonly AssociationEdge[];
    clear(removePersisted?: boolean): void;
    dispose(removePersisted?: boolean): void;
}

interface StoredEdge {
    readonly source: ContentId;
    readonly target: ContentId;
    weight: number;
    contentId?: ContentId;
}

/**
 * Create an adaptive association manager using Hebbian reinforcement,
 * weakening, and temporal decay, with optional Substratum persistence.
 */
export function createAssociations<
    C extends object,
    M extends object,
    E extends object,
    K extends Kind<C> = Kind<C>,
>(
    world: Substratum<C, M, E>,
    options: AssociationsOptions<C, M, K> = {},
): AssociationsManager {
    const learningRate = options.learningRate ?? 0.05;
    const decayRate = options.decayRate ?? 0.001;
    const minWeight = options.minWeight ?? 0;
    const maxWeight = options.maxWeight ?? 1;
    const directed = options.directed ?? false;
    const pruneAtMin = options.pruneAtMin ?? true;

    if (!Number.isFinite(learningRate) || learningRate < 0) {
        throw RangeError('learningRate must be finite and nonnegative');
    }
    if (!Number.isFinite(decayRate) || decayRate < 0) {
        throw RangeError('decayRate must be finite and nonnegative');
    }
    if (!Number.isFinite(minWeight) || !Number.isFinite(maxWeight) || minWeight > maxWeight) {
        throw RangeError('minWeight and maxWeight must be finite with minWeight <= maxWeight');
    }

    const edges = new Map<string, StoredEdge>();
    const adjacency = new Map<ContentId, Set<string>>();

    const canonicalPair = (a: ContentId, b: ContentId): readonly [ContentId, ContentId, string] => {
        if (directed || a <= b) return [a, b, JSON.stringify([a, b])];
        return [b, a, JSON.stringify([b, a])];
    };

    const clamp = (w: number): number => Math.min(maxWeight, Math.max(minWeight, w));

    const indexKey = (id: ContentId, key: string) => {
        let set = adjacency.get(id);
        if (!set) adjacency.set(id, set = new Set());
        set.add(key);
    };

    const unindexKey = (id: ContentId, key: string) => {
        const set = adjacency.get(id);
        if (!set) return;
        set.delete(key);
        if (!set.size) adjacency.delete(id);
    };

    const syncPersisted = (edge: StoredEdge) => {
        if (!options.kind || !options.createPayload) return;
        const payload = options.createPayload({
            source: edge.source,
            target: edge.target,
            weight: edge.weight,
        });
        if (edge.contentId && world.hasContent(edge.contentId)) {
            world.setContent(edge.contentId as ContentId<K>, payload);
            return;
        }
        const cid = world.createContent(options.kind, payload);
        edge.contentId = cid;
        if (options.createMetadata) {
            const meta = options.createMetadata({
                source: edge.source,
                target: edge.target,
                weight: edge.weight,
            });
            const places = world.placements(edge.source);
            if (places.length) {
                world.attach(places[0]!, cid, { ...meta, kind: options.kind } as Metadata<M, K>);
            }
        }
    };

    const deletePersisted = (edge: StoredEdge) => {
        if (edge.contentId && world.hasContent(edge.contentId)) {
            world.detachAll(edge.contentId);
            world.removeContent(edge.contentId);
        }
        edge.contentId = undefined;
    };

    const removeEdge = (key: string, edge: StoredEdge, removeContent = true) => {
        edges.delete(key);
        unindexKey(edge.source, key);
        unindexKey(edge.target, key);
        if (removeContent) deletePersisted(edge);
    };

    const restoreSnapshot = (
        prevEdges: Array<[string, StoredEdge | undefined]>,
    ) => {
        for (let i = 0; i < prevEdges.length; i++) {
            const [key, prev] = prevEdges[i]!;
            const cur = edges.get(key);
            if (!prev) {
                if (cur) {
                    edges.delete(key);
                    unindexKey(cur.source, key);
                    unindexKey(cur.target, key);
                }
            } else {
                if (!cur) {
                    edges.set(key, prev);
                    indexKey(prev.source, key);
                    indexKey(prev.target, key);
                } else {
                    cur.weight = prev.weight;
                    cur.contentId = prev.contentId;
                }
            }
        }
    };

    const runWithRollback = (
        snapshots: Array<[string, StoredEdge | undefined]>,
        fn: () => void,
    ) => {
        try {
            world.batch(fn);
        } catch (err) {
            if (!(err instanceof EventDispatchError)) {
                restoreSnapshot(snapshots);
            }
            throw err;
        }
    };

    const adjust = (a: ContentId, b: ContentId, delta: number): number => {
        if (!Number.isFinite(delta)) throw RangeError('adjustment amount must be finite');
        const [source, target, key] = canonicalPair(a, b);
        const existing = edges.get(key);
        const snap: Array<[string, StoredEdge | undefined]> = [
            [key, existing ? { ...existing } : undefined],
        ];
        const next = clamp((existing?.weight ?? minWeight) + delta);
        if (pruneAtMin && next <= minWeight) {
            if (existing) {
                runWithRollback(snap, () => removeEdge(key, existing, true));
            }
            return minWeight;
        }
        let edge = existing;
        runWithRollback(snap, () => {
            if (!edge) {
                edge = { source, target, weight: next };
                edges.set(key, edge);
                indexKey(source, key);
                indexKey(target, key);
            } else {
                edge.weight = next;
            }
            syncPersisted(edge);
        });
        return next;
    };

    const offUpdate: Dispose | undefined = options.autoDecay
        ? world.on('update', dt => manager.decay(dt))
        : undefined;

    const manager: AssociationsManager = {
        reinforce(a, b, amount = learningRate) {
            if (!Number.isFinite(amount) || amount < 0) throw RangeError('amount must be finite and nonnegative');
            return adjust(a, b, amount);
        },
        weaken(a, b, amount = learningRate) {
            if (!Number.isFinite(amount) || amount < 0) throw RangeError('amount must be finite and nonnegative');
            return adjust(a, b, -amount);
        },
        weight(a, b) {
            const [, , key] = canonicalPair(a, b);
            return edges.get(key)?.weight ?? minWeight;
        },
        related(id, relOpts = {}) {
            const keys = adjacency.get(id);
            if (!keys) return [];
            const floor = relOpts.minWeight ?? minWeight;
            const out: AssociationEdge[] = [];
            for (const key of keys) {
                const e = edges.get(key);
                if (!e) continue;
                if (directed && e.source !== id) continue;
                if (e.weight < floor) continue;
                const other = e.source === id ? e.target : e.source;
                out.push(Object.freeze({
                    source: id,
                    target: other,
                    weight: e.weight,
                    contentId: e.contentId,
                }));
            }
            out.sort((x, y) => y.weight - x.weight);
            return relOpts.limit !== undefined ? out.slice(0, relOpts.limit) : out;
        },
        decay(dt = 1) {
            if (!Number.isFinite(dt) || dt < 0) throw RangeError('dt must be finite and nonnegative');
            const drop = decayRate * dt;
            if (drop === 0 || !edges.size) return;
            const snap: Array<[string, StoredEdge | undefined]> = [...edges.entries()]
                .map(([k, e]) => [k, { ...e }]);
            runWithRollback(snap, () => {
                for (const [key, edge] of [...edges.entries()]) {
                    const next = clamp(edge.weight - drop);
                    if (pruneAtMin && next <= minWeight) {
                        removeEdge(key, edge, true);
                    } else if (next !== edge.weight) {
                        edge.weight = next;
                        syncPersisted(edge);
                    }
                }
            });
        },
        all() {
            return [...edges.values()].map(e => Object.freeze({
                source: e.source,
                target: e.target,
                weight: e.weight,
                contentId: e.contentId,
            }));
        },
        clear(removePersisted = false) {
            const snap: Array<[string, StoredEdge | undefined]> = [...edges.entries()]
                .map(([k, e]) => [k, { ...e }]);
            runWithRollback(snap, () => {
                for (const [key, edge] of [...edges.entries()]) {
                    removeEdge(key, edge, removePersisted);
                }
            });
        },
        dispose(removePersisted = false) {
            offUpdate?.();
            if (removePersisted) {
                manager.clear(true);
            }
        },
    };

    return manager;
}
