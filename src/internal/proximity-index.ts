import { addressKey, distanceSquared6, type Geometry } from '../geometry.ts';
import type { Address, Vec3 } from '../types.ts';
import { MinHeap } from './heap.ts';

interface Partition {
    children: Map<number, Partition>;
    key?: string;
}

interface TraversalEntry {
    partition: Partition;
    x0: number;
    x1: number;
    y0: number;
    y1: number;
    z0: number;
    z1: number;
}

const partition = (): Partition => ({ children: new Map() });

function stepCode(p0: string, p1: string, p2: string, i: number): number {
    const d0 = i < p0.length ? (p0.charCodeAt(i) === 48 ? 0 : 1) : 2;
    const d1 = i < p1.length ? (p1.charCodeAt(i) === 48 ? 0 : 1) : 2;
    const d2 = i < p2.length ? (p2.charCodeAt(i) === 48 ? 0 : 1) : 2;
    return d0 * 9 + d1 * 3 + d2;
}

/**
 * Hierarchical 3-axis proximity index (radix-27 partitions) for best-first distance traversal.
 */
export class ProximityIndex {
    private root = partition();
    count = 1;

    add(a: Address, key: string = addressKey(a)): void {
        let cur = this.root;
        const p0 = a[0], p1 = a[1], p2 = a[2];
        const depth = Math.max(p0.length, p1.length, p2.length);
        for (let i = 0; i < depth; i++) {
            const code = stepCode(p0, p1, p2, i);
            let child = cur.children.get(code);
            if (!child) {
                cur.children.set(code, child = partition());
                this.count++;
            }
            cur = child;
        }
        cur.key = key;
    }

    remove(a: Address): void {
        let cur = this.root;
        const p0 = a[0], p1 = a[1], p2 = a[2];
        const depth = Math.max(p0.length, p1.length, p2.length);
        const parents: Partition[] = [];
        const codes: number[] = [];
        const children: Partition[] = [];
        for (let i = 0; i < depth; i++) {
            const code = stepCode(p0, p1, p2, i);
            const child = cur.children.get(code);
            if (!child) throw Error('missing proximity partition');
            parents.push(cur);
            codes.push(code);
            children.push(child);
            cur = child;
        }
        delete cur.key;
        for (let i = depth - 1; i >= 0; i--) {
            const child = children[i]!;
            if (child.key !== undefined || child.children.size) break;
            parents[i]!.children.delete(codes[i]!);
            this.count--;
        }
    }

    *distance(xyz: Vec3, geometry: Geometry, cutoff: number): IterableIterator<{
        key: string;
        distance: number;
    }> {
        const heap = new MinHeap<TraversalEntry>();
        const x = xyz[0], y = xyz[1], z = xyz[2];
        const lo = -geometry.offset, hi = geometry.offset - 1;
        heap.push(distanceSquared6(x, y, z, lo, hi, lo, hi, lo, hi), {
            partition: this.root,
            x0: lo, x1: hi,
            y0: lo, y1: hi,
            z0: lo, z1: hi,
        });
        while (heap.size) {
            const top = heap.pop()!;
            if (top.priority > cutoff) break;
            const { partition: cur, x0, x1, y0, y1, z0, z1 } = top.value;
            if (cur.key !== undefined) {
                yield { key: cur.key, distance: Math.sqrt(top.priority) };
            }
            if (!cur.children.size) continue;
            const xm = Math.floor((x0 + x1) / 2);
            const ym = Math.floor((y0 + y1) / 2);
            const zm = Math.floor((z0 + z1) / 2);
            for (const [code, child] of cur.children) {
                const d0 = (code / 9) | 0;
                const rem = code - d0 * 9;
                const d1 = (rem / 3) | 0;
                const d2 = rem - d1 * 3;
                const nx0 = d0 === 1 ? xm + 1 : x0;
                const nx1 = d0 === 0 ? xm : x1;
                const ny0 = d1 === 1 ? ym + 1 : y0;
                const ny1 = d1 === 0 ? ym : y1;
                const nz0 = d2 === 1 ? zm + 1 : z0;
                const nz1 = d2 === 0 ? zm : z1;
                const d = distanceSquared6(x, y, z, nx0, nx1, ny0, ny1, nz0, nz1);
                if (d <= cutoff) {
                    heap.push(d, { partition: child, x0: nx0, x1: nx1, y0: ny0, y1: ny1, z0: nz0, z1: nz1 });
                }
            }
        }
    }

    validate(keys: ReadonlySet<string>): void {
        let count = 0;
        const found = new Set<string>();
        const walk = (p: Partition) => {
            count++;
            if (p.key !== undefined) {
                if (found.has(p.key)) throw Error('duplicate proximity key');
                found.add(p.key);
            }
            for (const c of p.children.values()) walk(c);
        };
        walk(this.root);
        if (count !== this.count || found.size !== keys.size || [...found].some(k => !keys.has(k))) {
            throw Error('invalid proximity index');
        }
    }
}
