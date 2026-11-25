import type { Address, Bounds, BoxOptions, Extent, Interval, Region, Vec3 } from './types.ts';

export const ALL: Address = Object.freeze(['', '', '']);
export const addressKey = (a: Address): string => `${a[0]}/${a[1]}/${a[2]}`;

export function matches(a: Address, q: Address, overlap: boolean): boolean {
    for (let i = 0; i < 3; i++) {
        const ap = a[i]!, qp = q[i]!;
        if (!ap.startsWith(qp) && !(overlap && qp.startsWith(ap))) return false;
    }
    return true;
}

export function boundsMatch(a: Bounds, q: Bounds, overlap: boolean): boolean {
    const a0 = a[0], q0 = q[0];
    if (overlap ? a0[0] > q0[1] || a0[1] < q0[0] : a0[0] < q0[0] || a0[1] > q0[1]) return false;
    const a1 = a[1], q1 = q[1];
    if (overlap ? a1[0] > q1[1] || a1[1] < q1[0] : a1[0] < q1[0] || a1[1] > q1[1]) return false;
    const a2 = a[2], q2 = q[2];
    return overlap ? a2[0] <= q2[1] && a2[1] >= q2[0] : a2[0] >= q2[0] && a2[1] <= q2[1];
}

export function isExactPoint(b: Bounds): boolean {
    return b[0][0] === b[0][1] && b[1][0] === b[1][1] && b[2][0] === b[2][1];
}

export function isAddress(r: Region): r is Address {
    return Array.isArray(r) && r.length === 3 && typeof r[0] === 'string';
}

export function isBounds(r: Region): r is Bounds {
    return Array.isArray(r) && r.length === 3 && Array.isArray(r[0]);
}

function checkMaxBoxes(maxBoxes: number | undefined): void {
    if (maxBoxes !== undefined && (!Number.isSafeInteger(maxBoxes) || maxBoxes < 1)) {
        throw new RangeError('maxBoxes must be a positive integer');
    }
}

/** Signed integer lattice geometry. Distances use inclusive integer bounds. */
export class Geometry {
    readonly bits: number;
    readonly offset: number;

    constructor(bits = 16) {
        if (!Number.isInteger(bits) || bits < 1 || bits > 32) {
            throw new RangeError('bits must be 1–32');
        }
        this.bits = bits;
        this.offset = 2 ** (bits - 1);
    }

    address(a: Address): Address {
        if (
            !Array.isArray(a) ||
            a.length !== 3 ||
            typeof a[0] !== 'string' || typeof a[1] !== 'string' || typeof a[2] !== 'string' ||
            a[0].length > this.bits || a[1].length > this.bits || a[2].length > this.bits ||
            /[^01]/.test(a[0]) || /[^01]/.test(a[1]) || /[^01]/.test(a[2])
        ) {
            throw new RangeError('expected three binary prefixes');
        }
        return Object.freeze([a[0], a[1], a[2]] as const);
    }

    encode(n: number): string {
        if (!Number.isInteger(n) || n < -this.offset || n >= this.offset) {
            throw new RangeError('coordinate out of range');
        }
        return (n + this.offset).toString(2).padStart(this.bits, '0');
    }

    point(xyz: Vec3): Address {
        this.vector(xyz);
        return Object.freeze([this.encode(xyz[0]), this.encode(xyz[1]), this.encode(xyz[2])] as const);
    }

    vector(xyz: Vec3): void {
        if (!Array.isArray(xyz) || xyz.length !== 3 || !Number.isFinite(xyz[0]) || !Number.isFinite(xyz[1]) || !Number.isFinite(xyz[2])) {
            throw new RangeError('expected three finite coordinates');
        }
    }

    decode(p: string): Interval {
        if (typeof p !== 'string' || p.length > this.bits || /[^01]/.test(p)) {
            throw new RangeError('invalid prefix');
        }
        const width = 2 ** (this.bits - p.length);
        const lo = (p ? parseInt(p, 2) : 0) * width - this.offset;
        return Object.freeze([lo, lo + width - 1] as const);
    }

    bounds(a: Address): Bounds {
        const p = this.address(a);
        return Object.freeze([this.decode(p[0]), this.decode(p[1]), this.decode(p[2])] as const);
    }

    validateBounds(b: Bounds): Bounds {
        if (!Array.isArray(b) || b.length !== 3) {
            throw new RangeError('expected three coordinate intervals');
        }
        const out: Interval[] = [];
        for (let i = 0; i < 3; i++) {
            const iv = b[i];
            if (
                !Array.isArray(iv) ||
                iv.length !== 2 ||
                !Number.isInteger(iv[0]) ||
                !Number.isInteger(iv[1]) ||
                iv[0] > iv[1] ||
                iv[0] < -this.offset ||
                iv[1] >= this.offset
            ) {
                throw new RangeError('bounds out of range');
            }
            out.push(Object.freeze([iv[0], iv[1]] as const));
        }
        return Object.freeze([out[0]!, out[1]!, out[2]!] as const);
    }

    extentBounds(xyz: Vec3, extent: Extent = 1): Bounds {
        this.vector(xyz);
        const dims: Vec3 = typeof extent === 'number' ? [extent, extent, extent] : extent;
        if (
            !Array.isArray(dims) ||
            dims.length !== 3 ||
            !Number.isSafeInteger(dims[0]) || dims[0] <= 0 ||
            !Number.isSafeInteger(dims[1]) || dims[1] <= 0 ||
            !Number.isSafeInteger(dims[2]) || dims[2] <= 0 ||
            !Number.isInteger(xyz[0]) || !Number.isInteger(xyz[1]) || !Number.isInteger(xyz[2])
        ) {
            throw new RangeError('integer anchors and positive integer dimensions required');
        }
        const out: Interval[] = [];
        for (let i = 0; i < 3; i++) {
            const lo = xyz[i]! - Math.floor(dims[i]! / 2);
            const hi = lo + dims[i]! - 1;
            if (lo < -this.offset || hi >= this.offset) {
                throw new RangeError('extent exceeds bounds');
            }
            out.push(Object.freeze([lo, hi] as const));
        }
        return Object.freeze([out[0]!, out[1]!, out[2]!] as const);
    }

    boundsOf(region: Region): Bounds {
        if (Array.isArray(region)) {
            if (region.length !== 3) throw new RangeError('invalid region');
            if (typeof region[0] === 'string') return this.bounds(region as Address);
            if (Array.isArray(region[0])) return this.validateBounds(region as Bounds);
            throw new RangeError('invalid region');
        }
        if (region && typeof region === 'object' && 'at' in region) {
            const box = region as { readonly at: Vec3; readonly extent?: Extent };
            return this.extentBounds(box.at, box.extent);
        }
        throw new TypeError('invalid region');
    }

    /** Canonical 1D disjoint dyadic decomposition of inclusive integer interval [lo, hi]. */
    decomposeAxis(lo: number, hi: number): readonly string[] {
        if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi || lo < -this.offset || hi >= this.offset) {
            throw new RangeError('bounds out of range');
        }
        let cur = lo + this.offset;
        const end = hi + this.offset + 1;
        const result: string[] = [];
        while (cur < end) {
            let width = 1;
            while (cur % (width * 2) === 0 && width * 2 <= end - cur) {
                width *= 2;
            }
            const length = this.bits - Math.log2(width);
            result.push(length ? (cur / width).toString(2).padStart(length, '0') : '');
            cur += width;
        }
        return Object.freeze(result);
    }

    boundsAxes(bounds: Bounds): readonly [readonly string[], readonly string[], readonly string[]] {
        const b = this.validateBounds(bounds);
        return [
            this.decomposeAxis(b[0][0], b[0][1]),
            this.decomposeAxis(b[1][0], b[1][1]),
            this.decomposeAxis(b[2][0], b[2][1]),
        ];
    }

    decomposeBounds(bounds: Bounds, options: BoxOptions = {}): readonly Address[] {
        checkMaxBoxes(options.maxBoxes);
        const axes = this.boundsAxes(bounds);
        const total = axes[0].length * axes[1].length * axes[2].length;
        if (options.maxBoxes !== undefined && total > options.maxBoxes) {
            throw new RangeError(`Region decomposition produces ${total} cells, exceeding maxBoxes (${options.maxBoxes})`);
        }
        const result: Address[] = [];
        for (const x of axes[0]) {
            for (const y of axes[1]) {
                for (const z of axes[2]) {
                    result.push(Object.freeze([x, y, z] as const));
                }
            }
        }
        return Object.freeze(result);
    }

    decomposeExtent(xyz: Vec3, extent: Extent = 1, options: BoxOptions = {}): readonly Address[] {
        return this.decomposeBounds(this.extentBounds(xyz, extent), options);
    }

    /** Decompose any Region into an exact, disjoint cover of aligned cell addresses. */
    decompose(region: Region, options: BoxOptions = {}): readonly Address[] {
        checkMaxBoxes(options.maxBoxes);
        if (isAddress(region)) {
            return Object.freeze([this.address(region)]);
        }
        return this.decomposeBounds(this.boundsOf(region), options);
    }

    /** Tightest single aligned cell address enclosing the entire region. */
    cover(region: Region): Address {
        if (isAddress(region)) {
            return this.address(region);
        }
        const b = this.boundsOf(region);
        const parts: string[] = [];
        for (let i = 0; i < 3; i++) {
            const lo = this.encode(b[i]![0]);
            const hi = this.encode(b[i]![1]);
            let k = 0;
            while (k < this.bits && lo.charCodeAt(k) === hi.charCodeAt(k)) k++;
            parts.push(lo.slice(0, k));
        }
        return Object.freeze([parts[0]!, parts[1]!, parts[2]!] as const);
    }
}

export function distanceSquared6(
    x: number, y: number, z: number,
    x0: number, x1: number,
    y0: number, y1: number,
    z0: number, z1: number,
): number {
    const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
    const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
    const dz = z < z0 ? z0 - z : z > z1 ? z - z1 : 0;
    return dx * dx + dy * dy + dz * dz;
}

export function distanceSquared(xyz: Vec3, bounds: Bounds): number {
    return distanceSquared6(
        xyz[0], xyz[1], xyz[2],
        bounds[0][0], bounds[0][1],
        bounds[1][0], bounds[1][1],
        bounds[2][0], bounds[2][1],
    );
}
