import type {
    Address,
    Bounds,
    ChangeEvent,
    ContentId,
    ContentTransition,
    Dispose,
    Mutation,
    Operation,
    SpatialEvent,
} from '../types.ts';
import { addressKey, type Geometry } from '../geometry.ts';
import { RegionIndex } from './region-index.ts';

type Handler = (event: unknown) => void;

interface Scoped {
    index: RegionIndex<number>;
    handlers: Map<number, Handler>;
}

export interface SpatialPayload {
    readonly event: SpatialEvent;
    readonly regionBounds: readonly Bounds[];
}

export interface Delivery {
    readonly name: string;
    readonly value: unknown;
    readonly spatial?: SpatialPayload;
}

export class EventDispatchError extends Error {
    constructor(cause: unknown) {
        super('Event dispatch failed; committed writes remain committed', { cause });
        this.name = 'EventDispatchError';
    }
}

interface TransitionAcc {
    id: ContentId;
    kind: string;
    added: Address[];
    updated: Address[];
    removed: Address[];
    contentChanged: boolean;
    contentOperation?: Operation;
}

function computeTransitions<C extends object, M extends object>(
    changes: readonly Mutation<C, M>[],
): readonly ContentTransition<C>[] {
    const byId = new Map<ContentId, TransitionAcc>();
    for (let i = 0; i < changes.length; i++) {
        const c = changes[i]!;
        if (c.target === 'cell') continue;
        let acc = byId.get(c.id);
        if (!acc) {
            acc = {
                id: c.id,
                kind: c.kind,
                added: [],
                updated: [],
                removed: [],
                contentChanged: false,
            };
            byId.set(c.id, acc);
        }
        if (c.target === 'attachment') {
            if (c.operation === 'add') acc.added.push(c.address);
            else if (c.operation === 'update') acc.updated.push(c.address);
            else acc.removed.push(c.address);
        } else {
            acc.contentChanged = true;
            acc.contentOperation = c.operation;
        }
    }
    const out: ContentTransition<C>[] = [];
    for (const acc of byId.values()) {
        const item = acc.contentOperation !== undefined
            ? {
                id: acc.id,
                kind: acc.kind,
                added: Object.freeze(acc.added),
                updated: Object.freeze(acc.updated),
                removed: Object.freeze(acc.removed),
                contentChanged: acc.contentChanged,
                contentOperation: acc.contentOperation,
            }
            : {
                id: acc.id,
                kind: acc.kind,
                added: Object.freeze(acc.added),
                updated: Object.freeze(acc.updated),
                removed: Object.freeze(acc.removed),
                contentChanged: acc.contentChanged,
            };
        out.push(Object.freeze(item) as unknown as ContentTransition<C>);
    }
    return Object.freeze(out);
}

/** Create a frozen ChangeEvent with a lazy, memoized `transitions` getter. */
export function createChangeEvent<C extends object, M extends object>(
    regions: readonly Address[],
    changes: readonly Mutation<C, M>[],
): ChangeEvent<C, M> {
    let cached: readonly ContentTransition<C>[] | undefined;
    const event: ChangeEvent<C, M> = {
        name: 'spatial:change',
        regions,
        data: changes,
        changes,
        get transitions(): readonly ContentTransition<C>[] {
            if (!cached) cached = computeTransitions(changes);
            return cached;
        },
    };
    return Object.freeze(event);
}

export class EventBus {
    private sequence = 0;
    private globals = new Map<string, Map<number, Handler>>();
    private scoped = new Map<string, Scoped>();
    private queue: Delivery[] = [];
    dispatching = false;
    private readonly maxEvents: number;
    private readonly geometry: Geometry;

    constructor(maxEvents: number, geometry: Geometry) {
        this.maxEvents = maxEvents;
        this.geometry = geometry;
    }

    on(name: string, handler: Handler, bounds?: Bounds): Dispose {
        const id = this.sequence++;
        if (!bounds) {
            let group = this.globals.get(name);
            if (!group) this.globals.set(name, group = new Map());
            group.set(id, handler);
            return () => {
                group.delete(id);
                if (!group.size && this.globals.get(name) === group) this.globals.delete(name);
            };
        }
        let group = this.scoped.get(name);
        if (!group) this.scoped.set(name, group = { index: new RegionIndex(), handlers: new Map() });
        group.index.addBounds(id, bounds, this.geometry);
        group.handlers.set(id, handler);
        return () => {
            group.index.remove(id);
            group.handlers.delete(id);
            if (!group.handlers.size && this.scoped.get(name) === group) this.scoped.delete(name);
        };
    }

    has(name: string): boolean {
        return this.globals.has(name) || this.scoped.has(name);
    }

    immediate(name: string, value: unknown): void {
        const group = this.globals.get(name);
        if (!group) return;
        for (const handler of [...group.values()]) handler(value);
    }

    private deliver(item: Delivery): void {
        const payload = item.spatial;
        if (!payload) {
            this.immediate(item.name, item.value);
            return;
        }
        const { event, regionBounds } = payload;
        const group = this.scoped.get(item.name);
        const matches = new Map<number, Address[]>();
        if (group) {
            for (let i = 0; i < event.regions.length; i++) {
                const region = event.regions[i]!;
                const rBounds = regionBounds[i]!;
                for (const id of group.index.select(region, rBounds, true)) {
                    const list = matches.get(id);
                    if (list) list.push(region);
                    else matches.set(id, [region]);
                }
            }
        }
        const deliveries = [...matches]
            .sort(([a], [b]) => a - b)
            .map(([id, regions]) => {
                const frozenRegions = Object.freeze(regions);
                let scoped: SpatialEvent;
                if (event.name === 'spatial:change') {
                    const keys = new Set(regions.map(addressKey));
                    type AnyMutation = Mutation<Record<string, unknown>, Record<string, unknown>>;
                    const source = event.data as readonly AnyMutation[];
                    const changes: AnyMutation[] = source.flatMap(change => {
                        const selected = change.regions.filter(r => keys.has(addressKey(r)));
                        return selected.length
                            ? [Object.freeze({ ...change, regions: Object.freeze(selected) }) as AnyMutation]
                            : [];
                    });
                    scoped = createChangeEvent<Record<string, unknown>, Record<string, unknown>>(
                        frozenRegions,
                        Object.freeze(changes),
                    );
                } else {
                    scoped = Object.freeze({ name: event.name, data: event.data, regions: frozenRegions });
                }
                return [group!.handlers.get(id)!, scoped] as const;
            });
        this.immediate(item.name, event);
        for (const [handler, scoped] of deliveries) handler(scoped);
    }

    enqueue(items: readonly Delivery[]): void {
        for (let i = 0; i < items.length; i++) this.queue.push(items[i]!);
        if (this.dispatching || !this.queue.length) return;
        this.dispatching = true;
        const limit = this.queue.length + this.maxEvents;
        try {
            for (let i = 0; i < this.queue.length; i++) {
                if (i >= limit) throw new Error('Event cascade exceeded maxEvents');
                this.deliver(this.queue[i]!);
            }
        } catch (cause) {
            throw new EventDispatchError(cause);
        } finally {
            this.queue = [];
            this.dispatching = false;
        }
    }

    stats(): { subscriptions: number; scopedSubscriptions: number } {
        const scopedSubscriptions = [...this.scoped.values()].reduce((n, g) => n + g.handlers.size, 0);
        const globalSubscriptions = [...this.globals.values()].reduce((n, g) => n + g.size, 0);
        return { scopedSubscriptions, subscriptions: scopedSubscriptions + globalSubscriptions };
    }

    validate(): void {
        for (const g of this.scoped.values()) {
            g.index.validate();
            if (g.index.records.size !== g.handlers.size || [...g.handlers.keys()].some(k => !g.index.records.has(k))) {
                throw Error('invalid subscription index');
            }
        }
    }
}
