import {
    ALL,
    EventDispatchError,
    type Address,
    type Bounds,
    type ContentId,
    type Dispose,
    type Kind,
    type Metadata,
    type Plugin,
    type Region,
    type SearchOptions,
    type SearchResult,
    type Substratum,
    type Vec3,
} from '../mod.ts';

export type MultiPlacementPolicy = 'first' | 'centroid' | 'all-attachments';

export interface DbscanOptions<C extends object, M extends object, K extends Kind<C> = Kind<C>>
    extends SearchOptions<M, K> {
    readonly region?: Region;
    readonly epsilon: number;
    readonly minSamples: number;
    /** Policy for content with multiple cell attachments. Default: 'first'. */
    readonly multiPlacement?: MultiPlacementPolicy;
}

export interface ClusterMember<C extends object, M extends object, K extends Kind<C> = Kind<C>> {
    readonly hit: SearchResult<C, M, K>;
    readonly point: Vec3;
}

export interface Cluster<C extends object, M extends object, K extends Kind<C> = Kind<C>> {
    readonly id: number;
    readonly members: readonly ClusterMember<C, M, K>[];
    readonly memberIds: readonly ContentId<K>[];
    readonly centroid: Vec3;
    readonly bounds: Bounds;
    readonly count: number;
    readonly density: number;
}

export interface DbscanResult<C extends object, M extends object, K extends Kind<C> = Kind<C>> {
    readonly clusters: readonly Cluster<C, M, K>[];
    readonly noise: readonly ClusterMember<C, M, K>[];
}

export interface ClusterPluginOptions<
    C extends object,
    M extends object,
    K extends Kind<C> = Kind<C>,
    CK extends Kind<C> = Kind<C>,
> extends DbscanOptions<C, M, K> {
    /** Content kind used when materialising clusters in Substratum. */
    readonly clusterKind: CK;
    /** Build payload for a materialised cluster. */
    readonly createPayload: (cluster: Cluster<C, M, K>) => C[CK];
    /** Build attachment metadata for a materialised cluster. */
    readonly createMetadata?: (cluster: Cluster<C, M, K>) => Metadata<M, CK>;
    /** Remove materialised cluster content on plugin disposal. Default: false. */
    readonly removeOnDispose?: boolean;
    /** Reuse existing cluster ContentIds across recomputations when membership Jaccard similarity >= identityThreshold. Default: false. */
    readonly preserveIdentity?: boolean;
    /** Minimum Jaccard similarity in (0, 1] required to match a cluster across recomputations. Default: 0.5. */
    readonly identityThreshold?: number;
}

function addressCenter<C extends object, M extends object, E extends object>(
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

function computeBounds(points: readonly Vec3[]): Bounds {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < points.length; i++) {
        const [x, y, z] = points[i]!;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
    }
    return [
        [Math.floor(minX), Math.ceil(maxX)],
        [Math.floor(minY), Math.ceil(maxY)],
        [Math.floor(minZ), Math.ceil(maxZ)],
    ];
}

function computeCentroid(points: readonly Vec3[]): Vec3 {
    if (!points.length) return [0, 0, 0];
    let sx = 0, sy = 0, sz = 0;
    for (let i = 0; i < points.length; i++) {
        const [x, y, z] = points[i]!;
        sx += x;
        sy += y;
        sz += z;
    }
    return [sx / points.length, sy / points.length, sz / points.length];
}

/** Run DBSCAN density-based clustering over Substratum placements in a region. */
export function dbscan<
    C extends object,
    M extends object,
    E extends object,
    K extends Kind<C> = Kind<C>,
>(
    world: Substratum<C, M, E>,
    options: DbscanOptions<C, M, K>,
): DbscanResult<C, M, K> {
    if (!Number.isFinite(options.epsilon) || options.epsilon < 0) {
        throw RangeError('epsilon must be finite and nonnegative');
    }
    if (!Number.isSafeInteger(options.minSamples) || options.minSamples < 1) {
        throw RangeError('minSamples must be a positive integer');
    }

    const region = options.region ?? ALL;
    const policy = options.multiPlacement ?? 'first';
    const searchOpts: SearchOptions<M, Kind<C>> = {
        kind: options.kind,
        where: options.where,
        tags: options.tags,
        filter: options.filter as ((m: unknown) => boolean) | undefined,
        overlap: options.overlap,
    };

    const items: ClusterMember<C, M, K>[] = [];
    if (policy === 'all-attachments') {
        for (const hit of world.search(region, searchOpts)) {
            const h = hit as unknown as SearchResult<C, M, K>;
            items.push({ hit: h, point: addressCenter(world, h.address) });
        }
    } else {
        for (const hit of world.searchContent(region, searchOpts)) {
            const h = hit as unknown as SearchResult<C, M, K>;
            if (policy === 'centroid') {
                const places = world.placements(h.id);
                const pts = places.map(a => addressCenter(world, a));
                items.push({ hit: h, point: computeCentroid(pts) });
            } else {
                items.push({ hit: h, point: addressCenter(world, h.address) });
            }
        }
    }

    const n = items.length;
    if (!n) return { clusters: [], noise: [] };

    const visited = new Uint8Array(n);
    const assigned = new Int32Array(n).fill(-1); // -1 = unassigned/noise, >= 0 = cluster id

    // Build an O(1) spatial hash grid of cell size `epsilon` over the collected points
    // to avoid repeated priority-queue traversals and frozen result allocations per point.
    const eps = options.epsilon;
    const eps2 = eps * eps;
    const grid = new Map<string, number[]>();
    const cellSize = eps > 0 ? eps : 1;
    for (let i = 0; i < n; i++) {
        const [x, y, z] = items[i]!.point;
        const gx = Math.floor(x / cellSize);
        const gy = Math.floor(y / cellSize);
        const gz = Math.floor(z / cellSize);
        const k = `${gx},${gy},${gz}`;
        let bucket = grid.get(k);
        if (!bucket) grid.set(k, bucket = []);
        bucket.push(i);
    }

    const regionQuery = (idx: number): number[] => {
        const [px, py, pz] = items[idx]!.point;
        const gx = Math.floor(px / cellSize);
        const gy = Math.floor(py / cellSize);
        const gz = Math.floor(pz / cellSize);
        const neighbors: number[] = [];
        const seenBuckets = new Set<string>();
        const span = eps > 0 ? 1 : 0;
        for (let dx = -span; dx <= span; dx++) {
            for (let dy = -span; dy <= span; dy++) {
                for (let dz = -span; dz <= span; dz++) {
                    const bk = `${gx + dx},${gy + dy},${gz + dz}`;
                    if (seenBuckets.has(bk)) continue;
                    seenBuckets.add(bk);
                    const bucket = grid.get(bk);
                    if (!bucket) continue;
                    for (let b = 0; b < bucket.length; b++) {
                        const j = bucket[b]!;
                        const [qx, qy, qz] = items[j]!.point;
                        const ddx = px - qx;
                        const ddy = py - qy;
                        const ddz = pz - qz;
                        if (ddx * ddx + ddy * ddy + ddz * ddz <= eps2) {
                            neighbors.push(j);
                        }
                    }
                }
            }
        }
        return neighbors;
    };

    let clusterId = 0;

    for (let i = 0; i < n; i++) {
        if (visited[i]) continue;
        visited[i] = 1;
        const seeds = regionQuery(i);
        if (seeds.length < options.minSamples) continue;

        const cid = clusterId++;
        assigned[i] = cid;
        const queue = seeds.slice();
        const inQueue = new Set(queue);

        for (let q = 0; q < queue.length; q++) {
            const j = queue[q]!;
            if (!visited[j]) {
                visited[j] = 1;
                const jNeighbors = regionQuery(j);
                if (jNeighbors.length >= options.minSamples) {
                    for (let m = 0; m < jNeighbors.length; m++) {
                        const nb = jNeighbors[m]!;
                        if (!inQueue.has(nb)) {
                            inQueue.add(nb);
                            queue.push(nb);
                        }
                    }
                }
            }
            if (assigned[j] === -1) assigned[j] = cid;
        }
    }

    const membersByCluster = new Array<ClusterMember<C, M, K>[]>(clusterId);
    for (let c = 0; c < clusterId; c++) membersByCluster[c] = [];
    const noise: ClusterMember<C, M, K>[] = [];
    for (let i = 0; i < n; i++) {
        const cid = assigned[i]!;
        if (cid === -1) noise.push(items[i]!);
        else membersByCluster[cid]!.push(items[i]!);
    }

    const clusters: Cluster<C, M, K>[] = [];
    for (let cid = 0; cid < clusterId; cid++) {
        const members = membersByCluster[cid]!;
        const pts = members.map(m => m.point);
        const bounds = computeBounds(pts);
        const centroid = computeCentroid(pts);
        const vol = (bounds[0][1] - bounds[0][0] + 1)
            * (bounds[1][1] - bounds[1][0] + 1)
            * (bounds[2][1] - bounds[2][0] + 1);
        const memberIds = [...new Set(members.map(m => m.hit.id))];
        clusters.push(Object.freeze({
            id: cid,
            members: Object.freeze(members),
            memberIds: Object.freeze(memberIds),
            centroid,
            bounds,
            count: members.length,
            density: vol > 0 ? members.length / vol : 0,
        }));
    }

    return Object.freeze({
        clusters: Object.freeze(clusters),
        noise: Object.freeze(noise),
    });
}

/**
 * Optional plugin that materialises discovered clusters as Substratum content
 * whenever matching entries change inside the target region.
 */
export function createClusterPlugin<
    C extends object,
    M extends object,
    E extends object,
    K extends Kind<C> = Kind<C>,
    CK extends Kind<C> = Kind<C>,
>(
    options: ClusterPluginOptions<C, M, K, CK>,
): Plugin<C, M, E> {
    const threshold = options.identityThreshold ?? 0.5;
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
        throw RangeError('identityThreshold must be finite and in (0, 1]');
    }
    return world => {
        let activeClusters: Array<{ id: ContentId<CK>; members: ReadonlySet<ContentId<K>> }> = [];
        let syncing = false;

        const clearMaterialised = () => {
            if (!activeClusters.length) return;
            try {
                world.batch(() => {
                    for (let i = 0; i < activeClusters.length; i++) {
                        const id = activeClusters[i]!.id;
                        if (world.hasContent(id)) {
                            world.detachAll(id);
                            world.removeContent(id);
                        }
                    }
                });
                activeClusters = [];
            } catch (err) {
                if (err instanceof EventDispatchError) {
                    activeClusters = [];
                }
                throw err;
            }
        };

        const recompute = () => {
            if (syncing) return;
            syncing = true;
            try {
                const { clusters } = dbscan(world, {
                    ...options,
                    filter: meta =>
                        (meta.kind as string) !== (options.clusterKind as string)
                        && (!options.filter || options.filter(meta)),
                });

                const nextClusters: Array<{ id: ContentId<CK>; members: ReadonlySet<ContentId<K>> }> = [];
                const matchedOld = new Set<number>();
                const matchedNew = new Map<number, ContentId<CK>>();

                if (options.preserveIdentity && activeClusters.length && clusters.length) {
                    const candidates: Array<{ oldIdx: number; newIdx: number; score: number }> = [];
                    for (let oi = 0; oi < activeClusters.length; oi++) {
                        const oldSet = activeClusters[oi]!.members;
                        for (let ni = 0; ni < clusters.length; ni++) {
                            const newIds = clusters[ni]!.memberIds;
                            let intersection = 0;
                            for (let k = 0; k < newIds.length; k++) {
                                if (oldSet.has(newIds[k]!)) intersection++;
                            }
                            if (intersection === 0) continue;
                            const union = oldSet.size + newIds.length - intersection;
                            const jaccard = intersection / union;
                            if (jaccard >= threshold) {
                                candidates.push({ oldIdx: oi, newIdx: ni, score: jaccard });
                            }
                        }
                    }
                    candidates.sort((a, b) => b.score - a.score || a.oldIdx - b.oldIdx || a.newIdx - b.newIdx);
                    for (let i = 0; i < candidates.length; i++) {
                        const { oldIdx, newIdx } = candidates[i]!;
                        if (matchedOld.has(oldIdx) || matchedNew.has(newIdx)) continue;
                        const oldId = activeClusters[oldIdx]!.id;
                        if (!world.hasContent(oldId)) continue;
                        matchedOld.add(oldIdx);
                        matchedNew.set(newIdx, oldId);
                    }
                }

                try {
                    world.batch(() => {
                        for (let i = 0; i < activeClusters.length; i++) {
                            if (matchedOld.has(i)) continue;
                            const id = activeClusters[i]!.id;
                            if (world.hasContent(id)) {
                                world.detachAll(id);
                                world.removeContent(id);
                            }
                        }
                        for (let i = 0; i < clusters.length; i++) {
                            const c = clusters[i]!;
                            const pos: Vec3 = [
                                Math.round(c.centroid[0]),
                                Math.round(c.centroid[1]),
                                Math.round(c.centroid[2]),
                            ];
                            const meta = options.createMetadata
                                ? options.createMetadata(c)
                                : ({ kind: options.clusterKind } as unknown as Metadata<M, CK>);
                            const fullMeta = { ...meta, kind: options.clusterKind } as Metadata<M, CK> & { readonly kind: CK };
                            const payload = options.createPayload(c);
                            const existingId = matchedNew.get(i);
                            if (existingId) {
                                world.setContent(existingId, payload);
                                world.moveContent(existingId, pos, { metadata: fullMeta });
                                nextClusters.push({ id: existingId, members: new Set(c.memberIds) });
                            } else {
                                const id = world.putPoint(pos, fullMeta, payload);
                                nextClusters.push({ id, members: new Set(c.memberIds) });
                            }
                        }
                    });
                    activeClusters = nextClusters;
                } catch (err) {
                    if (err instanceof EventDispatchError) {
                        activeClusters = nextClusters;
                    }
                    throw err;
                }
            } finally {
                syncing = false;
            }
        };

        recompute();
        const watchRegion = options.multiPlacement === 'centroid' ? ALL : (options.region ?? ALL);
        const off: Dispose = world.on(
            'spatial:change',
            event => {
                if (syncing) return;
                const relevant = event.changes.some(c => {
                    if (c.target === 'cell') return false;
                    return c.kind !== options.clusterKind && (options.kind === undefined || c.kind === options.kind);
                });
                if (relevant) recompute();
            },
            { region: watchRegion },
        );

        return () => {
            off();
            if (options.removeOnDispose) clearMaterialised();
        };
    };
}
