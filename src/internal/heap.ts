export class MinHeap<T> {
    private readonly data: {
        priority: number;
        value: T;
    }[] = [];
    get size(): number { return this.data.length; }
    push(priority: number, value: T): void { const a = this.data; let i = a.length; a.push({ priority, value }); while (i > 0) {
        const p = (i - 1) >> 1;
        if (a[p]!.priority <= priority)
            break;
        a[i] = a[p]!;
        i = p;
    } a[i] = { priority, value }; }
    pop(): {
        priority: number;
        value: T;
    } | undefined { const a = this.data, first = a[0], last = a.pop(); if (a.length && last) {
        let i = 0;
        while (i * 2 + 1 < a.length) {
            let c = i * 2 + 1;
            if (c + 1 < a.length && a[c + 1]!.priority < a[c]!.priority)
                c++;
            if (a[c]!.priority >= last.priority)
                break;
            a[i] = a[c]!;
            i = c;
        }
        a[i] = last;
    } return first; }
}
