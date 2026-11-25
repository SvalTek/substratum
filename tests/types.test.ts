import { Substratum, type ContentId, type Address, type Bounds, type Region, type SearchResult } from '../src/mod.ts';

interface Content {
    resource: {
        quantity: number;
        renewable: boolean;
    };
    hazard: {
        active: boolean;
    };
}
interface Meta {
    confidence?: number;
    faction?: string;
}
interface Events {
    observation: {
        observer: string;
        confidence: number;
    };
    ping: number;
}

// This file is compiled, never executed. Negative assertions must remain errors.
function contract() {
    const world = new Substratum<Content, Meta, Events>({ indexedFields: ['confidence', 'faction'], indexedTags: true });
    const res = world.putPoint([1, 2, 3], { kind: 'resource', tags: ['wood'] }, { quantity: 1, renewable: true }, { maxBoxes: 16 });
    const id: ContentId<'resource'> = res;
    const quantity: number = world.getContent(id).quantity;
    // @ts-expect-error incorrect content kind
    const bad: ContentId<'hazard'> = res;
    // @ts-expect-error payload does not match declared kind
    world.putPoint([0, 0, 0], { kind: 'resource' }, { active: true });
    // @ts-expect-error unknown kind
    world.createContent('unknown', {});
    // @ts-expect-error content ID determines payload
    world.setContent(res, { active: true });
    // @ts-expect-error content ID determines metadata kind
    world.attach(['', '', ''], res, { kind: 'hazard' });
    // @ts-expect-error invalid metadata field
    world.put(['', '', ''], { kind: 'resource', bogus: 1 }, { quantity: 1, renewable: true });
    for (const r of world.nearestContent([0, 0, 0], { kind: 'resource', limit: 5, filter: m => m.kind === 'resource' })) {
        const n: number = r.content.quantity;
        const rid: ContentId<'resource'> = r.id;
        void [n, rid];
        // @ts-expect-error narrowing excludes hazard fields
        r.content.active;
        // @ts-expect-error metadata is immutable
        r.metadata.confidence = 0;
    }
    for (const r of world.search()) {
        if (r.kind === 'hazard') {
            const active: boolean = r.content.active;
            void active;
        }
        // @ts-expect-error unfiltered results are a discriminated union
        r.content.quantity;
    }
    const box: Bounds = [[0, 10], [0, 0], [0, 10]];
    const region: Region = { at: [0, 0, 0], extent: [8, 1, 8] };
    const covered: Address = world.cover(box);
    const cells: readonly Address[] = world.decompose(region, { maxBoxes: 16 });
    void cells;
    for (const r of world.search(box, { kind: 'hazard', overlap: true })) {
        const active: boolean = r.content.active;
        void active;
    }
    for (const r of world.searchContent(region, { kind: 'resource' })) {
        const q: number = r.content.quantity;
        void q;
    }
    // @ts-expect-error can't claim a narrowed return type without kind restriction
    world.search<'resource'>(undefined, {});
    world.on('observation', event => { const observer: string = event.data.observer; void observer; });
    world.on('observation', event => { const observer: string = event.data.observer; void observer; }, { region: box });
    world.on('spatial:change', event => {
        for (const t of event.transitions) {
            if (t.kind === 'hazard') {
                const hid: ContentId<'hazard'> = t.id;
                // @ts-expect-error narrowed transition ID is hazard, not resource
                const wrong: ContentId<'resource'> = t.id;
                void [hid, wrong];
            }
        }
    }, { region });
    world.emitAt('observation', world.point([1, 2, 3]), { observer: 'robot', confidence: 1 });
    world.emitAt('observation', box, { observer: 'robot', confidence: 1 }, { maxBoxes: 32 });
    // @ts-expect-error wrong event data
    world.emit('observation', { observer: 'robot' });
    // @ts-expect-error unknown event
    world.on('missing', () => { });
    // @ts-expect-error lifecycle tick is not spatial
    world.on('update', () => { }, { region: ['', '', ''] });
    world.on('update:before', dt => { const n: number = dt; void n; });
    world.on('update', dt => { const n: number = dt; void n; });
    world.on('update:after', dt => { const n: number = dt; void n; });
    world.use(space => {
        space.on('update', dt => { void dt; });
    });
    world.update(0.016);
    world.middleware((ctx, next) => {
        if (ctx.target === 'content' && ctx.kind === 'hazard' && ctx.payload) {
            const b: boolean = ctx.payload.active;
            next({ target: 'content', kind: 'hazard', payload: { active: !b } });
            return;
        }
        if (ctx.target === 'cell' && ctx.operation !== 'remove') {
            next({ target: 'cell', metadata: { ...ctx.metadata, audited: true } });
            return;
        }
        next();
    });
    world.middleware((ctx, next) => {
        // @ts-expect-error wrong patch payload for kind
        next({ target: 'content', kind: 'hazard', payload: { quantity: 1, renewable: true } });
    });
    // @ts-expect-error address requires three axes
    const a: Address = ['', ''];
    const results: IterableIterator<SearchResult<Content, Meta, 'resource'>> = world.search(undefined, { kind: 'resource' });
    return [quantity, bad, a, covered, results];
}
void contract;
