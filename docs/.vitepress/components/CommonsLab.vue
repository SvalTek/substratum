<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import {
  Substratum,
  MutationRejected,
  type Address,
  type Bounds,
  type ContentId,
  type Dispose,
  type Extent,
  type Vec3,
} from '../../../src/mod.ts';

interface CommonsContent {
  depot: { name: string };
  resource: { qty: number; name: string };
  hazard: { at: Vec3; extent: Extent; name: string };
  memory: {
    source: ContentId<'resource' | 'hazard'>;
    kind: 'resource' | 'hazard';
    at: Vec3;
    extent: Extent;
    qty?: number;
    last: number;
  };
  agent: {
    name: string;
    role: 'scout' | 'forager';
    carry: number;
    mode: string;
    waypoint: Vec3 | null;
  };
}

interface CommonsEvents {
  observation: {
    source: ContentId<'resource' | 'hazard'>;
    kind: 'resource' | 'hazard';
    at: Vec3;
    extent: Extent;
    qty?: number;
  };
  harvest: {
    agent: ContentId<'agent'>;
    source: ContentId<'resource'>;
  };
  deposit: {
    agent: ContentId<'agent'>;
  };
}

type World = Substratum<CommonsContent, {}, CommonsEvents>;
type Tool = 'inspect' | 'food' | 'hazard' | 'clear';
type LogType = 'memory' | 'guard' | 'scope' | 'food' | 'system';

interface LogEntry {
  type: LogType;
  text: string;
  tick: number;
}

interface AgentRow {
  id: ContentId<'agent'>;
  index: number;
  name: string;
  role: 'scout' | 'forager';
  mode: string;
  x: number;
  z: number;
  carry: number;
  color: string;
}

const W = 30;
const H = 20;
const DEPOT: Vec3 = [2, 0, 10];
const RANGE = 4.5;
const COLORS = ['#71dec5', '#f4ce78', '#91a8ff', '#e6a2ff', '#ff987e', '#a3d77a'];

const canvasRef = ref<HTMLCanvasElement | null>(null);
const tickRef = ref(0);
const deliveredRef = ref(0);
const discoveriesRef = ref(0);
const rejectedRef = ref(0);
const localRef = ref(0);
const runningRef = ref(true);
const speedRef = ref(5);
const toolRef = ref<Tool>('inspect');
const selectedRef = ref(0);
const showCellsRef = ref(false);
const truthRef = ref(false);
const memoryOnRef = ref(true);
const guardOnRef = ref(true);
const inspectTextRef = ref('Select a scout or inspect a cell. Use placement tools on the map.');
const statsTextRef = ref('');
const agentRowsRef = ref<AgentRow[]>([]);
const logEntriesRef = ref<LogEntry[]>([]);

let world!: World;
let offMemory: Dispose | null = null;
let offGuard: Dispose | null = null;
let idSeq = 0;
let rng!: () => number;
let seen = new Map<ContentId<'resource' | 'hazard'>, ContentId<'memory'>>();
let lastMove = new Map<ContentId<'agent'>, [Vec3, Vec3]>();
let agents: ContentId<'agent'>[] = [];
let log: LogEntry[] = [];
let rafId = 0;
let resizeObserver: ResizeObserver | null = null;

const pos = (x: number, z: number): Vec3 => [x, 0, z];
const key = (p: Vec3) => `${p[0]},${p[2]}`;
const ground = (x: number, z: number) => x >= 0 && x < W && z >= 0 && z < H;
const xy = (w: World, address: Address): Vec3 => {
  const b = w.bounds(address);
  return [b[0][0], b[1][0], b[2][0]];
};
const placements = (id: ContentId): Bounds[] => world.placements(id).map(a => world.bounds(a));
const loc = (id: ContentId): Vec3 => xy(world, world.placements(id)[0]!);
const lookup = <K extends keyof CommonsContent & string>(kind: K, x: number, z: number) =>
  [...world.searchContent({ at: pos(x, z) }, { kind, overlap: true })];

function say(type: LogType, text: string) {
  log.unshift({ type, text, tick: tickRef.value });
  log = log.slice(0, 35);
}

function seeded(s: number) {
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function addResource(x: number, z: number, qty = 18) {
  return world.putPoint(pos(x, z), { kind: 'resource', tags: ['food'] }, { qty, name: 'Nectar patch' });
}

function addHazard(x: number, z: number) {
  const extent: Vec3 = [
    Math.min(5, 2 * Math.min(x, W - 1 - x) + 1),
    1,
    Math.min(5, 2 * Math.min(z, H - 1 - z) + 1),
  ];
  return world.putPoint(
    pos(x, z),
    { kind: 'hazard' },
    { at: pos(x, z), extent, name: 'Toxic bloom' },
    { extent, maxBoxes: 64 },
  );
}

function memoryPlugin(w: World) {
  w.on('observation', e => {
    const { source, kind, at, extent, qty } = e.data;
    const known = seen.get(source);
    if (known && w.hasContent(known)) {
      const old = w.getContent(known);
      if (old.qty !== qty || tickRef.value - old.last >= 8) {
        w.setContent(known, { ...old, qty, last: tickRef.value });
      }
      return;
    }
    const id = w.putPoint(
      at,
      { kind: 'memory', tags: [kind] },
      { source, kind, at, extent, qty, last: tickRef.value },
      { extent, maxBoxes: 64 },
    );
    seen.set(source, id);
    discoveriesRef.value++;
    say('memory', kind === 'hazard' ? 'Hazard knowledge shared with colony' : 'New nectar patch mapped');
  });
}

function safetyPlugin(w: World) {
  w.middleware((m, next) => {
    if (
      m.target === 'attachment' &&
      m.kind === 'agent' &&
      m.operation !== 'remove' &&
      [...w.searchContent(m.address, { kind: 'hazard', overlap: true })].length
    ) {
      return;
    }
    next();
  });
  w.on('mutation:veto', m => {
    if (m.target !== 'cell' && m.kind === 'agent') {
      rejectedRef.value++;
      say('guard', `Safety middleware vetoed ${w.getContent(m.id).name} move`);
    }
  });
}

function harvestPlugin(w: World) {
  w.on('harvest', e => {
    const { agent, source } = e.data;
    if (!w.hasContent(source) || !w.hasContent(agent)) return;
    const a = w.getContent(agent);
    const r = w.getContent(source);
    if (a.carry || r.qty <= 0 || key(loc(agent)) !== key(loc(source))) return;
    w.batch(() => {
      w.setContent(source, { ...r, qty: r.qty - 1 });
      w.setContent(agent, { ...a, carry: 1 });
    });
    w.emitAt('observation', w.point(loc(source)), {
      source,
      kind: 'resource',
      at: loc(source),
      extent: 1,
      qty: r.qty - 1,
    });
  });
  w.on('deposit', e => {
    const a = w.getContent(e.data.agent);
    if (!a.carry || key(loc(e.data.agent)) !== key(DEPOT)) return;
    deliveredRef.value += a.carry;
    w.setContent(e.data.agent, { ...a, carry: 0 });
    if (deliveredRef.value % 5 === 0) {
      say('food', `${deliveredRef.value} nectar delivered to the colony`);
    }
  });
}

function observe(w: World, p: Vec3) {
  for (const r of w.radiusContent(p, RANGE, { kind: 'resource' })) {
    if (r.content.qty <= 0 && !seen.has(r.id)) continue;
    w.emitAt('observation', r.address, {
      source: r.id,
      kind: 'resource',
      at: loc(r.id),
      extent: 1,
      qty: r.content.qty,
    });
  }
  for (const r of w.radiusContent(p, RANGE, { kind: 'hazard' })) {
    w.emitAt(
      'observation',
      { at: r.content.at, extent: r.content.extent },
      {
        source: r.id,
        kind: 'hazard',
        at: r.content.at,
        extent: r.content.extent,
      },
    );
  }
}

function isKnownHazard(p: Vec3) {
  return [...world.searchContent({ at: p }, { kind: 'memory', tags: ['hazard'], overlap: true })].length > 0;
}

function route(start: Vec3, target: Vec3): Vec3 {
  if (key(start) === key(target)) return start;
  const queue: Vec3[] = [start];
  const prev = new Map<string, Vec3 | null>([[key(start), null]]);
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i]!;
    for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
      const n = pos(p[0] + dx, p[2] + dz);
      const k = key(n);
      if (!ground(n[0], n[2]) || prev.has(k) || isKnownHazard(n)) continue;
      prev.set(k, p);
      if (k === key(target)) {
        let cur = n;
        while (prev.get(key(cur)) && key(prev.get(key(cur))!) !== key(start)) {
          cur = prev.get(key(cur))!;
        }
        return cur;
      }
      queue.push(n);
    }
  }
  return start;
}

function pilotPlugin(w: World) {
  w.on('update', () => {
    tickRef.value++;
    for (const id of agents) {
      const a = w.getContent(id);
      const p = loc(id);
      observe(w, p);
      let target: Vec3 | null;
      let mode: string;
      if (a.carry) {
        target = DEPOT;
        mode = 'Returning';
      } else {
        const m =
          a.role === 'scout'
            ? undefined
            : [...w.nearestContent(p, { kind: 'memory', tags: ['resource'], limit: 40 })].find(
                r => (r.content.qty ?? 0) > 0,
              );
        if (m) {
          target = m.content.at;
          mode = 'Foraging';
        } else {
          target = a.waypoint;
          mode = 'Exploring';
          if (!target || key(p) === key(target) || isKnownHazard(target)) {
            target = pos(3 + Math.floor(rng() * (W - 3)), Math.floor(rng() * H));
          }
        }
      }
      let next = target ? route(p, target) : p;
      if (target && key(next) === key(p) && key(p) !== key(target)) {
        const options = ([[1, 0], [0, 1], [-1, 0], [0, -1]] as const)
          .map(([dx, dz]) => pos(p[0] + dx, p[2] + dz))
          .filter(q => ground(q[0], q[2]) && !isKnownHazard(q));
        if (options.length) next = options[Math.floor(rng() * options.length)]!;
      }
      if (key(next) !== key(p)) {
        try {
          w.moveContent(id, next);
          lastMove.set(id, [p, next]);
        } catch (e) {
          if (!(e instanceof MutationRejected)) throw e;
          mode = 'Blocked';
          target = null;
        }
      }
      const now = loc(id);
      w.setContent(id, { ...w.getContent(id), mode, waypoint: target });
      if (key(now) === key(DEPOT) && a.carry) {
        w.emitAt('deposit', w.point(now), { agent: id });
      } else if (!a.carry) {
        const food = lookup('resource', now[0], now[2]).find(r => r.content.qty > 0);
        if (food) w.emitAt('harvest', food.address, { agent: id, source: food.id });
      }
    }
  });
}

function paint() {
  const canvas = canvasRef.value;
  if (!canvas || !world) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const box = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = Math.max(1, Math.round(box.width * dpr));
  const ch = Math.max(1, Math.round(box.height * dpr));
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }

  ctx.setTransform(cw / W, 0, 0, ch / H, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#101d24';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#182b35';
  ctx.fillRect(15, 0, 15, H);

  ctx.strokeStyle = '#29414a';
  ctx.lineWidth = 0.025;
  for (let i = 0; i <= W; i++) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, H);
    ctx.stroke();
  }
  for (let i = 0; i <= H; i++) {
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(W, i);
    ctx.stroke();
  }

  ctx.strokeStyle = '#70a9ba';
  ctx.lineWidth = 0.07;
  ctx.setLineDash([0.25, 0.25]);
  ctx.beginPath();
  ctx.moveTo(15, 0);
  ctx.lineTo(15, H);
  ctx.stroke();
  ctx.setLineDash([]);

  const rect = (b: Bounds, fill: string, stroke?: string, dash = false) => {
    const [x, z] = [b[0], b[2]];
    ctx.fillStyle = fill;
    ctx.fillRect(x[0] + 0.03, z[0] + 0.03, x[1] - x[0] + 0.94, z[1] - z[0] + 0.94);
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 0.06;
      ctx.setLineDash(dash ? [0.2, 0.12] : []);
      ctx.strokeRect(x[0] + 0.04, z[0] + 0.04, x[1] - x[0] + 0.92, z[1] - z[0] + 0.92);
      ctx.setLineDash([]);
    }
  };

  if (truthRef.value) {
    for (const r of world.searchContent(undefined, { kind: 'hazard' })) {
      for (const b of placements(r.id)) rect(b, '#702b4266', '#c46a79', true);
    }
    for (const r of world.searchContent(undefined, { kind: 'resource' })) {
      const p = loc(r.id);
      ctx.fillStyle = '#c5dd7444';
      ctx.fillRect(p[0] + 0.1, p[2] + 0.1, 0.8, 0.8);
    }
  }

  for (const r of world.searchContent(undefined, { kind: 'memory' })) {
    if (r.content.kind === 'hazard') {
      for (const b of placements(r.id)) rect(b, '#d4586c55', '#f37c89');
    } else {
      const p = r.content.at;
      ctx.beginPath();
      ctx.arc(p[0] + 0.5, p[2] + 0.5, 0.37, 0, Math.PI * 2);
      ctx.fillStyle = (r.content.qty ?? 0) > 0 ? '#c6e582' : '#526557';
      ctx.fill();
      ctx.strokeStyle = '#0d1d23';
      ctx.lineWidth = 0.09;
      ctx.stroke();
      ctx.fillStyle = '#d8e6cc';
      ctx.font = '.41px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(String(r.content.qty ?? 0), p[0] + 0.5, p[2] + 1.16);
    }
  }

  if (showCellsRef.value) {
    for (const r of world.searchCells()) {
      rect(world.bounds(r.address), '#0000', '#b9c4dc80', true);
    }
  }

  ctx.fillStyle = '#68b5ce';
  ctx.fillRect(1.65, 9.65, 1.7, 1.7);
  ctx.fillStyle = '#143441';
  ctx.font = 'bold .72px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('H', 2.5, 10.7);

  for (let i = 0; i < agents.length; i++) {
    const id = agents[i]!;
    const p = loc(id);
    const a = world.getContent(id);
    const x = p[0] + 0.5;
    const z = p[2] + 0.5;
    const last = lastMove.get(id);
    if (last) {
      ctx.strokeStyle = `${COLORS[i]}77`;
      ctx.lineWidth = 0.1;
      ctx.beginPath();
      ctx.moveTo(last[0][0] + 0.5, last[0][2] + 0.5);
      ctx.lineTo(x, z);
      ctx.stroke();
    }
    if (i === selectedRef.value) {
      ctx.beginPath();
      ctx.arc(x, z, RANGE, 0, Math.PI * 2);
      ctx.fillStyle = '#71dec509';
      ctx.fill();
      ctx.strokeStyle = '#71dec57a';
      ctx.lineWidth = 0.06;
      ctx.setLineDash([0.2, 0.18]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.beginPath();
    ctx.arc(x, z, 0.34, 0, Math.PI * 2);
    ctx.fillStyle = COLORS[i]!;
    ctx.fill();
    ctx.strokeStyle = '#08171b';
    ctx.lineWidth = 0.1;
    ctx.stroke();
    if (a.carry) {
      ctx.fillStyle = '#f4ce78';
      ctx.fillRect(x + 0.2, z - 0.42, 0.23, 0.23);
    }
    ctx.fillStyle = '#101d24';
    ctx.font = 'bold .38px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(i + 1), x, z + 0.13);
  }

  ctx.textAlign = 'left';
  ctx.font = '.44px monospace';
  ctx.fillStyle = '#91b0bd';
  ctx.fillText('WEST', 0.45, 0.72);
  ctx.fillText('EAST / SCOPED WATCH', 15.45, 0.72);
}

function render() {
  const s = world.stats();
  statsTextRef.value = `${s.cells} cells  /  ${s.attachments} attachments  /  ${s.contents} contents`;
  agentRowsRef.value = agents.map((id, i) => {
    const a = world.getContent(id);
    const p = loc(id);
    return {
      id,
      index: i,
      name: a.name,
      role: a.role,
      mode: a.mode,
      x: p[0],
      z: p[2],
      carry: a.carry,
      color: COLORS[i]!,
    };
  });
  logEntriesRef.value = log.slice(0, 8);
  paint();
}

function reset() {
  tickRef.value = 0;
  deliveredRef.value = 0;
  discoveriesRef.value = 0;
  rejectedRef.value = 0;
  localRef.value = 0;
  idSeq = 0;
  log = [];
  seen = new Map();
  lastMove = new Map();
  agents = [];
  rng = seeded(2718);

  world = new Substratum<CommonsContent, {}, CommonsEvents>({
    bits: 6,
    indexedTags: true,
    idFactory: () => `entity-${++idSeq}`,
  });

  world.putPoint(DEPOT, { kind: 'depot' }, { name: 'Home' });
  for (const [x, z, q] of [
    [7, 4, 22],
    [13, 15, 25],
    [24, 3, 24],
    [25, 16, 24],
    [18, 8, 22],
    [5, 17, 18],
  ] as const) {
    addResource(x, z, q);
  }
  addHazard(12, 7);
  addHazard(21, 13);

  for (let i = 0; i < 6; i++) {
    const id = world.putPoint(
      pos(2 + (i % 2), 8 + i),
      { kind: 'agent' },
      {
        name: `A${i + 1}`,
        role: i < 2 ? 'scout' : 'forager',
        carry: 0,
        mode: 'Exploring',
        waypoint: i < 2 ? pos(24, i ? 17 : 3) : pos(8 + i * 3, i % 2 ? 16 : 3),
      },
    );
    agents.push(id);
  }

  offMemory = memoryOnRef.value ? world.use(memoryPlugin) : null;
  offGuard = guardOnRef.value ? world.use(safetyPlugin) : null;
  world.use(harvestPlugin);
  world.use(pilotPlugin);
  world.on(
    'observation',
    () => {
      localRef.value++;
      if (localRef.value === 1 || localRef.value % 30 === 0) {
        say('scope', `East watch received ${localRef.value} local observations`);
      }
    },
    { region: [[15, W - 1], [0, 0], [0, H - 1]] },
  );

  say('system', 'Runtime online · six independent scouts');
  world.validate();
  render();
}

function step() {
  try {
    world.update(1);
    render();
  } catch (e) {
    runningRef.value = false;
    say('guard', String(e));
    render();
    throw e;
  }
}

function togglePlay() {
  runningRef.value = !runningRef.value;
}

function handleStep() {
  runningRef.value = false;
  step();
}

function selectAgent(i: number) {
  selectedRef.value = i;
  render();
}

function toggleMemory() {
  if (memoryOnRef.value) offMemory = world.use(memoryPlugin);
  else {
    offMemory?.();
    offMemory = null;
  }
  say('system', `Memory plugin ${memoryOnRef.value ? 'installed' : 'removed'}`);
  render();
}

function toggleGuard() {
  if (guardOnRef.value) offGuard = world.use(safetyPlugin);
  else {
    offGuard?.();
    offGuard = null;
  }
  say('system', `Safety middleware ${guardOnRef.value ? 'installed' : 'removed'}`);
  render();
}

function validateIndexes() {
  try {
    world.validate();
    say('system', 'validate(): all indexes consistent');
  } catch (e) {
    say('guard', String(e));
  }
  render();
}

function onCanvasClick(e: MouseEvent) {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const r = canvas.getBoundingClientRect();
  const x = Math.floor(((e.clientX - r.left) / r.width) * W);
  const z = Math.floor(((e.clientY - r.top) / r.height) * H);
  if (!ground(x, z)) return;

  if (toolRef.value === 'food') {
    addResource(x, z, 20);
    say('food', `Nectar seeded at ${x},${z}`);
  } else if (toolRef.value === 'hazard') {
    addHazard(x, z);
    say('guard', `Toxic bloom introduced at ${x},${z}`);
  } else if (toolRef.value === 'clear') {
    const rs = lookup('hazard', x, z);
    for (const h of rs) {
      world.batch(() => {
        world.detachAll(h.id);
        world.removeContent(h.id);
        const m = seen.get(h.id);
        if (m && world.hasContent(m)) {
          world.detachAll(m);
          world.removeContent(m);
          seen.delete(h.id);
        }
      });
    }
    say('system', `${rs.length} hazard(s) cleared`);
  } else {
    const found = agents.findIndex(id => key(loc(id)) === key(pos(x, z)));
    if (found >= 0) selectedRef.value = found;
    const matches = [...world.searchContent({ at: pos(x, z) }, { overlap: true })];
    inspectTextRef.value = `(${x}, 0, ${z}) · ${
      matches.length
        ? matches.map(m => (m.kind === 'memory' ? `memory:${m.content.kind}` : m.kind)).join(', ')
        : 'empty'
    }`;
  }
  render();
}

onMounted(() => {
  reset();
  if (canvasRef.value) {
    resizeObserver = new ResizeObserver(paint);
    resizeObserver.observe(canvasRef.value);
  }
  let last = performance.now();
  const animate = (now: number) => {
    if (runningRef.value && now - last >= 1000 / speedRef.value) {
      last = now;
      step();
    } else if (!runningRef.value) {
      last = now;
    }
    rafId = requestAnimationFrame(animate);
  };
  rafId = requestAnimationFrame(animate);

  (window as unknown as Record<string, unknown>).commons = {
    get world() { return world; },
    step,
    reset,
    get tick() { return tickRef.value; },
    get delivered() { return deliveredRef.value; },
    get discoveries() { return discoveriesRef.value; },
    get agents() { return agents; },
    get rejected() { return rejectedRef.value; },
  };
});

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId);
  resizeObserver?.disconnect();
  delete (window as unknown as Record<string, unknown>).commons;
});
</script>

<template>
  <div class="commons-root">
    <div class="commons-main">
      <div class="commons-header">
        <div>
          <div class="eyebrow">SUBSTRATUM / EXPERIMENT 001</div>
          <h1>Commons</h1>
          <p>Six agents. One shared memory. No central knowledge controller.</p>
        </div>
        <div class="live">● LIVE ESM RUNTIME</div>
      </div>

      <div class="metrics">
        <div class="metric"><small>Tick</small><strong>{{ tickRef }}</strong></div>
        <div class="metric"><small>Nectar home</small><strong>{{ deliveredRef }}</strong></div>
        <div class="metric"><small>Discoveries</small><strong>{{ discoveriesRef }}</strong></div>
        <div class="metric"><small>Vetoes</small><strong>{{ rejectedRef }}</strong></div>
        <div class="metric"><small>East events</small><strong>{{ localRef }}</strong></div>
      </div>

      <div class="layout">
        <section class="panel">
          <div class="bar">
            <button class="primary" @click="togglePlay">{{ runningRef ? 'Pause' : 'Resume' }}</button>
            <button @click="handleStep">Step</button>
            <button @click="reset">Reset</button>
            <span class="spacer"></span>
            <label>
              Rate
              <input v-model.number="speedRef" type="range" min="1" max="15" />
              <span>{{ speedRef }} / s</span>
            </label>
          </div>

          <canvas
            ref="canvasRef"
            :style="{ cursor: toolRef === 'inspect' ? 'default' : 'crosshair' }"
            aria-label="Interactive colony map. Click to inspect or place objects."
            @click="onCanvasClick"
          ></canvas>

          <div class="legend">
            <span><i class="dot" style="background:#71dec5"></i>Agents</span>
            <span><i class="dot" style="background:#c6e582"></i>Known nectar</span>
            <span><i class="dot" style="background:#d4586c"></i>Known hazard</span>
            <span><i class="dot" style="background:#68b5ce"></i>Home</span>
            <span>Dashed circle: perception</span>
          </div>

          <div class="bar line">
            <button :class="{ selected: toolRef === 'inspect' }" @click="toolRef = 'inspect'">Inspect</button>
            <button :class="{ selected: toolRef === 'food' }" @click="toolRef = 'food'">+ Nectar</button>
            <button :class="{ selected: toolRef === 'hazard' }" @click="toolRef = 'hazard'">+ Hazard</button>
            <button :class="{ selected: toolRef === 'clear' }" @click="toolRef = 'clear'">Clear hazard</button>
            <span class="spacer"></span>
            <label><input v-model="truthRef" type="checkbox" @change="paint" />Reveal truth</label>
            <label><input v-model="showCellsRef" type="checkbox" @change="paint" />Cells</label>
          </div>

          <div class="inspect">{{ inspectTextRef }}</div>
        </section>

        <aside class="side">
          <section class="panel inside">
            <h2>Agents / select to inspect</h2>
            <div>
              <button
                v-for="row in agentRowsRef"
                :key="row.id"
                class="agent"
                :class="{ selected: row.index === selectedRef }"
                @click="selectAgent(row.index)"
              >
                <i :style="{ background: row.color }"></i>
                <b :title="row.role">{{ row.name }}</b>
                <span>{{ row.mode }}{{ row.role === 'scout' ? ' · scout' : '' }}</span>
                <small>{{ row.x }},{{ row.z }}{{ row.carry ? ' • load' : '' }}</small>
              </button>
            </div>
          </section>

          <section class="panel inside">
            <h2>Runtime plugins</h2>
            <div class="switch">
              <label><input v-model="memoryOnRef" type="checkbox" @change="toggleMemory" /> Shared memory</label>
              <span>●</span>
            </div>
            <div class="switch">
              <label><input v-model="guardOnRef" type="checkbox" @change="toggleGuard" /> Safety middleware</label>
              <span>●</span>
            </div>
            <p>Perception, navigation and harvesting stay active. Removing memory retains existing observations.</p>
          </section>

          <section class="panel inside events">
            <h2>Event stream</h2>
            <div aria-live="off">
              <div v-for="(entry, idx) in logEntriesRef" :key="idx" class="entry">
                <span>{{ String(entry.tick).padStart(3, '0') }}</span>
                <span :class="entry.type">{{ entry.text }}</span>
              </div>
            </div>
          </section>
        </aside>
      </div>

      <div class="foot">
        <span>{{ statsTextRef }}</span>
        <button @click="validateIndexes">Validate indexes</button>
      </div>

      <div class="explain">
        <div>
          <b>01 / Perceive</b>
          <p>Scouts query nearby real content with <code>radiusContent</code> and emit spatial observations.</p>
        </div>
        <div>
          <b>02 / Remember</b>
          <p>The memory plugin stores discoveries as spatial content. Other scouts find them with <code>nearestContent</code>.</p>
        </div>
        <div>
          <b>03 / React</b>
          <p>Safety middleware vetoes unsafe moves; an east-only listener receives overlapping observations.</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.commons-root {
  background: #0c171e;
  color: #e7f0ec;
  font: 14px system-ui, sans-serif;
  line-height: 1.45;
  min-height: calc(100vh - var(--vp-nav-height, 64px));
}
.commons-root * {
  box-sizing: border-box;
}
.commons-main {
  max-width: 1180px;
  margin: auto;
  padding: 20px 18px 32px;
}
.commons-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
h1 {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -1px;
  line-height: 1;
  margin: 4px 0 7px;
  color: #e7f0ec;
}
h2 {
  font-size: 13px;
  font-weight: 600;
  margin: 0 0 8px;
  border: none;
  padding: 0;
  color: #e7f0ec;
}
p {
  margin: 0;
  color: #a1b5ba;
  font-size: 12px;
}
code {
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: #71dec5;
  background: #172b35;
  padding: 1px 4px;
  border-radius: 3px;
}
.eyebrow {
  font: 10px ui-monospace, monospace;
  letter-spacing: 2px;
  color: #71dec5;
}
.live {
  font: 10px ui-monospace, monospace;
  color: #71dec5;
  border: 1px solid #32554f;
  padding: 7px 9px;
  border-radius: 5px;
  white-space: nowrap;
}
.metrics {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 7px;
  margin-bottom: 10px;
}
.metric {
  background: #13242d;
  border: 1px solid #28404a;
  padding: 9px 11px;
  border-radius: 7px;
}
.metric small {
  display: block;
  color: #9ab0b9;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.metric strong {
  display: block;
  font: 700 24px ui-monospace, monospace;
  color: #e7f0ec;
}
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 260px;
  gap: 10px;
}
.panel {
  background: #13242d;
  border: 1px solid #28404a;
  border-radius: 8px;
  overflow: hidden;
}
.bar {
  padding: 10px;
  display: flex;
  gap: 7px;
  align-items: center;
  flex-wrap: wrap;
}
button {
  background: #203640;
  color: #e2eceb;
  border: 1px solid #38505a;
  border-radius: 5px;
  padding: 7px 10px;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
}
button:hover,
button:focus-visible {
  border-color: #71dec5;
  outline: none;
}
button.selected {
  background: #28483f;
  border-color: #71dec5;
  color: #baf8e5;
}
button.primary {
  background: #71dec5;
  color: #102824;
  border-color: #71dec5;
  font-weight: 700;
}
label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: #b7c8cc;
  cursor: pointer;
}
input {
  accent-color: #71dec5;
}
input[type='range'] {
  width: 70px;
}
.spacer {
  flex: 1;
}
canvas {
  display: block;
  width: 100%;
  aspect-ratio: 3 / 2;
  background: #101d24;
  touch-action: none;
}
.legend {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  padding: 9px 10px;
  font-size: 10px;
  color: #afc1c6;
}
.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 4px;
}
.line {
  border-top: 1px solid #28404a;
}
.side {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.inside {
  padding: 11px;
}
.agent {
  display: grid;
  width: 100%;
  grid-template-columns: 9px 24px 1fr auto;
  gap: 6px;
  align-items: center;
  text-align: left;
  margin: 4px 0;
  padding: 6px;
  background: #172b35;
  font-size: 11px;
}
.agent i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.agent span {
  color: #a9c2c5;
}
.agent small {
  font-size: 10px;
  color: #a0b5b9;
}
.switch {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 7px 0;
}
.switch label {
  font-size: 12px;
}
.entry {
  display: grid;
  grid-template-columns: 28px 1fr;
  gap: 7px;
  padding: 5px 0;
  font: 11px ui-monospace, monospace;
  border-bottom: 1px solid #263b44;
}
.entry > span:first-child {
  color: #718c98;
}
.memory {
  color: #c5e68b;
}
.guard {
  color: #ff9ba7;
}
.scope {
  color: #91c6ee;
}
.food {
  color: #f4ce78;
}
.system {
  color: #a5d9c7;
}
.foot {
  margin-top: 10px;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  color: #9db2b9;
  font: 10px ui-monospace, monospace;
}
.inspect {
  min-height: 24px;
  padding: 0 10px 8px;
  color: #a8c4c9;
  font: 11px ui-monospace, monospace;
}
.explain {
  margin-top: 12px;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
.explain div {
  border: 1px solid #28404a;
  border-radius: 6px;
  padding: 9px;
}
.explain b {
  font-size: 11px;
  color: #c5e7e0;
}
.explain p {
  font-size: 11px;
  margin-top: 3px;
}
@media (max-width: 760px) {
  .commons-main {
    padding: 10px;
  }
  .layout {
    grid-template-columns: 1fr;
  }
  .side {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }
  .events {
    grid-column: 1 / -1;
  }
  .metrics {
    gap: 4px;
  }
  .metric {
    padding: 6px;
  }
  .metric strong {
    font-size: 20px;
  }
  .metric small {
    font-size: 9px;
  }
  .explain {
    grid-template-columns: 1fr;
  }
  h1 {
    font-size: 23px;
  }
  .live {
    font-size: 9px;
  }
}
@media (max-width: 390px) {
  .side {
    display: flex;
  }
  .metrics {
    grid-template-columns: repeat(3, 1fr);
  }
}
</style>
