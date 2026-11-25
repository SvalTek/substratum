import {
    type ContentId,
    type Kind,
    type Metadata,
    type Region,
    type Substratum,
    type Vec3,
} from '../mod.ts';
import { cosineDistance, euclideanDistance, type Vector } from './math.ts';

export interface SomOptions<
    C extends object,
    M extends object,
    K extends Kind<C> = Kind<C>,
> {
    /** Optional region whose lower corner defines the lattice origin in world space. */
    readonly region?: Region;
    /** Lattice dimensions [nx, ny, nz]. */
    readonly dimensions: readonly [number, number, number];
    /** Dimensionality of input feature vectors. */
    readonly inputDimensions: number;
    /** Initial learning rate. Default: 0.1. */
    readonly learningRate?: number;
    /** Initial neighbourhood radius in lattice units. Default: max(dimensions) / 2. */
    readonly neighbourhoodRadius?: number;
    /** Exponential decay per training step for learningRate. Default: 0. */
    readonly learningDecay?: number;
    /** Exponential decay per training step for neighbourhoodRadius. Default: 0. */
    readonly radiusDecay?: number;
    /** Distance metric for comparing input vectors to prototype weights. Default: 'euclidean'. */
    readonly metric?: 'euclidean' | 'cosine';
    /** Optional PRNG seed for deterministic weight initialization. */
    readonly seed?: number;
    /** Optional Substratum content kind for persisting SOM lattice nodes. */
    readonly nodeKind?: K;
    /** Payload builder when persisting SOM lattice nodes. */
    readonly createNodePayload?: (weights: readonly number[], coords: Vec3) => C[K];
    /** Metadata builder when persisting SOM lattice nodes. */
    readonly createNodeMetadata?: (coords: Vec3) => Metadata<M, K>;
}

export interface SomTrainResult {
    readonly bmu: Vec3;
    readonly distance: number;
    readonly step: number;
}

export interface SomInstance<C extends object, M extends object> {
    readonly dimensions: readonly [number, number, number];
    readonly inputDimensions: number;
    train(vector: Vector): SomTrainResult;
    trainBatch(vectors: readonly Vector[], epochs?: number): void;
    project(vector: Vector): Vec3;
    place<K extends Kind<C>>(id: ContentId<K>, vector: Vector, metadata: Metadata<M, K>): Vec3;
    weightsAt(coords: Vec3): readonly number[] | undefined;
    dispose(removePersisted?: boolean): void;
}

/** Create a 3D Self-Organising Map backed by Substratum lattice coordinates. */
export function createSOM<
    C extends object,
    M extends object,
    E extends object,
    NK extends Kind<C> = Kind<C>,
>(
    world: Substratum<C, M, E>,
    options: SomOptions<C, M, NK>,
): SomInstance<C, M> {
    const [nx, ny, nz] = options.dimensions;
    const dim = options.inputDimensions;
    if (nx < 1 || ny < 1 || nz < 1 || !Number.isSafeInteger(nx) || !Number.isSafeInteger(ny) || !Number.isSafeInteger(nz)) {
        throw RangeError('dimensions must be positive integers');
    }
    if (!Number.isSafeInteger(dim) || dim < 1) {
        throw RangeError('inputDimensions must be a positive integer');
    }

    const origin: Vec3 = options.region
        ? (() => {
            const b = world.geometry.boundsOf(options.region);
            return [b[0][0], b[1][0], b[2][0]];
        })()
        : [0, 0, 0];

    const baseRate = options.learningRate ?? 0.1;
    const baseRadius = options.neighbourhoodRadius ?? Math.max(nx, ny, nz) * 0.5;
    const learningDecay = options.learningDecay ?? 0;
    const radiusDecay = options.radiusDecay ?? 0;
    const metric = options.metric ?? 'euclidean';

    let prng = (options.seed ?? 0x5eed1234) >>> 0;
    const nextRand = () => {
        prng = (Math.imul(prng, 1664525) + 1013904223) >>> 0;
        return prng / 2 ** 32;
    };

    const totalNodes = nx * ny * nz;
    const weights = new Array<Float64Array>(totalNodes);
    const nodeIds = new Array<ContentId<NK> | undefined>(totalNodes);

    const nodeIndex = (ix: number, iy: number, iz: number) => (ix * ny + iy) * nz + iz;
    const worldCoords = (ix: number, iy: number, iz: number): Vec3 => [
        origin[0] + ix,
        origin[1] + iy,
        origin[2] + iz,
    ];

    for (let ix = 0; ix < nx; ix++) {
        for (let iy = 0; iy < ny; iy++) {
            for (let iz = 0; iz < nz; iz++) {
                const idx = nodeIndex(ix, iy, iz);
                const w = new Float64Array(dim);
                for (let d = 0; d < dim; d++) w[d] = nextRand() * 2 - 1;
                weights[idx] = w;
            }
        }
    }

    if (options.nodeKind && options.createNodePayload) {
        world.batch(() => {
            for (let ix = 0; ix < nx; ix++) {
                for (let iy = 0; iy < ny; iy++) {
                    for (let iz = 0; iz < nz; iz++) {
                        const idx = nodeIndex(ix, iy, iz);
                        const coords = worldCoords(ix, iy, iz);
                        const payload = options.createNodePayload!(Array.from(weights[idx]!), coords);
                        const meta = options.createNodeMetadata
                            ? options.createNodeMetadata(coords)
                            : ({ kind: options.nodeKind } as unknown as Metadata<M, NK>);
                        nodeIds[idx] = world.putPoint(
                            coords,
                            { ...meta, kind: options.nodeKind! } as Metadata<M, NK> & { readonly kind: NK },
                            payload,
                        );
                    }
                }
            }
        });
    }

    const vectorDist = (a: Vector, b: Float64Array): number => {
        if (metric === 'cosine') {
            return cosineDistance(a, b as unknown as Vector);
        }
        return euclideanDistance(a, b as unknown as Vector);
    };

    const findBmu = (vector: Vector): { ix: number; iy: number; iz: number; distance: number } => {
        if (vector.length !== dim) {
            throw RangeError(`Expected vector of length ${dim}, got ${vector.length}`);
        }
        let bestIx = 0, bestIy = 0, bestIz = 0;
        let bestDist = Infinity;
        for (let ix = 0; ix < nx; ix++) {
            for (let iy = 0; iy < ny; iy++) {
                for (let iz = 0; iz < nz; iz++) {
                    const d = vectorDist(vector, weights[nodeIndex(ix, iy, iz)]!);
                    if (d < bestDist) {
                        bestDist = d;
                        bestIx = ix;
                        bestIy = iy;
                        bestIz = iz;
                    }
                }
            }
        }
        return { ix: bestIx, iy: bestIy, iz: bestIz, distance: bestDist };
    };

    let stepCount = 0;

    return {
        dimensions: options.dimensions,
        inputDimensions: dim,
        train(vector) {
            const bmu = findBmu(vector);
            const t = stepCount++;
            const alpha = baseRate * Math.exp(-learningDecay * t);
            const sigma = Math.max(0.5, baseRadius * Math.exp(-radiusDecay * t));
            const rCeil = Math.ceil(sigma);
            const twoSigmaSq = 2 * sigma * sigma;

            const minX = Math.max(0, bmu.ix - rCeil);
            const maxX = Math.min(nx - 1, bmu.ix + rCeil);
            const minY = Math.max(0, bmu.iy - rCeil);
            const maxY = Math.min(ny - 1, bmu.iy + rCeil);
            const minZ = Math.max(0, bmu.iz - rCeil);
            const maxZ = Math.min(nz - 1, bmu.iz + rCeil);

            const updated: number[] = [];
            for (let ix = minX; ix <= maxX; ix++) {
                for (let iy = minY; iy <= maxY; iy++) {
                    for (let iz = minZ; iz <= maxZ; iz++) {
                        const dx = ix - bmu.ix;
                        const dy = iy - bmu.iy;
                        const dz = iz - bmu.iz;
                        const d2 = dx * dx + dy * dy + dz * dz;
                        if (d2 > sigma * sigma) continue;
                        const influence = Math.exp(-d2 / twoSigmaSq) * alpha;
                        const idx = nodeIndex(ix, iy, iz);
                        const w = weights[idx]!;
                        for (let d = 0; d < dim; d++) {
                            w[d]! += influence * (vector[d]! - w[d]!);
                        }
                        updated.push(idx);
                    }
                }
            }

            if (options.nodeKind && options.createNodePayload && updated.length) {
                world.batch(() => {
                    for (let i = 0; i < updated.length; i++) {
                        const idx = updated[i]!;
                        const nid = nodeIds[idx];
                        if (!nid || !world.hasContent(nid)) continue;
                        const iz = idx % nz;
                        const iy = Math.floor(idx / nz) % ny;
                        const ix = Math.floor(idx / (ny * nz));
                        world.setContent(nid, options.createNodePayload!(Array.from(weights[idx]!), worldCoords(ix, iy, iz)));
                    }
                });
            }

            return {
                bmu: worldCoords(bmu.ix, bmu.iy, bmu.iz),
                distance: bmu.distance,
                step: t + 1,
            };
        },
        trainBatch(vectors, epochs = 1) {
            for (let e = 0; e < epochs; e++) {
                for (let i = 0; i < vectors.length; i++) {
                    this.train(vectors[i]!);
                }
            }
        },
        project(vector) {
            const bmu = findBmu(vector);
            return worldCoords(bmu.ix, bmu.iy, bmu.iz);
        },
        place(id, vector, metadata) {
            const pos = this.project(vector);
            world.attachPoint(pos, id, metadata);
            return pos;
        },
        weightsAt(coords) {
            const ix = coords[0] - origin[0];
            const iy = coords[1] - origin[1];
            const iz = coords[2] - origin[2];
            if (ix < 0 || ix >= nx || iy < 0 || iy >= ny || iz < 0 || iz >= nz) return undefined;
            const w = weights[nodeIndex(ix, iy, iz)];
            return w ? Array.from(w) : undefined;
        },
        dispose(removePersisted = false) {
            if (!removePersisted) return;
            world.batch(() => {
                for (let i = 0; i < nodeIds.length; i++) {
                    const nid = nodeIds[i];
                    if (nid && world.hasContent(nid)) {
                        world.detachAll(nid);
                        world.removeContent(nid);
                    }
                    nodeIds[i] = undefined;
                }
            });
        },
    };
}
