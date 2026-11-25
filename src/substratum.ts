import {
    ALL,
    Geometry,
    addressKey,
    boundsMatch,
    distanceSquared,
    isAddress,
    isExactPoint,
} from './geometry.ts';
import { EventBus, createChangeEvent, type Delivery } from './internal/events.ts';
import { equal, freezeMetadata, scalarKey } from './internal/metadata.ts';
import { ProximityIndex } from './internal/proximity-index.ts';
import { RegionIndex, type AxisSpans } from './internal/region-index.ts';
import type {
    Address,
    Bounds,
    BoxOptions,
    CellMetadata,
    CellSnapshot,
    ContentId,
    CustomName,
    Dispose,
    DistanceResult,
    EventMap,
    ExtentOptions,
    Interval,
    Kind,
    Metadata,
    Middleware,
    MoveOptions,
    Mutation,
    MutationPatch,
    NearestOptions,
    QueryOptions,
    Region,
    SearchOptions,
    SearchResult,
    SpatialEvent,
    Stats,
    SubstratumOptions,
    Vec3,
} from './types.ts';

const EMPTY: CellMetadata = Object.freeze({});
const RESERVED = new Set([
    'spatial:change',
    'mutation:before',
    'mutation:veto',
    'mutation:add',
    'mutation:update',
    'mutation:remove',
    'mutation:after',
    'update:before',
    'update',
    'update:after',
]);

const isThenable = (v: unknown): boolean =>
    v !== null &&
    (typeof v === 'object' || typeof v === 'function') &&
    typeof (v as { then?: unknown }).then === 'function';

export class MutationRejected extends Error {
    readonly mutation: unknown;
    constructor(mutation: unknown) {
        super('Mutation rejected by middleware');
        this.name = 'MutationRejected';
        this.mutation = mutation;
    }
}

interface ContentRecord {
    kind: string;
    payload: unknown;
}

interface StoredAttachment {
    readonly cell: StoredCell;
    readonly id: ContentId;
    readonly kind: string;
    readonly metadata: Readonly<Record<string, unknown>>;
}

interface StoredCell {
    readonly key: string;
    readonly address: Address;
    readonly bounds: Bounds;
    metadata: CellMetadata;
    readonly attachments: Map<ContentId, StoredAttachment>;
}

interface CacheEntry {
    readonly bounds: Bounds;
    readonly overlap: boolean;
    readonly keys: readonly string[];
}

interface Criteria {
    readonly test: (a: StoredAttachment) => boolean;
    readonly groups: readonly ReadonlySet<StoredAttachment>[];
}

const EMPTY_SET: ReadonlySet<StoredAttachment> = new Set();

/** A synchronous, in-memory, reactive spatial runtime. All coordinates are integer lattice positions. */
export class Substratum<
    C extends object = Record<string, unknown>,
    M extends object = Record<string, unknown>,
    E extends object = Record<never, never>,
> {
    readonly geometry: Geometry;
    private readonly cells = new Map<string, StoredCell>();
    private readonly regions = new RegionIndex<string>();
    private readonly proximity = new ProximityIndex();
    private readonly contents = new Map<ContentId, ContentRecord>();
    private readonly placementIndex = new Map<ContentId, Set<string>>();
    private readonly fieldIndex = new Map<string, Map<string, Set<StoredAttachment>>>();
    private readonly tagIndex = new Map<string, Set<StoredAttachment>>();
    private readonly indexedFields: Set<string>;
    private readonly indexedTags: boolean;
    private readonly cache = new Map<string, CacheEntry>();
    private cacheSize = 0;
    private readonly bus: EventBus;
    private readonly idFactory: () => string;
    private readonly middlewareHandlers = new Map<symbol, Middleware<C, M>>();
    private readonly installScopes: Dispose[][] = [];
    private depth = 0;
    private active = false;
    private updating = false;
    private undo: Dispose[] = [];
    private pending: Delivery[] = [];
    private changes: Mutation<C, M>[] = [];

    constructor(options: SubstratumOptions<M> = {}) {
        this.geometry = new Geometry(options.bits);
        this.indexedFields = new Set(['kind', ...(options.indexedFields ?? [])]);
        this.indexedTags = options.indexedTags ?? false;
        const max = options.maxEvents ?? 10000;
        if (!Number.isSafeInteger(max) || max < 1) {
            throw RangeError('maxEvents must be a positive integer');
        }
        this.bus = new EventBus(max, this.geometry);
        this.idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
    }

    get bits(): number { return this.geometry.bits; }
    encode(value: number): string { return this.geometry.encode(value); }
    decode(prefix: string): Interval { return this.geometry.decode(prefix); }
    point(xyz: Vec3): Address { return this.geometry.point(xyz); }
    bounds(address: Address): Bounds { return this.geometry.bounds(address); }
    decompose(region: Region, options?: BoxOptions): readonly Address[] {
        return this.geometry.decompose(region, options);
    }
    cover(region: Region): Address { return this.geometry.cover(region); }

    private track(dispose: Dispose): Dispose {
        this.installScopes.at(-1)?.push(dispose);
        return dispose;
    }

    private record(id: ContentId): ContentRecord {
        const rec = this.contents.get(id);
        if (!rec) throw Error(`Unknown content: ${id}`);
        return rec;
    }

    /** Get a payload, with its type inferred from the branded content ID. Payloads remain live. */
    getContent<K extends Kind<C>>(id: ContentId<K>): C[K] {
        return this.record(id).payload as C[K];
    }

    hasContent(id: ContentId): boolean {
        return this.contents.has(id);
    }

    private publish(item: Delivery): void {
        if (this.depth) this.pending.push(item);
        else this.bus.enqueue([item]);
    }

    /** Synchronous transaction with nested savepoints. Post-commit notifications cannot roll back writes. */
    batch<T>(run: () => T): T {
        if (this.active) throw Error('Middleware and pre-commit listeners cannot initiate writes');
        const mark = [this.undo.length, this.pending.length, this.changes.length] as const;
        this.depth++;
        let value: T;
        try {
            value = run();
            if (isThenable(value)) throw TypeError('batch must be synchronous');
        } catch (error) {
            for (let i = this.undo.length - 1; i >= mark[0]; i--) this.undo[i]!();
            this.undo.length = mark[0];
            this.pending.length = mark[1];
            this.changes.length = mark[2];
            throw error;
        } finally {
            this.depth--;
        }
        if (!this.depth) {
            const pending = this.pending;
            const changes = Object.freeze(this.changes.filter(c => c.regions.length));
            this.pending = [];
            this.changes = [];
            this.undo = [];
            if (this.bus.has('spatial:change') && changes.length) {
                const regionMap = new Map<string, Address>();
                for (let i = 0; i < changes.length; i++) {
                    const rs = changes[i]!.regions;
                    for (let j = 0; j < rs.length; j++) {
                        const r = rs[j]!;
                        const k = addressKey(r);
                        if (!regionMap.has(k)) regionMap.set(k, r);
                    }
                }
                if (regionMap.size) {
                    const regions = Object.freeze([...regionMap.values()]);
                    const regionBounds: Bounds[] = [];
                    for (const [k, r] of regionMap) {
                        regionBounds.push(this.cells.get(k)?.bounds ?? this.geometry.bounds(r));
                    }
                    const event = createChangeEvent(regions, changes);
                    pending.push({ name: event.name, value: event, spatial: { event, regionBounds } });
                }
            }
            this.bus.enqueue(pending);
        }
        return value;
    }

    private mutate(ctx: Mutation<C, M>, commit: (ctx: Mutation<C, M>) => void): void {
        if (this.active) throw Error('Recursive mutation');
        this.active = true;
        const handlers = [...this.middlewareHandlers.values()];
        let committed = false;
        const dispatch = (i: number, proposal: Mutation<C, M>): void => {
            if (i === handlers.length) {
                commit(proposal);
                committed = true;
                this.changes.push(proposal);
                for (const name of [`mutation:${proposal.operation}`, 'mutation:after']) {
                    if (this.bus.has(name)) this.pending.push({ name, value: proposal });
                }
                return;
            }
            let called = false;
            let open = true;
            try {
                const value = handlers[i]!(proposal, (patch?: MutationPatch<C, M>) => {
                    if (!open || called) throw Error('next() must be called once and synchronously');
                    called = true;
                    let next = proposal;
                    if (patch) {
                        if (
                            patch.target !== proposal.target ||
                            ('kind' in patch && (!('kind' in proposal) || patch.kind !== proposal.kind))
                        ) {
                            throw Error('Patch does not match mutation target or kind');
                        }
                        if ('metadata' in patch) {
                            if (proposal.target === 'content' || proposal.operation === 'remove' || patch.metadata === undefined) {
                                throw Error('Invalid metadata patch');
                            }
                            const metadata = proposal.target === 'attachment'
                                ? this.checkMetadata(patch.metadata, proposal.kind)
                                : freezeMetadata(patch.metadata);
                            next = Object.freeze({ ...proposal, metadata }) as Mutation<C, M>;
                        } else if ('payload' in patch) {
                            if (proposal.target !== 'content' || proposal.operation === 'remove') {
                                throw Error('Invalid payload patch');
                            }
                            next = Object.freeze({ ...proposal, payload: patch.payload } as object) as Mutation<C, M>;
                        }
                    }
                    dispatch(i + 1, next);
                });
                if (isThenable(value)) throw TypeError('Middleware must be synchronous');
            } finally {
                open = false;
            }
        };
        try {
            this.bus.immediate('mutation:before', ctx);
            dispatch(0, ctx);
            if (!committed) {
                this.bus.immediate('mutation:veto', ctx);
                throw new MutationRejected(ctx);
            }
        } finally {
            this.active = false;
        }
    }

    private invalidate(bounds: Bounds): void {
        if (!this.cache.size) return;
        for (const [key, entry] of this.cache) {
            if (boundsMatch(bounds, entry.bounds, entry.overlap)) {
                this.cache.delete(key);
                this.cacheSize -= entry.keys.length;
            }
        }
    }

    private ensureCell(address: Address): StoredCell {
        const key = addressKey(address);
        let cell = this.cells.get(key);
        if (!cell) {
            const bounds = this.geometry.bounds(address);
            cell = { key, address, bounds, metadata: EMPTY, attachments: new Map() };
            this.cells.set(key, cell);
            this.regions.add(key, address, bounds);
            this.proximity.add(address, key);
            this.invalidate(bounds);
        }
        return cell;
    }

    private pruneCell(cell: StoredCell): void {
        if (cell.attachments.size || Object.keys(cell.metadata).length) return;
        this.cells.delete(cell.key);
        this.regions.remove(cell.key);
        this.proximity.remove(cell.address);
        this.invalidate(cell.bounds);
    }

    private indexAttachment(a: StoredAttachment, add: boolean): void {
        const meta = a.metadata;
        for (const field of this.indexedFields) {
            if (!Object.hasOwn(meta, field)) continue;
            const sk = scalarKey(meta[field]);
            if (sk === undefined) continue;
            if (add) {
                let byVal = this.fieldIndex.get(field);
                if (!byVal) this.fieldIndex.set(field, byVal = new Map());
                let bucket = byVal.get(sk);
                if (!bucket) byVal.set(sk, bucket = new Set());
                bucket.add(a);
            } else {
                const byVal = this.fieldIndex.get(field);
                const bucket = byVal?.get(sk);
                if (bucket) {
                    bucket.delete(a);
                    if (!bucket.size) {
                        byVal!.delete(sk);
                        if (!byVal!.size) this.fieldIndex.delete(field);
                    }
                }
            }
        }
        if (this.indexedTags && Array.isArray(meta.tags)) {
            for (let i = 0; i < meta.tags.length; i++) {
                const tag = meta.tags[i] as string;
                if (add) {
                    let bucket = this.tagIndex.get(tag);
                    if (!bucket) this.tagIndex.set(tag, bucket = new Set());
                    bucket.add(a);
                } else {
                    const bucket = this.tagIndex.get(tag);
                    if (bucket) {
                        bucket.delete(a);
                        if (!bucket.size) this.tagIndex.delete(tag);
                    }
                }
            }
        }
    }

    private checkMetadata(metadata: object, kind: string): Readonly<Record<string, unknown>> {
        const m = freezeMetadata(metadata) as Readonly<Record<string, unknown>>;
        if (m.kind !== kind) throw Error('Metadata kind must equal content kind');
        if (m.tags !== undefined && (!Array.isArray(m.tags) || [...m.tags].some(t => typeof t !== 'string'))) {
            throw TypeError('tags must be strings');
        }
        return m;
    }

    private setAttachment(
        address: Address,
        id: ContentId,
        kind: string,
        metadata: Readonly<Record<string, unknown>> | undefined,
    ): void {
        const key = addressKey(address);
        let cell = this.cells.get(key);
        const old = cell?.attachments.get(id);
        if (old) {
            this.indexAttachment(old, false);
            cell!.attachments.delete(id);
            const ps = this.placementIndex.get(id)!;
            ps.delete(key);
            if (!ps.size) this.placementIndex.delete(id);
        }
        if (metadata !== undefined) {
            cell = this.ensureCell(address);
            const stored: StoredAttachment = { cell, id, kind, metadata };
            cell.attachments.set(id, stored);
            let ps = this.placementIndex.get(id);
            if (!ps) this.placementIndex.set(id, ps = new Set());
            ps.add(key);
            this.indexAttachment(stored, true);
        }
        if (cell) this.pruneCell(cell);
    }

    private changeAttachment(
        address: Address,
        id: ContentId,
        metadata?: object,
        checked = false,
    ): boolean {
        const rec = this.record(id);
        const old = this.cells.get(addressKey(address))?.attachments.get(id);
        if (!metadata && !old) return false;
        const proposed = metadata
            ? (checked ? (metadata as Readonly<Record<string, unknown>>) : this.checkMetadata(metadata, rec.kind))
            : undefined;
        const ctx = Object.freeze({
            target: 'attachment',
            operation: metadata ? (old ? 'update' : 'add') : 'remove',
            address,
            id,
            kind: rec.kind,
            metadata: proposed,
            previousMetadata: old?.metadata,
            regions: Object.freeze([address]),
        }) as Mutation<C, M>;
        const oldMeta = old?.metadata;
        this.mutate(ctx, c => {
            if (c.target !== 'attachment') throw Error('Invalid mutation');
            const nextMeta = c.metadata === undefined
                ? undefined
                : (c.metadata === proposed ? proposed : this.checkMetadata(c.metadata, rec.kind));
            this.undo.push(() => this.setAttachment(address, id, rec.kind, oldMeta));
            this.setAttachment(address, id, rec.kind, nextMeta);
        });
        return true;
    }

    private changeContent(id: ContentId, kind: string, payload: unknown, remove = false): void {
        const old = this.contents.get(id);
        if (old && old.kind !== kind) throw Error('Cannot change content kind');
        if (remove && this.placementIndex.has(id)) throw Error('Content is still attached');
        const ctx = Object.freeze({
            target: 'content',
            operation: remove ? 'remove' : old ? 'update' : 'add',
            id,
            kind,
            payload,
            previousPayload: old?.payload,
            regions: this.placements(id),
        }) as Mutation<C, M>;
        this.mutate(ctx, c => {
            if (c.target !== 'content') throw Error('Invalid mutation');
            this.undo.push(() => {
                if (old) this.contents.set(id, old);
                else this.contents.delete(id);
            });
            if (remove) this.contents.delete(id);
            else this.contents.set(id, { kind, payload: c.payload });
        });
    }

    /** Create an unattached payload of a declared kind. */
    createContent<K extends Kind<C>>(kind: K, payload: NoInfer<C[K]>): ContentId<K> {
        return this.batch(() => {
            if (typeof kind !== 'string' || !kind) throw TypeError('kind must be nonempty');
            const id = this.idFactory() as ContentId<K>;
            if (typeof id !== 'string' || !id || this.contents.has(id)) {
                throw Error('Invalid or duplicate content ID');
            }
            this.changeContent(id, kind, payload);
            return id;
        });
    }

    /** Replace a payload without changing its identity or placements. */
    setContent<K extends Kind<C>>(id: ContentId<K>, payload: NoInfer<C[K]>): ContentId<K> {
        return this.batch(() => {
            this.changeContent(id, this.record(id).kind, payload);
            return id;
        });
    }

    touchContent<K extends Kind<C>>(id: ContentId<K>): ContentId<K> {
        return this.setContent(id, this.getContent(id));
    }

    removeContent(id: ContentId): boolean {
        return this.batch(() => {
            const rec = this.contents.get(id);
            if (!rec) return false;
            this.changeContent(id, rec.kind, undefined, true);
            return true;
        });
    }

    /** Create content and attach it at a cell address in one transaction. */
    put<K extends Kind<C>>(
        address: Address,
        metadata: Metadata<M, K> & { readonly kind: K },
        payload: NoInfer<C[K]>,
    ): ContentId<K> {
        return this.batch(() => {
            const a = this.geometry.address(address);
            const checked = this.checkMetadata(metadata, metadata.kind);
            const id = this.createContent<K>(metadata.kind, payload);
            this.changeAttachment(a, id, checked, true);
            return id;
        });
    }

    /** Create content covering an exact, potentially multi-cell box. */
    putPoint<K extends Kind<C>>(
        xyz: Vec3,
        metadata: Metadata<M, K> & { readonly kind: K },
        payload: NoInfer<C[K]>,
        options: ExtentOptions = {},
    ): ContentId<K> {
        return this.batch(() => {
            const addresses = this.geometry.decomposeExtent(xyz, options.extent, options);
            const checked = this.checkMetadata(metadata, metadata.kind);
            const id = this.createContent<K>(metadata.kind, payload);
            for (let i = 0; i < addresses.length; i++) {
                this.changeAttachment(addresses[i]!, id, checked, true);
            }
            return id;
        });
    }

    /** Attach existing content to a cell address. */
    attach<K extends Kind<C>>(
        address: Address,
        id: ContentId<K>,
        metadata: NoInfer<Metadata<M, K>>,
    ): ContentId<K> {
        return this.batch(() => {
            this.changeAttachment(this.geometry.address(address), id, metadata);
            return id;
        });
    }

    attachPoint<K extends Kind<C>>(
        xyz: Vec3,
        id: ContentId<K>,
        metadata: NoInfer<Metadata<M, K>>,
        options: ExtentOptions = {},
    ): ContentId<K> {
        return this.batch(() => {
            const addresses = this.geometry.decomposeExtent(xyz, options.extent, options);
            const checked = this.checkMetadata(metadata, this.record(id).kind);
            for (let i = 0; i < addresses.length; i++) {
                this.changeAttachment(addresses[i]!, id, checked, true);
            }
            return id;
        });
    }

    updateAttachment<K extends Kind<C>>(
        address: Address,
        id: ContentId<K>,
        metadata: NoInfer<Metadata<M, K>>,
    ): ContentId<K> {
        return this.batch(() => {
            const a = this.geometry.address(address);
            if (!this.cells.get(addressKey(a))?.attachments.has(id)) {
                throw Error('Unknown attachment');
            }
            return this.attach(a, id, metadata);
        });
    }

    private applyCellMetadata(address: Address, metadata: CellMetadata): void {
        const cell = Object.keys(metadata).length ? this.ensureCell(address) : this.cells.get(addressKey(address));
        if (cell) {
            cell.metadata = metadata;
            this.pruneCell(cell);
        }
    }

    setCellMetadata(address: Address, metadata: CellMetadata): Address {
        return this.batch(() => {
            const a = this.geometry.address(address);
            const old = this.cells.get(addressKey(a))?.metadata ?? EMPTY;
            const m = freezeMetadata(metadata);
            if (equal(old, m)) return a;
            const ctx = Object.freeze({
                target: 'cell',
                operation: Object.keys(m).length ? (Object.keys(old).length ? 'update' : 'add') : 'remove',
                address: a,
                metadata: Object.keys(m).length ? m : undefined,
                previousMetadata: Object.keys(old).length ? old : undefined,
                regions: Object.freeze([a]),
            }) as Mutation<C, M>;
            this.mutate(ctx, c => {
                if (c.target !== 'cell') throw Error('Invalid mutation');
                this.undo.push(() => this.applyCellMetadata(a, old));
                this.applyCellMetadata(a, c.operation === 'remove' ? EMPTY : freezeMetadata(c.metadata!));
            });
            return a;
        });
    }

    /** Detach a single content ID from one cell address. */
    detach(address: Address, id: ContentId): boolean {
        return this.batch(() => {
            const a = this.geometry.address(address);
            if (!this.cells.get(addressKey(a))?.attachments.has(id)) return false;
            return this.changeAttachment(a, id);
        });
    }

    /** Clear all attachments and cell metadata at an exact cell address; descendants remain. */
    clearCell(address: Address): boolean {
        return this.batch(() => {
            const a = this.geometry.address(address);
            const cell = this.cells.get(addressKey(a));
            if (!cell) return false;
            for (const id of [...cell.attachments.keys()]) this.changeAttachment(a, id);
            this.setCellMetadata(a, EMPTY);
            return true;
        });
    }

    clearPoint(xyz: Vec3): boolean {
        return this.clearCell(this.point(xyz));
    }

    /** Return all cell addresses where a content ID is currently attached. */
    placements(id: ContentId): readonly Address[] {
        const set = this.placementIndex.get(id);
        if (!set) return Object.freeze([]);
        const out: Address[] = [];
        for (const k of set) out.push(this.cells.get(k)!.address);
        return Object.freeze(out);
    }

    /** Detach a content ID from every cell it occupies while retaining its payload. */
    detachAll(id: ContentId): number {
        return this.batch(() => {
            const places = this.placements(id);
            for (let i = 0; i < places.length; i++) this.changeAttachment(places[i]!, id);
            return places.length;
        });
    }

    /** Replace all placements of a content ID with a new exact box, reusing unchanged cells. */
    moveContent<K extends Kind<C>>(
        id: ContentId<K>,
        xyz: Vec3,
        options: MoveOptions<M, NoInfer<K>> = {},
    ): ContentId<K> {
        return this.batch(() => {
            const rec = this.record(id);
            const old = this.placements(id);
            const desired = this.geometry.decomposeExtent(xyz, options.extent, options);
            const keys = new Set(desired.map(addressKey));
            const metadata = old.map(a => this.cells.get(addressKey(a))!.attachments.get(id)!.metadata);
            const m = options.metadata !== undefined
                ? this.checkMetadata(options.metadata, rec.kind)
                : metadata[0];
            if (!m) throw Error('Unattached content requires metadata');
            if (options.metadata === undefined && metadata.some(v => !equal(v, m))) {
                throw Error('Heterogeneous metadata requires explicit replacement');
            }
            for (let i = 0; i < old.length; i++) {
                const a = old[i]!;
                if (!keys.has(addressKey(a))) this.changeAttachment(a, id);
            }
            for (let i = 0; i < desired.length; i++) {
                const a = desired[i]!;
                const existing = this.cells.get(addressKey(a))?.attachments.get(id);
                if (!existing || !equal(existing.metadata, m)) {
                    this.changeAttachment(a, id, m, true);
                }
            }
            return id;
        });
    }

    orphans(): readonly ContentId<Kind<C>>[] {
        const out: ContentId<Kind<C>>[] = [];
        for (const id of this.contents.keys()) {
            if (!this.placementIndex.has(id)) out.push(id as ContentId<Kind<C>>);
        }
        return Object.freeze(out);
    }

    collectOrphans(): readonly ContentId<Kind<C>>[] {
        return this.batch(() => {
            const ids = this.orphans();
            for (let i = 0; i < ids.length; i++) this.removeContent(ids[i]!);
            return ids;
        });
    }

    private cacheKey(bounds: Bounds, overlap: boolean): string {
        return `${overlap ? '1' : '0'}:${bounds[0][0]},${bounds[0][1]}/${bounds[1][0]},${bounds[1][1]}/${bounds[2][0]},${bounds[2][1]}`;
    }

    private queryAxes(region: Region, qBounds: Bounds): AxisSpans {
        if (isAddress(region)) return [[region[0]], [region[1]], [region[2]]];
        return this.geometry.boundsAxes(qBounds);
    }

    private cacheGet(key: string): CacheEntry | undefined {
        const cached = this.cache.get(key);
        if (cached) {
            this.cache.delete(key);
            this.cache.set(key, cached);
        }
        return cached;
    }

    private cachePut(key: string, bounds: Bounds, overlap: boolean, keys: readonly string[]): void {
        if (keys.length > 100000) return;
        while (this.cache.size && (this.cache.size >= 128 || this.cacheSize + keys.length > 100000)) {
            const first = this.cache.keys().next().value!;
            this.cacheSize -= this.cache.get(first)!.keys.length;
            this.cache.delete(first);
        }
        this.cache.set(key, { bounds, overlap, keys });
        this.cacheSize += keys.length;
    }

    private selectCells(region: Region, overlap: boolean): readonly string[] {
        const qBounds = this.geometry.boundsOf(region);
        if (!overlap && isExactPoint(qBounds)) {
            const k = addressKey(this.geometry.point([qBounds[0][0], qBounds[1][0], qBounds[2][0]]));
            return this.cells.has(k) ? [k] : [];
        }
        const ck = this.cacheKey(qBounds, overlap);
        const cached = this.cacheGet(ck);
        if (cached) return cached.keys;
        const plan = this.regions.plan(this.queryAxes(region, qBounds), overlap);
        const selected = this.regions.selectPlan(qBounds, overlap, plan);
        this.cachePut(ck, qBounds, overlap, selected);
        return selected;
    }

    getCell(address: Address): CellSnapshot<C, M> | undefined {
        const cell = this.cells.get(addressKey(this.geometry.address(address)));
        if (!cell) return undefined;
        const attachments = [...cell.attachments.values()].map(a =>
            Object.freeze({ id: a.id, kind: a.kind, metadata: a.metadata }),
        );
        return Object.freeze({
            address: cell.address,
            metadata: cell.metadata,
            attachments: Object.freeze(attachments),
        }) as unknown as CellSnapshot<C, M>;
    }

    *searchCells(
        region: Region = ALL,
        options: {
            readonly overlap?: boolean;
            readonly filter?: (metadata: CellMetadata) => boolean;
        } = {},
    ): IterableIterator<CellSnapshot<C, M>> {
        for (const k of this.selectCells(region, options.overlap ?? false)) {
            const cell = this.cells.get(k);
            if (cell && (!options.filter || options.filter(cell.metadata))) {
                yield this.getCell(cell.address)!;
            }
        }
    }

    private criteria<K extends Kind<C>>(options: QueryOptions<M, K>): Criteria {
        const where = Object.entries(options.where ?? {});
        const groups: ReadonlySet<StoredAttachment>[] = [];
        if (options.kind !== undefined) {
            const sk = scalarKey(options.kind);
            groups.push((sk !== undefined ? this.fieldIndex.get('kind')?.get(sk) : undefined) ?? EMPTY_SET);
        }
        for (let i = 0; i < where.length; i++) {
            const [field, v] = where[i]!;
            const sk = scalarKey(v);
            if (this.indexedFields.has(field) && sk !== undefined) {
                groups.push(this.fieldIndex.get(field)?.get(sk) ?? EMPTY_SET);
            }
        }
        if (this.indexedTags && options.tags) {
            for (let i = 0; i < options.tags.length; i++) {
                groups.push(this.tagIndex.get(options.tags[i]!) ?? EMPTY_SET);
            }
        }
        if (groups.length > 1) groups.sort((a, b) => a.size - b.size);
        const tags = options.tags;
        const filter = options.filter;
        const kind = options.kind;
        return {
            groups,
            test: a =>
                (kind === undefined || a.kind === kind) &&
                where.every(([k, v]) => Object.hasOwn(a.metadata, k) && equal(a.metadata[k], v)) &&
                (!tags || tags.every(t => Array.isArray(a.metadata.tags) && a.metadata.tags.includes(t))) &&
                (!filter || filter(a.metadata as Metadata<M, K>)),
        };
    }

    private inAllGroups(a: StoredAttachment, groups: readonly ReadonlySet<StoredAttachment>[]): boolean {
        for (let g = 1; g < groups.length; g++) {
            if (!groups[g]!.has(a)) return false;
        }
        return true;
    }

    private result<K extends Kind<C>>(cell: StoredCell, a: StoredAttachment): SearchResult<C, M, K> {
        return Object.freeze({
            address: cell.address,
            id: a.id,
            kind: a.kind,
            metadata: a.metadata,
            content: this.record(a.id).payload,
        }) as unknown as SearchResult<C, M, K>;
    }

    /** Yield matching attachments across any Region. Overlap includes intersecting cells. */
    private *searchImpl<K extends Kind<C>>(
        region: Region,
        options: SearchOptions<M, K>,
    ): IterableIterator<SearchResult<C, M, K>> {
        const qBounds = this.geometry.boundsOf(region);
        const overlap = options.overlap ?? false;
        const criteria = this.criteria(options);
        const smallest = criteria.groups[0];
        if (smallest?.size === 0) return;

        // O(1) exact point fast path: no region scan, no semantic scan, no cache entry.
        if (!overlap && isExactPoint(qBounds)) {
            const cell = this.cells.get(addressKey(this.geometry.point([qBounds[0][0], qBounds[1][0], qBounds[2][0]])));
            if (!cell) return;
            for (const a of cell.attachments.values()) {
                if (criteria.test(a)) yield this.result<K>(cell, a);
            }
            return;
        }

        const ck = this.cacheKey(qBounds, overlap);
        const cached = this.cacheGet(ck);
        if (cached) {
            if (smallest && smallest.size < cached.keys.length) {
                for (const a of smallest) {
                    if (!this.inAllGroups(a, criteria.groups)) continue;
                    if (boundsMatch(a.cell.bounds, qBounds, overlap) && criteria.test(a)) {
                        yield this.result<K>(a.cell, a);
                    }
                }
                return;
            }
            for (let i = 0; i < cached.keys.length; i++) {
                const cell = this.cells.get(cached.keys[i]!);
                if (!cell) continue;
                for (const a of cell.attachments.values()) {
                    if (criteria.test(a)) yield this.result<K>(cell, a);
                }
            }
            return;
        }

        const plan = this.regions.plan(this.queryAxes(region, qBounds), overlap);
        if (plan.count === 0) {
            this.cachePut(ck, qBounds, overlap, []);
            return;
        }
        if (smallest && smallest.size < plan.count) {
            for (const a of smallest) {
                if (!this.inAllGroups(a, criteria.groups)) continue;
                if (boundsMatch(a.cell.bounds, qBounds, overlap) && criteria.test(a)) {
                    yield this.result<K>(a.cell, a);
                }
            }
            return;
        }

        const selected = this.regions.selectPlan(qBounds, overlap, plan);
        this.cachePut(ck, qBounds, overlap, selected);
        for (let i = 0; i < selected.length; i++) {
            const cell = this.cells.get(selected[i]!);
            if (!cell) continue;
            for (const a of cell.attachments.values()) {
                if (criteria.test(a)) yield this.result<K>(cell, a);
            }
        }
    }

    search<K extends Kind<C>>(
        region: Region | undefined,
        options: SearchOptions<M, K> & { readonly kind: K },
    ): IterableIterator<SearchResult<C, M, K>>;
    search(region?: Region, options?: SearchOptions<M, Kind<C>>): IterableIterator<SearchResult<C, M>>;
    search<K extends Kind<C>>(
        region: Region = ALL,
        options: SearchOptions<M, K> = {},
    ): IterableIterator<SearchResult<C, M, K>> {
        return this.searchImpl(region, options);
    }

    searchContent<K extends Kind<C>>(
        region: Region | undefined,
        options: SearchOptions<M, K> & { readonly kind: K },
    ): IterableIterator<SearchResult<C, M, K>>;
    searchContent(region?: Region, options?: SearchOptions<M, Kind<C>>): IterableIterator<SearchResult<C, M>>;
    *searchContent<K extends Kind<C>>(
        region: Region = ALL,
        options: SearchOptions<M, K> = {},
    ): IterableIterator<SearchResult<C, M, K>> {
        const seen = new Set<ContentId>();
        for (const r of this.searchImpl(region, options)) {
            if (!seen.has(r.id)) {
                seen.add(r.id);
                yield r;
            }
        }
    }

    private *distance<K extends Kind<C>>(
        xyz: Vec3,
        cutoff: number,
        limit: number,
        options: QueryOptions<M, K>,
        unique: boolean,
    ): IterableIterator<DistanceResult<C, M, K>> {
        this.geometry.vector(xyz);
        if (!limit) return;
        const criteria = this.criteria(options);
        const smallest = criteria.groups[0];
        if (smallest?.size === 0) return;

        // Sparse semantic short-circuit: score matching attachments directly instead of traversing the proximity index.
        if (smallest && (smallest.size <= 64 || smallest.size * smallest.size <= this.cells.size * 16)) {
            const scored: { a: StoredAttachment; d2: number }[] = [];
            for (const a of smallest) {
                if (!this.inAllGroups(a, criteria.groups) || !criteria.test(a)) continue;
                const d2 = distanceSquared(xyz, a.cell.bounds);
                if (d2 <= cutoff) scored.push({ a, d2 });
            }
            scored.sort((x, y) => x.d2 - y.d2);
            const seen = unique ? new Set<ContentId>() : undefined;
            let count = 0;
            for (let i = 0; i < scored.length; i++) {
                const { a, d2 } = scored[i]!;
                if (seen) {
                    if (seen.has(a.id)) continue;
                    seen.add(a.id);
                }
                yield Object.freeze({ ...this.result<K>(a.cell, a), distance: Math.sqrt(d2) }) as DistanceResult<C, M, K>;
                if (++count >= limit) return;
            }
            return;
        }

        const seen = unique ? new Set<ContentId>() : undefined;
        let count = 0;
        for (const { key, distance } of this.proximity.distance(xyz, this.geometry, cutoff)) {
            const cell = this.cells.get(key);
            if (!cell) continue;
            for (const a of cell.attachments.values()) {
                if ((seen && seen.has(a.id)) || !criteria.test(a)) continue;
                if (seen) seen.add(a.id);
                yield Object.freeze({ ...this.result<K>(cell, a), distance }) as DistanceResult<C, M, K>;
                if (++count >= limit) return;
            }
        }
    }

    private limit(value: number): number {
        if (!Number.isSafeInteger(value) || value < 0) throw RangeError('limit must be a nonnegative integer');
        return value;
    }

    private cutoff(radius: number): number {
        if (!Number.isFinite(radius) || radius < 0) throw RangeError('radius must be finite and nonnegative');
        return radius * radius;
    }

    nearest<K extends Kind<C>>(
        xyz: Vec3,
        options: NearestOptions<M, K> & { readonly kind: K },
    ): IterableIterator<DistanceResult<C, M, K>>;
    nearest(xyz: Vec3, options?: NearestOptions<M, Kind<C>>): IterableIterator<DistanceResult<C, M>>;
    nearest<K extends Kind<C>>(
        xyz: Vec3,
        options: NearestOptions<M, K> = {},
    ): IterableIterator<DistanceResult<C, M, K>> {
        return this.distance(xyz, Infinity, this.limit(options.limit ?? 1), options, false);
    }

    nearestContent<K extends Kind<C>>(
        xyz: Vec3,
        options: NearestOptions<M, K> & { readonly kind: K },
    ): IterableIterator<DistanceResult<C, M, K>>;
    nearestContent(xyz: Vec3, options?: NearestOptions<M, Kind<C>>): IterableIterator<DistanceResult<C, M>>;
    nearestContent<K extends Kind<C>>(
        xyz: Vec3,
        options: NearestOptions<M, K> = {},
    ): IterableIterator<DistanceResult<C, M, K>> {
        return this.distance(xyz, Infinity, this.limit(options.limit ?? 1), options, true);
    }

    radius<K extends Kind<C>>(
        xyz: Vec3,
        radius: number,
        options: QueryOptions<M, K> & { readonly kind: K },
    ): IterableIterator<DistanceResult<C, M, K>>;
    radius(xyz: Vec3, radius: number, options?: QueryOptions<M, Kind<C>>): IterableIterator<DistanceResult<C, M>>;
    radius<K extends Kind<C>>(
        xyz: Vec3,
        radius: number,
        options: QueryOptions<M, K> = {},
    ): IterableIterator<DistanceResult<C, M, K>> {
        return this.distance(xyz, this.cutoff(radius), Infinity, options, false);
    }

    radiusContent<K extends Kind<C>>(
        xyz: Vec3,
        radius: number,
        options: QueryOptions<M, K> & { readonly kind: K },
    ): IterableIterator<DistanceResult<C, M, K>>;
    radiusContent(xyz: Vec3, radius: number, options?: QueryOptions<M, Kind<C>>): IterableIterator<DistanceResult<C, M>>;
    radiusContent<K extends Kind<C>>(
        xyz: Vec3,
        radius: number,
        options: QueryOptions<M, K> = {},
    ): IterableIterator<DistanceResult<C, M, K>> {
        return this.distance(xyz, this.cutoff(radius), Infinity, options, true);
    }

    /** Install a typed event listener. Scoped subscriptions accept any Region on spatial events. */
    on<N extends Extract<keyof EventMap<C, M, E>, string>>(
        name: N,
        handler: (event: EventMap<C, M, E>[N]) => void,
        ...args: N extends CustomName<E> | 'spatial:change'
            ? [options?: { readonly region?: Region }]
            : []
    ): Dispose {
        const region = (args as [{ readonly region?: Region }?])[0]?.region;
        if (region !== undefined && RESERVED.has(name) && name !== 'spatial:change') {
            throw Error('Lifecycle event cannot be scoped');
        }
        if (typeof handler !== 'function' || !name) throw TypeError('Invalid listener');
        return this.track(
            this.bus.on(
                name,
                handler as (value: unknown) => void,
                region !== undefined ? this.geometry.boundsOf(region) : undefined,
            ),
        );
    }

    middleware(handler: Middleware<C, M>): Dispose {
        if (typeof handler !== 'function') throw TypeError('Invalid middleware');
        const key = Symbol();
        this.middlewareHandlers.set(key, handler);
        return this.track(() => { this.middlewareHandlers.delete(key); });
    }

    emit<N extends CustomName<E>>(name: N, data: NoInfer<E[N]>): void {
        if (RESERVED.has(name) || !name) throw Error('Invalid custom event');
        const event: SpatialEvent<E[N], N> = Object.freeze({ name, data, regions: Object.freeze([]) });
        this.publish({ name, value: event });
    }

    emitAt<N extends CustomName<E>>(
        name: N,
        region: Region,
        data: NoInfer<E[N]>,
        options?: BoxOptions,
    ): void {
        if (RESERVED.has(name) || !name) throw Error('Invalid custom event');
        const regions = this.geometry.decompose(region, options);
        const regionBounds = regions.map(r => this.geometry.bounds(r));
        const event: SpatialEvent<E[N], N> = Object.freeze({ name, data, regions });
        this.publish({ name, value: event, spatial: { event, regionBounds } });
    }

    /** Install a plugin once. Disposal unregisters synchronous installation registrations. */
    use(installer: (world: this) => void | Dispose): Dispose {
        const scope: Dispose[] = [];
        let cleanup: void | Dispose;
        let disposed = false;
        const dispose = () => {
            if (disposed) return;
            disposed = true;
            const errors: unknown[] = [];
            for (const off of scope.reverse()) {
                try { off(); } catch (e) { errors.push(e); }
            }
            scope.length = 0;
            if (typeof cleanup === 'function') {
                try { cleanup(); } catch (e) { errors.push(e); }
            }
            if (errors.length) throw new AggregateError(errors, 'Plugin cleanup failed');
        };
        this.installScopes.push(scope);
        try {
            cleanup = installer(this);
            if (cleanup !== undefined && typeof cleanup !== 'function') {
                throw TypeError('Installer must return a cleanup function or void');
            }
        } catch (e) {
            this.installScopes.pop();
            dispose();
            throw e;
        }
        this.installScopes.pop();
        return this.track(dispose);
    }

    update(dt: number): void {
        if (this.updating || this.depth || this.bus.dispatching) {
            throw Error('update requires an idle runtime');
        }
        if (!Number.isFinite(dt) || dt < 0) throw RangeError('dt must be finite and nonnegative');
        this.updating = true;
        try {
            for (const name of ['update:before', 'update', 'update:after']) {
                this.bus.enqueue([{ name, value: dt }]);
            }
        } finally {
            this.updating = false;
        }
    }

    stats(): Stats {
        let semanticBuckets = this.tagIndex.size;
        for (const byVal of this.fieldIndex.values()) semanticBuckets += byVal.size;
        return Object.freeze({
            cells: this.cells.size,
            attachments: [...this.cells.values()].reduce((n, v) => n + v.attachments.size, 0),
            contents: this.contents.size,
            orphans: this.orphans().length,
            partitions: this.proximity.count,
            ...this.bus.stats(),
            cachedQueries: this.cache.size,
            semanticBuckets,
        });
    }

    /** Throws if an internal index or reverse placement map is inconsistent. */
    validate(): void {
        this.regions.validate();
        this.bus.validate();
        this.proximity.validate(new Set(this.cells.keys()));
        if (this.cells.size !== this.regions.records.size) throw Error('Invalid cell count');

        const places = new Map<ContentId, Set<string>>();
        const fields = new Map<string, Map<string, Set<StoredAttachment>>>();
        const tags = new Map<string, Set<StoredAttachment>>();
        const addPlace = (k: ContentId, v: string) => {
            let s = places.get(k);
            if (!s) places.set(k, s = new Set());
            s.add(v);
        };

        for (const [k, cell] of this.cells) {
            if (
                cell.key !== k ||
                addressKey(cell.address) !== k ||
                !this.regions.records.has(k) ||
                (!cell.attachments.size && !Object.keys(cell.metadata).length)
            ) {
                throw Error('Invalid cell');
            }
            for (const [id, a] of cell.attachments) {
                if (a.cell !== cell || a.id !== id || this.record(id).kind !== a.kind || a.metadata.kind !== a.kind) {
                    throw Error('Invalid attachment');
                }
                addPlace(id, k);
                for (const field of this.indexedFields) {
                    if (!Object.hasOwn(a.metadata, field)) continue;
                    const sk = scalarKey(a.metadata[field]);
                    if (sk === undefined) continue;
                    let byVal = fields.get(field);
                    if (!byVal) fields.set(field, byVal = new Map());
                    let bucket = byVal.get(sk);
                    if (!bucket) byVal.set(sk, bucket = new Set());
                    bucket.add(a);
                }
                if (this.indexedTags && Array.isArray(a.metadata.tags)) {
                    for (const tag of a.metadata.tags as readonly string[]) {
                        let bucket = tags.get(tag);
                        if (!bucket) tags.set(tag, bucket = new Set());
                        bucket.add(a);
                    }
                }
            }
        }

        const sameSetMap = <K, V>(a: Map<K, Set<V>>, b: Map<K, Set<V>>) =>
            a.size === b.size &&
            [...a].every(([k, s]) => b.get(k)?.size === s.size && [...s].every(v => b.get(k)!.has(v)));

        if (!sameSetMap(places, this.placementIndex) || !sameSetMap(tags, this.tagIndex)) {
            throw Error('Invalid placement or tag index');
        }
        if (
            fields.size !== this.fieldIndex.size ||
            [...fields].some(([f, m]) => !this.fieldIndex.has(f) || !sameSetMap(m, this.fieldIndex.get(f)!))
        ) {
            throw Error('Invalid field index');
        }

        let total = 0;
        for (const [, entry] of this.cache) {
            const expected = new Set(this.regions.selectBounds(entry.bounds, entry.overlap, this.geometry));
            if (expected.size !== entry.keys.length || entry.keys.some(key => !expected.has(key))) {
                throw Error('Invalid query cache');
            }
            total += entry.keys.length;
        }
        if (total !== this.cacheSize) throw Error('Invalid cache accounting');
    }
}
