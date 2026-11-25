# Middleware & Plugins

Substratum is designed for independent systems to compose over one shared space without knowing about each other.

## Middleware

Middleware intercepts every content, attachment, and cell mutation synchronously before commit. Call `next()` once to allow the write, omit `next()` to **veto** it (throwing `MutationRejected`), or pass a typed `MutationPatch` to transform the proposed value:

```ts
// Clamp resource quantity to >= 0
const stopClamp = world.middleware((ctx, next) => {
    if (ctx.target === 'content' && ctx.kind === 'resource' && ctx.operation !== 'remove') {
        next({
            target: 'content',
            kind: 'resource',
            payload: { ...ctx.payload, quantity: Math.max(0, ctx.payload.quantity) },
        });
        return;
    }
    next();
});

// Reject negative confidence metadata
world.middleware((ctx, next) => {
    if (ctx.target === 'attachment' && ctx.operation !== 'remove') {
        if ((ctx.metadata.confidence ?? 1) < 0) return; // veto
    }
    next();
});
```

### Middleware rules

- Continuation `next()` must be called at most once, synchronously (async middleware is rejected).
- Patches must match the `target` (`'content' | 'attachment' | 'cell'`) and `kind` of the proposal; they cannot redirect addresses, IDs, or operations.
- Middleware may inspect provisional state (including earlier writes in the same `batch()`), but **cannot initiate writes**. Post-commit listeners can initiate writes.

## Plugins (`use`)

Plugins are synchronous installers — not tick functions. `world.use(installer)` tracks all `on()`, `middleware()`, and nested `use()` registrations created synchronously during installation and returns an idempotent disposer that tears them down in reverse order:

```ts
const uninstall = world.use(space => {
    space.middleware((ctx, next) => {
        if (ctx.target === 'attachment' && ctx.kind === 'robot' && ctx.operation !== 'remove') {
            for (const h of space.searchContent(ctx.address, { kind: 'hazard', overlap: true })) {
                if (h.content.active) return; // veto movement into active hazards
            }
        }
        next();
    });

    space.on('update', dt => {
        // dt is caller-supplied
    });

    // Optional custom cleanup hook
    return () => {
        console.log('Safety plugin removed');
    };
});

world.update(0.016); // fires 'update:before' -> 'update' -> 'update:after'
uninstall();
```

If an installer throws during setup, any registrations made before the failure are automatically disposed.

## Complete Example: Composable Warehouse

From `examples/warehouse.ts`, two completely independent plugins share one `Substratum` instance:

```ts
import { Substratum, MutationRejected, type Bounds } from '@svaltek/substratum';

interface Content {
    robot: { name: string };
    hazard: { name: string; active: boolean };
}
interface Events {
    alarm: { name: string };
}

const world = new Substratum<Content, {}, Events>({ indexedTags: true });

// Plugin 1: Safety interlock vetoes robot entry into active hazards
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

// Plugin 2: Territory monitor raises alarms when active hazards appear on floor 0
const territory: Bounds = [[0, 64], [0, 0], [-64, 64]];
world.use(space => {
    space.on('spatial:change', event => {
        for (const t of event.transitions) {
            if (t.kind !== 'hazard' || !t.added.length || !space.hasContent(t.id)) continue;
            const hazard = space.getContent(t.id);
            if (hazard.active) space.emitAt('alarm', t.added[0]!, { name: hazard.name });
        }
    }, { region: territory });

    space.on('alarm', e => console.log('ALARM:', e.data.name), { region: territory });
});

const robot = world.putPoint([0, 0, 0], { kind: 'robot' }, { name: 'Atlas' });
const spill = world.putPoint(
    [8, 0, 8],
    { kind: 'hazard', tags: ['chemical'] },
    { name: 'Chemical spill', active: true },
    { extent: [8, 1, 8] },
);

try {
    world.moveContent(robot, [8, 0, 8]); // vetoed atomically
} catch (err) {
    if (!(err instanceof MutationRejected)) throw err;
}

world.setContent(spill, { name: 'Chemical spill', active: false });
world.moveContent(robot, [8, 0, 8]); // succeeds
```
