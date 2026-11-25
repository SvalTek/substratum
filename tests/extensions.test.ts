import { Substratum, type ContentId, type Vec3 } from '../src/mod.ts';
import {
    WelfordAccumulator,
    add,
    correlation,
    cosineSimilarity,
    covariance,
    dominance,
    dot,
    entropy,
    epanechnikov,
    euclideanDistance,
    gaussian,
    histogram,
    inverseDistance,
    l1Normalize,
    lerp,
    mean,
    minMaxNormalize,
    mutualInformation,
    norm,
    normalizeVector,
    scale,
    softmax,
    softmaxWeights,
    stdDev,
    subtract,
    variance,
} from '../src/extensions/math.ts';
import { attend, weightedAggregate } from '../src/extensions/attention.ts';
import { analyse, observeStatistics } from '../src/extensions/statistics.ts';
import { createClusterPlugin, dbscan } from '../src/extensions/clustering.ts';
import { createAssociations } from '../src/extensions/associations.ts';
import { createSOM } from '../src/extensions/som.ts';
import { createPropagation, createPropagationPlugin } from '../src/extensions/propagation.ts';

interface C {
    observation: { category: string; confidence: number; vector?: number[] };
    cluster: { clusterId: number; count: number; centroid: Vec3 };
    edge: { source: string; target: string; weight: number };
    somNode: { coords: Vec3; weights: readonly number[] };
    item: { label: string };
}

interface M {
    confidence?: number;
    tag?: string;
}

interface E {
    ping: number;
}

const makeWorld = () => new Substratum<C, M, E>({
    bits: 8,
    indexedFields: ['confidence'],
    indexedTags: true,
});

function assert(value: unknown, message = 'assertion failed'): asserts value {
    if (!value) throw Error(message);
}

function approx(a: number, b: number, eps = 1e-6, label = '') {
    assert(Math.abs(a - b) <= eps, `${label ? label + ': ' : ''}${a} !≈ ${b} (eps=${eps})`);
}

let passed = 0;
const test = (name: string, run: () => void) => {
    run();
    passed++;
    console.log('PASS', name);
};

test('math: vectors, kernels, normalization, and stats', () => {
    approx(dot([1, 2, 3], [4, 5, 6]), 32);
    approx(norm([3, 4]), 5);
    approx(norm(normalizeVector([3, 4])), 1);
    assert(JSON.stringify(normalizeVector([0, 0])) === '[0,0]');
    assert(JSON.stringify(add([1, 2], [3, 4])) === '[4,6]');
    assert(JSON.stringify(subtract([5, 3], [2, 1])) === '[3,2]');
    assert(JSON.stringify(scale([2, -3], 2)) === '[4,-6]');
    assert(JSON.stringify(lerp([0, 10], [10, 20], 0.25)) === '[2.5,12.5]');
    approx(euclideanDistance([0, 0, 0], [3, 4, 0]), 5);
    approx(cosineSimilarity([1, 0], [1, 0]), 1);
    approx(cosineSimilarity([1, 0], [0, 1]), 0);
    approx(cosineSimilarity([0, 0], [1, 1]), 0);

    approx(gaussian(0, 10), 1);
    assert(gaussian(10, 10) < gaussian(5, 10));
    assert(inverseDistance(0, 1, 0.1) > inverseDistance(5, 1, 0.1));
    approx(epanechnikov(0, 2), 0.75);
    approx(epanechnikov(2, 2), 0);

    const sm = softmax(0.5)([1, 2, 3]);
    approx(sm.reduce((a, b) => a + b, 0), 1);
    assert(sm[2]! > sm[1]! && sm[1]! > sm[0]!);
    approx(l1Normalize([1, 3]).reduce((a, b) => a + b, 0), 1);
    assert(JSON.stringify(minMaxNormalize([10, 15, 20])) === '[0,0.5,1]');

    const vals = [2, 4, 4, 4, 5, 5, 7, 9];
    approx(mean(vals), 5);
    approx(variance(vals), 4);
    approx(stdDev(vals), 2);
    approx(covariance([1, 2, 3], [2, 4, 6]), 4 / 3);
    approx(correlation([1, 2, 3], [2, 4, 6]), 1);

    const h = histogram([1, 2, 2, 8, 9], 2, [0, 10]);
    assert(JSON.stringify(h.counts) === '[3,2]');
    approx(entropy([5, 5]), 1);
    approx(entropy([10, 0]), 0);
    approx(dominance([7, 2, 1]), 0.7);
    assert(mutualInformation(['a', 'a', 'b', 'b'], [1, 1, 2, 2]) > 0.99);

    const w = new WelfordAccumulator();
    for (const v of vals) w.push(v);
    approx(w.mean, 5);
    approx(w.variance, 4);
    approx(w.sampleVariance, 32 / 7);
});

test('attention: distance-weighted scoring, softmax, content scope, and aggregation', () => {
    const world = makeWorld();
    const obs: Array<[Vec3, number, number]> = [
        [[5, 0, 0], 0.9, 10],
        [[15, 0, 0], 0.7, 20],
        [[30, 0, 0], 1.0, 30],
        [[45, 0, 0], 0.8, 40],
        [[65, 0, 0], 0.6, 50],
        [[90, 0, 0], 0.95, 60],
    ];
    for (const [pos, conf, val] of obs) {
        world.putPoint(pos, { kind: 'observation', confidence: conf }, {
            category: 'sensor',
            confidence: conf,
            vector: [val, val * 2],
        });
    }

    const results = attend(world, [0, 0, 0], {
        radius: 128,
        kind: 'observation',
        score: hit => gaussian(hit.distance ?? 0, 25) * (hit.metadata.confidence ?? 1),
        normalize: softmax(0.4),
        limit: 4,
    });

    assert(results.length === 4);
    approx(results.reduce((s, r) => s + r.weight, 0), 1);
    assert(results[0]!.hit.distance === 5);
    assert(results[0]!.weight > results[1]!.weight);

    const agg = weightedAggregate(results, r => r.hit.content.vector!);
    assert(Array.isArray(agg) && agg.length === 2);
    assert(agg[0]! > 10 && agg[0]! < 40);

    // Multi-placement identity-level combination
    const multiId = world.createContent('observation', { category: 'multi', confidence: 0.5 });
    world.attachPoint([2, 0, 0], multiId, { kind: 'observation', confidence: 0.5 });
    world.attachPoint([8, 0, 0], multiId, { kind: 'observation', confidence: 0.5 });

    const byContent = attend(world, [0, 0, 0], {
        radius: 10,
        kind: 'observation',
        scope: 'content',
        combine: 'sum',
        score: hit => hit.id === multiId ? 1 : 0.5,
        normalize: false,
    });
    const multiEntry = byContent.find(r => r.hit.id === multiId);
    assert(multiEntry !== undefined);
    approx(multiEntry.score, 2);
});

test('statistics: analyse and reactive observeStatistics', () => {
    const world = makeWorld();
    const region = [[-10, 10], [-10, 10], [-10, 10]] as const;

    const id1 = world.putPoint([0, 0, 0], { kind: 'observation' }, { category: 'A', confidence: 0.2 });
    world.putPoint([2, 0, 0], { kind: 'observation' }, { category: 'A', confidence: 0.4 });
    world.putPoint([4, 2, 0], { kind: 'observation' }, { category: 'B', confidence: 0.6 });

    const stats = analyse(world, region, {
        kind: 'observation',
        groupBy: hit => hit.content.category,
        value: hit => hit.content.confidence,
        metrics: ['count', 'mean', 'variance', 'entropy', 'dominance', 'centroid', 'density'],
    });

    assert(stats.count === 3);
    approx(stats.mean!, 0.4);
    approx(stats.dominance!, 2 / 3);
    assert(stats.entropy! > 0.9 && stats.entropy! < 1.0);
    approx(stats.centroid![0], 2);
    assert(stats.density! > 0);

    const seen: number[] = [];
    const stop = observeStatistics(world, region, {
        kind: 'observation',
        groupBy: hit => hit.content.category,
        value: hit => hit.content.confidence,
        emitInitial: true,
        onChange: s => seen.push(s.mean ?? 0),
    });

    // Mutate content payload directly -> should trigger reactive statistics update
    world.setContent(id1, { category: 'A', confidence: 0.8 });
    assert(seen.length === 2);
    approx(seen[1]!, 0.6);

    stop();
    world.putPoint([1, 1, 1], { kind: 'observation' }, { category: 'C', confidence: 1.0 });
    assert(seen.length === 2);
});

test('clustering: dbscan and cluster materialisation plugin', () => {
    const world = makeWorld();
    // Cluster 1 around (0,0,0)
    const c1: Vec3[] = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]];
    // Cluster 2 around (50,50,50)
    const c2: Vec3[] = [[50, 50, 50], [51, 50, 50], [50, 51, 50], [51, 51, 50]];
    // Noise
    const noisePt: Vec3 = [100, -100, 0];

    for (const p of [...c1, ...c2, noisePt]) {
        world.putPoint(p, { kind: 'observation' }, { category: 'pt', confidence: 1 });
    }

    const res = dbscan(world, {
        kind: 'observation',
        epsilon: 2,
        minSamples: 3,
    });
    assert(res.clusters.length === 2);
    assert(res.noise.length === 1);

    const disposePlugin = world.use(createClusterPlugin<C, M, E, 'observation', 'cluster'>({
        kind: 'observation',
        clusterKind: 'cluster',
        epsilon: 2,
        minSamples: 3,
        createPayload: cl => ({ clusterId: cl.id, count: cl.count, centroid: cl.centroid }),
        removeOnDispose: true,
    }));

    const materialised = [...world.searchContent(undefined, { kind: 'cluster' })];
    assert(materialised.length === 2);
    disposePlugin();
    const afterDispose = [...world.searchContent(undefined, { kind: 'cluster' })];
    assert(afterDispose.length === 0);
});

test('associations: reinforcement, decay, and persisted records', () => {
    const world = makeWorld();
    const a = world.putPoint([0, 0, 0], { kind: 'item' }, { label: 'A' });
    const b = world.putPoint([1, 0, 0], { kind: 'item' }, { label: 'B' });
    const c = world.putPoint([2, 0, 0], { kind: 'item' }, { label: 'C' });

    const assoc = createAssociations(world, {
        learningRate: 0.2,
        decayRate: 0.05,
        kind: 'edge',
        createPayload: e => ({ source: e.source, target: e.target, weight: e.weight }),
        createMetadata: () => ({ kind: 'edge' }),
        autoDecay: true,
    });

    assoc.reinforce(a, b);
    assoc.reinforce(a, b);
    assoc.reinforce(a, c);
    approx(assoc.weight(a, b), 0.4);
    approx(assoc.weight(a, c), 0.2);

    const rel = assoc.related(a);
    assert(rel.length === 2 && rel[0]!.target === b);
    assert([...world.searchContent(undefined, { kind: 'edge' })].length === 2);

    // Auto decay on world.update(2) -> drops by 0.1
    world.update(2);
    approx(assoc.weight(a, b), 0.3);
    approx(assoc.weight(a, c), 0.1);

    assoc.weaken(a, c, 0.1);
    approx(assoc.weight(a, c), 0);
    assert([...world.searchContent(undefined, { kind: 'edge' })].length === 1);

    // Disposing without removePersisted leaves persisted content intact
    assoc.dispose(false);
    assert([...world.searchContent(undefined, { kind: 'edge' })].length === 1);
});

test('som: training, projection, and placement', () => {
    const world = makeWorld();
    const som = createSOM(world, {
        region: [[10, 13], [10, 13], [10, 10]],
        dimensions: [4, 4, 1],
        inputDimensions: 3,
        learningRate: 0.4,
        neighbourhoodRadius: 2,
        seed: 42,
        nodeKind: 'somNode',
        createNodePayload: (weights, coords) => ({ coords, weights }),
    });

    assert([...world.searchContent(undefined, { kind: 'somNode' })].length === 16);

    const vA = [1, 0, 0];
    const vB = [0, 1, 0];
    for (let i = 0; i < 20; i++) {
        som.train(vA);
        som.train(vB);
    }

    const posA = som.project(vA);
    const posB = som.project(vB);
    assert(posA[0] >= 10 && posA[0] <= 13);
    assert(posB[0] >= 10 && posB[0] <= 13);
    assert(posA[0] !== posB[0] || posA[1] !== posB[1]);

    const item = world.createContent('item', { label: 'vecA' });
    const placed = som.place(item, vA, { kind: 'item' });
    assert(JSON.stringify(placed) === JSON.stringify(posA));
    assert(world.placements(item).length === 1);

    som.dispose(true);
    assert([...world.searchContent(undefined, { kind: 'somNode' })].length === 0);
});

test('propagation: step-based spreading activation and update plugin', () => {
    const world = makeWorld();
    const n1 = world.putPoint([0, 0, 0], { kind: 'item' }, { label: 'N1' });
    const n2 = world.putPoint([2, 0, 0], { kind: 'item' }, { label: 'N2' });
    const n3 = world.putPoint([4, 0, 0], { kind: 'item' }, { label: 'N3' });

    const net = createPropagation(world, {
        decay: 0.2,
        threshold: 0.05,
        radius: 3,
        aggregation: 'sum',
        activation: 'tanh',
    });

    net.activate(n1, 1.0);
    const activeCount = net.step();
    assert(activeCount >= 2);
    assert(net.getActivation(n2) > 0);
    assert(net.getActivation(n3) === 0); // 1 hop away from n1 is > radius 3

    const dispose = world.use(createPropagationPlugin(net));
    world.update(1);
    assert(net.getActivation(n3) > 0); // reached on second hop

    dispose();
    net.reset();
    assert(net.getActive().size === 0);
    net.dispose();
});

test('review regressions: overflow, prototype keys, rollbacks, and cleanup', () => {
    // 1. softmaxWeights overflow guard
    const smBig = softmaxWeights([1e308, 1e308], 0.5);
    approx(smBig[0]!, 0.5);
    approx(smBig[1]!, 0.5);

    // 2. mutualInformation delimiter collision guard
    approx(mutualInformation(['a', 'a\0string:b'], ['b\0string:c', 'c']), 1);

    // 3. statistics prototype-safe groupBy & observeStatistics initial mutation
    const wStats = makeWorld();
    wStats.putPoint([0, 0, 0], { kind: 'observation' }, { category: '__proto__', confidence: 1 });
    wStats.putPoint([1, 0, 0], { kind: 'observation' }, { category: 'constructor', confidence: 1 });
    const protoStats = analyse(wStats, undefined, {
        kind: 'observation',
        groupBy: h => h.content.category,
        metrics: ['count', 'entropy', 'dominance'],
    });
    approx(protoStats.dominance!, 0.5);
    approx(protoStats.entropy!, 1);

    const wObs = makeWorld();
    const obsEvents: number[] = [];
    const stopObs = observeStatistics(wObs, [[-5, 5], [-5, 5], [-5, 5]], {
        kind: 'observation',
        emitInitial: true,
        onChange: s => {
            obsEvents.push(s.count);
            if (s.count === 0) {
                wObs.putPoint([0, 0, 0], { kind: 'observation' }, { category: 'init', confidence: 1 });
            }
        },
    });
    assert(obsEvents.length === 2 && obsEvents[0] === 0 && obsEvents[1] === 1);
    stopObs();

    // 4. clustering tiny epsilon & plugin excluding clusterKind when kind omitted
    const wCl = makeWorld();
    wCl.putPoint([1, 1, 1], { kind: 'observation' }, { category: 'a', confidence: 1 });
    const tinyRes = dbscan(wCl, { epsilon: 1e-20, minSamples: 2 });
    assert(tinyRes.clusters.length === 0 && tinyRes.noise.length === 1);

    wCl.putPoint([1, 1, 2], { kind: 'observation' }, { category: 'a', confidence: 1 });
    const stopCl = wCl.use(createClusterPlugin<C, M, E, 'observation', 'cluster'>({
        clusterKind: 'cluster',
        epsilon: 2,
        minSamples: 2,
        createPayload: cl => ({ clusterId: cl.id, count: cl.count, centroid: cl.centroid }),
    }));
    const third = wCl.putPoint([1, 2, 1], { kind: 'observation' }, { category: 'a', confidence: 1 });
    const mat = [...wCl.searchContent(undefined, { kind: 'cluster' })];
    assert(mat.length === 1 && mat[0]!.content.count === 3);
    wCl.detachAll(third);
    stopCl();

    // 5. associations NaN guard & persistence rollback
    const wAssoc = makeWorld();
    const a1 = wAssoc.createContent('item', { label: '1' });
    const a2 = wAssoc.createContent('item', { label: '2' });
    let shouldFail = true;
    const assoc = createAssociations(wAssoc, {
        kind: 'edge',
        createPayload: e => {
            if (shouldFail) throw Error('boom');
            return { source: e.source, target: e.target, weight: e.weight };
        },
    });
    let threw = false;
    try { assoc.reinforce(a1, a2, 0.3); } catch { threw = true; }
    assert(threw && assoc.weight(a1, a2) === 0);
    shouldFail = false;
    let nanThrew = false;
    try { assoc.reinforce(a1, a2, Number.NaN); } catch { nanThrew = true; }
    assert(nanThrew);

    // 6. som fractional weightsAt & rollback on createNodePayload throw
    const wSom = makeWorld();
    let failSom = false;
    const som = createSOM(wSom, {
        dimensions: [1, 1, 1],
        inputDimensions: 1,
        learningRate: 1,
        seed: 1,
        nodeKind: 'somNode',
        createNodePayload: (weights, coords) => {
            if (failSom) throw Error('som persist fail');
            return { coords, weights };
        },
    });
    assert(som.weightsAt([0.5, 0, 0]) === undefined);
    const beforeW = som.weightsAt([0, 0, 0])![0]!;
    failSom = true;
    let somThrew = false;
    try { som.train([42]); } catch { somThrew = true; }
    assert(somThrew);
    approx(som.weightsAt([0, 0, 0])![0]!, beforeW);

    // 7. som dispose(true) rollback on veto & non-finite vector rejection
    let nanVecThrew = false;
    try { som.train([Number.NaN]); } catch { nanVecThrew = true; }
    assert(nanVecThrew);
    const stopVeto = wSom.middleware((_m, next) => {
        // veto removal of somNode
        if (_m.target === 'attachment' && _m.operation === 'remove') return;
        next();
    });
    let disposeThrew = false;
    try { som.dispose(true); } catch { disposeThrew = true; }
    assert(disposeThrew && [...wSom.searchContent(undefined, { kind: 'somNode' })].length === 1);
    stopVeto();
    som.dispose(true);
    assert([...wSom.searchContent(undefined, { kind: 'somNode' })].length === 0);

    // 8. clustering preserveIdentity keeps ContentId across recomputation
    const wIdCl = makeWorld();
    wIdCl.putPoint([0, 0, 0], { kind: 'observation' }, { category: 'a', confidence: 1 });
    wIdCl.putPoint([1, 0, 0], { kind: 'observation' }, { category: 'a', confidence: 1 });
    const stopIdCl = wIdCl.use(createClusterPlugin<C, M, E, 'observation', 'cluster'>({
        kind: 'observation',
        clusterKind: 'cluster',
        epsilon: 2,
        minSamples: 2,
        preserveIdentity: true,
        createPayload: cl => ({ clusterId: cl.id, count: cl.count, centroid: cl.centroid }),
    }));
    const firstClusterId = [...wIdCl.searchContent(undefined, { kind: 'cluster' })][0]!.id;
    wIdCl.putPoint([0, 1, 0], { kind: 'observation' }, { category: 'a', confidence: 1 });
    const updatedClusters = [...wIdCl.searchContent(undefined, { kind: 'cluster' })];
    assert(updatedClusters.length === 1 && updatedClusters[0]!.id === firstClusterId && updatedClusters[0]!.content.count === 3);
    stopIdCl();

    // 9. propagation terminal dispose & finite weight guard
    const wProp = makeWorld();
    const p1 = wProp.putPoint([0, 0, 0], { kind: 'item' }, { label: 'p1' });
    const pNet = createPropagation(wProp, {
        neighbors: () => [{ id: p1, weight: Number.POSITIVE_INFINITY }],
    });
    pNet.activate(p1, 1);
    let propWeightThrew = false;
    try { pNet.step(); } catch { propWeightThrew = true; }
    assert(propWeightThrew);
    pNet.dispose();
    let propDisposedThrew = false;
    try { pNet.step(); } catch { propDisposedThrew = true; }
    assert(propDisposedThrew);
});

console.log(`\n${passed} extension tests passed.`);
