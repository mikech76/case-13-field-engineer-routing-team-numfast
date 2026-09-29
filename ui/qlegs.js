// Copyright (c) 2026 NumFast
// SPDX-License-Identifier: AGPL-3.0-only
// qlegs.js — BROWSER-ONLY quant legs (ESM, no deps).
// Static pack ui/q/: mat_offsets/exit (ClusterBuild matrices) + mat_q_car/foot
// (QuantFull s1000/r3600) + snap_lon/lat/clu + ports_from/to + tracks.json
// (baked port-polylines, build-time roadgraph-js batch on moscow CSR).
// Browser NEVER loads CSR (*.bin full 332MB / moscow 24MB) and NEVER routes:
// times = batch Q-lookup over quant bins (ms); geometry = baked tracks only.
// Miss legs (no baked track) get NO line — badge only (distant schematic
// straights banned). Home connectors = pedestrian dashed home<->port
// (drawn by app.js refresh for real legs; track ends ARE snapped ports).
const Q_NONE = 0xFFFF;
let Q = null;

async function getBin(base, name, Type) {
  const r = await fetch(base + '/' + name);
  if (!r.ok) throw new Error('q/' + name + ' ' + r.status);
  const buf = await r.arrayBuffer();
  return new Type(buf);
}

export async function loadQuant(base) {
  base = base || 'q';
  const t0 = performance.now();
  const meta = await (await fetch(base + '/meta.json')).json();
  const [off64, exit, qcar, qfoot, lon, lat, clu, pfrom, pto] = await Promise.all([
    getBin(base, 'mat_offsets.bin', BigInt64Array),
    getBin(base, 'mat_exit.bin', Int32Array),
    getBin(base, 'mat_q_car.bin', Uint16Array),
    getBin(base, 'mat_q_foot.bin', Uint16Array),
    getBin(base, 'snap_lon.bin', Int32Array),
    getBin(base, 'snap_lat.bin', Int32Array),
    getBin(base, 'snap_clu.bin', Int32Array),
    getBin(base, 'ports_from.bin', Int32Array),
    getBin(base, 'ports_to.bin', Int32Array),
  ]);
  const off = new Int32Array(off64.length);
  for (let i = 0; i < off64.length; i++) off[i] = Number(off64[i]);
  let tracks = { legs: {}, miss: [] };
  try { tracks = await (await fetch(base + '/tracks.json')).json(); } catch (_) {}
  // UI-FULLQ: hybrid south addition (q_south/tracks_south.json, 22 real
  // full-CSR tracks for Kashira/south legs outside moscow pack). Merged
  // into legs + byPair; miss lists concatenated.
  try {
    const south = await (await fetch('q_south/tracks_south.json')).json();
    const slegs = (south && south.legs) || {};
    tracks.legs = Object.assign({}, tracks.legs, slegs);
    tracks.miss = (tracks.miss || []).concat(south.miss || []);
    tracks.south_n = Object.keys(slegs).length;
  } catch (_) { tracks.south_n = 0; }
  // BAKE-LIVE-TRACKS: live-plan addition (tracks_live.json, 45 real
  // full-CSR tracks for S0/seed42/default_100 pairs missing from base+south).
  // Separate file with version/seed; merged into legs + byPair.
  try {
    const live = await (await fetch(base + '/tracks_live.json')).json();
    const llegs = (live && live.legs) || {};
    tracks.legs = Object.assign({}, tracks.legs, llegs);
    tracks.miss = (tracks.miss || []).concat(live.miss || []);
    tracks.live_n = Object.keys(llegs).length;
  } catch (_) { tracks.live_n = 0; }
  Q = { meta, off, exit, qcar, qfoot, lon, lat, clu, pfrom, pto, tracks,
    n: lon.length, load_ms: Math.round((performance.now() - t0) * 10) / 10 };
  // UI-TRACKS: pair index frm|to -> track (plan-independent port lookup).
  // Legacy key TEAM|REQ baked for one plan; live S0 plan reassigns reqs,
  // so direct key misses. Pair lookup survives reassignment.
  Q.byPair = {};
  try {
    for (const v of Object.values(Q.tracks.legs || {})) {
      if (v && v.frm && v.to) Q.byPair[v.frm + '|' + v.to] = v;
    }
  } catch (_) {}
  return Q;
}

export function quant() { return Q; }

// Brute-force nearest node over int32 deg*1e7 snap bins. 701k iterations,
// pure int arithmetic — single snap ~2-5ms, visible-team batch stays in ms.
export function snap(lon, lat) {
  const qx = Math.round(lon * 1e7), qy = Math.round(lat * 1e7);
  const { lon: LON, lat: LAT, clu: CLU, n } = Q;
  let best = -1, bd = Infinity;
  for (let i = 0; i < n; i++) {
    const dx = LON[i] - qx, dy = LAT[i] - qy;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  return { node: best, clu: best >= 0 ? CLU[best] : -1,
    d_m: Math.round(Math.sqrt(bd) / 1e7 * 111320) };
}

// Q-lookup: row cid, column exitNode -> dequant ms (q*step) or null.
// step=1000ms (s1000), 0xFFFF = INF/unreachable/out-of-radius.
export function qget(cid, exitNode, prof) {
  const arr = prof === 'foot' ? Q.qfoot : Q.qcar;
  const a = Q.off[cid], b = Q.off[cid + 1];
  for (let i = a; i < b; i++) {
    if (Q.exit[i] === exitNode) {
      const q = arr[i];
      return q === Q_NONE ? null : q * Q.meta.step_ms;
    }
  }
  return null;
}

// UI-TRACKS: port-pair lookup (directed; reverse fallback with flipped pts).
export function trackByPair(frm, to) {
  if (!Q || !Q.byPair || frm == null || to == null) return null;
  const f = Q.byPair[frm + '|' + to];
  if (f) return f;
  const r = Q.byPair[to + '|' + frm];
  if (r && Array.isArray(r.pts) && r.pts.length > 1)
    return { pts: r.pts.slice().reverse(), src: (r.src || 'q-track') + '-rev',
      frm, to, dur_ms: r.dur_ms != null ? r.dur_ms : null };
  return null;
}

// Batch over visible-team legs. Per leg: snap A/B + direct Q key probe
// (ca -> snapped-B-node as exit, hit only when B is a port of ca's row).
// time source: baked exact track dur_ms (build-time route) else plan minutes.
// Plan (done/assign) untouched — parity by construction.
export function batchLegs(legs) {
  const t0 = performance.now();
  const out = [];
  for (const l of legs) {
    const sa = snap(l.alon, l.alat), sb = snap(l.blon, l.blat);
    const qExact = sa.clu >= 0 ? qget(sa.clu, sb.node, l.prof) : null;
    // UI-TRACKS: legacy plan key first, then port-pair (survives reassignment).
    const tr = Q.tracks.legs[l.key]
      || ((l.frm && l.to) ? trackByPair(l.frm, l.to) : null);
    out.push({ key: l.key, snapA: sa, snapB: sb, qExact_ms: qExact,
      qHit: qExact !== null,
      portA: sa.node >= 0 ? [Q.lon[sa.node] / 1e7, Q.lat[sa.node] / 1e7] : null,
      portB: sb.node >= 0 ? [Q.lon[sb.node] / 1e7, Q.lat[sb.node] / 1e7] : null,
      timeMin: tr && tr.dur_ms != null ? Math.round(tr.dur_ms / 600) / 100 : l.planMin,
      timeSrc: tr && tr.dur_ms != null ? 'q-track' : 'plan',
      track: tr || null });
  }
  return { legs: out, ms: Math.round((performance.now() - t0) * 10) / 10 };
}
