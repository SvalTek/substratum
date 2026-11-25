/** Independent binary prefixes, ordered X, Y, Z. Empty prefixes are unrestricted. */
export type Address = readonly [string, string, string];
export type Vec3 = readonly [number, number, number];
export type Extent = number | Vec3;
export type Interval = readonly [number, number];
export type Bounds = readonly [Interval, Interval, Interval];
export interface BoxRegion {
    readonly at: Vec3;
    readonly extent?: Extent;
}
/** A spatial region: an exact cell address, inclusive integer bounds, or a point with extent. */
export type Region = Address | Bounds | BoxRegion;
export interface BoxOptions {
    readonly maxBoxes?: number;
}
export interface ExtentOptions extends BoxOptions {
    readonly extent?: Extent;
}
export type Dispose = () => void;
export type Kind<C extends object> = Extract<keyof C, string>;
export type DeepReadonly<T> = T extends object
    ? { readonly [P in keyof T]: DeepReadonly<T[P]> }
    : T;
/** Unique content ID branded with its declared kind. Obtain IDs from the runtime, not casts. */
declare const contentKind: unique symbol;
export type ContentId<K extends string = string> = string & {
    readonly [contentKind]: K;
};
export interface BaseMetadata {
    readonly tags?: readonly string[];
}
export type Metadata<M extends object, K extends string> = DeepReadonly<Omit<M, 'kind' | 'tags'>> & BaseMetadata & {
    readonly kind: K;
};
export type CellMetadata = Readonly<Record<string, unknown>>;
export type Attachment<C extends object, M extends object, K extends Kind<C> = Kind<C>> = {
    [P in K]: {
        readonly id: ContentId<P>;
        readonly kind: P;
        readonly metadata: Metadata<M, P>;
    };
}[K];
export type SearchResult<C extends object, M extends object, K extends Kind<C> = Kind<C>> = {
    [P in K]: {
        readonly address: Address;
        readonly id: ContentId<P>;
        readonly kind: P;
        readonly metadata: Metadata<M, P>;
        readonly content: C[P];
    };
}[K];
export type DistanceResult<C extends object, M extends object, K extends Kind<C> = Kind<C>> = SearchResult<C, M, K> & {
    readonly distance: number;
};
export interface QueryOptions<M extends object, K extends string> {
    readonly kind?: K;
    readonly where?: Partial<Metadata<M, K>>;
    readonly tags?: readonly string[];
    readonly filter?: (metadata: Metadata<M, K>) => boolean;
}
export interface SearchOptions<M extends object, K extends string> extends QueryOptions<M, K> {
    readonly overlap?: boolean;
}
export interface NearestOptions<M extends object, K extends string> extends QueryOptions<M, K> {
    readonly limit?: number;
}
export interface CellSnapshot<C extends object, M extends object> {
    readonly address: Address;
    readonly metadata: CellMetadata;
    readonly attachments: readonly Attachment<C, M>[];
}
export interface SpatialEvent<D = unknown, N extends string = string> {
    readonly name: N;
    readonly regions: readonly Address[];
    readonly data: D;
}
export type Operation = 'add' | 'update' | 'remove';
type MutationBase = {
    readonly regions: readonly Address[];
};
type ValueChange<T, V extends string, P extends string> =
    | ({ readonly operation: 'add' } & { readonly [K in V]: T } & { readonly [K in P]: undefined })
    | ({ readonly operation: 'update' } & { readonly [K in V | P]: T })
    | ({ readonly operation: 'remove' } & { readonly [K in V]: undefined } & { readonly [K in P]: T });
export type AttachmentMutation<C extends object, M extends object> = {
    [K in Kind<C>]: MutationBase & {
        readonly target: 'attachment';
        readonly kind: K;
        readonly address: Address;
        readonly id: ContentId<K>;
    } & ValueChange<Metadata<M, K>, 'metadata', 'previousMetadata'>;
}[Kind<C>];
export type ContentMutation<C extends object> = {
    [K in Kind<C>]: MutationBase & {
        readonly target: 'content';
        readonly kind: K;
        readonly id: ContentId<K>;
    } & ValueChange<C[K], 'payload', 'previousPayload'>;
}[Kind<C>];
export type CellMutation = MutationBase & {
    readonly target: 'cell';
    readonly address: Address;
} & ValueChange<CellMetadata, 'metadata', 'previousMetadata'>;
export type Mutation<C extends object, M extends object> =
    | AttachmentMutation<C, M>
    | ContentMutation<C>
    | CellMutation;
export type ContentTransition<C extends object> = {
    [K in Kind<C>]: {
        readonly id: ContentId<K>;
        readonly kind: K;
        readonly added: readonly Address[];
        readonly updated: readonly Address[];
        readonly removed: readonly Address[];
        readonly contentChanged: boolean;
        readonly contentOperation?: Operation;
    };
}[Kind<C>];
export interface ChangeEvent<C extends object, M extends object>
    extends SpatialEvent<readonly Mutation<C, M>[], 'spatial:change'> {
    readonly name: 'spatial:change';
    readonly changes: readonly Mutation<C, M>[];
    /** Lazy per-content summary grouped across attachment and content mutations in scope. */
    readonly transitions: readonly ContentTransition<C>[];
}
export type LifecycleEvents<C extends object, M extends object> = {
    'spatial:change': ChangeEvent<C, M>;
    'mutation:before': Mutation<C, M>;
    'mutation:veto': Mutation<C, M>;
    'mutation:add': Mutation<C, M>;
    'mutation:update': Mutation<C, M>;
    'mutation:remove': Mutation<C, M>;
    'mutation:after': Mutation<C, M>;
    'update:before': number;
    update: number;
    'update:after': number;
};
export type CustomName<E extends object> = Exclude<Extract<keyof E, string>, keyof LifecycleEvents<object, object>>;
export type EventMap<C extends object, M extends object, E extends object> = LifecycleEvents<C, M> & {
    [K in CustomName<E>]: SpatialEvent<E[K], K>;
};
/** Only proposed values may be replaced. Kind, identity and routing cannot change. */
export type MutationPatch<C extends object, M extends object> =
    | {
        readonly target: 'cell';
        readonly metadata: CellMetadata;
    }
    | {
        [K in Kind<C>]:
            | {
                readonly target: 'attachment';
                readonly kind: K;
                readonly metadata: Metadata<M, K>;
            }
            | {
                readonly target: 'content';
                readonly kind: K;
                readonly payload: C[K];
            };
    }[Kind<C>];
export type Middleware<C extends object, M extends object> = (
    mutation: Mutation<C, M>,
    next: (patch?: MutationPatch<C, M>) => void,
) => void;
export interface SubstratumOptions<M extends object> {
    readonly bits?: number;
    readonly indexedFields?: readonly (Extract<keyof M, string> | 'kind')[];
    readonly indexedTags?: boolean;
    readonly maxEvents?: number;
    readonly idFactory?: () => string;
}
export interface MoveOptions<M extends object, K extends string> extends ExtentOptions {
    readonly metadata?: Metadata<M, K>;
}
export interface Stats {
    readonly cells: number;
    readonly attachments: number;
    readonly contents: number;
    readonly orphans: number;
    readonly partitions: number;
    readonly subscriptions: number;
    readonly scopedSubscriptions: number;
    readonly cachedQueries: number;
    readonly semanticBuckets: number;
}
/** A reusable synchronous plugin installer. */
export type Plugin<C extends object, M extends object, E extends object> = (
    world: import('./substratum.ts').Substratum<C, M, E>,
) => void | Dispose;
