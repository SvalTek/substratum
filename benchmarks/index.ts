import { Substratum, type Bounds, type Vec3 } from '../src/mod.ts';

interface C {
    point: { index: number };
    beacon: { id: number };
}
interface E {
    ping: number;
}

const world = new Substratum<C, {}, E>();
let seed = 42;
function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
}
function median(values: number[]): number {
    return values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
}

const started = performance.now();
for (let i = 0; i < 10000; i++) {
    const pos: Vec3 = [Math.floor(random() * 1024), Math.floor(random() * 16), Math.floor(random() * 1024)];
    world.putPoint(pos, { kind: 'point' }, { index: i });
}
console.log('10,000 inserts (ms):', (performance.now() - started).toFixed(2));

world.putPoint([900, 4, 900], { kind: 'beacon' }, { id: 1 });
world.putPoint([100, 4, 100], { kind: 'beacon' }, { id: 2 });
world.putPoint([500, 12, 500], { kind: 'beacon' }, { id: 3 });

const q = ['', world.encode(4), ''] as const;
let t = performance.now();
const results = [...world.search(q)];
console.log('Cold layer query (ms):', (performance.now() - t).toFixed(3), 'results:', results.length);

const samples: number[] = [];
for (let i = 0; i < 100; i++) {
    t = performance.now();
    [...world.search(q)];
    samples.push(performance.now() - t);
}
console.log('Warm layer median (ms):', median(samples).toFixed(3));

const pt = world.point([500, 4, 500]);
const ptWithKind: number[] = [];
const ptNoKind: number[] = [];
for (let i = 0; i < 100; i++) {
    t = performance.now();
    [...world.search(pt, { kind: 'point' })];
    ptWithKind.push(performance.now() - t);
    t = performance.now();
    [...world.search(pt)];
    ptNoKind.push(performance.now() - t);
}
console.log(`Point query median (ms): with common kind=${median(ptWithKind).toFixed(4)}, without kind=${median(ptNoKind).toFixed(4)}`);

const box: Bounds = [[103, 317], [1, 12], [205, 419]];
t = performance.now();
const boxResults = [...world.search(box, { overlap: true })];
console.log('Cold unaligned 3D Bounds query (ms):', (performance.now() - t).toFixed(3), 'results:', boxResults.length);

t = performance.now();
const nearest = [...world.nearestContent([500, 4, 500], { limit: 10 })];
console.log('Nearest 10 (ms):', (performance.now() - t).toFixed(3), 'results:', nearest.length);

const rareTimes: number[] = [];
for (let i = 0; i < 50; i++) {
    t = performance.now();
    [...world.nearestContent([500, 4, 500], { kind: 'beacon', limit: 2 })];
    rareTimes.push(performance.now() - t);
}
console.log('Rare kind nearest 2 median (ms):', median(rareTimes).toFixed(4));

const sim = new Substratum<C, {}, E>();
const agents = Array.from({ length: 200 }, (_, i) => {
    const x = (i * 17) % 200 - 100;
    const z = (i * 31) % 200 - 100;
    return { id: sim.putPoint([x, 0, z], { kind: 'point' }, { index: i }), x, z };
});
t = performance.now();
for (let tick = 0; tick < 60; tick++) {
    sim.batch(() => {
        for (const a of agents) {
            a.x += 1;
            sim.moveContent(a.id, [a.x, 0, a.z]);
        }
    });
}
const moveMs = performance.now() - t;
console.log(`200 agents x 60 ticks (12,000 moves): ${moveMs.toFixed(2)} ms (${(moveMs / 60).toFixed(2)} ms/tick)`);

for (const n of [0, 100, 1000, 5000]) {
    const bus = new Substratum<C, {}, E>();
    for (let i = 0; i < n; i++) {
        bus.on('ping', () => { }, { region: ['0', bus.encode(i), ''] });
    }
    const address = bus.point([1, 0, 0]);
    for (let i = 0; i < 200; i++) bus.emitAt('ping', address, i);
    const times: number[] = [];
    for (let trial = 0; trial < 9; trial++) {
        const start = performance.now();
        for (let i = 0; i < 2000; i++) bus.emitAt('ping', address, i);
        times.push((performance.now() - start) * 1000 / 2000);
    }
    console.log(`${n} nonmatching subscribers: ${median(times).toFixed(3)} µs/event`);
}

world.validate();
sim.validate();
