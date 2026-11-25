import { Substratum, MutationRejected, type Bounds } from '../src/mod.ts';

interface Content {
    robot: { name: string };
    hazard: { name: string; active: boolean };
    resource: { name: string; quantity: number };
}
interface Meta {
    confidence?: number;
}
interface Events {
    alarm: { name: string };
    observation: { observer: string; confidence: number };
}

const world = new Substratum<Content, Meta, Events>({ indexedTags: true });

// A safety plugin interprets hazard knowledge as rules for movement.
world.use(space => {
    space.middleware((ctx, next) => {
        if (ctx.target === 'attachment' && ctx.kind === 'robot' && ctx.operation !== 'remove') {
            for (const hazard of space.searchContent(ctx.address, { kind: 'hazard', overlap: true })) {
                if (hazard.content.active) return;
            }
        }
        next();
    });
});

// An independent plugin watches a rectangular territory on floor 0.
const territory: Bounds = [[0, 64], [0, 0], [-64, 64]];
world.use(space => {
    space.on('spatial:change', event => {
        for (const t of event.transitions) {
            if (t.kind !== 'hazard' || !t.added.length || !space.hasContent(t.id)) continue;
            const hazard = space.getContent(t.id);
            if (hazard.active) {
                space.emitAt('alarm', t.added[0]!, { name: hazard.name });
            }
        }
    }, { region: territory });
    space.on('alarm', event => console.log('ALARM:', event.data.name), { region: territory });
});

const robot = world.putPoint([0, 0, 0], { kind: 'robot' }, { name: 'Atlas' });
const spill = world.putPoint(
    [8, 0, 8],
    { kind: 'hazard', tags: ['chemical'] },
    { name: 'Chemical spill', active: true },
    { extent: [8, 1, 8] },
);

console.log('Hazard cells:', world.placements(spill).length);
for (const hazard of world.nearestContent([0, 0, 0], { kind: 'hazard' })) {
    console.log('Nearest hazard:', hazard.distance.toFixed(2), hazard.content.name);
}

try {
    world.moveContent(robot, [8, 0, 8]);
} catch (error) {
    if (!(error instanceof MutationRejected)) throw error;
    console.log('Movement blocked. Position preserved:', world.placements(robot).map(a => world.bounds(a)));
}

world.setContent(spill, { name: 'Chemical spill', active: false });
world.moveContent(robot, [8, 0, 8]);
console.log(world.getContent(robot).name, 'moved to', world.placements(robot).map(a => world.bounds(a)));
world.validate();
