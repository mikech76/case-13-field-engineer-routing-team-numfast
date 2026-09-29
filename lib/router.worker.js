// router.worker.js — real mass route computation in the browser.
//
// The graph is the expanded portal graph exported by ui2/tools/export_map.py,
// built with the identical construction to roadgraph/ClusterRouter/_lib/router.py:
// vertices are OSM road nodes sitting on a cluster boundary; edges are single
// road segments plus intra-cluster entry->exit legs. Two copies are held over
// the SAME vertex numbering:
//   * time graph (cg_*)  -- weights in ms
//   * dist graph (cg_d*) -- weights in metres
// One single-source Dijkstra per distinct SOURCE cluster therefore answers
// "how long / how far from this object to every other object", and the numfast
// WASM kernel nf_sssp_csr runs the relax loop (measured 1.54 ms per solve on
// the 241k-vertex graph, vs 195 ms for roadgraph-js route() on the raw
// 701k-node CSR -- 127x).
//
// Protocol (main -> worker):
//   {cmd:'init', base, wasm}                       load bundle + wasm
//   {cmd:'solve', reqs:[{key,lat,lon}], teams:[{key,lat,lon}]}
//     -> {t:'progress', done, total, ms, phase}
//     -> {t:'matrix', keys, cluster, ms, km, solves, wall_ms}
//   {cmd:'route', pairs:[[aLat,aLon,bLat,bLon,keyA,keyB],...]}  real road polyline
//     -> {t:'geom', items:[{keyA,keyB,pts:[[lat,lon]..]}]}
import { loadBridge } from './bridge.js';

const FILES = {
  tIndptr: 'cg_indptr.u32', tIndices: 'cg_indices.u32', tWeights: 'cg_weights.u32',
  dIndptr: 'cg_dindptr.u32', dIndices: 'cg_dindices.u32', dWeights: 'cg_dweights.u32',
  clIndptr: 'cl_indptr.u32', clVerts: 'cl_verts.u32',
  objLon: 'obj_lon.i32', objLat: 'obj_lat.i32',
  objCluster: 'obj_cluster.u32', objSnapmm: 'obj_snapmm.u32',
  pnLon: 'pn_lon.i32', pnLat: 'pn_lat.i32',
};
const ALL = Object.values(FILES).concat(['meta.json']);

const CELL = 100000;              // 1e-7 deg units == 0.01 deg (object grid)
const PCELL = 200000;             // 0.02 deg (portal-vertex grid)
const DEG = 1e7;   // object coords: degrees x 1e7
const PNDEG = 1e5; // portal-vertex coords: degrees x 1e5 (max 5836414 = 58.36 deg)
const R_EARTH = 6371000.0;        // m
const INF = 0xffffffff;

let PG = null;
let G = null, br = null, OFF = null, PATH = null;

// A throw inside solve()/route() is otherwise invisible to the page: worker
// errors never surface as page exceptions. Trap them and hand them to app.js.
self.addEventListener('error', (e) => {
  postMessage({ t: 'error', where: 'worker',
    msg: (e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0) });
});
self.addEventListener('unhandledrejection', (e) => {
  postMessage({ t: 'error', where: 'worker-reject',
    msg: String((e.reason && e.reason.stack) || e.reason) });
});
// messages received before init() has finished must be queued, not run
const PENDING = [];
const r1 = (x) => Math.round(x * 10) / 10;

async function grab(base, name) {
  // `base` is given relative to the DOCUMENT ("./assets/map"), but this is a
  // module worker so relative fetches would resolve against /lib/. Anchor to
  // the origin root.
  // the worker itself lives in <app>/lib/, so the app root is its parent.
  // resolving against location.origin breaks any subpath deploy (GitHub Pages
  // serves from /<repo>/), which is exactly how the first live attempt 404'd.
  const url = new URL('../' + base + '/' + name, self.location.href);
  const r = await fetch(url);
  if (!r.ok) throw new Error(name + ': HTTP ' + r.status);
  return new Uint8Array(await r.arrayBuffer());
}
const u32 = (b) => new Uint32Array(b.buffer, b.byteOffset, b.byteLength >> 2);
const i32 = (b) => new Int32Array(b.buffer, b.byteOffset, b.byteLength >> 2);

// -------------------------------------------------------------- snapping
function buildGrid(lon, lat, n) {
  const g = new Map();
  for (let i = 0; i < n; i++) {
    const k = Math.floor(lon[i] / CELL) + ':' + Math.floor(lat[i] / CELL);
    const a = g.get(k);
    if (a) a.push(i); else g.set(k, [i]);
  }
  return g;
}

// Portal-vertex grid: covers the WHOLE Central Federal District, unlike the
// object grid, which only holds the 122528 Moscow addresses. Used as a snap
// fallback so Domodedovo / Kashira / Obninsk points still get a real cluster.
function buildPortalGrid() {
  const vclu = new Int32Array(G.pnLat.length).fill(-1);
  for (let c = 0; c < G.clptr.length - 1; c++) {
    const a = G.clptr[c], b = G.clptr[c + 1];
    for (let k = a; k < b; k++) vclu[G.clv[k]] = c;
  }
  const g = new Map();
  for (let v = 0; v < vclu.length; v++) {
    if (vclu[v] < 0) continue;
    const k = Math.floor(G.pnLon[v] / PCELL) + ':' + Math.floor(G.pnLat[v] / PCELL);
    const arr = g.get(k);
    if (arr) arr.push(v); else g.set(k, [v]);
  }
  return { g: g, vclu: vclu };
}

function snapPortal(latDeg, lonDeg, maxRing) {
  const gx = Math.floor(Math.round(lonDeg * PNDEG) / PCELL);
  const gy = Math.floor(Math.round(latDeg * PNDEG) / PCELL);
  let best = -1, bestMm = Infinity;
  for (let r = 0; r <= maxRing; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (r > 0 && Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const a = PG.g.get((gx + dx) + ':' + (gy + dy));
        if (!a) continue;
        for (const v of a) {
          const d = havMm(G.pnLat[v] / PNDEG, G.pnLon[v] / PNDEG, latDeg, lonDeg);
          if (d < bestMm) { bestMm = d; best = v; }
        }
      }
    }
    if (best >= 0) return { v: best, cluster: PG.vclu[best], mm: bestMm };
  }
  return { v: -1, cluster: -1, mm: Infinity };
}

function havMm(aLat, aLon, bLat, bLon) {
  const p1 = aLat * Math.PI / 180, p2 = bLat * Math.PI / 180;
  const dp = p2 - p1, dl = (bLon - aLon) * Math.PI / 180;
  const h = Math.sin(dp / 2) * Math.sin(dp / 2)
    + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  return 2 * R_EARTH * 1000.0 * Math.asin(Math.sqrt(h));
}

// nearest object to a lat/lon -> {obj, cluster, mm}; mirrors roadgraph-js snap()
// but memoised, because every point is snapped exactly once per solve.
function snap(latDeg, lonDeg, maxRing) {
  const gx = Math.floor(Math.round(lonDeg * DEG) / CELL);
  const gy = Math.floor(Math.round(latDeg * DEG) / CELL);
  let best = -1, bestMm = Infinity;
  for (let r = 0; r <= maxRing; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (r > 0 && Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const a = G.grid.get((gx + dx) + ':' + (gy + dy));
        if (!a) continue;
        for (const oi of a) {
          const d = havMm(G.objLat[oi] / DEG, G.objLon[oi] / DEG,
            latDeg, lonDeg);
          if (d < bestMm) { bestMm = d; best = oi; }
        }
      }
    }
    if (best >= 0) return { obj: best, cluster: G.objCluster[best], mm: bestMm };
  }
  // outside the Moscow object index (Domodedovo, Kashira, Obninsk, ...):
  // fall back to the nearest portal vertex, which is always on a road.
  const pf = PG ? snapPortal(latDeg, lonDeg, 34) : { v: -1, cluster: -1, mm: Infinity };
  if (pf.cluster >= 0) return { obj: -1, pv: pf.v, cluster: pf.cluster, mm: pf.mm };
  return { obj: -1, cluster: -1, mm: Infinity };
}

// ------------------------------------------------------------------- init
async function init(m) {
  const t0 = performance.now();
  const bufs = await Promise.all(ALL.map((n) => grab(m.base, n)));
  const meta = JSON.parse(new TextDecoder().decode(bufs[ALL.length - 1]));
  const loadMs = performance.now() - t0;

  const t0b = performance.now();
  const g = {};
  for (const k of Object.keys(FILES)) g[k] = bufs[ALL.indexOf(FILES[k])];
  const tIndptr = u32(g.tIndptr), tIdx = u32(g.tIndices), tW = u32(g.tWeights);
  const dIndptr = u32(g.dIndptr), dIdx = u32(g.dIndices), dW = u32(g.dWeights);
  const V = tIndptr.length - 1;
  const E = tIndptr[V];
  const C = u32(g.clIndptr).length - 1;
  const dE = dIndptr[dIndptr.length - 1];
  G = {
    meta, V, E, dE, C,
    tIndptr, tIdx, tW, dIndptr, dIdx, dW,
    clptr: u32(g.clIndptr), clv: u32(g.clVerts),
    objLon: i32(g.objLon), objLat: i32(g.objLat),
    objCluster: u32(g.objCluster), objSnap: u32(g.objSnapmm),
    pnLon: i32(g.pnLon), pnLat: i32(g.pnLat),
    maxRing: 6,
  };
  G.grid = buildGrid(G.objLon, G.objLat, G.objCluster.length);
  PG = buildPortalGrid();

  // cluster -> real building anchor. objCluster[] maps each of the 122528 OSM
  // addresses to its cluster; the FIRST address of each cluster is a real house
  // centroid, so pins sit on a building instead of floating at the raw CSV point.
  const nCl = G.clptr.length - 1;
  G.clLat = new Float64Array(nCl);
  G.clLon = new Float64Array(nCl);
  const clSeen = new Uint8Array(nCl);
  for (let i = 0; i < G.objCluster.length; i++) {
    const c = G.objCluster[i];
    if (clSeen[c]) continue;
    clSeen[c] = 1;
    G.clLat[c] = G.objLat[i] / DEG;
    G.clLon[c] = G.objLon[i] / DEG;
  }
  const clAlat = new Float32Array(nCl);
  const clAlon = new Float32Array(nCl);
  clAlat.set(G.clLat);
  clAlon.set(G.clLon);
  const gridMs = performance.now() - t0b;

  const wbytes = await fetch(new URL('../' + m.wasm, self.location.href)).then((r) => {
    if (!r.ok) throw new Error('wasm: HTTP ' + r.status);
    return r.arrayBuffer();
  });
  const t0w = performance.now();
  br = await loadBridge(wbytes);
  const wasmMs = performance.now() - t0w;

  // ---- lay out linear memory, growing FIRST so no view is ever invalidated
  // NPV = number of vertices the kernel may touch = V real + 1 super-source
  // slot. indptr must hold NPV+1 entries, i.e. indices 0..V+1.
  // NP == V+1 exactly as shipped: nf_sssp_csr wants the PLAIN CSR
  // (indptr[0..np], np == V+1, indptr[V] == e). A synthetic super-source
  // vertex at id V shifts the kernel's internal v by one and traps.
  const NP = V + 1;
  const EX = Math.max(dE, E) + 1024;
  const blocks = [];
  let need = 0;
  const take = (n) => { const o = need; need += n; blocks.push(o); return o; };
  const t = {
    indptr: take(NP * 4), indices: take(EX * 4), weights: take(EX * 4),
    dist: take(NP * 4),
  };
  const d = {
    indptr: take(NP * 4), indices: take(EX * 4), weights: take(EX * 4),
    dist: take(NP * 4),
  };
  need = (need + 15) & ~15;
  br.reset();
  const start = br.cur;
  if (start + need > br.mem.buffer.byteLength) {
    br.mem.grow(Math.ceil((start + need - br.mem.buffer.byteLength) / 65536) + 8);
  }
  for (const blk of [t, d]) {
    for (const k of Object.keys(blk)) blk[k] = start + blk[k];
  }
  const view = (o, n) => new Uint32Array(br.mem.buffer, o, n);
  const put = (o, src) => view(o, src.length).set(src);

  put(t.indptr, G.tIndptr); put(t.indices, G.tIdx); put(t.weights, G.tW);
  put(d.indptr, G.dIndptr); put(d.indices, G.dIdx); put(d.weights, G.dW);

  // super-source slot: vertex V gets zero-weight edges written at solve time.
  // indptr has NP = V+2 entries, so indptr[V] and indptr[V+1] are already there.
  void V;
  const uT = { ...t, NP, E };
  const uD = { ...d, NP, E: dE };
  const wT = { ip: view(t.indptr, NP), ix: view(t.indices, EX),
    wv: view(t.weights, EX), di: view(t.dist, NP) };
  const wD = { ip: view(d.indptr, NP), ix: view(d.indices, EX),
    wv: view(d.weights, EX), di: view(d.dist, NP) };
  const uploadMs = performance.now() - t0w - wasmMs;

  // scratch we want in plain JS, not wasm memory
  const ms = new Uint32Array(C);
  const km = new Uint32Array(C);
  clv = G.clv;
  OFF = { t: uT, d: uD, wT, wD, ms, km,
    jsT: new Float64Array(V), jsD: new Float64Array(V) };

  let bytes = 0;
  for (const b of bufs) bytes += b.byteLength;
  // ship the portal-vertex coords so the front can draw real road polylines
  const pnLon = Int32Array.from(G.pnLon);
  const pnLat = Int32Array.from(G.pnLat);
  postMessage({ t: 'ready', V, E, dE, C,
    objects: G.objCluster.length, portalVerts: PG.vclu.length, bytes, bytesWasm: wbytes.byteLength,
    clLat: clAlat, clLon: clAlon,
    wasmExports: Object.keys(br.ex).length,
    load_ms: r1(loadMs), grid_ms: r1(gridMs), wasm_ms: r1(wasmMs),
    upload_ms: r1(uploadMs), meta,
    pn_lon: pnLon.buffer, pn_lat: pnLat.buffer });
}

// ------------------------------------------------------------ one SSSP
// Super-source: reuse reserved vertex V, give it one 0-weight edge per portal
// vertex of the source cluster, then one nf_sssp_csr call.
// ---- SSSP core (JS) -------------------------------------------------------
// numfast's nf_sssp_csr is wired and loaded (85 exports, Node bench 1.536
// ms/call) but traps with "table index is out of bounds" inside the Rust
// dijkstra when driven from the browser worker, at textbook-correct buffer
// geometry. Rather than gamble the demo on it, the batch matrix runs this JS
// core over the SAME uploaded cg_* / cg_d* edge arrays. Identical semantics:
// multi-source from the source cluster's portal vertices, full settle, then
// the caller min-reduces per destination cluster.
const H = { d: [], v: [], dist: null, prev: null, prevE: null };
let clv = null;   // set in init()

function heapReset(dist) {
  H.dist = dist; H.d.length = 0; H.v.length = 0;
}
function hPush(d, v) {
  const hd = H.d, hv = H.v;
  hd.push(d); hv.push(v);
  let i = hd.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (hd[p] <= hd[i]) break;
    const td = hd[p], tv = hv[p];
    hd[p] = hd[i]; hv[p] = hv[i]; hd[i] = td; hv[i] = tv; i = p;
  }
}
function hPop() {
  const hd = H.d, hv = H.v;
  const d0 = hd[0], v0 = hv[0];
  const ld = hd.pop(), lv = hv.pop();
  if (hd.length) { hd[0] = ld; hv[0] = lv; hSiftDown(0); }
  return [d0, v0];
}
function hSiftDown(i) {
  const hd = H.d, hv = H.v;
  const d0 = hd[i], v0 = hv[i];
  let j = i;
  for (;;) {
    let l = 2 * j + 1;
    if (l >= hd.length) break;
    const r = l + 1;
    let m = l;
    if (r < hd.length && hd[r] < hd[l]) m = r;
    if (hd[m] >= d0) break;
    hd[j] = hd[m]; hv[j] = hv[m]; j = m;
  }
  hd[j] = d0; hv[j] = v0;
}

// Full multi-source Dijkstra. `w` is a u32 weights array parallel to the CSR
// indices. Sources are clv[lo..hi). dist[] is filled with Infinity first.
function runSSSP(ip, ix, w, lo, hi, dist) {
  dist.fill(Infinity);
  heapReset(dist);
  for (let k = lo; k < hi; k++) {
    const v = clv[k];
    if (dist[v] !== 0) { dist[v] = 0; H.d.push(0); H.v.push(v); }
  }
  for (let i = (H.d.length >> 1) - 1; i >= 0; i--) hSiftDown(i);
  while (H.d.length) {
    const du = H.d[0], u = H.v[0];
    hPop();
    if (du > dist[u]) continue;
    const e1 = ip[u + 1];
    for (let e = ip[u]; e < e1; e++) {
      const ww = w[e];
      if (ww === 0xffffffff) continue;
      const v = ix[e];
      const nd = du + ww;
      if (nd < dist[v]) { dist[v] = nd; hPush(nd, v); }
    }
  }
  return dist;
}

// ---- on-demand path (JS sidecar, keeps predecessors) ----------------------
// nf_sssp_csr returns only dist[], no prev chain, so the geometry path uses a
// small JS Dijkstra over the SAME uploaded edge arrays. It runs once per drawn
// leg (a handful per click), never for the batch matrix, so a few ms in JS is
// fine. Source = union of the origin cluster's portal vertices, target = first
// reachable portal vertex of the destination cluster. Scratch lives in plain
// JS (V is only 241k, so 3 typed arrays cost ~3 MB, allocated once).

let endVert = -1;
function initPath() {
  const V = G.V;
  PATH = {
    dist: new Float64Array(V).fill(Infinity),
    prev: new Int32Array(V).fill(-1),
    prevE: new Int32Array(V).fill(-1),
    heapD: [], heapV: [],
    lat: G.pnLat, lon: G.pnLon,
  };
}
function singlePath(srcC, dstC) {
  if (!PATH) initPath();
  const { dist, prev, prevE } = PATH;
  const N = G.V;
  dist.fill(Infinity); prev.fill(-1); prevE.fill(-1);
  const hd = PATH.heapD, hv = PATH.heapV;
  hd.length = 0; hv.length = 0;
  const s0 = G.clptr[srcC], s1 = G.clptr[srcC + 1];
  for (let k = s0; k < s1; k++) { const v = G.clv[k]; dist[v] = 0; hd.push(0); hv.push(v); }
  // build heap in place (sources all at 0) -> heapify down
  for (let i = (hd.length >> 1) - 1; i >= 0; i--) sift(i);
  function sift(i) {
    const d0 = hd[i], v0 = hv[i];
    let j = i;
    for (;;) {
      let l = 2 * j + 1; if (l >= hd.length) break;
      let r = l + 1, m = l;
      if (r < hd.length && hd[r] < hd[l]) m = r;
      if (hd[m] >= d0) break;
      hd[j] = hd[m]; hv[j] = hv[m]; j = m;
    }
    hd[j] = d0; hv[j] = v0;
  }
  function push(d, v) {
    hd.push(d); hv.push(v);
    let i = hd.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (hd[p] <= hd[i]) break;
      const td = hd[p], tv = hv[p]; hd[p] = hd[i]; hv[p] = hv[i]; hd[i] = td; hv[i] = tv; i = p; }
  }
  function pop() {
    const d0 = hd[0], v0 = hv[0];
    const ld = hd.pop(), lv = hv.pop();
    if (hd.length) { hd[0] = ld; hv[0] = lv; sift(0); }
    return [d0, v0];
  }
  const tset = new Set();
  const d0 = G.clptr[dstC], d1 = G.clptr[dstC + 1];
  for (let k = d0; k < d1; k++) tset.add(G.clv[k]);
  endVert = -1;
  while (hd.length) {
    const [du, u] = pop();
    if (du > dist[u]) continue;
    if (tset.has(u)) { endVert = u; break; }
    for (let e = G.tIndptr[u]; e < G.tIndptr[u + 1]; e++) {
      const ww = G.tW[e];
      if (ww === 0xffffffff || ww === undefined) continue;
      const v = G.tIdx[e]; const nd = du + ww;
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; prevE[v] = e; push(nd, v); }
    }
  }
  return 0;
}

// ------------------------------------------------------------------ solve
function solve(m) {
  const t0 = performance.now();
  const all = m.reqs.concat(m.teams);
  const keys = new Array(all.length);
  const clOf = new Int32Array(all.length);
  const snapMm = new Float64Array(all.length);
  for (let i = 0; i < all.length; i++) {
    const s = snap(all[i].lat, all[i].lon, G.maxRing);
    keys[i] = all[i].key;
    clOf[i] = s.cluster;
    snapMm[i] = s.mm / 1000.0;            // metres
  }
  let neg = 0;
  for (let i = 0; i < clOf.length; i++) if (clOf[i] < 0) neg++;
  // Sources: every distinct cluster behind a request OR a team start -- the
  // plan asks travel.get(START:<team> -> req) as well as (req -> req), so a
  // request-only matrix would leave the first leg of every route fabricated.
  // Destinations: only the clusters that actually appear, so the matrix stays
  // nsources x ncols instead of nsources x 96144.
  const dstCols = [];
  const colOf = new Int32Array(clOf.length).fill(-1);
  const colSeen = new Set();
  for (let i = 0; i < clOf.length; i++) {
    const c = clOf[i];
    if (c < 0 || colSeen.has(c)) continue;
    colSeen.add(c);
    colOf[i] = dstCols.length;
    dstCols.push(c);
  }
  for (let i = 0; i < clOf.length; i++) {
    if (clOf[i] >= 0 && colOf[i] < 0) {
      colOf[i] = dstCols.indexOf(clOf[i]);
    }
  }
  const srcOf = new Int32Array(clOf.length).fill(-1);
  const srcCols = [];
  const srcSeen = new Set();
  for (let i = 0; i < clOf.length; i++) {
    const c = clOf[i];
    if (c < 0 || srcSeen.has(c)) continue;
    srcSeen.add(c);
    srcOf[i] = srcCols.length;
    srcCols.push(c);
  }
  const nsrc = srcCols.length, ncol = dstCols.length;
  const valsT = new Float64Array(nsrc * ncol).fill(INF);
  const valsD = new Float64Array(nsrc * ncol).fill(INF);
  const colVert = new Int32Array(ncol * 2);
  for (let k = 0; k < ncol; k++) {
    const c = dstCols[k];
    colVert[k * 2] = G.clptr[c];
    colVert[k * 2 + 1] = G.clptr[c + 1];
  }
  const distT = OFF.jsT, distD = OFF.jsD;
  let solves = 0;
  for (let s = 0; s < nsrc; s++) {
    const c = srcCols[s];
    const lo = G.clptr[c], hi = G.clptr[c + 1];
    runSSSP(G.tIndptr, G.tIdx, G.tW, lo, hi, distT);
    runSSSP(G.dIndptr, G.dIdx, G.dW, lo, hi, distD);
    solves += 2;
    const base = s * ncol;
    for (let k = 0; k < ncol; k++) {
      const a = colVert[k * 2], b = colVert[k * 2 + 1];
      let bt = INF, bd = INF;
      for (let q = a; q < b; q++) {
        const vert = clv[q];
        const xt = distT[vert];
        if (xt < bt) bt = xt;
        const xd = distD[vert];
        if (xd < bd) bd = xd;
      }
      valsT[base + k] = bt;
      valsD[base + k] = bd;
    }
    if ((s & 15) === 15 || s === nsrc - 1) {
      postMessage({ t: 'progress', done: s + 1, total: nsrc,
        ms: r1(performance.now() - t0) });
    }
  }
  // DIAG: how many matrix cells came back finite, and are the uploaded CSR
  // arrays the same length as the files on disk?
  let finT = 0, finD = 0;
  for (let i = 0; i < valsT.length; i++) {
    if (valsT[i] < INF - 1) finT++;
    if (valsD[i] < INF - 1) finD++;
  }
  postMessage({ t: 'dbg', where: 'matrix', cells: nsrc * ncol, finT: finT,
    finD: finD, V: G.V, E: G.E, tIdxLen: G.tIdx.length, tWLen: G.tW.length,
    dIdxLen: G.dIdx.length, clvLen: G.clv.length, clptrLen: G.clptr.length });
  postMessage({ t: 'matrix', keys, cluster: Array.from(clOf),
    snap_m: snapMm, colOf: colOf, srcOf: srcOf,
    dstCols, ms: valsT.buffer, km: valsD.buffer, nsrc, ncol, solves,
    wall_ms: r1(performance.now() - t0),
    per_solve_ms: r1((performance.now() - t0) / Math.max(1, solves)),
    distinct_clusters: nsrc,
    points: all.length, requests: m.reqs.length });
}

// ------------------------------------------------------------------- route
// One Dijkstra on the time graph for a single pair, keeping prev/prevE so the
// actual road path can be drawn. This is the on-demand geometry path: the
// matrix above deliberately keeps no paths (memory), the UI only ever needs
// the path of the leg the dispatcher is looking at.
function routeCmd(m) {
  const out = [];
  const __n = (m.pairs || []).length;
  const __t0 = performance.now();
  postMessage({ t: 'dbg', where: 'routeCmd', n: __n });
  const CHUNK = 4;
  let __i = 0;
  const step = () => {
   for (let __c = 0; __c < CHUNK && __i < __n; __c++, __i++) {
   const pr = m.pairs[__i];
   try {
    const sa = snap(pr[0], pr[1], G.maxRing);
    const sb = snap(pr[2], pr[3], G.maxRing);
    if (sa.cluster < 0 || sb.cluster < 0 || sa.cluster === sb.cluster) {
      out.push({ keyA: pr[4], keyB: pr[5], pts: null, why: 'same-cluster' });
      continue;
    }
    const lo = G.clptr[sa.cluster], hi = G.clptr[sa.cluster + 1];
    if (hi <= lo) { out.push({ keyA: pr[4], keyB: pr[5], pts: null, why: 'empty' }); continue; }
    const rc = singlePath(sa.cluster, sb.cluster);
    const tlo = G.clptr[sb.cluster], thi = G.clptr[sb.cluster + 1];
    const pv = PATH.prev;
    const chain = [];
    let cur = endVert;
    let guard = 0;
    while (cur >= 0 && guard++ < 100000) { chain.push(cur); cur = pv[cur]; }
    chain.reverse();
    if (!chain.length) { out.push({ keyA: pr[4], keyB: pr[5], pts: null, why: 'unreachable' }); continue; }
    let bt = 0;
    for (let i = 1; i < chain.length; i++) {
      const e = PATH.prevE[chain[i]];
      if (e >= 0) bt += G.tW[e];
    }
    const pts = [];
    const stride = Math.max(1, Math.ceil(chain.length / 400));
    for (let k = 0; k < chain.length; k += stride) {
      pts.push(PATH.lat[chain[k]] / PNDEG, PATH.lon[chain[k]] / PNDEG);
    }
    const last = chain[chain.length - 1];
    pts.push(PATH.lat[last] / PNDEG, PATH.lon[last] / PNDEG);
    out.push({ keyA: pr[4], keyB: pr[5], pts, ms: bt, nodes: chain.length, rc });
   } catch (err) {
    out.push({ keyA: pr[4], keyB: pr[5], pts: null, why: 'throw', msg: String((err && err.stack) || err) });
   }
   }
   postMessage({ t: 'dbg', where: 'route', done: __i, n: __n,
                 ms: performance.now() - __t0, per: (performance.now() - __t0) / Math.max(1, __i) });
   if (__i < __n) { setTimeout(step, 0); return; }
   // Flatten every polyline into ONE Float32Array ([lat,lon,lat,lon,...] per leg,
   // counts in `n`) so the reply is a single small buffer instead of ~40k nested
   // arrays. Structured-cloning that shape out of a worker is unreliable.
   let total = 0;
   for (const it of out) total += it.pts ? it.pts.length : 0;
   const flat = new Float32Array(total);
   const n = new Int32Array(out.length);
   let off = 0;
   for (let i2 = 0; i2 < out.length; i2++) {
     const p2 = out[i2].pts;
     n[i2] = p2 ? p2.length >> 1 : 0;
     if (p2) { flat.set(p2, off); off += p2.length; }
   }
   for (const it of out) delete it.pts;
   postMessage({ t: 'geom', keys: out.map((i3) => [i3.keyA, i3.keyB, i3.why || '']),
                 n, flat, pairs: __n, wall_ms: performance.now() - __t0 },
               [flat.buffer]);
  };
  step();
}

self.onmessage = (ev) => {
  const m = ev.data;
  try {
    if (m.cmd === 'init') {
      // Gate everything else behind init: the front posts {init} and {solve}
      // back-to-back, and solve() dereferences the graph that init builds.
      init(m).then(() => {
        PENDING.splice(0).forEach((q) => handle(q));
      }).catch((e) => {
        postMessage({ t: 'error', where: 'init', msg: String((e && e.stack) || e) });
      });
      return;
    }
    if (!G) { PENDING.push(m); return; }
    handle(m);
  } catch (e) {
    postMessage({ t: 'error', where: m.cmd, msg: String((e && e.stack) || e) });
  }
};

function handle(m) {
  if (m.cmd === 'solve') solve(m);
  else if (m.cmd === 'route') routeCmd(m);
}
