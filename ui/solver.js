// Copyright (c) 2026 NumFast
// SPDX-License-Identifier: AGPL-3.0-only
// solver.js — S0 narrow-first insertion, ESM. Port of solver/_lib/{solver,models,priority,constraints,durations,objective}.py
// + AlgoRegistry/_lib/{contract,strategies}.py run_s0 path. Flat JSON only, no deps.
// TIME-SEMANTICS v2 via timeGates (shared/time_predicate.py single source).
// Travel layers: legs -> roadgraph-js (optional inject) -> haversine*1.3 -> uniform.
// Parity mode = legs + haversine (roadgraph-js OFF), bit-bit with Python assign(S0).
export const BASE_WEIGHTS = { accident: 100, connection: 50, repair: 20, extra_order: 20 };
export const DEFAULT_WEIGHTS = { priority: 1, window_urgency: 1, travel_time: 1, distance: 1, locality: 0.5, same_location: 0.5, route_continuity: 0.5, equipment: 0.5, new_team: 0.5 };
const SOFT_KEYS = ["priority", "window_urgency", "travel_time", "distance", "locality", "same_location", "route_continuity", "equipment", "new_team"];
const MAX_EFF = 100 * 100;
const MVP_MODES = new Set(["auto", "foot", "bike", "ot"]);
const WORK_DOCS = { connection: 70, accident: 80, extra_order: 20, repair: 30 };
const SPEEDS = { auto: 28, car: 28, scooter: 28, bike: 14, bicycle: 14, foot: 4.5, ot: 4.5 };
const PROF = { auto: "car", car: "car", scooter: "car", bike: "bike", bicycle: "bike", foot: "foot", ot: "foot" };
const MODEMAP = { "car/car": "auto", car: "auto", auto: "auto", "bike/cycle": "bike", bike: "bike", cycle: "bike", foot: "foot", ot: "ot" };

export function mm(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Math.trunc(v);
  const s = String(v).trim().split(/\s+/).pop();
  if (s.includes(":")) { const [h, m] = s.split(":"); return parseInt(h, 10) * 60 + parseInt(m, 10); }
  return Math.trunc(parseFloat(s));
}
export function normMode(v) { return MODEMAP[String(v ?? "auto").trim().toLowerCase()] ?? "auto"; }
function havKm(aLat, aLon, bLat, bLon) {
  const R = 6371, dLa = (bLat - aLat) * Math.PI / 180, dLo = (bLon - aLon) * Math.PI / 180;
  const s = Math.sin(dLa / 2) ** 2 + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function fbMinKm(a, b, mode) {
  const sp = SPEEDS[String(mode ?? "auto").trim().toLowerCase()] ?? 28;
  const km = havKm(a[0], a[1], b[0], b[1]) * 1.3;
  return [km / sp * 60, km];
}
function pyRound(x) { const n = Math.floor(x), f = x - n; if (f < 0.5) return n; if (f > 0.5) return n + 1; return n % 2 === 0 ? n : n + 1; }
export function timeGates(arrive, ws, we, dur, sh0, sh1, lo = null) {
  const L = lo === null || lo === undefined ? ws : (lo < ws ? ws : lo);
  if (arrive > we) return [null, null, "TRAVEL_INFEASIBLE"];
  const start = arrive >= L ? arrive : L;
  if (start > we) return [null, null, "window_missed"];
  const end = start + dur;
  if (start < sh0 || end > sh1) return [null, null, "overload"];
  return [start, end, null];
}
export function onsiteDuration(r) {
  const v = WORK_DOCS[r.rtype];
  if (v !== undefined) return v;
  if (r.duration !== undefined && r.duration !== null) { const n = parseInt(r.duration, 10) - 20; if (Number.isFinite(n)) return n; }
  return 30;
}
export function effPrio(r, bw = BASE_WEIGHTS) { return (bw[r.rtype] ?? 0) * parseFloat(r.prio ?? r.priority_factor ?? 1); }
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
export function softFeatures(eff, span, remain, dMin, dKm, same, nearby, cont, kitReady, needPickup, opensNew) {
  const f = {};
  f.priority = clamp01(eff / MAX_EFF);
  f.window_urgency = span > 0 ? clamp01(1 - remain / span) : 1;
  f.travel_time = clamp01(1 - dMin / 120);
  f.distance = clamp01(1 - dKm / 30);
  f.locality = nearby ? 1 : 0; f.same_location = same ? 1 : 0; f.route_continuity = cont ? 1 : 0;
  f.equipment = kitReady ? 1 : needPickup ? 0.3 : 0;
  f.new_team = opensNew ? 0 : 1;
  return f;
}
export function softScore(f, w = DEFAULT_WEIGHTS) { let s = 0; for (const k of SOFT_KEYS) s += (f[k] ?? 0) * (w[k] ?? 0); return s; }

// TypedArray travel store (numfast-js style): index ids, Int32Array minutes + Float64Array km for explicit legs.
export class TravelStore {
  constructor(travel = {}, coords = {}) {
    this.dt = parseInt(travel.default_t ?? 15, 10); this.dk = parseFloat(travel.default_km ?? 3);
    this.coords = coords; this.nFb = 0; this.nUniform = 0; this.nLeg = 0; this.unreliable = false;
    this.rg = null; // {map, mod, profileOf} optional roadgraph-js inject
    const legs = travel.legs ?? [];
    this.idx = new Map(); const ids = new Set();
    for (const l of legs) { ids.add(String(l.frm)); ids.add(String(l.to)); }
    for (const k of Object.keys(coords)) ids.add(k);
    this.ids = [...ids]; this.ids.forEach((id, i) => this.idx.set(id, i));
    const n = this.ids.length;
    // Per-mode TypedArray layers (numfast-js style): Int32 minutes (-1 = miss) + Float64 km.
    this.layers = new Map();
    const layer = m => {
      let L = this.layers.get(m);
      if (!L) { L = { t: new Int32Array(n * n).fill(-1), k: new Float64Array(n * n).fill(NaN) }; this.layers.set(m, L); }
      return L;
    };
    for (const l of legs) {
      const i = this.idx.get(String(l.frm)), j = this.idx.get(String(l.to));
      const L = layer(String(l.mode ?? "auto"));
      L.t[i * n + j] = parseInt(l.t_min ?? this.dt, 10); L.k[i * n + j] = parseFloat(l.d_km ?? this.dk);
    }
    this.n = n;
  }
  attachRoadgraph(map, mod, profileOf) { this.rg = { map, mod, profileOf }; }
  get(frm, to, mode) {
    const i = this.idx.get(frm), j = this.idx.get(to);
    if (i !== undefined && j !== undefined) {
      const L = this.layers.get(String(mode));
      if (L && L.t[i * this.n + j] >= 0) { this.nLeg++; return [L.t[i * this.n + j], L.k[i * this.n + j]]; }
      const A0 = this.layers.get("auto");
      if (A0 && A0.t[i * this.n + j] >= 0) { this.nLeg++; return [A0.t[i * this.n + j], A0.k[i * this.n + j]]; }
    }
    if (this.rg) {
      try {
        const A = this.coords[frm], B = this.coords[to];
        if (A && B) {
          const prof = (this.rg.profileOf ?? (() => "car"))(mode);
          const r = this.rg.mod.route(this.rg.map, [A[1], A[0]], [B[1], B[0]], prof);
          if (r && r.reachable && r.duration_ms != null) return [Math.round(r.duration_ms / 60000), r.distance_m / 1000];
        }
      } catch { /* fall through to haversine */ }
    }
    const A = this.coords[frm], B = this.coords[to];
    if (A && B && (A[0] !== 0 || A[1] !== 0 || B[0] !== 0 || B[1] !== 0)) {
      const [mn, km] = fbMinKm(A, B, mode);
      this.nFb++;
      return [pyRound(mn), km];
    }
    this.nUniform++; this.unreliable = true;
    return [this.dt, this.dk];
  }
}

export function toTeam(t) {
  return { id: String(t.id), region: String(t.region ?? ""), sh0: mm(t.sh0 ?? 480), sh1: mm(t.sh1 ?? 1200),
    skills: new Set(t.skills ?? []), mode: String(t.mode ?? "auto"), status: String(t.status ?? "active"),
    stock: { ...(t.stock ?? {}) }, frozen: parseInt(t.frozen ?? 0, 10),
    avail_t: t.avail_t ?? null, avail_p: t.avail_p ?? null, lat: parseFloat(t.lat ?? 0), lon: parseFloat(t.lon ?? 0) };
}
export function toReq(r) {
  let eq = r.equip ?? {};
  if (typeof eq === "number" && eq > 0) eq = { kit: eq };
  const ws = mm(r.ws ?? 600), we = mm(r.we ?? 720);
  const appear = r.appear === null || r.appear === undefined || r.appear === "" ? 420 : mm(r.appear);
  const lat = parseFloat(r.lat ?? 0), lon = parseFloat(r.lon ?? 0);
  return { id: String(r.id), region: String(r.region ?? ""), rtype: String(r.rtype ?? "repair"),
    ws, we, duration: parseInt(r.dur ?? 50, 10), skills: new Set(r.skills ?? []), equip: { ...eq },
    appear, prio: parseFloat(r.prio ?? 1), lat, lon,
    loc: `${lat.toFixed(4)},${lon.toFixed(4)}`, exec: "sent", tneed: "" };
}
const startId = t => "START:" + t.id;
function checkSkill(t, r) { for (const s of r.skills) if (!t.skills.has(s)) return "no_skill"; return null; }
function checkTransport(t, r) {
  if (r.tneed === "moto" || t.mode === "moto" || !MVP_MODES.has(t.mode)) return "no_transport";
  return null;
}
function checkStock(ts, dl, r) { for (const [k, q] of Object.entries(r.equip)) if ((ts[k] ?? 0) + (dl[k] ?? 0) < q) return "no_stock"; return null; }
function checkAll(t, r, stock, depotLeft) {
  if (!(t.region === r.region && r.region === t.region)) return "region";
  if (r.exec === "done" || r.exec === "cancelled") return "cancelled_before_start";
  if (t.status === "unavailable") return "frozen_unavailable";
  return checkSkill(t, r) ?? checkTransport(t, r) ?? checkStock(stock, depotLeft, r) ?? null;
}
export function buildSchedule(t, ordered, travel, eventTime = null) {
  const jobs = [];
  let curT = t.avail_t ?? t.sh0; if (curT < t.sh0) curT = t.sh0;
  let curP = t.avail_p ?? startId(t);
  let km = 0;
  for (const r of ordered) {
    const [tMin, dKm] = travel.get(curP, r.id, t.mode);
    const arrive = curT + tMin;
    let lo = r.ws; if (r.appear > lo) lo = r.appear; if (eventTime !== null && eventTime > lo) lo = eventTime;
    const [start, end, code] = timeGates(arrive, r.ws, r.we, onsiteDuration(r), t.sh0, t.sh1, lo);
    if (code) return null;
    jobs.push({ id: r.id, arrive, start, end, tMin, km: dKm });
    km += dKm; curT = end; curP = r.id;
  }
  return [jobs, Math.round(km * 1e6) / 1e6];
}
function diagnose(t, ordered, travel, eventTime = null) {
  let curT = t.avail_t ?? t.sh0; if (curT < t.sh0) curT = t.sh0;
  let curP = t.avail_p ?? startId(t);
  for (const r of ordered) {
    const [tMin] = travel.get(curP, r.id, t.mode);
    const arrive = curT + tMin;
    let lo = r.ws; if (r.appear > lo) lo = r.appear; if (eventTime !== null && eventTime > lo) lo = eventTime;
    const [, , code] = timeGates(arrive, r.ws, r.we, onsiteDuration(r), t.sh0, t.sh1, lo);
    if (code === "TRAVEL_INFEASIBLE" || code === "window_missed" || code === "overload") return code;
    const st = arrive > lo ? arrive : lo; curT = st + onsiteDuration(r); curP = r.id;
  }
  return "overload";
}
function consume(ts, dl, r) {
  for (const [k, q] of Object.entries(r.equip)) {
    const h = ts[k] ?? 0;
    if (h >= q) ts[k] = h - q;
    else if (h + (dl[k] ?? 0) >= q) { dl[k] = (dl[k] ?? 0) - (q - h); ts[k] = 0; }
    else return null;
  }
  return false;
}
export function bestInsertion(t, routeIds, req, byId, travel, stock, depotLeft, weights) {
  const base = buildSchedule(t, routeIds.map(id => byId[id]), travel);
  if (!base) return [null, "overload"];
  const [baseJobs, baseKm] = base;
  const pre = checkAll(t, req, stock, depotLeft);
  if (pre) return [null, pre];
  let best = null;
  for (let pos = t.frozen; pos <= routeIds.length; pos++) {
    const trial = [...routeIds.slice(0, pos), req.id, ...routeIds.slice(pos)];
    const ts = { ...stock }, dl = { ...depotLeft };
    let ok = true;
    for (const id of trial) if (consume(ts, dl, byId[id]) === null) { ok = false; break; }
    if (!ok) { if (!best) best = ["fail", "no_stock"]; continue; }
    const sched = buildSchedule(t, trial.map(id => byId[id]), travel);
    if (!sched) { if (!best) best = ["fail", diagnose(t, trial.map(id => byId[id]), travel)]; continue; }
    const [jobs, km] = sched;
    const dKm = km - baseKm;
    const eff = effPrio(req);
    let same = false;
    if (pos > 0) same = byId[routeIds[pos - 1]].loc === req.loc;
    if (!same && pos < routeIds.length) same = byId[routeIds[pos]].loc === req.loc;
    const nearby = same || dKm <= 3, cont = pos === routeIds.length;
    const span = Math.max(1, req.we - req.ws), remain = Math.max(0, req.we - jobs[pos].start);
    const feats = softFeatures(eff, span, remain, Math.max(0, jobs[jobs.length - 1].end - (baseJobs.length ? baseJobs[baseJobs.length - 1].end : t.sh0)), Math.max(0, dKm), same, nearby, cont, Object.keys(req.equip).length === 0, false, routeIds.length === 0);
    const soft = softScore(feats, weights);
    const cand = [dKm, -soft, pos, jobs, km, soft];
    if (!best || best[0] === "fail" || dKm < best[0] || (dKm === best[0] && (-soft < best[1] || (-soft === best[1] && pos < best[2])))) best = cand;
  }
  if (!best) return [null, "overload"];
  if (best[0] === "fail") return [null, best[1]];
  const [dKm, neg, pos, jobs, km, soft] = best;
  return [{ jobs, km, pos, dKm, soft }, null];
}
export function orderNarrow(pool) {
  return [...pool].sort((a, b) => ((a.we - a.ws) - (b.we - b.ws)) || (effPrio(b) - effPrio(a)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
function twoOpt(t, routeIds, byId, travel) {
  const head = routeIds.slice(0, t.frozen), tail = routeIds.slice(t.frozen);
  if (tail.length < 3) return routeIds;
  const cur = buildSchedule(t, routeIds.map(id => byId[id]), travel);
  if (!cur) return routeIds;
  let best = [...routeIds], bestKm = cur[1];
  for (let i = 0; i < tail.length; i++) for (let j = i + 1; j < tail.length; j++) {
    const cand = [...head, ...tail.slice(0, i), ...tail.slice(i, j + 1).reverse(), ...tail.slice(j + 1)];
    const s = buildSchedule(t, cand.map(id => byId[id]), travel);
    if (!s) continue;
    if (s[1] < bestKm - 1e-9) { best = cand; bestKm = s[1]; }
  }
  return best;
}
function solveCore(teams, reqs, travel, order = "narrow", weights = DEFAULT_WEIGHTS) {
  teams = [...teams].sort((a, b) => (a.id < b.id ? -1 : 1));
  const byId = Object.fromEntries(reqs.map(r => [r.id, r]));
  const pool = order === "narrow" ? orderNarrow(reqs.filter(r => r.exec !== "done" && r.exec !== "cancelled")) : [...reqs.filter(r => r.exec !== "done" && r.exec !== "cancelled")].sort((a, b) => (effPrio(b) - effPrio(a)) || (a.we - b.we) || (a.ws - b.ws) || (a.appear - b.appear) || (a.id < b.id ? -1 : 1));
  const routes = Object.fromEntries(teams.map(t => [t.id, []]));
  const initStocks = Object.fromEntries(teams.map(t => [t.id, { ...t.stock }]));
  let depotLeft = {};
  const unassigned = {}, details = {}, reasons = [];
  for (const req of pool) {
    const cands = [], obs = [];
    for (const t of teams) {
      if (t.region !== req.region || t.status !== "active") continue;
      const structOk = !checkSkill(t, req) && !checkTransport(t, req) && !checkStock(initStocks[t.id], depotLeft, req);
      const [ins, code] = bestInsertion(t, routes[t.id], req, byId, travel, initStocks[t.id], depotLeft, weights);
      if (!ins) obs.push([code, structOk]);
      else cands.push([t, ins]);
    }
    if (cands.length) {
      cands.sort((a, b) => (a[1].dKm - b[1].dKm) || (b[1].soft - a[1].soft) || (a[0].id < b[0].id ? -1 : 1) || (a[1].pos - b[1].pos));
      const [team, ins] = cands[0];
      const tmp = Object.fromEntries(teams.map(t => [t.id, { ...initStocks[t.id] }]));
      let tmpDepot = { ...depotLeft };
      // full replay in team_id order (matches Python commit path)
      for (const tid of teams.map(t => t.id).sort()) {
        const seq = tid === team.id ? [...routes[tid].slice(0, ins.pos), req.id, ...routes[tid].slice(ins.pos)] : routes[tid];
        for (const id of seq) {
          const r = byId[id], ts = tmp[tid];
          for (const [k, q] of Object.entries(r.equip)) {
            const h = ts[k] ?? 0;
            if (h >= q) ts[k] = h - q;
            else if (h + (tmpDepot[k] ?? 0) >= q) { tmpDepot[k] = (tmpDepot[k] ?? 0) - (q - h); ts[k] = 0; }
          }
        }
      }
      for (const tid of Object.keys(tmp)) initStocks[tid] = tmp[tid];
      depotLeft = tmpDepot;
      routes[team.id] = [...routes[team.id].slice(0, ins.pos), req.id, ...routes[team.id].slice(ins.pos)];
      const j = ins.jobs[ins.pos];
      reasons.push(`ASSIGN ${req.id}->${team.id} pos${ins.pos} arr${j.arrive} start${j.start} end${j.end} +${ins.dKm.toFixed(1)}km soft${ins.soft.toFixed(2)}`);
    } else {
      const timing = obs.filter(([, ok]) => ok).map(([c]) => c);
      const pick = s => obs.map(([c]) => c).includes(s) ? s : timing.includes(s) ? s : null;
      let code = "overload";
      if (obs.length) {
        const set = new Set(timing.length ? timing : obs.map(([c]) => c));
        for (const c of ["cancelled_before_start", "window_missed", "TRAVEL_INFEASIBLE", "preempted", "overload"]) if (set.has(c)) { code = c; break; }
        if (code === "overload") for (const c of ["cancelled_before_start", "no_skill", "no_transport", "no_stock", "window_missed", "TRAVEL_INFEASIBLE", "preempted", "overload"]) if (set.has(c)) { code = c; break; }
      }
      void pick;
      unassigned[req.id] = code; details[req.id] = `${req.id} ${code}`;
      reasons.push(`UNASSIGNED ${req.id} ${code}`);
    }
  }
  for (const t of teams) routes[t.id] = twoOpt(t, routes[t.id], byId, travel);
  const planRoutes = {};
  for (const t of teams) {
    const s = buildSchedule(t, routes[t.id].map(id => byId[id]), travel);
    planRoutes[t.id] = s ? s[0] : [];
  }
  let done = 0, used = 0, km = 0;
  for (const t of teams) { const j = planRoutes[t.id]; done += j.length; if (j.length) used++; for (const x of j) km += x.km; }
  return { routes: planRoutes, unassigned, details, reasons, done, used, km: Math.round(km * 1e6) / 1e6 };
}
export function countViolations(teams, byId, planRoutes, travel) {
  let v = 0;
  for (const t of teams) {
    const ids = planRoutes[t.id] ?? [];
    if (ids.length && !buildSchedule(t, ids.map(id => byId[id]), travel)) v++;
  }
  return v;
}
export function assign(requests, teams, travel, config = {}) {
  const t0 = performance.now();
  const sid = config.strategy ?? "S0";
  if (sid !== "S0") throw new Error("browser engine beta: only S0 (requested " + sid + ")");
  const T = teams.map(toTeam), R = requests.map(toReq);
  const coords = {};
  for (const t of T) coords["START:" + t.id] = [t.lat, t.lon];
  for (const r of R) coords[r.id] = [r.lat, r.lon];
  const store = new TravelStore(travel, coords);
  if (config._rg) store.attachRoadgraph(config._rg.map, config._rg.mod, config._rg.profileOf);
  const plan = solveCore(T, R, store, "narrow");
  const byId = Object.fromEntries(R.map(r => [r.id, r]));
  const assigns = [];
  for (const t of T) for (const j of plan.routes[t.id] ?? []) assigns.push({ request_id: j.id, team_id: t.id, arrive: j.arrive, start: j.start, end: j.end });
  assigns.sort((a, b) => (a.team_id < b.team_id ? -1 : 1) || (a.start - b.start) || (a.request_id < b.request_id ? -1 : 1));
  return { strategy: "S0", assignments: assigns, done: plan.done, rejected: { ...plan.unassigned }, reasons: { ...plan.details },
    teams_used: plan.used, km: Math.round(plan.km * 1000) / 1000, wall_ms: Math.round((performance.now() - t0) * 10) / 10,
    violations: countViolations(T, byId, Object.fromEntries(T.map(t => [t.id, (plan.routes[t.id] ?? []).map(j => j.id)])), store),
    teams: teams.map(t => t.id), _travelFb: store.nFb, _travelLeg: store.nLeg, _travelUniform: store.nUniform, _unreliable: store.unreliable };
}
export function debugSolve(requests, teams, travel) {
  const T = teams.map(toTeam), R = requests.map(toReq);
  const coords = {};
  for (const t of T) coords["START:" + t.id] = [t.lat, t.lon];
  for (const r of R) coords[r.id] = [r.lat, r.lon];
  const store = new TravelStore(travel, coords);
  const plan = solveCore(T, R, store, "narrow");
  return { routes: Object.fromEntries(Object.entries(plan.routes).map(([k, v]) => [k, v.map(j => j.id)])), reasons: plan.reasons, unassigned: plan.unassigned };
}
export const listStrategies = () => [{ id: "S0", title: "production narrow-first (browser beta)", src: "solver.solve narrow (we-ws),-prio,id" }];
