/** Metadata is plain, acyclic data. Copy before freezing; never freeze caller objects. */
export function freezeMetadata<T extends object>(value: T): T { if (!value || typeof value !== 'object' || Array.isArray(value))
    throw TypeError('metadata must be a plain object'); return copy(value, new Set()) as T; }
function copy(value: unknown, seen: Set<object>): unknown { if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'undefined' || typeof value === 'number')
    return value; if (typeof value !== 'object')
    throw TypeError('metadata must contain plain data'); if (seen.has(value))
    throw TypeError('cyclic metadata'); seen.add(value); let result: unknown; if (Array.isArray(value))
    result = Object.freeze(value.map(v => copy(v, seen)));
else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype)
        throw TypeError('metadata must contain plain objects');
    const entries = Object.entries(value).map(([k, v]) => [k, copy(v, seen)] as const);
    result = Object.freeze(Object.fromEntries(entries));
} seen.delete(value); return result; }
export function equal(a: unknown, b: unknown): boolean { if (Object.is(a, b))
    return true; if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b))
    return false; if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length)
    return false; const aa = Object.entries(a), bb = Object.entries(b); return aa.length === bb.length && aa.every(([k, v]) => Object.hasOwn(b, k) && equal(v, (b as Record<string, unknown>)[k])); }
export function scalarKey(v: unknown): string | undefined { if (v === null)
    return 'null'; switch (typeof v) {
    case 'string': return 's:' + v;
    case 'number': return 'n:' + (Object.is(v, -0) ? '-0' : String(v));
    case 'boolean': return 'b:' + v;
    case 'undefined': return 'u:';
    default: return undefined;
} }
