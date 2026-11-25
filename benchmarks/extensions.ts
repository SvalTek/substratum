import { Substratum, type Bounds, type ContentId, type Vec3 } from '../src/mod.ts';
import { cosineSimilarity, gaussian, softmax } from '../src/extensions/math.ts';
import { attend, weightedAggregate } from '../src/extensions/attention.ts';
import { analyse, observeStatistics } from '../src/extensions/statistics.ts';
import { dbscan, createClusterPlugin } from '../src/extensions/clustering.ts';
import { createAssociations } from '../src/extensions/associations.ts';
import { createSOM } from '../src/extensions/som.ts';
import { createPropagation } from '../src/extensions/propagation.ts';

interface C {
    obs: { category: string; value: number };
    item: { index: number };
    edge: { source: string; target: string; weight: number };
    cluster: { count: number; centroid: Vec3 };
    somNode: { coords: Vec3; weights: readonly number[] };
}
interface M {
    confidence?: number;
}
interface E {
    tick: number;
}

let seed = 0x9e3779b9;
function rand(): number {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
}
function median(values: number[]): number {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
}
function bench(label: string, fn: () => void, iterations = 15): void {
    fn(); // warmup
    const times: number[] = [];
    for (let i = 0; i < iterations; i++) {
        const t = performance.now();
        fn();
        times.push(performance.now() - t);
    }
    console.log(`${label}: ${median(times).toFixed(3)} ms (median of ${iterations})`);
}

// 1. Math: 10,000 x 384-D cosine similarity + softmax
{
    const a = Array.from({ length: 384 }, () => rand() * 2 - 1);
    const b = Array.from({ length: 384 }, () => rand() * 2 - 1);
    const scores = Array.from({ length: 1000 }, () => rand() * 10);
    const sm = softmax(0.7);
    bench('math: 10,000 x 384-D cosineSimilarity', () => {
        let acc = 0;
        for (let i = 0; i < 10000; i++) acc += cosineSimilarity(a, b);
        if (acc === Infinity) console.log(acc);
    });
    bench('math: 1,000 x softmax(0.7) over 1000 scores', () => {
        for (let i = 0; i < 1000; i++) sm(scores);
    });
}

// World with 10,000 observations for attention & statistics
const world = new Substratum<C, M, E>({ bits: 10, indexedFields: ['confidence'] });
const cats = ['alpha', 'beta', 'gamma', 'delta'];
for (let i = 0; i < 10000; i++) {
    const pos: Vec3 = [Math.floor(rand() * 512), Math.floor(rand() * 32), Math.floor(rand() * 512)];
    const conf = 0.2 + rand() * 0.8;
    world.putPoint(pos, { kind: 'obs', confidence: conf }, {
        category: cats[i % cats.length]!,
        value: rand() * 100,
    });
}

// 2. Attention
bench('attention: attend(radius=64, limit=20) on 10k world', () => {
    const res = attend(world, [256, 16, 256], {
        radius: 64,
        kind: 'obs',
        score: hit => gaussian(hit.distance ?? 0, 24) * (hit.metadata.confidence ?? 1),
        normalize: softmax(0.5),
        limit: 20,
    });
    weightedAggregate(res, r => r.hit.content.value);
});

// 3. Statistics
const region: Bounds = [[100, 300], [0, 31], [100, 300]];
bench('statistics: analyse(6 metrics) over ~1.5k hits in 10k world', () => {
    analyse(world, region, {
        kind: 'obs',
        groupBy: hit => hit.content.category,
        value: hit => hit.content.value,
        metrics: ['count', 'mean', 'variance', 'entropy', 'dominance', 'centroid'],
    });
});

{
    const obsWorld = new Substratum<C, M, E>({ bits: 10 });
    let updates = 0;
    const stop = observeStatistics(obsWorld, region, {
        kind: 'obs',
        groupBy: hit => hit.content.category,
        value: hit => hit.content.value,
        onChange: () => { updates++; },
    });
    bench('statistics: observeStatistics across 200 batched inserts', () => {
        obsWorld.batch(() => {
            for (let i = 0; i < 200; i++) {
                obsWorld.putPoint(
                    [150 + (i % 50), 5, 150 + Math.floor(i / 50)],
                    { kind: 'obs' },
                    { category: cats[i % 4]!, value: i },
                );
            }
        });
    }, 5);
    stop();
    if (updates === 0) throw Error('expected updates');
}

// 4. Clustering (DBSCAN over 1,000 points in 5 clusters)
{
    const clusterWorld = new Substratum<C, M, E>({ bits: 10 });
    for (let c = 0; c < 5; c++) {
        const cx = c * 100;
        const cy = c * 20;
        for (let i = 0; i < 200; i++) {
            const x = cx + Math.floor((rand() - 0.5) * 16);
            const y = cy + Math.floor((rand() - 0.5) * 8);
            const z = Math.floor((rand() - 0.5) * 16);
            clusterWorld.putPoint([x, y, z], { kind: 'item' }, { index: c * 200 + i });
        }
    }
    bench('clustering: dbscan(1,000 points, eps=6, minSamples=4)', () => {
        const res = dbscan(clusterWorld, { kind: 'item', epsilon: 6, minSamples: 4 });
        if (res.clusters.length === 0) throw Error('expected clusters');
    }, 5);
}

// 5. Associations
{
    const assocWorld = new Substratum<C, M, E>();
    const ids: ContentId<'item'>[] = [];
    for (let i = 0; i < 200; i++) {
        ids.push(assocWorld.createContent('item', { index: i }));
    }
    const assoc = createAssociations(assocWorld, { learningRate: 0.05, decayRate: 0.001 });
    bench('associations: 5,000 reinforce + 500 related + decay', () => {
        for (let i = 0; i < 5000; i++) {
            assoc.reinforce(ids[i % 200]!, ids[(i * 7 + 3) % 200]!);
        }
        for (let i = 0; i < 500; i++) {
            assoc.related(ids[i % 200]!, { limit: 10 });
        }
        assoc.decay(1);
    }, 5);
}

// 6. Self-Organising Map
{
    const somWorld = new Substratum<C, M, E>({ bits: 8 });
    const som = createSOM(somWorld, {
        dimensions: [8, 8, 4], // 256 nodes
        inputDimensions: 128,
        learningRate: 0.1,
        neighbourhoodRadius: 3,
    });
    const vecs = Array.from({ length: 200 }, () =>
        Array.from({ length: 128 }, () => rand() * 2 - 1),
    );
    bench('som: 200 train() steps on 8x8x4 (256 nodes) x 128-D', () => {
        for (let i = 0; i < vecs.length; i++) som.train(vecs[i]!);
    }, 5);
    bench('som: 500 project() calls on 256 nodes x 128-D', () => {
        for (let i = 0; i < 500; i++) som.project(vecs[i % vecs.length]!);
    }, 5);
}

// 7. Propagation
{
    const propWorld = new Substratum<C, M, E>({ bits: 10 });
    const ids: ContentId<'item'>[] = [];
    for (let i = 0; i < 500; i++) {
        const pos: Vec3 = [Math.floor(rand() * 64), Math.floor(rand() * 8), Math.floor(rand() * 64)];
        ids.push(propWorld.putPoint(pos, { kind: 'item' }, { index: i }));
    }
    const net = createPropagation(propWorld, { radius: 8, decay: 0.1, threshold: 0.05 });
    bench('propagation: 10 step() rounds over 500 spatial nodes', () => {
        net.reset();
        for (let i = 0; i < 20; i++) net.activate(ids[i]!, 1.0);
        for (let s = 0; s < 10; s++) net.step();
    }, 5);
    net.dispose();
}

// 8. Persisted & Composed Workloads
{
    const pAssocWorld = new Substratum<C, M, E>({ bits: 8 });
    const pIds: ContentId<'item'>[] = [];
    for (let i = 0; i < 100; i++) {
        pIds.push(pAssocWorld.putPoint([i, 0, 0], { kind: 'item' }, { index: i }));
    }
    const pAssoc = createAssociations(pAssocWorld, {
        learningRate: 0.05,
        decayRate: 0.001,
        kind: 'edge',
        createPayload: e => ({ source: e.source, target: e.target, weight: e.weight }),
        createMetadata: () => ({ kind: 'edge' }),
    });
    bench('persisted associations: 500 reinforce + decay (content + attachments)', () => {
        for (let i = 0; i < 500; i++) {
            pAssoc.reinforce(pIds[i % 100]!, pIds[(i * 7 + 3) % 100]!);
        }
        pAssoc.decay(1);
    }, 5);
    pAssoc.dispose(true);
}

{
    const pSomWorld = new Substratum<C, M, E>({ bits: 8 });
    const pSom = createSOM(pSomWorld, {
        dimensions: [8, 8, 4], // 256 persisted nodes
        inputDimensions: 64,
        learningRate: 0.1,
        neighbourhoodRadius: 2,
        nodeKind: 'somNode',
        createNodePayload: (weights, coords) => ({ coords, weights }),
    });
    const vecs = Array.from({ length: 50 }, () => Array.from({ length: 64 }, () => rand() * 2 - 1));
    bench('persisted som: 50 train() steps on 256 persisted nodes x 64-D', () => {
        for (let i = 0; i < vecs.length; i++) pSom.train(vecs[i]!);
    }, 5);
    pSom.dispose(true);
}

{
    const cWorld = new Substratum<C, M, E>({ bits: 10 });
    const obsIds: ContentId<'obs'>[] = [];
    for (let c = 0; c < 4; c++) {
        for (let i = 0; i < 50; i++) {
            obsIds.push(cWorld.putPoint(
                [c * 40 + (i % 10), 0, Math.floor(i / 10)],
                { kind: 'obs' },
                { category: 'pt', value: i },
            ));
        }
    }
    const stopCl = cWorld.use(createClusterPlugin<C, M, E, 'obs', 'cluster'>({
        kind: 'obs',
        clusterKind: 'cluster',
        epsilon: 3,
        minSamples: 4,
        preserveIdentity: true,
        createPayload: cl => ({ count: cl.count, centroid: cl.centroid }),
    }));
    let step = 0;
    bench('composed clustering (preserveIdentity): 20 moves across 200 pts', () => {
        step++;
        cWorld.batch(() => {
            for (let i = 0; i < 20; i++) {
                cWorld.moveContent(obsIds[i]!, [(i % 10), step % 2, Math.floor(i / 10)]);
            }
        });
    }, 5);
    stopCl();
}

{
    const compWorld = new Substratum<C, M, E>({ bits: 10 });
    const cIds: ContentId<'item'>[] = [];
    for (let i = 0; i < 200; i++) {
        cIds.push(compWorld.putPoint([i % 20, 0, Math.floor(i / 20)], { kind: 'item' }, { index: i }));
    }
    const compAssoc = createAssociations(compWorld, { learningRate: 0.2 });
    for (let i = 0; i < 200; i++) {
        compAssoc.reinforce(cIds[i]!, cIds[(i + 1) % 200]!);
        compAssoc.reinforce(cIds[i]!, cIds[(i + 7) % 200]!);
    }
    const compNet = createPropagation(compWorld, {
        neighbors: id => compAssoc.related(id).map(e => ({ id: e.target, weight: e.weight })),
    });
    bench('composed pipeline: associations -> propagation(5 steps) -> attend', () => {
        compNet.reset();
        for (let i = 0; i < 10; i++) compNet.activate(cIds[i]!, 1.0);
        for (let s = 0; s < 5; s++) compNet.step();
        attend(compWorld, [10, 0, 5], {
            radius: 15,
            kind: 'item',
            score: h => compNet.getActivation(h.id) + gaussian(h.distance ?? 0, 5),
            normalize: softmax(0.5),
            limit: 10,
        });
    }, 5);
    compNet.dispose();
    compAssoc.dispose();
}
