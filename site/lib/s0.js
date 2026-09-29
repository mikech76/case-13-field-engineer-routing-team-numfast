// Copyright (c) 2026 NumFast
// SPDX-License-Identifier: AGPL-3.0-only
// s0.js — port of the production S0 dispatcher ("narrow-first") to JS.
// Runs in the browser with zero dependencies. No RNG: the production path is
// deterministic (solver/_lib/solver.py, solver/_lib/priority.py,
// solver/_lib/constraints.py, solver/_lib/durations.py,
// solver/_lib/objective.py, shared/time_predicate.py).
//
// Fidelity rules carried over from the Python (do not "simplify"):
//   * pool order = (we-ws asc, -effectivePriority asc, id asc)  -- strategies.py:18-21
//   * position choice = strict < on (delta_km, -soft, pos)       -- solver.py:207-213
//   * soft score accumulated left-to-right in SOFT_KEYS order    -- priority.py:13-16
//   * time gate order: arrival -> window -> shift                 -- time_predicate.py:20-33
//   * `we` never caps the end; only shift_end does
//   * service time comes from the WORK_DOCS table, not from req.dur
//   * equipment shortfall `break`s WITHOUT rollback                -- solver.py:342-358
//   * preemption leaves stocks stale on purpose                    -- solver.py:398-468
//   * round() is half-even; Math.round is half-up                 -- contract.py:124
//   * integer-like object keys reorder in JS: use Map, never {}
//
// Travel provider interface (the front injects the portal-graph SSSP result):
//   travel.get(fromKey, toKey, mode) -> { t: minutes, km: kilometres }
// where fromKey is a request id or "START:<teamId>".

export const BASE_WEIGHTS = {
  accident: 100.0, connection: 50.0, repair: 20.0, extra_order: 20.0,
};
export const MAX_EFF = 10000.0;

// solver/_lib/durations.py:17-22 — onsite minutes by request type.
export const WORK_DOCS = {
  connection: 70, accident: 80, extra_order: 20, repair: 30,
};

const DEFAULT_WEIGHTS = {
  priority: 1.0, window_urgency: 1.0, travel_time: 1.0, distance: 1.0,
  locality: 0.5, same_location: 0.5, route_continuity: 0.5,
  equipment: 0.5, new_team: 0.5,
};
const SOFT_KEYS = ['priority', 'window_urgency', 'travel_time', 'distance',
  'locality', 'same_location', 'route_continuity', 'equipment', 'new_team'];

const REASON_ORDER = ['cancelled_before_start', 'no_skill', 'no_transport',
  'no_stock', 'window_missed', 'UNREACHABLE', 'TRAVEL_INFEASIBLE', 'preempted', 'overload'];
const REASON_PRIORITY = ['cancelled_before_start', 'window_missed',
  'TRAVEL_INFEASIBLE', 'preempted', 'overload'];

// ---------------------------------------------------------------- utilities

// Python's round() on a float is round-half-to-even; Math.round is half-up.
// Travel minutes are fractional, so a .5 boundary is reachable.
export function roundHalfEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return (f % 2 === 0) ? f : f + 1;
}

export function roundTo(x, nd) {
  const p = Math.pow(10, nd);
  return roundHalfEven(x * p) / p;
}

const clamp01 = (x) => (x < 0 ? 0.0 : (x > 1 ? 1.0 : x));

// models.py:61-62 — f"{lat:.4f},{lon:.4f}". The -0.0 case is load-bearing:
// Python prints "-0.0000" and JS toFixed prints "0.0000", which would break
// the same-location test and shift the soft score by 1.0.
export function locKey(lat, lon) {
  return fmt4(lat) + ',' + fmt4(lon);
}
function fmt4(v) {
  if (Object.is(v, -0)) v = 0;
  return v.toFixed(4);
}

// ------------------------------------------------------------------ request

export function makeRequest(j) {
  const ws = j.ws == null ? 600 : j.ws;
  const we = j.we == null ? 720 : j.we;
  const lat = j.lat || 0.0;
  const lon = j.lon || 0.0;
  const equip = new Map();
  if (typeof j.equip === 'number' && j.equip > 0) {
    equip.set('kit', j.equip);            // contract.py:153-154
  } else if (j.equip && typeof j.equip === 'object') {
    for (const k of Object.keys(j.equip)) equip.set(k, j.equip[k]);
  }
  return {
    request_id: String(j.id),
    region_id: j.region == null ? '' : String(j.region),
    window_start: ws,
    window_end: we,
    duration: j.dur == null ? 50 : Math.trunc(j.dur),
    skills: new Set((j.skills || []).map(String)),
    equipment_requirements: equip,
    appearance_time: j.appear == null ? 420 : j.appear,
    priority_factor: j.prio == null ? 1.0 : Number(j.prio),
    rtype: String(j.rtype || 'repair'),
    lat, lon,
    loc_key: locKey(lat, lon),
    exec_status: j.status || '',
  };
}

export function makeTeam(j) {
  return {
    team_id: String(j.id),
    region_id: j.region == null ? '' : String(j.region),
    skills: new Set((j.skills || []).map(String)),
    transport_mode: String(j.mode || 'auto'),
    status: String(j.status || 'active'),
    shift_start: j.sh0 == null ? 480 : j.sh0,
    shift_end: j.sh1 == null ? 1200 : j.sh1,
    inventory: new Map(Object.entries(j.stock || {})),
    frozen_prefix: j.frozen == null ? 0 : Math.trunc(j.frozen),
    avail_time: (j.avail_t == null) ? null : j.avail_t,
    avail_point: (j.avail_p == null) ? null : String(j.avail_p),
    start_lat: j.lat || 0.0,
    start_lon: j.lon || 0.0,
  };
}

// Set by buildSchedule when a pair has no bridge in any graph; consumed by the
// reject-code arbitration so the funnel says UNREACHABLE, not a fake reason.
let NO_TRAVEL = null;

// durations.py:38-50 — the input `duration` is deliberately NOT the service
// time; the norm table is.
export function onsiteDuration(req) {
  const d = WORK_DOCS[req.rtype];
  if (d !== undefined) return d;
  return req.duration > 20 ? req.duration - 20 : 30;
}

// priority.py:25-27
export function effectivePriority(req, bw) {
  const w = (bw || BASE_WEIGHTS)[req.rtype];
  return (w === undefined ? 0.0 : w) * req.priority_factor;
}

// shared/time_predicate.py:20-33
export function timeGates(arrive, ws, we, dur, sh0, sh1, loIn) {
  const lo = (loIn < ws) ? ws : loIn;
  if (arrive > we) return null;                 // TRAVEL_INFEASIBLE
  const start = (arrive >= lo) ? arrive : lo;
  if (start > we) return null;                  // window_missed
  const end = start + dur;
  if (start < sh0 || end > sh1) return null;    // overload
  return { start, end };
}

// solver.py:98-103 — mirrors the gate order of timeGates.
function diagnoseScheduleFailure(team, trial, byId, travel) {
  let cur_t = team.avail_time != null ? team.avail_time : team.shift_start;
  if (cur_t < team.shift_start) cur_t = team.shift_start;
  let cur_p = team.avail_point != null ? team.avail_point : 'START:' + team.team_id;
  for (const rid of trial) {
    const r = byId.get(rid);
    let t = travel.get(cur_p, rid, team.transport_mode, cur_t);
    if (!t) return 'UNREACHABLE';
    t = travel.applyTraffic(t, cur_t);
    const arrive = cur_t + t.t;
    const lo = Math.max(r.window_start, r.appearance_time);
    if (arrive > r.window_end) return 'TRAVEL_INFEASIBLE';
    const start = arrive >= lo ? arrive : lo;
    if (start > r.window_end) return 'window_missed';
    const end = start + onsiteDuration(r);
    if (start < team.shift_start || end > team.shift_end) return 'overload';
    cur_t = end; cur_p = rid;
  }
  return 'overload';
}

// constraints.py:97-109 — ordered if-chain. Returns a code or null.
function checkAll(team, req, teamStock) {
  if (team.region_id !== req.region_id) return 'no_skill';
  if (req.exec_status === 'done' || req.exec_status === 'cancelled') {
    return 'cancelled_before_start';
  }
  if (team.frozen_prefix > 0 && false) return 'frozen_unavailable';
  for (const s of req.skills) if (!team.skills.has(s)) return 'no_skill';
  if (team.status !== 'active') return 'no_transport';
  const st = teamStock || team.inventory;
  for (const [k, q] of req.equipment_requirements) {
    if ((st.get(k) || 0) < q) return 'no_stock';
  }
  return null;
}

// solver.py:108-122
function consume(stock, depot, req) {
  for (const [etype, qty] of req.equipment_requirements) {
    const have = stock.get(etype) || 0;
    if (have >= qty) stock.set(etype, have - qty);
    else if (have + (depot.get(etype) || 0) >= qty) {
      depot.set(etype, (depot.get(etype) || 0) - (qty - have));
      stock.set(etype, 0);
    } else return false;
  }
  return true;
}

// solver.py:43-71
function buildSchedule(team, ordered, byId, travel) {
  let cur_t = (team.avail_time != null) ? team.avail_time : team.shift_start;
  let cur_p = (team.avail_point != null) ? team.avail_point
    : 'START:' + team.team_id;
  if (cur_t < team.shift_start) cur_t = team.shift_start;
  const jobs = [];
  let mileage = 0.0;
  for (const rid of ordered) {
    const r = byId.get(rid);
    let leg = travel.get(cur_p, rid, team.transport_mode, cur_t);
    // No bridge in ANY graph: refuse instead of inventing a time. Flagged so
    // the reject funnel reports UNREACHABLE (CONDITIONS_SPEC §2.3) instead of
    // a made-up TRAVEL_INFEASIBLE.
    if (!leg) { NO_TRAVEL = rid; return null; }
    leg = travel.applyTraffic(leg, cur_t);
    const arrive = cur_t + leg.t;
    const lo = Math.max(r.window_start, r.appearance_time);
    const g = timeGates(arrive, r.window_start, r.window_end,
      onsiteDuration(r), team.shift_start, team.shift_end, lo);
    if (g === null) return null;
    jobs.push({ request_id: rid, arrive, start: g.start, end: g.end,
      t_min: leg.t, d_km: leg.km, k: leg.k || 1, leg_src: leg.src || 'portal' });
    mileage += leg.km;
    cur_t = g.end;
    cur_p = rid;
  }
  return { jobs, km: roundTo(mileage, 6) };
}

// priority.py:38-69
function softScore(req, pos, routeIds, jobs, deltaKm, deltaMin, byId) {
  const n = routeIds.length;
  const f = {};
  f.priority = clamp01(effectivePriority(req) / MAX_EFF);
  const windowSpan = Math.max(1, req.window_end - req.window_start);
  const remain = Math.max(0, req.window_end - jobs[pos].start);
  f.window_urgency = windowSpan > 0 ? clamp01(1.0 - remain / windowSpan) : 1.0;
  f.travel_time = clamp01(1.0 - Math.max(0, deltaMin) / 120.0);
  f.distance = clamp01(1.0 - Math.max(0, deltaKm) / 30.0);
  const same = (pos > 0 && byId.get(routeIds[pos - 1]).loc_key === req.loc_key)
    || (pos < n && byId.get(routeIds[pos]).loc_key === req.loc_key);
  const nearby = same || deltaKm <= 3.0;
  f.locality = nearby ? 1.0 : 0.0;
  f.same_location = same ? 1.0 : 0.0;
  f.route_continuity = (pos === n) ? 1.0 : 0.0;
  f.equipment = (req.equipment_requirements.size === 0) ? 1.0 : 0.0;
  f.new_team = (n === 0) ? 0.0 : 1.0;
  let s = 0.0;
  for (const k of SOFT_KEYS) s += f[k] * DEFAULT_WEIGHTS[k];
  return s;
}

// solver.py:150-220
function bestInsertion(team, routeIds, req, byId, travel, teamStock, depot) {
  const base = buildSchedule(team, routeIds, byId, travel);
  if (base === null) return { ins: null, code: 'overload' };
  const baseKm = base.km;
  const baseEnd = base.jobs.length ? base.jobs[base.jobs.length - 1].end
    : team.shift_start;

  const pre = checkAll(team, req, teamStock);
  if (pre !== null) return { ins: null, code: pre };

  let best = null;
  let failMarker = null;
  const n = routeIds.length;
  for (let pos = team.frozen_prefix; pos <= n; pos++) {
    const trial = routeIds.slice(0, pos).concat([req.request_id],
      routeIds.slice(pos));
    const ts = new Map(teamStock);
    const dl = new Map(depot);
    let ok = true;
    for (const rid of trial) {
      if (!consume(ts, dl, byId.get(rid))) { ok = false; break; }
    }
    if (!ok) { if (best === null) failMarker = 'no_stock'; continue; }
    const sched = buildSchedule(team, trial, byId, travel);
    if (sched === null) {
      if (best === null) {
        failMarker = diagnoseScheduleFailure(team, trial, byId, travel);
      }
      continue;
    }
    const deltaKm = sched.km - baseKm;
    const deltaMin = sched.jobs[sched.jobs.length - 1].end - baseEnd;
    const soft = softScore(req, pos, routeIds, sched.jobs, deltaKm, deltaMin, byId);
    if (best === null || (deltaKm < best.deltaKm)
      || (deltaKm === best.deltaKm && -soft < -best.soft)
      || (deltaKm === best.deltaKm && soft === best.soft && pos < best.pos)) {
      best = { jobs: sched.jobs, km: sched.km, pos, deltaKm, deltaMin, soft };
    }
  }
  if (best === null) return { ins: null, code: failMarker || 'overload' };
  return { ins: best, code: null };
}

// solver.py:237-252
function primaryReason(pairs) {
  const timing = new Set();
  const all = new Set();
  for (const [code, ok] of pairs) {
    all.add(code);
    if (ok) timing.add(code);
  }
  if (timing.size > 0) {
    for (const c of REASON_PRIORITY) if (timing.has(c)) return c;
    for (const c of REASON_ORDER) if (timing.has(c)) return c;
    return 'overload';
  }
  for (const c of REASON_ORDER) if (all.has(c)) return c;
  if (all.has('window_early')) return 'window_missed';
  return 'overload';
}

// solver.py:255-275
function twoOpt(team, routeIds, byId, travel) {
  const frozen = team.frozen_prefix;
  const head = routeIds.slice(0, frozen);
  const tail = routeIds.slice(frozen);
  if (tail.length < 3) return routeIds;
  const cur = buildSchedule(team, routeIds, byId, travel);
  if (cur === null) return routeIds;
  let best = routeIds.slice();
  let bestKm = cur.km;
  for (let i = 0; i < tail.length; i++) {
    for (let j = i + 1; j < tail.length; j++) {
      const seg = tail.slice(i, j + 1).reverse();
      const cand = head.concat(tail.slice(0, i), seg, tail.slice(j + 1));
      const s = buildSchedule(team, cand, byId, travel);
      if (s === null) continue;
      if (s.km < bestKm - 1e-9) { best = cand; bestKm = s.km; }
    }
  }
  return best;
}

// --------------------------------------------------------------- the solver

// strategies.py:18-21
function narrowOrder(a, b) {
  const wa = a.window_end - a.window_start;
  const wb = b.window_end - b.window_start;
  if (wa !== wb) return wa - wb;
  const pa = -effectivePriority(a, BASE_WEIGHTS);
  const pb = -effectivePriority(b, BASE_WEIGHTS);
  if (pa !== pb) return pa - pb;
  return a.request_id < b.request_id ? -1 : (a.request_id > b.request_id ? 1 : 0);
}

// solver.py:278-395
export function solve(requestsIn, teamsIn, travel, opts) {
  const o = opts || {};
  const preempt = o.preempt !== false;
  const stats = { sssp: 0, insert: 0, twoopt: 0, stock: 0 };
  const t0 = now();

  const byId = new Map();
  for (const r of requestsIn) byId.set(r.request_id, r);
  const teams = teamsIn.slice().sort((a, b) =>
    a.team_id < b.team_id ? -1 : (a.team_id > b.team_id ? 1 : 0));
  const pool = requestsIn.filter(
    (r) => r.exec_status !== 'done' && r.exec_status !== 'cancelled')
    .slice().sort(narrowOrder);

  const routes = new Map();
  const pristine = new Map();
  for (const t of teams) { routes.set(t.team_id, []); pristine.set(t.team_id, new Map(t.inventory)); }
  let stocks = new Map();
  for (const t of teams) stocks.set(t.team_id, new Map(t.inventory));
  const depotLeft = new Map();
  const unassigned = new Map();
  const details = new Map();
  const teamById = new Map(teams.map((t) => [t.team_id, t]));

  for (const req of pool) {
    const cands = [];
    const observed = [];
    for (const team of teams) {
      if (team.region_id !== req.region_id) continue;
      if (team.status !== 'active') continue;
      const st = stocks.get(team.team_id);
      const structOk = checkAll(team, req, st) === null;
      const r = bestInsertion(team, routes.get(team.team_id), req, byId, travel,
        st, depotLeft);
      if (r.ins === null) observed.push([r.code, structOk]);
      else cands.push([team, r.ins]);
    }
    if (cands.length > 0) {
      cands.sort((x, y) => (x[1].deltaKm - y[1].deltaKm)
        || (y[1].soft - x[1].soft)
        || cmpStr(x[0].team_id, y[0].team_id) || (x[1].pos - y[1].pos));
      const [team, ins] = cands[0];
      const trial = routes.get(team.team_id).slice(0, ins.pos)
        .concat([req.request_id], routes.get(team.team_id).slice(ins.pos));
      const tid = Array.from(routes.keys()).sort(cmpStr);
      const tmp = new Map();
      const tmpDepot = new Map();
      for (const t2 of tid) tmp.set(t2, new Map(pristine.get(t2)));
      for (const t2 of tid) {
        const seq = (t2 === team.team_id) ? trial : routes.get(t2);
        const cur = tmp.get(t2);
        for (const rid of seq) {
          let good = true;
          for (const [etype, qty] of byId.get(rid).equipment_requirements) {
            const have = cur.get(etype) || 0;
            if (have >= qty) cur.set(etype, have - qty);
            else if (have + (tmpDepot.get(etype) || 0) >= qty) {
              tmpDepot.set(etype, (tmpDepot.get(etype) || 0) - (qty - have));
              cur.set(etype, 0);
            } else { good = false; break; }
          }
          if (!good) break;                     // no rollback, on purpose
        }
      }
      stocks = tmp;
      depotLeft.clear();
      for (const [k, v] of tmpDepot) depotLeft.set(k, v);
      routes.set(team.team_id, trial);
    } else {
      if (preempt && req.rtype === 'accident') {
        if (tryPreempt(req, teams, routes, stocks, byId, travel, depotLeft,
          unassigned)) continue;
      }
      const code = primaryReason(observed);
      unassigned.set(req.request_id, code);
      details.set(req.request_id, req.request_id + ' ' + code);
    }
  }

  const ts = now();
  stats.insert = ts - t0;
  for (const t of teams) {
    routes.set(t.team_id, twoOpt(t, routes.get(t.team_id), byId, travel));
  }
  const t1 = now();
  stats.twoopt = t1 - ts;

  const assignments = [];
  const order = teams.map((t) => t.team_id).sort(cmpStr);
  let done = 0;
  let mileage = 0.0;
  let nteams = 0;
  const perTeam = new Map();
  for (const tid of order) {
    const t = teamById.get(tid);
    const ids = routes.get(tid);
    if (ids.length === 0) continue;
    const sch = buildSchedule(t, ids, byId, travel);
    if (sch === null) continue;
    nteams += 1;
    done += sch.jobs.length;
    perTeam.set(tid, sch.jobs);
    for (const j of sch.jobs) {
      assignments.push({ request_id: j.request_id, team_id: tid,
        arrive: j.arrive, start: j.start, end: j.end,
        t_min: j.t_min, d_km: roundTo(j.d_km, 3) });
      mileage += j.d_km;
    }
  }
  assignments.sort((a, b) => cmpStr(a.team_id, b.team_id)
    || (a.start - b.start) || cmpStr(a.request_id, b.request_id));

  // contract.py:182-197 — re-simulate without event_time, count nulls.
  let violations = 0;
  for (const tid of order) {
    if (!perTeam.has(tid)) continue;
    if (buildSchedule(teamById.get(tid), perTeam.get(tid).map((j) => j.request_id),
      byId, travel) === null) violations += 1;
  }

  const rejected = {};
  const reasons = {};
  for (const k of unassigned.keys()) rejected[k] = unassigned.get(k);
  for (const k of details.keys()) reasons[k] = details.get(k);
  stats.total = now() - t0;
  return {
    strategy: 'S0',
    assignments,
    perTeam,
    done, teams_used: nteams, km: roundTo(mileage, 3),
    rejected, reasons, violations,
    wall_ms: Math.round(stats.total * 100) / 100,
    stage_ms: { insert: Math.round(stats.insert * 100) / 100,
      twoopt: Math.round(stats.twoopt * 100) / 100 },
  };
}

// solver.py:398-468
function tryPreempt(req, teams, routes, stocks, byId, travel, depotLeft, unassigned) {
  const reqEff = effectivePriority(req, BASE_WEIGHTS);
  const victims = [];
  for (const team of teams) {
    const r = routes.get(team.team_id);
    for (let idx = team.frozen_prefix; idx < r.length; idx++) {
      const v = byId.get(r[idx]);
      if (v.rtype === 'accident') continue;
      const eff = effectivePriority(v, BASE_WEIGHTS);
      if (eff < reqEff) victims.push([eff, team.team_id, idx, v.request_id]);
    }
  }
  if (victims.length === 0) return false;
  victims.sort((a, b) => (a[0] - b[0]) || cmpStr(a[1], b[1])
    || (a[2] - b[2]) || cmpStr(a[3], b[3]));
  const teamById = new Map(teams.map((t) => [t.team_id, t]));
  const order = teams.map((t) => t.team_id).sort(cmpStr);
  const snapshot = new Map();
  for (const t of teams) snapshot.set(t.team_id, routes.get(t.team_id).slice());

  for (const [eff, tid, idx, rid] of victims) {
    const trial = new Map();
    for (const k of snapshot.keys()) trial.set(k, snapshot.get(k).slice());
    trial.get(tid).splice(idx, 1);
    const tmpDepot = new Map(depotLeft);
    const cands = [];
    for (const team of teams) {
      if (team.region_id !== req.region_id || team.status !== 'active') continue;
      const r = bestInsertion(team, trial.get(team.team_id), req, byId, travel,
        new Map(stocks.get(team.team_id)), tmpDepot);
      if (r.ins) cands.push([team, r.ins]);
    }
    if (cands.length === 0) continue;
    cands.sort((x, y) => (x[1].deltaKm - y[1].deltaKm)
      || (y[1].soft - x[1].soft) || cmpStr(x[0].team_id, y[0].team_id)
      || (x[1].pos - y[1].pos));
    const [team, ins] = cands[0];
    const cur = trial.get(team.team_id);
    trial.set(team.team_id, cur.slice(0, ins.pos).concat([req.request_id], cur.slice(ins.pos)));
    const rcands = [];
    for (const team2 of teams) {
      if (team2.region_id !== req.region_id || team2.status !== 'active') continue;
      const r = bestInsertion(team2, trial.get(team2.team_id), byId.get(rid),
        byId, travel, new Map(stocks.get(team2.team_id)), tmpDepot);
      if (r.ins) rcands.push([team2, r.ins]);
    }
    if (rcands.length > 0) {
      rcands.sort((x, y) => (x[1].deltaKm - y[1].deltaKm)
        || (y[1].soft - x[1].soft) || cmpStr(x[0].team_id, y[0].team_id)
        || (x[1].pos - y[1].pos));
      const [t2, ins2] = rcands[0];
      const c2 = trial.get(t2.team_id);
      trial.set(t2.team_id, c2.slice(0, ins2.pos).concat([rid], c2.slice(ins2.pos)));
    } else {
      unassigned.set(rid, 'preempted');
    }
    for (const k of trial.keys()) routes.set(k, trial.get(k));
    return true;   // stocks deliberately left stale, as in solver.py
  }
  return false;
}

function cmpStr(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }
function now() {
  return (typeof performance !== 'undefined' ? performance.now() : Date.now());
}

// ------------------------------------------------- travel over the portal graph

// One SSSP per distinct SOURCE cluster yields the time to every other cluster,
// THREE TIERS, ALL HONESTLY COUNTED. contract.py tier 4 silently returned
// (15 min, 3.0 km) and the registry never surfaced the flag, so a plan could be
// decided on invented numbers with no trace. Here every pair is attributed to
//   exact  - offline full-CFD Dijkstra baked into assets/map/exact.json
//   portal - in-browser SSSP over the quantised portal graph
//   approx - NEITHER bridged the pair -> NO fabricated time: get() returns
//            null, the pair is counted and surfaced in the UI as
//            "оценено приблизительно" (Q49: mark what did not fit).
// The traffic multiplier is a SEPARATE slot (loadTraffic) so build_schedule
// stays bit-exact with production when it is off, and a real per-edge raster
// can be dropped in later without touching the solver.
export function makePortalTravel(map, clusterOfKey, opts) {
  const o = opts || {};
  const cache = new Map();
  const ex = o.exact || null;
  const tr = o.traffic || null;
  const stat = { pairs: 0, exact: 0, portal: 0, approx: 0 };
  const approxPairs = [];
  const INF = 0xffffffff;
  return {
    stat,
    approxPairs,
    traffic: tr,
    // dist_ms / dist_m are Uint32Arrays indexed by cluster, filled by the router.
    register(key, cluster, distMs, distM) {
      cache.set(key, { c: cluster, t: distMs, d: distM });
    },
    get(frm, to, mode, departMin) {
      const a = cache.get(frm);
      const b = cache.get(to);
      stat.pairs++;
      if (a && a === b) return { t: 0, km: 0 };
      if (a && b) {
        const ms = a.t[b.c];
        if (ms < INF - 1) {
          stat.portal++;
          return { t: roundHalfEven(ms / 60000), km: (a.d[b.c] || 0) / 1000,
            src: 'portal' };
        }
      }
      if (ex && a && b) {
        const row = ex.rowFor(a.c, b.c);
        if (row) {
          stat.exact++;
          return { t: roundHalfEven(row.t / 60000), km: (row.d || 0) / 1000,
            src: 'exact' };
        }
      }
      stat.approx++;
      if (approxPairs.length < 400) approxPairs.push([frm, to]);
      if (o.onApprox) o.onApprox(frm, to);
      return null;
    },
    // k(h) applied here so production parity is untouched while traffic is off
    applyTraffic(leg, departMin) {
      if (!leg || !tr || !tr.on) return leg;
      const k = tr.kAt(departMin == null ? 480 : departMin);
      return { t: Math.max(1, roundHalfEven(leg.t * k)), km: leg.km, k };
    },
    size() { return cache.size; },
  };
}
