import { boundsMatch, type Geometry } from '../geometry.ts';
import type { Address, Bounds } from '../types.ts';

export type AxisSpans = readonly [readonly string[], readonly string[], readonly string[]];

export interface IndexedRegion {
    readonly bounds: Bounds;
    readonly axes: AxisSpans;
}

export interface SelectionPlan<K> {
    readonly count: number;
    readonly groups?: readonly Set<K>[];
    readonly needsDedup: boolean;
}

/**
 * Spatial region index for containment and overlap queries.
 * Indexes records independently along each axis so arbitrary 3D Bounds never expand cubically.
 */
export class RegionIndex<K> {
    readonly records = new Map<K, IndexedRegion>();
    private readonly postings: readonly [Map<string, Set<K>>, Map<string, Set<K>>, Map<string, Set<K>>] = [
        new Map(),
        new Map(),
        new Map(),
    ];
    private readonly exact: readonly [Map<string, Set<K>>, Map<string, Set<K>>, Map<string, Set<K>>] = [
        new Map(),
        new Map(),
        new Map(),
    ];
    private multiSpanCount = 0;

    private edit(map: Map<string, Set<K>>, p: string, k: K, add: boolean): void {
        if (add) {
            let b = map.get(p);
            if (!b) map.set(p, b = new Set());
            b.add(k);
        } else {
            const b = map.get(p);
            if (!b) return;
            b.delete(k);
            if (!b.size) map.delete(p);
        }
    }

    private addRecord(k: K, bounds: Bounds, axes: AxisSpans): void {
        if (this.records.has(k)) throw new Error('duplicate index key');
        this.records.set(k, { bounds, axes });
        if (axes[0].length > 1 || axes[1].length > 1 || axes[2].length > 1) {
            this.multiSpanCount++;
        }
        for (let i = 0; i < 3; i++) {
            const exactMap = this.exact[i]!;
            const postMap = this.postings[i]!;
            const ps = axes[i]!;
            for (let j = 0; j < ps.length; j++) {
                const p = ps[j]!;
                this.edit(exactMap, p, k, true);
                for (let n = 1; n <= p.length; n++) {
                    this.edit(postMap, n === p.length ? p : p.slice(0, n), k, true);
                }
            }
        }
    }

    add(k: K, a: Address, bounds: Bounds): void {
        this.addRecord(k, bounds, [[a[0]], [a[1]], [a[2]]]);
    }

    addBounds(k: K, bounds: Bounds, geometry: Geometry): void {
        this.addRecord(k, bounds, geometry.boundsAxes(bounds));
    }

    remove(k: K): void {
        const rec = this.records.get(k);
        if (!rec) return;
        this.records.delete(k);
        const { axes } = rec;
        if (axes[0].length > 1 || axes[1].length > 1 || axes[2].length > 1) {
            this.multiSpanCount--;
        }
        for (let i = 0; i < 3; i++) {
            const exactMap = this.exact[i]!;
            const postMap = this.postings[i]!;
            const ps = axes[i]!;
            for (let j = 0; j < ps.length; j++) {
                const p = ps[j]!;
                this.edit(exactMap, p, k, false);
                for (let n = 1; n <= p.length; n++) {
                    this.edit(postMap, n === p.length ? p : p.slice(0, n), k, false);
                }
            }
        }
    }

    /** Estimate candidate count and select the cheapest restricted axis in O(bits). */
    plan(axes: AxisSpans, overlap: boolean): SelectionPlan<K> {
        let best: Set<K>[] | undefined;
        let size = this.records.size;
        for (let i = 0; i < 3; i++) {
            const ps = axes[i]!;
            if (ps.length === 1 && ps[0] === '') continue;
            const exactMap = this.exact[i]!;
            const postMap = this.postings[i]!;
            const groups: Set<K>[] = [];
            let count = 0;
            const seenAncestors = overlap && ps.length > 1 ? new Set<string>() : undefined;
            for (let j = 0; j < ps.length; j++) {
                const p = ps[j]!;
                const own = postMap.get(p);
                if (own) {
                    groups.push(own);
                    count += own.size;
                }
                if (overlap) {
                    for (let n = 0; n < p.length; n++) {
                        const anc = n === 0 ? '' : p.slice(0, n);
                        if (seenAncestors) {
                            if (seenAncestors.has(anc)) continue;
                            seenAncestors.add(anc);
                        }
                        const b = exactMap.get(anc);
                        if (b) {
                            groups.push(b);
                            count += b.size;
                        }
                    }
                }
            }
            if (count < size || best === undefined) {
                best = groups;
                size = count;
                if (size === 0) break;
            }
        }
        return {
            count: size,
            groups: best,
            needsDedup: best !== undefined && best.length > 1 && this.multiSpanCount > 0,
        };
    }

    selectPlan(qBounds: Bounds, overlap: boolean, plan: SelectionPlan<K>): K[] {
        const out: K[] = [];
        if (plan.count === 0) return out;
        if (plan.groups === undefined) {
            for (const [k, rec] of this.records) {
                if (boundsMatch(rec.bounds, qBounds, overlap)) out.push(k);
            }
            return out;
        }
        if (plan.needsDedup) {
            const seen = new Set<K>();
            for (let g = 0; g < plan.groups.length; g++) {
                for (const k of plan.groups[g]!) {
                    if (seen.has(k)) continue;
                    seen.add(k);
                    if (boundsMatch(this.records.get(k)!.bounds, qBounds, overlap)) out.push(k);
                }
            }
            return out;
        }
        for (let g = 0; g < plan.groups.length; g++) {
            for (const k of plan.groups[g]!) {
                if (boundsMatch(this.records.get(k)!.bounds, qBounds, overlap)) out.push(k);
            }
        }
        return out;
    }

    select(q: Address, qBounds: Bounds, overlap: boolean): K[] {
        const p = this.plan([[q[0]], [q[1]], [q[2]]], overlap);
        return this.selectPlan(qBounds, overlap, p);
    }

    selectBounds(qBounds: Bounds, overlap: boolean, geometry: Geometry): K[] {
        const p = this.plan(geometry.boundsAxes(qBounds), overlap);
        return this.selectPlan(qBounds, overlap, p);
    }

    validate(): void {
        let multi = 0;
        for (const [k, rec] of this.records) {
            const { axes } = rec;
            if (axes[0].length > 1 || axes[1].length > 1 || axes[2].length > 1) multi++;
            for (let i = 0; i < 3; i++) {
                const exactMap = this.exact[i]!;
                const postMap = this.postings[i]!;
                for (const p of axes[i]!) {
                    if (!exactMap.get(p)?.has(k)) throw Error('missing exact posting');
                    for (let n = 1; n <= p.length; n++) {
                        if (!postMap.get(p.slice(0, n))?.has(k)) throw Error('missing posting');
                    }
                }
            }
        }
        if (multi !== this.multiSpanCount) throw Error('invalid multiSpanCount');
        for (let i = 0; i < 3; i++) {
            for (const [p, b] of this.exact[i]!) {
                if (!b.size) throw Error('empty bucket');
                for (const k of b) {
                    const rec = this.records.get(k);
                    if (!rec || !rec.axes[i]!.includes(p)) throw Error('invalid exact posting');
                }
            }
            for (const [p, b] of this.postings[i]!) {
                if (!b.size) throw Error('empty bucket');
                for (const k of b) {
                    const rec = this.records.get(k);
                    if (!rec || !rec.axes[i]!.some(rp => rp.startsWith(p))) throw Error('invalid posting');
                }
            }
        }
    }
}
