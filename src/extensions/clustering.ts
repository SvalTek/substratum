import {
    ALL,
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
        const span = eps > 0 ? 1 : 0;
        for (let dx = -span; dx <= span; dx++) {
            for (let dy = -span; dy <= span; dy++) {
                for (let dz = -span; dz <= span; dz++) {
                    const bucket = grid.get(`${gx + dx},${gy + dy},${gz + dz}`);
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

    const clusters: Cluster<C, M, K>[] = [];
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

        const members: ClusterMember<C, M, K>[] = [];
        for (let idx = 0; idx < n; idx++) {
            if (assigned[idx] === cid) members.push(items[idx]!);
        }
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

    const noise: ClusterMember<C, M, K>[] = [];
    for (let i = 0; i < n; i++) {
        if (assigned[i] === -1) noise.push(items[i]!);
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
    return world => {
        let activeClusterIds: ContentId<CK>[] = [];
        let syncing = false;

        const clearMaterialised = () => {
            if (!activeClusterIds.length) return;
            world.batch(() => {
                for (let i = 0; i < activeClusterIds.length; i++) {
                    const id = activeClusterIds[i]!;
                    if (world.hasContent(id)) {
                        world.detachAll(id);
                        world.removeContent(id);
                    }
                }
                activeClusterIds = [];
            });
        };

        const recompute = () => {
            if (syncing) return;
            syncing = true;
            try {
                const { clusters } = dbscan(world, options);
                world.batch(() => {
                    for (let i = 0; i < activeClusterIds.length; i++) {
                        const id = activeClusterIds[i]!;
                        if (world.hasContent(id)) {
                            world.detachAll(id);
                            world.removeContent(id);
                        }
                    }
                    activeClusterIds = [];
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
                        const id = world.putPoint(
                            pos,
                            { ...meta, kind: options.clusterKind } as Metadata<M, CK> & { readonly kind: CK },
                            options.createPayload(c),
                        );
                        activeClusterIds.push(id);
                    }
                });
            } finally {
                syncing = false;
            }
        };

        recompute();
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
            { region: options.region ?? ALL },
        );

        return () => {
            off();
            if (options.removeOnDispose) clearMaterialised();
        };
    };
}
