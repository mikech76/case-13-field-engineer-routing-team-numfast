// Copyright (c) 2026 NumFast
// SPDX-License-Identifier: AGPL-3.0-only
const CELL = 100000;
const SCALE = 1e7;
const RMM = 6371000.0 * 1000.0;
const key = (x, y) => x + ":" + y;
function havMm(lo1, la1, lo2, la2) {
    const p1 = la1 * Math.PI / 180, p2 = la2 * Math.PI / 180;
    const dp = p2 - p1, dl = (lo2 - lo1) * Math.PI / 180;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * RMM * Math.asin(Math.min(1, Math.sqrt(a)));
}
export function loadMap(parts) {
    const nodeLon = new Int32Array(parts.nodeLon);
    const nodeLat = new Int32Array(parts.nodeLat);
    const off = new Int32Array(parts.offsets);
    const heads = new Int32Array(parts.heads);
    const length = new Uint32Array(parts.length);
    const speed = new Uint32Array(parts.speed);
    const N = nodeLon.length, M = heads.length;
    const grid = new Map();
    for (let i = 0; i < N; i++) {
        const k = key(Math.floor(nodeLon[i] / CELL), Math.floor(nodeLat[i] / CELL));
        let a = grid.get(k);
        if (!a) {
            a = [];
            grid.set(k, a);
        }
        a.push(i);
    }
    return { N, M, nodeLon, nodeLat, off, heads, length, speed, grid };
}
export async function loadMapFromFetch(base) {
    const get = async (n) => (await (await fetch(base + "/" + n)).blob()).arrayBuffer();
    const [nodeLon, nodeLat, offsets, heads, length, speed] = await Promise.all(["node_lon.bin", "node_lat.bin", "offsets.bin", "heads.bin", "length.bin", "speed.bin"].map(get));
    return loadMap({ nodeLon, nodeLat, offsets, heads, length, speed });
}
export function snap(map, lon, lat) {
    const qx = Math.floor(lon * SCALE / CELL), qy = Math.floor(lat * SCALE / CELL);
    for (let r = 0; r <= 200; r++) {
        let best = -1, bd = Infinity;
        for (let dx = -r; dx <= r; dx++)
            for (let dy = -r; dy <= r; dy++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r)
                    continue;
                const lst = map.grid.get(key(qx + dx, qy + dy));
                if (!lst)
                    continue;
                for (let j = 0; j < lst.length; j++) {
                    const i = lst[j];
                    const mm = havMm(lon, lat, map.nodeLon[i] / SCALE, map.nodeLat[i] / SCALE);
                    if (mm < bd) {
                        bd = mm;
                        best = i;
                    }
                }
            }
        if (best >= 0)
            return { node: best, mm: bd, ring: r };
    }
    return { node: -1, mm: Infinity, ring: 200 };
}
// DERIVED foot speed bins (by value): car_kmh [90,999)->blocked, [60,90)->5,
// [40,60)->5, [25,40)->5, [0,25)->4 km/h.
function footV(s) {
    const kmh = s * 3600.0 / 1e6;
    if (kmh >= 60 && kmh < 999)
        return 5 * 1e6 / 3600;
    if (kmh >= 40 && kmh < 60)
        return 5 * 1e6 / 3600;
    if (kmh >= 25 && kmh < 40)
        return 5 * 1e6 / 3600;
    if (kmh >= 0 && kmh < 25)
        return 4 * 1e6 / 3600;
    return -1;
}
function edgeMs(map, e, profile) {
    const L = map.length[e], s = map.speed[e];
    if (profile === "car")
        return s > 0 ? Math.max(1, Math.floor(L * 1000 / s)) : -1;
    const v = footV(s);
    return v >= 1 ? Math.max(1, Math.floor(L * 1000 / Math.floor(v))) : -1;
}
class Heap {
    d = [];
    v = [];
    get size() { return this.d.length; }
    push(dist, node) {
        const d = this.d, v = this.v;
        d.push(dist);
        v.push(node);
        let i = d.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (d[p] <= d[i])
                break;
            [d[p], d[i]] = [d[i], d[p]];
            [v[p], v[i]] = [v[i], v[p]];
            i = p;
        }
    }
    pop() {
        const d = this.d, v = this.v;
        const top = v[0], ld = d.pop(), lv = v.pop();
        if (d.length) {
            d[0] = ld;
            v[0] = lv;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1, r = l + 1;
                let m = i;
                if (l < d.length && d[l] < d[m])
                    m = l;
                if (r < d.length && d[r] < d[m])
                    m = r;
                if (m === i)
                    break;
                [d[m], d[i]] = [d[i], d[m]];
                [v[m], v[i]] = [v[i], v[m]];
                i = m;
            }
        }
        return top;
    }
    peekD() { return this.d[0]; }
}
export function route(map, a, b, profile) {
    const sa = snap(map, a[0], a[1]), sb = snap(map, b[0], b[1]);
    const head = {
        reachable: false, duration_ms: null, distance_m: null,
        snap_node: [sa.node, sb.node], snap_mm: [sa.mm, sb.mm], rings: [sa.ring, sb.ring],
        settled: 0, path: [], polyline: [],
    };
    if (sa.node < 0 || sb.node < 0)
        return head;
    const src = sa.node, dst = sb.node;
    const N = map.N;
    const dist = new Float64Array(N).fill(Infinity);
    const prev = new Int32Array(N).fill(-1);
    const prevE = new Int32Array(N).fill(-1);
    const h = new Heap();
    dist[src] = 0;
    h.push(0, src);
    let settled = 0;
    while (h.size) {
        const du = h.peekD();
        const u = h.pop();
        if (du !== dist[u])
            continue;
        settled++;
        if (u === dst)
            break;
        for (let e = map.off[u]; e < map.off[u + 1]; e++) {
            const v = map.heads[e];
            const w = edgeMs(map, e, profile);
            if (w < 0)
                continue;
            const nd = du + w;
            if (nd < dist[v]) {
                dist[v] = nd;
                prev[v] = u;
                prevE[v] = e;
                h.push(nd, v);
            }
        }
    }
    head.settled = settled;
    if (!isFinite(dist[dst]))
        return head;
    const path = [];
    let dm = 0, c = dst;
    while (c !== src) {
        path.push(c);
        dm += map.length[prevE[c]] / 1000;
        c = prev[c];
    }
    path.push(src);
    path.reverse();
    const stride = Math.max(1, Math.ceil(path.length / 2000));
    const poly = [];
    for (let i = 0; i < path.length; i += stride)
        poly.push([map.nodeLon[path[i]] / SCALE, map.nodeLat[path[i]] / SCALE]);
    if (poly[poly.length - 1][0] !== map.nodeLon[dst] / SCALE)
        poly.push([map.nodeLon[dst] / SCALE, map.nodeLat[dst] / SCALE]);
    head.reachable = true;
    head.duration_ms = Math.round(dist[dst]);
    head.distance_m = Math.round(dm * 10) / 10;
    head.path = path.length <= 20000 ? path : path.filter((_, i) => i % stride === 0);
    head.polyline = poly;
    return head;
}
const yieldUi = () => new Promise((r) => setTimeout(r, 0));
export async function batch(map, pairs, profile, chunk = 5, onProgress) {
    const out = [];
    for (let i = 0; i < pairs.length; i++) {
        const p = pairs[i];
        out.push(route(map, [p[0], p[1]], [p[2], p[3]], profile));
        if (onProgress && (i + 1) % chunk === 0)
            onProgress(i + 1, pairs.length);
        if ((i + 1) % chunk === 0 && i + 1 < pairs.length)
            await yieldUi();
    }
    if (onProgress)
        onProgress(pairs.length, pairs.length);
    return out;
}
