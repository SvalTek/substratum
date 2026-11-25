import {
    Substratum,
    Geometry,
    MutationRejected,
    EventDispatchError,
    type Address,
    type Bounds,
    type Vec3,
    type ContentId,
} from '../src/mod.ts';

interface C {
    resource: { quantity: number };
    hazard: { active: boolean };
    robot: { name: string };
}
interface M {
    confidence?: number;
    faction?: string;
}
interface E {
    ping: number;
    pong: number;
}

const make = () => new Substratum<C, M, E>({ bits: 8, indexedFields: ['confidence', 'faction'], indexedTags: true });

function assert(value: unknown, message = 'assertion failed'): asserts value {
    if (!value) throw Error(message);
}
function eq(a: unknown, b: unknown) {
    assert(JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}
function throws(run: () => unknown, ctor?: new (...args: never[]) => Error) {
    let error: unknown;
    try { run(); } catch (e) { error = e; }
    assert(error instanceof Error, 'expected exception');
    if (ctor) assert(error instanceof ctor, `wrong exception: ${error}`);
    return error;
}

let passed = 0;
const test = (name: string, run: () => void) => { run(); passed++; console.log('PASS', name); };
const sorted = (xs: Iterable<string>) => [...xs].sort();

let seed = 0x12345678;
const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const ri = (n: number) => Math.floor(rand() * n);
const randomAddress = (): Address =>
    Array.from({ length: 3 }, () => Array.from({ length: ri(9) }, () => String(ri(2))).join('')) as unknown as Address;
const randomBounds = (min = -128, max = 127): Bounds => {
    const span = max - min + 1;
    const axis = (): readonly [number, number] => {
        const a = min + ri(span), b = min + ri(span);
        return a <= b ? [a, b] : [b, a];
    };
    return [axis(), axis(), axis()];
};
const boundsIntersects = (a: Bounds, b: Bounds, overlap: boolean) =>
    a.every(([lo, hi], i) => {
        const [l, h] = b[i]!;
        return overlap ? lo <= h && hi >= l : lo >= l && hi <= h;
    });
const intersects = (g: Geometry, a: Address, b: Address, overlap: boolean) =>
    boundsIntersects(g.bounds(a), g.bounds(b), overlap);

test('signed geometry and 100 exact extent covers', () => {
    const g = new Geometry(8);
    eq(g.decode(''), [-128, 127]);
    eq(g.decode(g.encode(-128)), [-128, -128]);
    eq(g.decode(g.encode(127)), [127, 127]);
    throws(() => g.encode(128));
    throws(() => g.decomposeExtent([127, 0, 0], 4));
    for (let n = 0; n < 100; n++) {
        const xyz: Vec3 = [ri(64) - 32, ri(64) - 32, ri(64) - 32];
        const dims: Vec3 = [1 + ri(8), 1 + ri(8), 1 + ri(8)];
        const covered = new Set<string>();
        for (const a of g.decompose({ at: xyz, extent: dims })) {
            const [[x, X], [y, Y], [z, Z]] = g.bounds(a);
            for (let i = x; i <= X; i++)
                for (let j = y; j <= Y; j++)
                    for (let k = z; k <= Z; k++) {
                        const key = [i, j, k].join();
                        assert(!covered.has(key));
                        covered.add(key);
                    }
        }
        const lo = xyz.map((v, i) => v - Math.floor(dims[i]! / 2));
        for (let x = 0; x < dims[0]; x++)
            for (let y = 0; y < dims[1]; y++)
                for (let z = 0; z < dims[2]; z++)
                    assert(covered.delete([lo[0]! + x, lo[1]! + y, lo[2]! + z].join()));
        eq(covered.size, 0);
    }
});

test('decompose, cover, and maxBoxes guard', () => {
    const w = make();
    const a: Address = ['01', '101', ''];
    eq(w.decompose(w.bounds(a)), [a]);
    eq(w.cover(a), a);

    const box: Bounds = [[-1, 1], [0, 0], [0, 3]];
    const cov = w.cover(box);
    assert(boundsIntersects(box, w.bounds(cov), false));
    eq(cov[0], '');
    eq(cov[1], w.encode(0));
    eq(w.bounds(cov)[2], [0, 3]);

    const unaligned: Vec3 = [1, 1, 1];
    assert(w.decompose({ at: unaligned, extent: [8, 8, 8] }).length === 64);
    throws(() => w.decompose({ at: unaligned, extent: [8, 8, 8] }, { maxBoxes: 16 }), RangeError);
    throws(() => w.putPoint(unaligned, { kind: 'resource' }, { quantity: 1 }, { extent: [8, 8, 8], maxBoxes: 16 }), RangeError);
    eq(w.stats().contents, 0);
    eq(w.stats().cells, 0);

    const id = w.putPoint([0, 0, 0], { kind: 'resource' }, { quantity: 5 });
    throws(() => w.moveContent(id, unaligned, { extent: [8, 8, 8], maxBoxes: 16 }), RangeError);
    eq(w.placements(id), [w.point([0, 0, 0])]);
    w.validate();
});

test('collocated metadata, frozen copies, semantic indexes', () => {
    const w = make();
    const m = { kind: 'resource' as const, tags: ['wood'], confidence: 1 };
    const id = w.putPoint([0, 0, 0], m, { quantity: 2 });
    const h = w.putPoint([0, 0, 0], { kind: 'hazard', tags: ['danger'] }, { active: true });
    m.tags.push('wrong');
    eq([...w.search(undefined, { tags: ['wrong'] })].length, 0);
    eq([...w.search(undefined, { where: { confidence: 1 }, tags: ['wood'] })].map(r => r.id), [id]);
    eq(w.getCell(w.point([0, 0, 0]))!.attachments.length, 2);
    w.updateAttachment(w.point([0, 0, 0]), id, { kind: 'resource', confidence: 0 });
    eq([...w.search(undefined, { where: { confidence: 1 } })].length, 0);
    eq([...w.search(undefined, { kind: 'hazard' })].map(r => r.id), [h]);
    w.validate();
});

test('unique content distance across multi-cell placements', () => {
    const w = make();
    const a = w.putPoint([0, 0, 0], { kind: 'resource' }, { quantity: 1 }, { extent: [20, 1, 20] });
    const b = w.putPoint([50, 0, 0], { kind: 'resource' }, { quantity: 2 });
    assert(w.placements(a).length > 1);
    eq([...w.nearestContent([0, 0, 0], { kind: 'resource', limit: 2 })].map(r => r.id), [a, b]);
    eq([...w.radiusContent([0, 0, 0], 5)].map(r => r.id), [a]);
    eq([...w.nearest([0, 0, 0], { limit: 0 })], []);
    throws(() => w.radius([0, 0, 0], -1));
    w.validate();
});

test('shared content routing and batched changes', () => {
    const w = make();
    const left: Address = ['0', '', ''];
    const id = w.putPoint([0, 0, 0], { kind: 'resource' }, { quantity: 1 }, { extent: [20, 1, 20] });
    let calls = 0, regions = 0;
    w.on('spatial:change', e => {
        calls++;
        regions = e.regions.length;
        assert(e.changes.every(c => c.regions.every(a => a[0].startsWith('0'))));
        eq(e.changes.length, 1);
        eq(e.changes[0]!.regions.length, regions);
    }, { region: left });
    w.setContent(id, { quantity: 2 });
    eq(calls, 1);
    eq(regions, w.placements(id).filter(a => a[0].startsWith('0')).length);
    w.validate();
});

test('extent veto is atomic, including created content', () => {
    const w = make();
    let attempts = 0, events = 0;
    w.on('spatial:change', () => events++);
    w.middleware((ctx, next) => {
        if (ctx.target === 'attachment' && ++attempts === 3) return;
        next();
    });
    throws(() => w.putPoint([0, 0, 0], { kind: 'resource' }, { quantity: 1 }, { extent: 20 }), MutationRejected);
    eq(w.stats().contents, 0);
    eq(w.stats().cells, 0);
    eq(events, 0);
    w.validate();
});

test('nested savepoints and cached-query rollback', () => {
    const w = make();
    let events = 0;
    w.on('spatial:change', () => events++);
    w.batch(() => {
        w.putPoint([1, 1, 1], { kind: 'resource' }, { quantity: 1 });
        throws(() => w.batch(() => {
            w.putPoint([2, 2, 2], { kind: 'resource' }, { quantity: 2 });
            eq([...w.search()].length, 2);
            throw Error('rollback');
        }));
        eq([...w.search()].length, 1);
        w.putPoint([3, 3, 3], { kind: 'resource' }, { quantity: 3 });
    });
    eq(events, 1);
    eq([...w.search()].length, 2);
    w.validate();
});

test('middleware patch, synchronous continuation, pre-commit write rejection', () => {
    const w = make();
    const off = w.middleware((ctx, next) => {
        if (ctx.target === 'content' && ctx.kind === 'resource') {
            return next({ target: 'content', kind: 'resource', payload: { quantity: 9 } });
        }
        next();
    });
    const id = w.putPoint([0, 0, 0], { kind: 'resource' }, { quantity: 1 });
    eq(w.getContent(id).quantity, 9);
    off();
    const twice = w.middleware((ctx, next) => { next(); next(); });
    throws(() => w.setContent(id, { quantity: 2 }));
    eq(w.getContent(id).quantity, 9);
    twice();
    const reenter = w.on('mutation:before', () => { w.setContent(id, { quantity: 3 }); });
    throws(() => w.setContent(id, { quantity: 4 }));
    eq(w.getContent(id).quantity, 9);
    reenter();
    w.validate();
});

test('atomic relocation, detach lifecycle, orphan collection', () => {
    const w = make();
    const id = w.putPoint([0, 0, 0], { kind: 'robot' }, { name: 'Atlas' });
    w.putPoint([8, 0, 8], { kind: 'hazard' }, { active: true }, { extent: [8, 1, 8] });
    w.middleware((c, next) => {
        if (
            c.target === 'attachment' &&
            c.kind === 'robot' &&
            c.operation !== 'remove' &&
            [...w.searchContent(c.address, { kind: 'hazard', overlap: true })].some(r => r.content.active)
        ) return;
        next();
    });
    throws(() => w.moveContent(id, [8, 0, 8]), MutationRejected);
    eq(w.placements(id), [w.point([0, 0, 0])]);
    w.moveContent(id, [-2, 0, 0]);
    eq(w.placements(id), [w.point([-2, 0, 0])]);
    throws(() => w.removeContent(id));
    eq(w.detachAll(id), 1);
    assert(w.orphans().includes(id));
    eq(w.collectOrphans(), [id]);
    assert(!w.hasContent(id));
    w.validate();
});

test('cell metadata independent of attachments', () => {
    const w = make();
    const a = w.point([0, 0, 0]);
    w.setCellMetadata(a, { terrain: 'rock' });
    const id = w.put(a, { kind: 'resource' }, { quantity: 1 });
    w.detach(a, id);
    eq(w.getCell(a)!.metadata, { terrain: 'rock' });
    eq([...w.searchCells()].length, 1);
    eq([...w.search()].length, 0);
    w.setCellMetadata(a, {});
    eq(w.getCell(a), undefined);
    w.validate();
});

test('plugin nested disposal, failed install, update lifecycle order', () => {
    const w = make();
    const log: string[] = [];
    const off = w.use(world => {
        world.on('update:before', () => log.push('before'));
        world.use(inner => {
            inner.on('update', () => log.push('update'));
            return () => { log.push('cleanup'); };
        });
        world.on('update:after', () => log.push('after'));
    });
    w.update(1);
    off();
    off();
    w.update(1);
    eq(log, ['before', 'update', 'after', 'cleanup']);
    throws(() => w.use(world => {
        world.on('update', () => log.push('bad'));
        throw Error('failed');
    }));
    w.update(1);
    eq(w.stats().subscriptions, 0);
    w.validate();
});

test('FIFO events, cascade bound, committed writes survive observer errors', () => {
    const w = make();
    const log: string[] = [];
    w.on('ping', e => { log.push('a' + e.data); w.emit('pong', e.data); });
    w.on('ping', () => log.push('b'));
    w.on('pong', () => log.push('c'));
    w.emit('ping', 1);
    eq(log, ['a1', 'b', 'c']);
    const loop = new Substratum<C, M, E>({ maxEvents: 3 });
    loop.on('ping', () => loop.emit('ping', 1));
    throws(() => loop.emit('ping', 1), EventDispatchError);
    w.on('spatial:change', () => { throw Error('observer'); });
    throws(() => w.putPoint([0, 0, 0], { kind: 'resource' }, { quantity: 1 }), EventDispatchError);
    eq(w.stats().contents, 1);
    w.validate();
});

test('100 random subscription routing comparisons', () => {
    const w = make();
    const received = new Set<number>();
    const scopes = Array.from({ length: 250 }, randomAddress);
    const off = scopes.map((a, i) => w.on('ping', () => { received.add(i); }, { region: a }));
    for (let i = 0; i < 100; i++) {
        const a = randomAddress();
        received.clear();
        w.emitAt('ping', a, i);
        eq([...received].sort((a, b) => a - b), scopes.flatMap((b, j) => intersects(w.geometry, a, b, true) ? [j] : []));
    }
    off.forEach(f => f());
    eq(w.stats().subscriptions, 0);
    w.validate();
});

test('100 random Bounds subscription routing and BoxRegion emitAt checks', () => {
    const w = make();
    const counts = new Map<number, number>();
    const scopes = Array.from({ length: 200 }, () => randomBounds(-64, 63));
    const off = scopes.map((b, i) => w.on('ping', e => {
        counts.set(i, (counts.get(i) ?? 0) + 1);
        assert(e.regions.every(r => boundsIntersects(w.bounds(r), b, true)));
    }, { region: b }));

    for (let i = 0; i < 100; i++) {
        counts.clear();
        const at: Vec3 = [ri(100) - 50, ri(100) - 50, ri(100) - 50];
        const extent: Vec3 = [1 + ri(6), 1 + ri(6), 1 + ri(6)];
        const emitBounds = w.geometry.extentBounds(at, extent);
        w.emitAt('ping', { at, extent }, i);
        const expected = scopes.flatMap((b, j) => boundsIntersects(emitBounds, b, true) ? [j] : []);
        eq([...counts.keys()].sort((a, b) => a - b), expected);
        assert([...counts.values()].every(c => c === 1));
    }
    off.forEach(f => f());
    eq(w.stats().subscriptions, 0);
    w.validate();
});

test('400 random spatial and proximity differential checks with removals', () => {
    const w = make();
    const rows: { a: Address; id: ContentId<'resource'>; quantity: number }[] = [];
    for (let i = 0; i < 450; i++) {
        const a = randomAddress();
        const id = w.put(a, { kind: 'resource', confidence: i % 3 }, { quantity: i });
        rows.push({ a, id, quantity: i });
    }
    for (let i = 0; i < 100; i++) {
        if (i % 4 === 0) {
            const row = rows.splice(ri(rows.length), 1)[0]!;
            w.detach(row.a, row.id);
            w.removeContent(row.id);
        }
        const q = randomAddress();
        for (const overlap of [false, true]) {
            eq(
                sorted([...w.search(q, { overlap })].map(r => r.id)),
                sorted(rows.filter(r => intersects(w.geometry, r.a, q, overlap)).map(r => r.id)),
            );
        }
        const xyz: Vec3 = [ri(300) - 150 + 0.25, ri(300) - 150, ri(300) - 150];
        const dist = (a: Address) =>
            Math.sqrt(w.bounds(a).reduce((s, [lo, hi], j) => s + Math.max(lo - xyz[j]!, xyz[j]! - hi, 0) ** 2, 0));
        const expected = rows.map(r => dist(r.a)).sort((a, b) => a - b);
        eq([...w.nearest(xyz, { limit: 7 })].map(r => r.distance), expected.slice(0, 7));
        eq([...w.radius(xyz, 40)].map(r => r.distance), expected.filter(d => d <= 40));
    }
    w.validate();
});

test('200 random Region (Bounds & BoxRegion) differential spatial checks and point fast path', () => {
    const w = make();
    const rows: { a: Address; b: Bounds; id: ContentId<'resource' | 'hazard'>; kind: 'resource' | 'hazard'; conf: number }[] = [];
    for (let i = 0; i < 350; i++) {
        const a = i < 150
            ? w.point([ri(40) - 20, ri(10) - 5, ri(40) - 20])
            : randomAddress();
        const kind = i % 10 === 0 ? 'hazard' : 'resource';
        const conf = i % 4;
        const id = kind === 'hazard'
            ? w.put(a, { kind: 'hazard', confidence: conf }, { active: true })
            : w.put(a, { kind: 'resource', confidence: conf }, { quantity: i });
        rows.push({ a, b: w.bounds(a), id, kind, conf });
    }

    const pt: Vec3 = [0, 0, 0];
    const idRes = w.putPoint(pt, { kind: 'resource', confidence: 2 }, { quantity: 99 });
    const idHaz = w.putPoint(pt, { kind: 'hazard', confidence: 2 }, { active: false });
    rows.push({ a: w.point(pt), b: w.bounds(w.point(pt)), id: idRes, kind: 'resource', conf: 2 });
    rows.push({ a: w.point(pt), b: w.bounds(w.point(pt)), id: idHaz, kind: 'hazard', conf: 2 });

    eq(
        sorted([...w.search({ at: pt }, { kind: 'resource' })].map(r => r.id)),
        sorted(rows.filter(r => r.kind === 'resource' && boundsIntersects(r.b, [[0, 0], [0, 0], [0, 0]], false)).map(r => r.id)),
    );
    eq(
        sorted([...w.search([[0, 0], [0, 0], [0, 0]], { kind: 'hazard' })].map(r => r.id)),
        sorted(rows.filter(r => r.kind === 'hazard' && boundsIntersects(r.b, [[0, 0], [0, 0], [0, 0]], false)).map(r => r.id)),
    );

    for (let i = 0; i < 200; i++) {
        const useBox = i % 2 === 0;
        const region = useBox
            ? { at: [ri(60) - 30, ri(60) - 30, ri(60) - 30] as Vec3, extent: [1 + ri(30), 1 + ri(30), 1 + ri(30)] as Vec3 }
            : randomBounds(-64, 63);
        const qb = w.geometry.boundsOf(region);
        const overlap = i % 3 !== 0;
        const kind = i % 5 === 0 ? 'hazard' : i % 5 === 1 ? 'resource' : undefined;
        const actual = kind
            ? [...w.search(region, { overlap, kind })].map(r => r.id)
            : [...w.search(region, { overlap })].map(r => r.id);
        const expected = rows
            .filter(r => (!kind || r.kind === kind) && boundsIntersects(r.b, qb, overlap))
            .map(r => r.id);
        eq(sorted(actual), sorted(expected));
    }
    w.validate();
});

test('sparse semantic distance differential checks', () => {
    const w = make();
    for (let i = 0; i < 400; i++) {
        w.putPoint([ri(120) - 60, ri(20) - 10, ri(120) - 60], { kind: 'resource' }, { quantity: i });
    }
    const rare: { id: ContentId<'hazard'>; boxes: readonly Bounds[] }[] = [];
    for (let i = 0; i < 6; i++) {
        const pos: Vec3 = [ri(100) - 50, ri(16) - 8, ri(100) - 50];
        const ext: Vec3 = i % 2 === 0 ? [5, 1, 5] : [1, 1, 1];
        const id = w.putPoint(pos, { kind: 'hazard', tags: ['rare'] }, { active: true }, { extent: ext });
        rare.push({ id, boxes: w.placements(id).map(a => w.bounds(a)) });
    }

    const boxDist = (xyz: Vec3, b: Bounds) =>
        Math.sqrt(b.reduce((s, [lo, hi], j) => s + Math.max(lo - xyz[j]!, xyz[j]! - hi, 0) ** 2, 0));

    for (let i = 0; i < 50; i++) {
        const xyz: Vec3 = [ri(140) - 70 + 0.5, ri(30) - 15, ri(140) - 70];
        const allAttachDists = rare.flatMap(r => r.boxes.map(b => boxDist(xyz, b))).sort((a, b) => a - b);
        const contentDists = rare.map(r => Math.min(...r.boxes.map(b => boxDist(xyz, b)))).sort((a, b) => a - b);

        eq([...w.nearest(xyz, { kind: 'hazard', limit: 4 })].map(r => r.distance), allAttachDists.slice(0, 4));
        eq([...w.nearestContent(xyz, { kind: 'hazard', tags: ['rare'], limit: 4 })].map(r => r.distance), contentDists.slice(0, 4));
        eq([...w.radius(xyz, 45, { kind: 'hazard' })].map(r => r.distance), allAttachDists.filter(d => d <= 45));
        eq([...w.radiusContent(xyz, 45, { kind: 'hazard' })].map(r => r.distance), contentDists.filter(d => d <= 45));
    }
    eq([...w.nearest([0, 0, 0], { kind: 'robot', limit: 5 })], []);
    w.validate();
});

test('lazy spatial:change transitions (global and scoped)', () => {
    const w = make();
    const zone: Bounds = [[0, 20], [0, 0], [0, 20]];
    const scopedLog: { kind: string; added: number; updated: number; removed: number; contentChanged: boolean; op?: string }[] = [];
    const globalLog: { kind: string; added: number; removed: number; contentChanged: boolean }[] = [];

    w.on('spatial:change', e => {
        for (const t of e.transitions) {
            scopedLog.push({
                kind: t.kind,
                added: t.added.length,
                updated: t.updated.length,
                removed: t.removed.length,
                contentChanged: t.contentChanged,
                op: t.contentOperation,
            });
        }
    }, { region: zone });

    w.on('spatial:change', e => {
        for (const t of e.transitions) {
            globalLog.push({
                kind: t.kind,
                added: t.added.length,
                removed: t.removed.length,
                contentChanged: t.contentChanged,
            });
        }
    });

    const h = w.putPoint([8, 0, 8], { kind: 'hazard' }, { active: true }, { extent: [8, 1, 8] });
    eq(scopedLog.length, 1);
    eq(scopedLog[0], { kind: 'hazard', added: w.placements(h).length, updated: 0, removed: 0, contentChanged: false, op: undefined });

    scopedLog.length = 0;
    w.setContent(h, { active: false });
    eq(scopedLog, [{ kind: 'hazard', added: 0, updated: 0, removed: 0, contentChanged: true, op: 'update' }]);

    scopedLog.length = 0;
    const r = w.putPoint([-5, 0, 0], { kind: 'robot' }, { name: 'R1' });
    eq(scopedLog.length, 0);

    w.moveContent(r, [5, 0, 5]);
    eq(scopedLog, [{ kind: 'robot', added: 1, updated: 0, removed: 0, contentChanged: false, op: undefined }]);

    scopedLog.length = 0;
    w.moveContent(r, [6, 0, 5]);
    eq(scopedLog, [{ kind: 'robot', added: 1, updated: 0, removed: 1, contentChanged: false, op: undefined }]);

    scopedLog.length = 0;
    w.updateAttachment(w.point([6, 0, 5]), r, { kind: 'robot', faction: 'alpha' });
    eq(scopedLog, [{ kind: 'robot', added: 0, updated: 1, removed: 0, contentChanged: false, op: undefined }]);

    scopedLog.length = 0;
    w.moveContent(r, [-5, 0, 0]);
    eq(scopedLog, [{ kind: 'robot', added: 0, updated: 0, removed: 1, contentChanged: false, op: undefined }]);

    scopedLog.length = 0;
    w.setCellMetadata(w.point([2, 0, 2]), { floor: 'tile' });
    eq(scopedLog, []);
    assert(globalLog.length > 0);
    w.validate();
});

test('32-bit geometry, metadata validation, clearCell, and heterogeneous move', () => {
    const g = new Geometry(32);
    eq(g.decode(g.encode(2147483647)), [2147483647, 2147483647]);
    eq(g.decompose({ at: [0, 0, 0], extent: 4294967296 }), [['', '', '']]);
    const w = make();
    const id = w.putPoint([0, 0, 0], { kind: 'resource', confidence: 1 }, { quantity: 1 });
    w.attachPoint([1, 0, 0], id, { kind: 'resource', confidence: 2 });
    throws(() => w.moveContent(id, [4, 0, 0]));
    w.moveContent(id, [4, 0, 0], { metadata: { kind: 'resource', confidence: 3 } });
    eq(w.placements(id), [w.point([4, 0, 0])]);
    assert(w.clearPoint([4, 0, 0]));
    eq(w.placements(id), []);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    throws(() => w.setCellMetadata(['', '', ''], cyclic));
    w.validate();
});

console.log(`\n${passed} runtime tests passed.`);
