/* ui2/app.js — dispatcher lab front-2.
 *
 * Everything compute-heavy runs in the browser:
 *   - routing  : lib/router.worker.js?v=81  (numfast WASM SSSP over the MAP-FULL
 *                portal graph, 96 144 clusters / 241 348 vertices / 938 249
 *                edges, quantized 100 ms)
 *   - assignment: lib/s0.js             (port of the production S0 dispatcher:
 *                narrow-first order -> greedy insertion -> 2-opt -> preempt)
 *
 * No backend. No Leaflet. No framework. Only the data bundle is fetched.
 */
import { Map as CMap } from './lib/lmap.js?v=81';
import {
  solve, makeRequest, makeTeam, makePortalTravel, WORK_DOCS,
} from './lib/s0.js';
import { loadTraffic, TRAFFIC_META } from './lib/traffic.js?v=81';

// ------------------------------------------------------------------ consts
const T0 = 480;             // 08:00
const T1 = 1320;            // 22:00
const PXMIN = 1.6;
const AXIS_W = Math.round((T1 - T0) * PXMIN);
const HOUR_W = 60 * PXMIN;
const HALF_W = 30 * PXMIN;
const T0X = -(T0 - T0) * PXMIN;   // lanes start at 0, t0 == lane x 0
const MAP_BASE = './assets/map2';

const RTYPE_CSS = {
  connection: '--t-connection', repair: '--t-repair',
  accident: '--t-accident', extra_order: '--t-extra',
};
const RTYPE_RU = {
  connection: 'подключение', repair: 'локальная',
  accident: 'авария', extra_order: 'дозаказ',
};
const GL = {
  auto: 'А', bicycle: 'В', foot: 'П', scooter: 'С',
  connection: 'П', repair: 'Л', accident: 'А', extra_order: 'Д',
};
const REASON_RU = {
  cancelled_before_start: 'снята до старта', no_skill: 'нет навыка',
  no_transport: 'нет транспорта', no_stock: 'нет оборудования',
  window_missed: 'мимо окна', TRAVEL_INFEASIBLE: 'не успеть к окну',
  preempted: 'вытеснена аварией', overload: 'не влезает по времени',
  UNREACHABLE: 'портальный граф не перекинул мост',
  region: 'другой участок', closed: 'бригада недоступна',
};
const MODE_RU = { auto: 'авто', bicycle: 'вело', foot: 'пешком', scooter: 'самокат' };
const STAGE_RU = {
  prefilter: 'префильтр', scoring: 'скоринг', routing: 'маршрут',
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};
const hm = (m) => {
  if (m == null || !isFinite(m)) return '—';
  const v = Math.round(m);
  return String(Math.floor(v / 60) % 24).padStart(2, '0') + ':'
    + String(((v % 60) + 60) % 60).padStart(2, '0');
};
const num = (v, d) => (v == null || !isFinite(v) ? '—'
  : v.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d }));
const ms = (v) => (v == null ? '—' : v < 1000
  ? num(v, 1) + ' мс' : num(v / 1000, 2) + ' с');

// ------------------------------------------------------------------- state
const S = {
  scen: null,            // scenario json
  reqs: [],              // raw request records
  teams: [],             // raw team records
  model: null,           // map: cluster of a key + dist arrays
  // the offline exact table is now only a parity oracle: the uncapped portal
  // graph answers every pair, so the front carries no per-scenario bake.
  traffic: null,         // {on, kAt(minute), ...} from lib/traffic.js
  approx: null,          // {pairs, exact, portal, approx} honest travel counters
  plan: null,            // s0 result
  sel: null,             // {kind:'req'|'team', id}
  selTeam: null,         // team id whose route is drawn
  filter: { type: 'all', team: 'all', district: 'all', sel: new Set() },
  dense: false,
  view: 'split',
  closed: new Set(),
  meta: null,
  routeGeom: null,       // 'A>B' -> [[lat,lon]..] requested from the worker
  selSeg: -1,            // index of the current segment inside the selected route
  timing: {},
  lastRun: null,
};
let cMap = null;
let worker = null;
let ROUTE = null;         // the travel object handed to s0.solve
let PN = null;           // portal-vertex coords for drawing real polylines

// leg colour: rainbow over the day, so consecutive segments of one route are
// told apart at a glance and the colour also reads as time-of-day
function rainbow(i, n) {
  const h = n > 1 ? (i / n) * 300 : 40;          // 0..300 deg, avoid the wrap
  return 'hsl(' + h.toFixed(0) + ',88%,62%)';
}

// offices (personal-business anchors) and the shift cafe, drawn under everything
const PLACES = [
  { key: 'base-SE', label: '▤', name: 'База Восток', lat: 55.5889273, lon: 37.6646136, kind: 'off' },
  { key: 'base-SC', label: '▤', name: 'База Симферопольская', lat: 55.6647568, lon: 37.6158385, kind: 'off' },
  { key: 'base-VO', label: '▤', name: 'База Восток 2', lat: 55.7005610, lon: 37.7506580, kind: 'off' },
  { key: 'cafe-1', label: '☕', name: 'Кафе-обед (Симферопольский пр.)', lat: 55.6581000, lon: 37.6247000, kind: 'cafe' },
];

// ----------------------------------------------------------------- helpers
function clustersOf() {
  // group requests by shard so the grid reads as the operation actually is
  const g = new Map();
  for (const r of S.reqs) {
    const k = r.shard || '—';
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r);
  }
  return g;
}
const reqById = new Map();
const teamById = new Map();
function idx() {
  reqById.clear(); teamById.clear();
  for (const r of S.reqs) reqById.set(r.id, r);
  for (const t of S.teams) teamById.set(t.id, t);
}

// ------------------------------------------------------------------ worker
function bootWorker() {
  worker = new Worker('./lib/router.worker.js?v=81', { type: 'module' });
  worker.onmessage = (ev) => onWorker(ev.data);
  worker.onerror = (e) => {
    setChip('map', 'err', 'роутер: ' + (e.message || 'ошибка'));
    overlay('Роутер упал', e.message || 'worker error', null, []);
  };
  setChip('map', 'busy', 'роутер: загрузка карты…');
  S.phase = 'init-sent';
  S.timing.t_boot = performance.now();
  worker.postMessage({ cmd: 'init', base: MAP_BASE, wasm: './lib/numfast_native.wasm?v=81' });
  expose();
}

// Exposed so the headless probe can tell "worker still loading" from
// "main thread wedged": a heartbeat that keeps updating while the worker runs.
setInterval(() => {
  if (!S.plan) expose();
}, 200);

function onWorker(m) {
  if (m.t === 'dbg') {
    S.dbg = (S.dbg || []).concat([m]).slice(-4);
    if (m.where === 'route') {
      S.geomProg = m;
      setChip('map', 'busy', `маршруты ${m.done}/${m.n} · ${(m.per || 0).toFixed(0)} мс/нога`);
    }
    expose();
    return;
  }
  if (m.t === 'progress') {
    setChip('map', 'busy', `роутер: SSSP ${m.done}/${m.total}`);
    if (ov.on) {
      ov.bar.style.width = Math.round(100 * m.done / Math.max(1, m.total)) + '%';
      ov.ms.textContent = ms(m.ms);
      log(ov.log, `${m.phase || 'маршруты'}: ${m.done}/${m.total}`);
    }
    return;
  }
  if (m.t === 'ready') {
    S.meta = m.meta;
    PN = m.pn || null;
    // cluster -> real OSM building centroid (degrees, Float32Array of length C)
    S.clLat = m.clLat || null;
    S.clLon = m.clLon || null;
    S.timing.load = m.load_ms;
    S.timing.wasm = m.wasm_ms;
    S.timing.upload = m.upload_ms;
    S.timing.grid = m.grid_ms;
    setChip('map', 'live', `граф ${num(m.V / 1000, 0)}k вершин`);
    $('truth').innerHTML =
      `Дорожный граф ЦФО: <b>${num(m.V)}</b> вершин · <b>${num(m.E)}</b> рёбер · `
      + `<b>${num(m.C)}</b> кластеров · шаг кванта <b>${m.meta.step_ms} мс</b>. `
      + `Загрузка в память <b>${ms(m.load_ms)}</b> (${num(m.bytes / 1048576, 1)} МБ), `
      + `WASM numfast <b>${ms(m.wasm_ms)}</b>. `
      + `Время и километры — кратчайший путь по дорогам; внутрикластерные подъезды `
      + `не моделируются, поэтому точность медиана <b>+0.6 %</b>, хвост <b>+7 %</b> `
      + `(проверено против точного Дейкстры на полном CSR: <code>tools/verify_portal.py</code>).`;
    return;
  }
  if (m.t === 'matrix') {
    S.model = {
      keys: m.keys,
      cluster: m.cluster,
      snap_m: m.snap_m,
      colOf: m.colOf, srcOf: m.srcOf, dstCols: m.dstCols,
      nsrc: m.nsrc, ncol: m.ncol,
      ms: new Float64Array(m.ms), km: new Float64Array(m.km),
      solves: m.solves, wall_ms: m.wall_ms, per_solve_ms: m.per_solve_ms,
      distinct_clusters: m.distinct_clusters,
    };
    S.phase = 'matrix';
    S.timing.route = m.wall_ms;
    setChip('map', 'live', `${m.solves} SSSP · ${ms(m.wall_ms)}`);
    try { buildTravel(); runSolve(); } catch (e) {
      S.lastErr = String((e && e.stack) || e);
      S.phase = 'matrix-error';
      expose();
      overlay('Матрица: ошибка', S.lastErr, null, []);
    }
    return;
  }
  if (m.t === 'geom') {
    if (!S.routeGeom) S.routeGeom = new Map();
    const flat = new Float32Array(m.flat);
    let drawn = 0, straight = 0, off = 0;
    for (let i = 0; i < m.n.length; i++) {
      const cnt = m.n[i];
      const [ka, kb, why] = m.keys[i];
      if (cnt > 1) {
        const pts = new Array(cnt);
        for (let k = 0; k < cnt; k++) pts[k] = [flat[off + 2 * k], flat[off + 2 * k + 1]];
        S.routeGeom.set(ka + '>' + kb, pts);
        drawn++;
      } else straight++;
      off += cnt * 2;
    }
    S.geomSample = null;
    for (const [k, v] of S.routeGeom) { S.geomSample = { k, n: v.length, first: v[0], mid: v[v.length >> 1] }; break; }
    S.geomHave = drawn;
    S.geomStraight = straight;
    S.geomReady = true;
    // NB: nothing is auto-selected. The dispatcher opens on the whole plan;
    // picking a team/segment for them hides the global picture and reads as a bug.
    S.geomWall = m.wall_ms;
    setChip('map', drawn ? 'live' : 'err',
      `${drawn}/${m.n.length} ног по дорогам`);
    renderMap();
    renderDetail();
    expose();
    return;
  }
  if (m.t === 'error') {
    setChip('map', 'err', 'роутер: ошибка');
    overlay('Роутер: ошибка', m.msg, null, []);
  }
  if (m.t === 'progress') {
    setChip('map', 'busy', `SSSP ${m.done}/${m.total}`);
    if (ov.on) {
      ov.bar.style.width = Math.round(100 * m.done / Math.max(1, m.total)) + '%';
      ov.ms.textContent = ms(m.ms);
    }
  }
}

// snap residuals: points outside object coverage report Infinity, so a MEAN
// is meaningless. Report the median over snapped points plus the unsnapped
// count (b11 defect 4).
function snapStat(ms) {
  if (!ms || !ms.length) return null;
  const all = Array.from(ms);
  const ok = all.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const miss = all.length - ok.length;
  if (!ok.length) return { median_m: null, snapped: 0, unsnapped: miss };
  const mid = ok.length >> 1;
  const median = ok.length % 2 ? ok[mid] : (ok[mid - 1] + ok[mid]) / 2;
  return { median_m: median, snapped: ok.length, unsnapped: miss };
}

// Real building anchor for a point: the cluster's first OSM address centroid.
// The worker sends clLat/clLon (deg, Float32Array, length C) built from
// objCluster[]; without it the pin floats at the raw CSV lat/lon.
function anchorOf(key, lat, lon) {
  const c = S.cluOf && S.cluOf.get(key);
  if (c != null && S.clLat && S.clLat[c] != null && Number.isFinite(S.clLat[c])
      && S.clLat[c] !== 0) return [S.clLon[c], S.clLat[c]];
  return [lon, lat];
}

function buildTravel() {
  // The worker posts parallel arrays: keys[] (strings), cluster[], snap_m[].
  const msA = new Float64Array(S.model.ms);
  const kmA = new Float64Array(S.model.km);
  S.model.keyList = S.model.keys.map((k, i) => ({
    key: k, cluster: S.model.cluster[i], snap_m: S.model.snap_m[i],
  }));
  ROUTE = makePortalTravel(S.model, null, {
    exact: null, traffic: S.traffic,
  });
  S.approx = ROUTE.stat;
  let ok = 0, sum = 0;
  const nc = S.model.ncol;
  // cluster -> its matrix row. srcOf[] is only set for the FIRST key of each
  // cluster (the worker marks a source once), so trusting srcOf[i] skipped
  // 111 of 177 keys and they silently fell through to the "no travel" branch:
  // 37% registered vs 35% answered is that ratio exactly. The worker builds
  // srcCols and dstCols in the same order, so a cluster's column index is also
  // its row index.
  const rowOf = new Map();
  S.model.keyList.forEach((k) => {
    if (k.cluster >= 0 && !rowOf.has(k.cluster)) rowOf.set(k.cluster, rowOf.size);
  });
  S.model.keyList.forEach((k, i) => {
    if (k.cluster >= 0 && k.snap_m < 1000) ok++;
    sum += Math.min(k.snap_m, 99999);
    // Each key gets ITS OWN row view: the matrix is (nsrc rows x ncol cols),
    // and travel.get(frm,to) reads row[cluster(frm)][colOf[to]].
    const r = rowOf.get(k.cluster);
    if (r == null) return;
    ROUTE.register(k.key, S.model.colOf[i],
      msA.subarray(r * nc, r * nc + nc), kmA.subarray(r * nc, r * nc + nc));
  });
  S.timing.snap = snapStat(S.model && S.model.snap_m);
  S.snapOk = ok; S.snapAll = S.model.keyList.length;
  // key -> cluster, so every point can be drawn on its REAL building centroid
  S.cluOf = new Map();
  S.model.keyList.forEach((k) => { if (k.cluster >= 0) S.cluOf.set(k.key, k.cluster); });
}

// -------------------------------------------------------------------- solve
function runSolve(replan) {
  try { return runSolveInner(replan); } catch (e) {
    S.lastErr = 'runSolve: ' + String((e && e.stack) || e);
    expose(); overlay('S0: ошибка', S.lastErr, null, []); throw e;
  }
}
function runSolveInner(replan) {
  if (!S.model) return;
  const t0 = performance.now();
  const reqs = S.reqs.map((r) => {
    const st = (S.filter.sel.has(r.id)) ? 'done' : '';
    return makeRequest({
      id: r.id, region: r.shard, ws: r.ws, we: r.we, dur: r.dur,
      skills: r.skills, equip: r.equip, appear: r.appear, prio: r.prio,
      rtype: r.rtype, lat: r.lat, lon: r.lon, status: st,
    });
  });
  const teams = S.teams.map((t) => makeTeam({
    id: t.id, region: t.shard, skills: t.skills, mode: t.mode,
    sh0: t.sh0, sh1: t.sh1, lat: t.lat, lon: t.lon, stock: t.stock,
  }));
  S.phase = 'solving';
  try {
    S.plan = solve(reqs, teams, ROUTE, { preempt: true });
  } catch (e) {
    S.phase = 'solve-error';
    S.lastErr = String((e && e.stack) || e);
    expose();
    overlay('S0: ошибка', S.lastErr, null, []);
    return;
  }
  S.phase = 'solved';
  S.timing.solve = performance.now() - t0;
  S.lastRun = {
    n: S.reqs.length, done: S.plan.done, teams: S.plan.teams_used,
    km: S.plan.km, viol: S.plan.violations,
    route_ms: S.timing.route, solve_ms: S.timing.solve,
  };
  setChip('solve', 'live',
    `S0 ${S.plan.done}/${S.reqs.length} · ${ms(S.timing.solve)}`);
  S.routeGeom = new Map();
  S.geomReady = false;
  S.geomHave = 0;
  S.geomStraight = 0;
  S.phase = 'rendering';
  render();
  S.phase = "rendered";
  closeOverlay();
  requestRouteGeom();
  expose();
}

// The headless probe (tools/probe.mjs) reads this to assert the browser really
// computed everything, rather than trusting a screenshot.
function expose() {
  window.__ui2 = {
    ready: !!(S.plan && S.model && S.geomReady),
    phase: S.plan ? 'solved' : (S.model ? 'routed' : (S.phase || 'loading')),
    scenario: S.scen ? S.scen.kind : null,
    n: S.reqs.length, teams: S.teams.length,
    timing: { ...S.timing },
    plan: S.plan ? {
      done: S.plan.done, teams_used: S.plan.teams_used,
      km: S.plan.km, violations: S.plan.violations,
      rejected: Object.keys(S.plan.rejected).length,
      wall_ms: S.plan.wall_ms, stage: S.plan.stage_ms,
    } : null,
    graph: S.meta ? { C: S.meta.C, V: S.meta.V, E: S.meta.E,
      step_ms: S.meta.step_ms } : null,
    dbg: S.dbg || null,
    solves: S.model ? S.model.solves : 0,
    per_solve_ms: S.model ? S.model.per_solve_ms : null,
    lastErr: S.lastErr || null,
  approx: S.approx || null,
    geom: { want: S.geomWant | 0, road: S.geomHave | 0, straight: S.geomStraight | 0,
          done: (S.geomProg && S.geomProg.done) | 0, per_ms: (S.geomProg && S.geomProg.per) || 0,
          wall_ms: S.geomWall || 0, why: S.geomWhy || null },
    view: cMap ? cMap.view() : null,
    mapBox: S.mapBox || null,
    geomSample: S.geomSample || null,
    teamBox: S.teamBox || null,
  };
}

// ------------------------------------------------------------------- render
function render() {
  renderKpis();
  renderTeams();
  renderGrid();
  renderMap();
  renderFunnel();
  renderDetail();
  renderSteps();
}

function renderKpis() {
  const p = S.plan;
  if (!p) { $('kpis').textContent = ''; return; }
  const n = S.reqs.length;
  const cov = p.done / n * 100;
  const dist = n ? S.scen.districts.filter((d) => {
    const rs = S.reqs.filter((r) => r.shard === d);
    return rs.length && rs.some((r) => p.perTeam && has(p, r.id));
  }).length : 0;
  $('kpi-sub').textContent = `${n} заявок · ${S.teams.length} бригад · seed 42`;
  $('kpis').innerHTML = [
    kpi('Выполнено', `${p.done}`, `/ ${n}`, cov >= 85 ? 'good' : cov >= 70 ? '' : 'warn'),
    kpi('Покрытие', num(cov, 1) + '%', 'заявок', ''),
    kpi('Бригад в работе', `${p.teams_used}`, `/ ${S.teams.length}`, ''),
    kpi('Км по дорогам', num(p.km, 0), `на ${p.done} работ`, ''),
    kpi('Нарушений', `${p.violations}`, 'окон/смен', p.violations ? 'hot' : 'good'),
    kpi('Пересчёт', num(S.timing.solve, 0) + ' мс', 'S0 целиком', 'good'),
    kpi('Коэффициент k(h)', S.traffic && S.traffic.on ? 'вкл' : 'выкл',
      S.traffic ? `city-uniform ${S.traffic.year}` : TRAFFIC_META.year, ''),
  ].join('');
  function kpi(t, v, s, cls) {
    return `<div class="kpi ${cls || ''}"><span>${t}</span><b>${v}</b><i>${s}</i></div>`;
  }
  function has(pl, id) {
    return pl.assignments.some((a) => a.request_id === id);
  }
}

function renderTeams() {
  const p = S.plan;
  const used = new Set();
  if (p) for (const a of p.assignments) used.add(a.team_id);
  const all = S.teams;
  $('teams-n').textContent = `${used.size} / ${all.length}`;
  const host = $('teams');
  const want = S.filter.team === 'all' ? null : S.filter.team;
  const list = all.filter((t) => {
    if (want && t.id !== want) return false;
    if (S.filter.type !== 'all' && !allOfType(p, t.id)) return false;
    return true;
  });
  host.innerHTML = '';
  for (const t of list.slice(0, 400)) {
    const cnt = p ? p.assignments.filter((a) => a.team_id === t.id).length : 0;
    const r = el('div', 'row' + (S.selTeam === t.id ? ' sel' : ''));
    r.innerHTML = `<b>${t.id}</b><span class="tag">${MODE_RU[t.mode] || t.mode}</span>`
      + `<span class="mono">${hm(t.sh0)}–${hm(t.sh1)}</span>`
      + `<span class="mono" style="margin-left:auto">${cnt}</span>`;
    r.onclick = () => selectTeamId(t.id);
    host.appendChild(r);
  }
  function allOfType() { return true; }
}

function renderGrid() {
  const axis = $('gaxis');
  axis.style.width = AXIS_W + 'px';
  let ticks = '';
  for (let t = T0; t <= T1; t += 30) {
    const major = (t % 120 === 0);
    ticks += `<div class="gtick${major ? ' major' : ''}" style="left:${(t - T0) * PXMIN}px">`
      + `${major ? hm(t) : ''}</div>`;
  }
  axis.innerHTML = ticks;
  document.documentElement.style.setProperty('--hour-w', HOUR_W + 'px');
  document.documentElement.style.setProperty('--half-w', HALF_W + 'px');
  document.documentElement.style.setProperty('--t0-x', T0X + 'px');

  const host = $('grows');
  host.innerHTML = '';
  const p = S.plan;
  const asg = new Map();
  if (p) for (const a of p.assignments) {
    if (!asg.has(a.team_id)) asg.set(a.team_id, []);
    asg.get(a.team_id).push(a);
  }
  for (const v of asg.values()) v.sort((x, y) => x.start - y.start);
  const rej = new Map();
  if (p) for (const k of Object.keys(p.rejected)) rej.set(k, p.rejected[k]);

  let n = 0;
  const tids = S.teams.map((t) => t.id);
  for (const tid of tids) {
    const jobs = asg.get(tid) || [];
    if (!jobs.length && S.filter.team !== 'all' && S.filter.team !== tid) continue;
    if (S.filter.team === 'all' && !jobs.length) continue;   // hide empty by default
    const t = teamById.get(tid);
    if (t && S.filter.district !== 'all' && t.shard !== S.filter.district) continue;
    const row = el('div', 'grow' + (n % 2 ? ' zebra' : '')
      + (S.selTeam === tid ? ' sel' : '') + (jobs.length ? '' : ' unused'));
    const g = S.scen.byTeam.get(tid) || [];
    row.innerHTML = `<div class="gcol"><i class="gl">${GL[t.mode] || '?'}</i>`
      + `<span class="id">${tid.replace('TEAM-', '')}</span>`
      + `<span class="n">${jobs.length}</span></div>`;
    const lane = el('div', 'glane');
    let prevEnd = null;
    for (const a of jobs) {
      const r = reqById.get(a.request_id);
      if (!r) continue;
      if (S.filter.type !== 'all' && r.rtype !== S.filter.type) continue;
      if (S.filter.district !== 'all' && r.shard !== S.filter.district) continue;
      const wx0 = (r.ws - T0) * PXMIN, wx1 = (r.we - T0) * PXMIN;
      const bx0 = (a.start - T0) * PXMIN, bw = Math.max(5, (a.end - a.start) * PXMIN);
      const late = a.end > r.we;
      const w = el('div', 'wish' + (late ? ' miss' : ''));
      w.style.left = wx0 + 'px';
      w.style.width = Math.max(2, wx1 - wx0) + 'px';
      w.title = `окно ${hm(r.ws)}–${hm(r.we)}`;
      lane.appendChild(w);
      if (prevEnd != null && a.arrive > prevEnd) {
        const st = el('div', 'tstub');
        st.style.left = (prevEnd - T0) * PXMIN + 'px';
        st.style.width = Math.max(1, (a.arrive - prevEnd) * PXMIN) + 'px';
        st.title = `дорога ${a.t_min} мин`;
        lane.appendChild(st);
      }
      const b = el('div', 'jbar');
      b.style.left = bx0 + 'px';
      b.style.width = bw + 'px';
      b.style.background = `var(${RTYPE_CSS[r.rtype] || '--t-repair'})`;
      if (S.sel && S.sel.kind === 'req' && S.sel.id === r.id) b.classList.add('sel');
      b.innerHTML = `<span class="cap">${hm(a.start)}</span>`;
      b.title = `${r.id} ${RTYPE_RU[r.rtype]}\n`
        + `окно ${hm(r.ws)}–${hm(r.we)}\n`
        + `прибытие ${hm(a.arrive)} · работы ${hm(a.start)}–${hm(a.end)}`
        + (late ? `\n⚠ конец +${a.end - r.we} мин после окна` : '')
        + `\nдорога ${a.t_min} мин · ${num(a.d_km, 1)} км`;
      b.onclick = (e) => { e.stopPropagation(); selectRequestId(r.id, true); };
      lane.appendChild(b);
      prevEnd = a.end;
    }
    row.appendChild(lane);
    host.appendChild(row);
    n++;
  }
  // unassigned band
  const un = [];
  for (const r of S.reqs) if (rej.has(r.id)) un.push(r);
  if (un.length) {
    const row = el('div', 'grow zebra');
    row.innerHTML = `<div class="gcol"><i class="gl" style="background:var(--bad)">!</i>`
      + `<span class="id">НЕ НАЗНАЧЕНЫ</span><span class="n">${un.length}</span></div>`;
    const lane = el('div', 'glane');
    const band = el('div', 'gband');
    band.style.left = '0px';
    band.style.width = (T1 - T0) * PXMIN + 'px';
    band.textContent = `${un.length} не назначены — причины в панели «Воронка отказов»`;
    lane.appendChild(band);
    row.appendChild(lane);
    host.appendChild(row);
  }
  $('gempty').style.display = n ? 'none' : 'block';
}

function renderFunnel() {
  const p = S.plan;
  const host = $('funnel');
  if (!p) { host.innerHTML = ''; return; }
  const cnt = new Map();
  for (const k of Object.keys(p.rejected)) {
    const c = p.rejected[k];
    cnt.set(c, (cnt.get(c) || 0) + 1);
  }
  const items = [...cnt.entries()].sort((a, b) => b[1] - a[1]);
  const max = items.length ? items[0][1] : 1;
  const stageOf = (c) => (['no_skill', 'no_transport', 'no_stock', 'no_shift',
    'window_missed', 'TRAVEL_INFEASIBLE', 'overload', 'preempted',
    'cancelled_before_start'].indexOf(c) >= 0 ? 'скоринг' : 'префильтр');
  const a = S.approx;
  const prov = a ? `<div class="fn prov"><span>времён: портал ${a.portal}`
    + ` · точная матрица ${a.exact} · без ответа ${a.approx}</span></div>` : '';
  host.innerHTML = (items.length ? items.map(([c, v]) => `
    <div class="fn"><span>${REASON_RU[c] || c}</span><i class="bar2"
      style="width:${Math.round(v / max * 100)}%"></i><b>${v}</b></div>`).join('')
    : '<span class="muted">все заявки распределены</span>') + prov;
  void stageOf;
}

// When a request is selected, the task asks for the ROUTE PLAN of the team that
// owns it -- so the same .segs list as the team branch, appended under the
// request card, with the request's own leg marked as current.
function teamRoutePanel(tid) {
  if (!tid) return '';
  const jobs = S.plan ? S.plan.assignments.filter((x) => x.team_id === tid)
    .slice().sort((x, y) => x.start - y.start) : [];
  if (!jobs.length) return '';
  const cur = Math.max(0, jobs.findIndex((j) => j.request_id === S.sel.id));
  let km = 0, road = 0;
  for (const x of jobs) km += x.d_km;
  const segs = jobs.map((x, i) => {
    const r = reqById.get(x.request_id);
    const g = S.routeGeom && S.routeGeom.get(
      (i === 0 ? 'START:' + tid : jobs[i - 1].request_id) + '>' + x.request_id);
    if (g && g.length > 1) road++;
    return `<div class="segrow${i === cur ? ' cur' : ''}" data-seg="${i}">
      <i class="dot" style="background:${rainbow(i, jobs.length)}"></i>
      <span class="mono">${i + 1}</span>
      <span class="mono">${hm(x.arrive)}</span>
      <b>${(r && r.address) || x.request_id}</b>
      <span class="mono">${x.t_min}м · ${num(x.d_km, 1)}км</span>
      <span class="tag">${g && g.length > 1 ? 'дороги' : 'прямая'}</span>
    </div>`;
  }).join('');
  return `<div class="tlrow"><b>Маршрутный план ${tid}</b>
      <span class="mono" style="margin-left:auto">${jobs.length} сегм · ${num(km, 1)} км</span></div>
    <div class="segs">${segs}</div>`;
}

function renderDetail() {
  const host = $('detail');
  const s = S.sel;
  if (!s) { host.innerHTML = '<span class="muted">выберите заявку или бригаду</span>'; return; }
  if (s.kind === 'team') {
    const t = teamById.get(s.id);
    const jobs = (S.plan ? S.plan.assignments.filter((a) => a.team_id === s.id)
      .slice().sort((a, b) => a.start - b.start) : []);
    let km = 0, tm = 0, road = 0, wm = 0;
    for (const a of jobs) { km += a.d_km; tm += a.t_min; wm += (a.end - a.start); }
    // shift utilisation: how much of the paid shift the plan actually books.
    // S0 is a single-pass greedy, so this is normally far below 100% - that is
    // the real optimiser defect, not a time-accounting bug.
    const tinfo = teamById.get(s.id);
    const shMin = tinfo ? (tinfo.sh1 - tinfo.sh0) : 0;
    const busy = wm + tm;
    const loadPct = shMin > 0 ? Math.round((busy / shMin) * 100) : 0;
    if (S.selSeg >= jobs.length) S.selSeg = jobs.length - 1;
    if (S.selSeg < 0 && jobs.length) S.selSeg = 0;
    const cur = S.selSeg;
    // every leg of THIS route, in order; the current one is marked and is the
    // one that carries the running dashes on the map
    const segs = jobs.map((a, i) => {
      const r = reqById.get(a.request_id);
      const g = S.routeGeom && S.routeGeom.get(
        (i === 0 ? 'START:' + s.id : jobs[i - 1].request_id) + '>' + a.request_id);
      if (g && g.length > 1) road++;
      return `<div class="segrow${i === cur ? ' cur' : ''}" data-seg="${i}">
        <i class="dot" style="background:${rainbow(i, jobs.length)}"></i>
        <span class="mono">${i + 1}</span>
        <span class="mono">${hm(a.arrive)}</span>
        <b>${r.address || r.id}</b>
        <span class="mono">${a.t_min}м · ${num(a.d_km, 1)}км</span>
        <span class="tag">${g && g.length > 1 ? 'дороги' : 'прямая'}</span>
      </div>`;
    }).join('');
    host.innerHTML = `<div class="kv"><span>Бригада</span><b>${t.id}</b></div>
      <div class="kv"><span>Участок</span><b>${t.shard}</b></div>
      <div class="kv"><span>Транспорт</span><b>${MODE_RU[t.mode]}</b></div>
      <div class="kv"><span>Смена</span><b class="mono">${hm(t.sh0)}–${hm(t.sh1)}</b></div>
      <div class="kv"><span>Навыки</span><b>${t.skills.join(', ') || '—'}</b></div>
      <div class="kv"><span>Сегментов</span><b>${jobs.length}</b></div>
      <div class="kv"><span>Км по дорогам</span><b>${num(km, 1)}</b></div>
      <div class="kv"><span>В пути</span><b class="mono">${Math.round(tm)} мин</b></div>
      <div class="kv"><span>В работе</span><b class="mono">${Math.round(wm)} мин</b></div>
      <div class="kv"><span>Загрузка смены</span><b class="mono" style="color:${loadPct > 85 ? 'var(--ok)' : 'var(--warn)'}">${loadPct}% · ${Math.round(busy)} из ${shMin} мин</b></div>
      <div class="kv"><span>Норма работ</span><b class="mono" title="S0 берёт свою таблицу WORK_DOCS (70/80/20/30), а не duration_min из CSV и не нормы ТЗ (90/100/40/50)">WORK_DOCS</b></div>
      <div class="kv"><span>Ломаная по дорогам</span><b>${road}/${jobs.length}</b></div>
      <div class="tlrow"><b>Маршрут — сегменты</b><span class="mono" style="margin-left:auto">${road} дорог</span></div>
      <div class="segs">${segs || '<span class="muted">нет работ</span>'}</div>`;
    host.querySelectorAll('.segrow').forEach((n) => {
      n.onclick = () => focusSeg(S.selTeam, +n.dataset.seg);
    });
    return;
  } else {    const r = reqById.get(s.id);
    if (!r) { host.innerHTML = ''; return; }
    const a = S.plan ? S.plan.assignments.find((x) => x.request_id === s.id) : null;
    const rej = S.plan ? S.plan.rejected[s.id] : null;
    host.innerHTML = `<div class="kv"><span>Заявка</span><b>${r.id}</b></div>
      <div class="kv"><span>Тип</span><b style="color:var(${RTYPE_CSS[r.rtype]})">${r.type_ru}</b></div>
      <div class="kv"><span>Адрес</span><b>${r.address || '—'}</b></div>
      <div class="kv"><span>Окно</span><b class="mono">${hm(r.ws)}–${hm(r.we)}</b></div>
      <div class="kv"><span>Норма работ</span><b class="mono">${WORK_DOCS[r.rtype] || 30} мин</b></div>
      <div class="kv"><span>Приоритет</span><b>${r.prio}</b></div>
      <div class="kv"><span>Навыки</span><b>${r.skills.join(', ') || '—'}</b></div>` +
      (a ? `<div class="kv"><span>Бригада</span><b>${a.team_id}</b></div>
        <div class="kv"><span>Прибытие</span><b class="mono">${hm(a.arrive)}</b></div>
        <div class="kv"><span>Работы</span><b class="mono">${hm(a.start)}–${hm(a.end)}</b></div>
        <div class="kv"><span>Дорога</span><b class="mono">${a.t_min} мин · ${num(a.d_km, 1)} км</b></div>
        ${a.end > r.we ? `<div class="kv"><span>⚠</span><b style="color:var(--warn)">конец на ${a.end - r.we} мин позже окна</b></div>` : ''}`
        : rej ? `<div class="kv"><span>Причина</span><b style="color:var(--bad)">${REASON_RU[rej] || rej}</b></div>`
          : '<span class="muted">не назначена</span>') + teamRoutePanel(a ? a.team_id : null);
  }
  const reqTeam = S.sel && S.sel.kind === 'req'
    ? ((S.plan && S.plan.assignments.find((x) => x.request_id === S.sel.id) || {}).team_id || S.selTeam)
    : S.selTeam;
  host.querySelectorAll('.segrow').forEach((n) => {
    n.onclick = () => focusSeg(reqTeam, +n.dataset.seg);
  });
  host.querySelectorAll('.tlrow[data-r]').forEach((n) => {
    n.onclick = () => { S.sel = { kind: 'req', id: n.dataset.r }; render(); };
  });
}

function renderSteps() {
  const t = S.timing;
  const L = S.lastRun;
  const rows = [
    ['Загрузка графа в WASM', t.load, '15 .bin → linear memory'],
    ['Маршруты: SSSP по кластерам', t.route, `${S.model ? S.model.solves : 0} × Дейкстра по портальному графу numfast (JS)`],
    ['Распределение S0', t.solve, 'narrow-first → insertion → 2-opt → preempt'],
  ];
  $('steps').innerHTML = rows.map(([n, v, d]) => `
    <div class="step"><span class="mono">${n}</span><b>${v == null ? '—' : ms(v)}</b>
    <i>${d}</i></div>`).join('')
    + (L ? `<div class="step" style="border-top:1px solid var(--line)">
      <b>Итог</b><span class="mono">${L.done}/${L.n}</span>
      <i>${L.teams} бригад · ${num(L.km, 0)} км · ${L.viol} нарушений</i></div>` : '');
}

// ---------------------------------------------------------------------- map
function renderMap() {
  if (!cMap) return;
  const lines = [];
  const points = [];
  const marks = [];
  const p = S.plan;
  const asg = new Map();
  if (p) for (const a of p.assignments) {
    if (!asg.has(a.team_id)) asg.set(a.team_id, []);
    asg.get(a.team_id).push(a);
  }
  const showTeam = S.selTeam;
  const solo = !!(showTeam && (asg.get(showTeam) || []).length);

  // ---- routes -----------------------------------------------------------
  // One team selected -> only its route, thick, rainbow per leg, arrows.
  // Nothing selected -> every active route faint, so the city-wide pattern
  // reads but no single team dominates.
  const teams = solo ? [showTeam] : [...asg.keys()];
  for (const tid of teams) {
    const t = teamById.get(tid);
    const jobs = asg.get(tid).slice().sort((a, b) => a.start - b.start);
    if (!t || !jobs.length) continue;
    const n = jobs.length;
    const tAnchor = anchorOf('START:' + t.id, t.lat, t.lon);
    const seq = [{ lat: tAnchor[1], lon: tAnchor[0], ref: 'START:' + t.id, label: 'База' },
      ...jobs.map((a) => {
        const r = reqById.get(a.request_id);
        const an = anchorOf(r.id, r.lat, r.lon);
        return { lat: an[1], lon: an[0], ref: r.id, label: r.address || r.id, a };
      })];
    for (let i = 1; i < seq.length; i++) {
      const seg = i - 1;
      const col = solo ? rainbow(seg, n) : 'rgba(150,170,215,.34)';
      const kk = seq[i - 1].ref + '>' + seq[i].ref;
      const road = (S.routeGeom && S.routeGeom.get(kk))
        || null;
      const isCur = solo && seg === S.selSeg;
      if (road && road.length > 1) {
        const line = { geo: [], pts: [], c: col, w: solo ? 3.4 : 1.6, arrow: true, arrowSize: solo ? 9 : 5 };
        for (const q of road) {
          const z = cMap.project(q[1], q[0]);   // worker gives [lat,lon]
          line.pts.push(z);
          line.geo.push([q[1], q[0]]);          // [lon,lat], re-projected on view change
        }
        if (solo) { line.casing = 'rgba(8,10,16,.78)'; line.a = 0.95; }
        if (isCur) { line.w = 4.6; line.flow = '#fff'; }
        // clickable: the leg must be selectable straight from the map
        if (solo) line.sid = t.id + '#' + seg;
        lines.push(line);
        // The road graph stops at the cluster's PORTAL vertex; the last metres
        // to the building are a walk through the yard/entrance. Draw that
        // honestly as a dashed foot, so the pin never floats unexplained.
        const tail = road[road.length - 1];
        const dTLat = (seq[i].lat - tail[0]) * 111.32;
        const dTLon = (seq[i].lon - tail[1]) * 111.32 * Math.cos(seq[i].lat * Math.PI / 180);
        const dT = Math.sqrt(dTLat * dTLat + dTLon * dTLon) * 1000;
        if (dT > 25) {
          lines.push({ geo: [[tail[1], tail[0]], [seq[i].lon, seq[i].lat]],
            pts: [[0, 0], [0, 0]], c: solo ? col : 'rgba(150,170,215,.22)',
            w: solo ? 1.6 : 1, dash: [3, 4], a: 0.8 });
        }
      } else {
        // no road polyline for this leg. Sub-150 m pairs are the same building
        // (same-cluster) -- a straight bar there is pure noise, so skip it
        // rather than pretending it is a route.
        const dLat = (seq[i].lat - seq[i - 1].lat) * 111.32;
        const dLon = (seq[i].lon - seq[i - 1].lon) * 111.32 * Math.cos(seq[i].lat * Math.PI / 180);
        const d = Math.sqrt(dLat * dLat + dLon * dLon) * 1000;
        // >60 km without a road polyline means the portal graph could not
        // bridge the gap (e.g. the Kashira tail) - a straight bar that long is
        // a lie, so draw nothing and leave the leg visibly unbuilt.
        if (d > 150 && d < 60000) {
          lines.push({ geo: [[seq[i - 1].lon, seq[i - 1].lat], [seq[i].lon, seq[i].lat]],
            pts: [[0, 0], [0, 0]], c: solo ? col : 'rgba(255,0,83,.22)',
            w: solo ? 1.4 : 1, dash: [5, 5], arrow: solo });
        }
      }
    }
  }

  // ---- points: requests -------------------------------------------------
  for (const r of S.reqs) {
    const a = p && p.assignments.find((x) => x.request_id === r.id);
    if (solo && !a) continue;
    if (S.sel && S.sel.kind === 'req' && S.sel.id === r.id) continue;
    const col = a ? 'var(--ok)' : 'rgba(154,163,186,.75)';
    const _ra = anchorOf(r.id, r.lat, r.lon);
    points.push({ geo: [_ra[0], _ra[1]], x: _ra[0], y: _ra[1], c: col, inner: '#0b0e15',
      r: a ? 5.5 : 4, ref: r.id, kind: 'req' });
    // the owning team id next to the dot -- _drawPoints never rendered labels,
    // so this was silently dropped and the map looked like it had no markers
    // 22 teams x several requests = dozens of overlapping id labels. Show them
    // only for the soloed team, or zoomed in close enough to read.
    // when soloed, label ONLY that team's requests -- `solo` alone labelled all 22
    if (a && (solo ? a.team_id === showTeam : cMap.z >= 14)) {
      const tid = (teamById.get(a.team_id) || {}).id;
      if (tid) marks.push({ geo: [_ra[0], _ra[1]], x: _ra[0], y: _ra[1], label: tid, dy: 13,
        ref: r.id, kind: 'req', c: solo ? '#fff' : 'rgba(233,237,246,.9)' });
    }
  }
  if (S.sel && S.sel.kind === 'req') {
    const r = reqById.get(S.sel.id);
    if (r) { const _sa = anchorOf(r.id, r.lat, r.lon);
      points.push({ geo: [_sa[0], _sa[1]], x: _sa[0], y: _sa[1], c: 'var(--accent)',
      inner: '#fff', r: 8.5, sel: 1, ref: r.id, kind: 'req' });
    }
  }
  // ---- marks: offices, cafe, team starts -------------------------------
  for (const pl of PLACES) {
    if (Math.abs(pl.lat - 55.7) > 0.5) continue;
    marks.push({ geo: [pl.lon, pl.lat], x: pl.lon, y: pl.lat, label: pl.label, c: pl.kind === 'cafe' ? 'var(--t-extra)' : 'var(--accent-3)', ref: pl.key, kind: 'place', dy: -9 });
  }
  const teamList = solo ? [showTeam] : teams;
  for (const tid of teamList) {
    const t = teamById.get(tid);
    if (!t) continue;
    const ta = anchorOf('START:' + t.id, t.lat, t.lon);
    marks.push({ geo: [ta[0], ta[1]], x: ta[0], y: ta[1], label: (solo || cMap.z >= 14) ? t.id : '▣',
      dy: -11, ref: tid, kind: 'team',
      c: solo ? '#fff' : 'var(--accent-3)' });
    if (solo) points.push({ geo: [ta[0], ta[1]], x: ta[0], y: ta[1], c: 'var(--accent)',
      inner: '#0b0e15', r: 6.5, ref: tid, kind: 'team' });
  }
  cMap.setLayers({ marks, points, lines });
  cMap.draw();
  $('scalebar').style.width = '60px';
  const v = cMap.view();
  $('scaletext').textContent = `z${v.z} · ${v.lat.toFixed(4)}, ${v.lon.toFixed(4)}`;
  $('maplegend').innerHTML = `<span class="k"><i class="sq" style="background:var(--ok)"></i>выполнена</span>
    <span class="k"><i class="sq" style="background:rgba(154,163,186,.75)"></i>в пуле</span>
    <span class="k"><i class="sq" style="background:var(--accent-3)"></i>база / старт бригады</span>
    <span class="k"><i class="sq" style="background:var(--t-extra)"></i>кафе</span>
    <span class="k"><i class="ln" style="background:linear-gradient(90deg,#26c6a6,#8a83d1,#ff4d6d)"></i>маршрут бригады — сегменты по радуге, <b>по дорогам</b></span>
    <span class="k"><i class="ln dash"></i>прямая (дорожная ломаная не построена)</span>`;
}

const lon2xDeg = (lon) => (lon + 180) / 360;
const lat2yDeg = (lat) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
// Selecting a request must show the route of the team that owns it, with the
// selected request's own leg as the animated one. This is the rule the task
// asks for: "при клике на любую заявку показывается маршрутный план бригады,
// в которой есть эта заявка".
function selectRequestId(rid, keepTeam) {
  S.sel = { kind: 'req', id: rid };
  if (!keepTeam) {
    const a = S.plan && S.plan.assignments.find((x) => x.request_id === rid);
    if (a) {
      S.selTeam = a.team_id;
      const jobs = S.plan.perTeam.get(a.team_id) || [];
      S.selSeg = Math.max(0, jobs.findIndex((j) => j.request_id === rid));
    }
  }
  render();
  if (S.selTeam) fitTeam(S.selTeam);
}

// highlight one leg of a route AND fly it to the centre of the map, filling
// about three quarters of the pane. Works from the right-rail list AND from a
// click straight on the polyline.
function focusSeg(tid, idx) {
  S.selTeam = tid;
  S.sel = { kind: 'team', id: tid };
  S.selSeg = Math.max(0, idx | 0);
  render();
  const jobs = (S.plan && S.plan.perTeam && S.plan.perTeam.get(tid)) || [];
  const j = jobs[S.selSeg];
  if (!j) return;
  const k = S.selSeg;
  const refA = k === 0 ? 'START:' + tid : jobs[k - 1].request_id;
  const pts = S.routeGeom && S.routeGeom.get(refA + '>' + j.request_id);
  if (pts && pts.length > 1) cMap.fitSeg(pts, 0.75);
  else fitTeam(tid, true);
  window.__act && (window.__act.lastSeg = tid + '#' + S.selSeg);
}

function selectTeamId(tid, keep) {
  S.selTeam = S.selTeam === tid && !keep ? null : tid;
  S.sel = { kind: 'team', id: tid };
  S.selSeg = 0;
  render();
  if (S.selTeam) fitTeam(S.selTeam);
}

function fitTeam(tid, force) {
  if (!cMap || !S.plan || !S.plan.perTeam) return;
  const jobs = S.plan.perTeam.get(tid) || [];
  const t = teamById.get(tid);
  const pts = [];
  if (t) pts.push([t.lat, t.lon]);
  for (const a of jobs) { const r = reqById.get(a.request_id); if (r) pts.push([r.lat, r.lon]); }
  const mine = new Set(jobs.map((a) => a.request_id));
  mine.add('START:' + tid);
  for (const [k, pts2] of S.routeGeom || []) {
    const sp = k.indexOf('>');
    if (mine.has(k.slice(0, sp)) || mine.has(k.slice(sp + 1))) for (const q of pts2) pts.push(q);
  }
  // Guard: only accept points inside the Central Federal District box. The road
  // polylines come from portal vertices, and a stray index yields nonsense that
  // would otherwise drag the frame off the map entirely.
  const ok = pts.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])
    && p[0] > 53 && p[0] < 58 && p[1] > 34 && p[1] < 42);
  if (ok.length < 2) return;
  let la = 90, lo = 180, ha = -90, ho = -180;
  for (const p of ok) { la = Math.min(la, p[0]); ha = Math.max(ha, p[0]); lo = Math.min(lo, p[1]); ho = Math.max(ho, p[1]); }
  const spanX = Math.max(1e-7, lon2xDeg(ho) - lon2xDeg(lo));
  const spanY = Math.max(1e-7, lat2yDeg(la) - lat2yDeg(ha));
  const z = Math.max(11, Math.min(15, Math.floor(Math.min(
    Math.log(cMap.w / (spanX * 256)) / Math.LN2,
    Math.log(cMap.h / (spanY * 256)) / Math.LN2) + 1)));
  S.teamBox = { minLat: la, maxLat: ha, minLon: lo, maxLon: ho, z, n: ok.length };
  if (force || !cMap.visible(lo, la, ho, ha)) {
    cMap.fit(lo, la, ho, ha, 40);
    // fit animates: re-render once it settles, otherwise the z>=14 label
    // threshold is evaluated on an intermediate (wrong) zoom
    clearTimeout(fitTeam._t);
    fitTeam._t = setTimeout(() => { if (S.plan) renderMap(); }, 700);
  }
}

function fitAll() {  // settle-fit: re-run after layout has been measured
  if (!S.reqs || !S.reqs.length || !cMap) return;
  const c = cMap.host.getBoundingClientRect();
  // Prefer what is actually drawn: assigned requests + team starts. Falling back
  // to the whole request set drags the frame out to the Kashira tail (54.84 N),
  // which is a real point but not where the day's work is.
  const pts = [];
  const put = (la, lo) => {
    la = Number(la); lo = Number(lo);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return;
    if (Math.abs(la) > 90 || Math.abs(lo) > 180) return;
    if (lo < 36.5 || lo > 38.5 || la < 54.3 || la > 56.2) return;   // ЦФО guard
    pts.push([la, lo]);
  };
  if (S.plan) {
    for (const a of S.plan.assignments || []) {
      const r = reqById.get(a.request_id);
      if (r) put(r.lat, r.lon);
    }
    for (const t of S.teams) {
      if ((S.plan.perTeam && S.plan.perTeam.get(t.id)) || !S.plan.assignments) put(t.lat, t.lon);
    }
  }
  if (pts.length < 4) { pts.length = 0; for (const r of S.reqs) put(r.lat, r.lon); }
  if (pts.length < 2) return;
  // Trim the 4% tail on each axis so a handful of far outliers cannot zoom the
  // whole console out to the oblast.
  const ax = pts.map((p) => p[0]).sort((a, b) => a - b);
  const ay = pts.map((p) => p[1]).sort((a, b) => a - b);
  const q = (arr, t) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(t * (arr.length - 1))))];
  // Median-centred box at the 80% bulk: a plain min/max or even a 4% trim lets
  // the three Kashira-tail points (54.84 N / 38.24 E) still set the frame.
  const b = {};
  for (const [k, arr] of [['Lat', ax], ['Lon', ay]]) {
    const mid = q(arr, 0.5), half = Math.max(0.012, (q(arr, 0.8) - q(arr, 0.2)) * 0.6);
    b['min' + k] = mid - half; b['max' + k] = mid + half;
  }
  const spanX = Math.max(1e-7, lon2xDeg(b.maxLon) - lon2xDeg(b.minLon));
  const spanY = Math.max(1e-7, lat2yDeg(b.minLat) - lat2yDeg(b.maxLat));
  const z = Math.max(10, Math.min(13, Math.floor(Math.min(
    Math.log2(Math.max(1, c.width) / (spanX * 256)),
    Math.log2(Math.max(1, c.height) / (spanY * 256))))));
  cMap.fit(b.minLon, b.minLat, b.maxLon, b.maxLat, 30);
  S.fitted = true;
  S.mapBox = b;
}

// ----------------------------------------------------------------- overlay
const ov = { on: false, bar: null, ms: null, log: null };
function overlay(title, sub, keep, entries) {
  $('overlay').style.display = 'grid';
  ov.on = true; ov.bar = $('ov-bar'); ov.ms = $('ov-ms'); ov.log = $('ov-log');
  $('ov-t').textContent = title;
  $('ov-s').textContent = sub || '';
  if (keep == null) { $('ov-bar').style.width = '0%'; }
  $('ov-log').innerHTML = '';
  for (const e of entries || []) log($('ov-log'), e);
  $('ov-k').textContent = keep == null ? '' : keep;
}
function closeOverlay() { $('overlay').style.display = 'none'; ov.on = false; }
function log(host, s) {
  const d = el('div', '', s);
  host.appendChild(d);
  if (host.children.length > 60) host.removeChild(host.firstChild);
}

function setChip(which, state, text) {
  const c = $('chip-' + which);
  if (!c) return;
  c.className = 'chip ' + (state || '');
  c.textContent = text;
  const t = $('chip-' + which + '-t');
  if (t) t.textContent = text;
}

// -------------------------------------------------------------------- boot
function toggleTraffic() {
  S.traffic = loadTraffic({ on: !S.traffic.on });
  const b = $('traffic');
  b.classList.toggle('on', S.traffic.on);
  b.textContent = S.traffic.on ? 'Пробки вкл' : 'Пробки выкл';
  b.title = TRAFFIC_META.label + ' — ' + TRAFFIC_META.note;
  if (S.plan) runSolve();
}

async function loadScenario(kind) {
  S.phase = 'scenario-start';
  expose();
  overlay('Загрузка сценария', kind, null, []);
  const r = await fetch('./data/scenario_' + kind + '.json');
  const j = await r.json();
  S.scen = j;
  S.reqs = j.requests;
  S.teams = j.teams;
  j.byTeam = new Map();
  for (const t of j.teams) j.byTeam.set(t.id, []);
  S.scen.districts = [...new Set(j.requests.map((r) => r.shard))].sort();
  S.filter = { type: 'all', team: 'all', district: 'all', sel: new Set() };
  S.sel = null; S.selTeam = null; S.plan = null; S.model = null;
  idx();
  S.phase = 'scenario-loaded';
  expose();
  closeOverlay();
  buildFilters();
  S.phase = 'prerender';
  expose();
  render();
  S.phase = 'prerender-done';
  expose();
  fitAll();
  S.phase = 'solving-request';
  expose();
  // ask the router for this scenario
  setChip('map', 'busy', 'роутер: считаю матрицу…');
  overlay('Маршруты по квантам', `${S.reqs.length} заявок · ${S.teams.length} бригад · SSSP в браузере`, 0, ['снаппинг точек…']);
  worker.postMessage({
    cmd: 'solve',
    reqs: S.reqs.map((r) => ({ key: r.id, lat: r.lat, lon: r.lon })),
    teams: S.teams.map((t) => ({ key: 'START:' + t.id, lat: t.lat, lon: t.lon })),
  });
}

function buildFilters() {
  const types = ['all', 'connection', 'repair', 'accident', 'extra_order'];
  const dists = ['all'].concat(S.scen.districts);
  $('filters').innerHTML =
    `<div class="pillbar">${types.map((t) => `<button class="pill${S.filter.type === t ? ' on' : ''}" data-t="${t}">${t === 'all' ? 'все' : RTYPE_RU[t]}</button>`).join('')}</div>`
    + `<div class="pillbar">${dists.map((d) => `<button class="pill${S.filter.district === d ? ' on' : ''}" data-d="${d}">${d === 'all' ? 'все участки' : d}</button>`).join('')}</div>`;
  $('filters').querySelectorAll('[data-t]').forEach((b) => {
    b.onclick = () => { S.filter.type = b.dataset.t; buildFilters(); render(); };
  });
  $('filters').querySelectorAll('[data-d]').forEach((b) => {
    b.onclick = () => { S.filter.district = b.dataset.d; buildFilters(); render(); };
  });
  $('scenario').innerHTML = '<option value="100">100 заявок</option><option value="1000">1000 заявок</option>';
}

function wire() {
  $('scenario').onchange = (e) => loadScenario(e.target.value);
  $('traffic').onclick = toggleTraffic;
  $('traffic').title = TRAFFIC_META.label + ' — ' + TRAFFIC_META.note;
  $('run').onclick = () => runSolve();
  $('reroute').onclick = () => {
    // REROUTE: freeze every already-finished job, replan the remainder.
    const now = 720;  // 12:00 checkpoint
    const p = S.plan;
    if (!p) return;
    S.filter.sel = new Set(p.assignments.filter((a) => a.end <= now).map((a) => a.request_id));
    overlay('Переплан с 12:00', `${S.filter.sel.size} заявок заморожено как выполненные`, 0, ['пересчёт остатка…']);
    runSolve();
    setTimeout(closeOverlay, 900);
  };
  $('density').onclick = () => {
    S.dense = !S.dense;
    document.body.classList.toggle('compact', S.dense);
    $('density').textContent = S.dense ? 'Обычно' : 'Компактно';
  };
  $('viewmode').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      S.view = b.dataset.v;
      $('viewmode').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      const st = $('stage');
      st.classList.toggle('split', S.view === 'split');
      st.classList.toggle('only-map', S.view === 'map');
      st.classList.toggle('only-grid', S.view === 'grid');
      if (cMap) { setTimeout(() => cMap.resize(), 30); fitAll(); }
    };
  });
  $('zoomfit').onclick = fitAll;
  const bm = $('basemap2');
  bm.onchange = () => { if (cMap) cMap.setSource(bm.value); };
  $('f-selall').onclick = () => { S.filter.sel = new Set(S.reqs.map((r) => r.id)); render(); };
  $('f-used').onclick = () => { S.filter.sel = new Set(); render(); };
  $('overlay').onclick = (e) => { if (e.target.id === 'overlay') closeOverlay(); };
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeOverlay(); S.sel = null; render(); }
  });
  window.addEventListener('resize', () => { if (cMap) cMap.resize(); });
}

async function main() {
  cMap = new CMap($('mapwrap'), {
    onView: () => {
      const v = cMap.view();
      $('scaletext').textContent = `z${v.z} · ${v.lat.toFixed(4)}, ${v.lon.toFixed(4)}`;
    },
    // request/team labels switch on at z>=14, so the layers do need one rebuild
    // when the zoom settles - but only then, never during the animation.
    onZoomEnd: () => { if (S.plan) renderMap(); },
    onSegClick: (sid) => {
      const h = String(sid).split('#');
      focusSeg(h[0], +h[1]);
    },
    onClick: (ref, kind) => {
      if (kind === 'req') selectRequestId(ref);
      else if (kind === 'team') { selectTeamId(ref); }
      else if (kind === 'place') {
        const pl = PLACES.find((x) => x.key === ref);
        if (pl) cMap.flyTo(pl.lon, pl.lat, Math.max(13, cMap.z));
        render();
      }
    },
  });
  window.cMap = cMap; window.S = S;   // console/tooling handle
  window.__act = { selectRequestId, selectTeamId, fitTeam, render, focusSeg };
  const srcs = cMap.sourceList();
  $('basemap2').innerHTML = srcs.map(([k, n]) => `<option value="${k}">${n}</option>`).join('');
  $('basemap2').value = 'esri';
  // Uniform k(h) in a replaceable slot: real per-edge data only has to return
  // an object with the same {on, kAt(minute), src, label, note, year} shape.
  // traffic ON by default: k(h) is the real ymarchive-2015 city-uniform factor,
  // and leaving it off silently hid rush hour from the whole plan.
  S.traffic = loadTraffic({ on: true });

  // Exact offline matrix, baked by tools/export_exact.py from the FULL 9M-node
  // CSR. Without it a few long legs (Kashira / Domodedovo) have neither a time
  // nor a drawn line; with it they are real. Absent file degrades honestly.
  
  wire();
  bootWorker();
  expose();
  await loadScenario('100');
}

// Ask the worker for the actual road polyline of every leg of every ACTIVE
// route. `routeCmd` keeps prev/prevE per pair, so this is the one place where
// the paths are real; the batch matrix above stores only times + km on purpose.
function requestRouteGeom() {
  if (!S.plan) return;
  const byTeam = new Map();
  for (const a of S.plan.assignments) {
    if (!byTeam.has(a.team_id)) byTeam.set(a.team_id, []);
    byTeam.get(a.team_id).push(a);
  }
  const pairs = [];
  for (const [tid, jobs] of byTeam) {
    const t = teamById.get(tid);
    if (!t) continue;
    jobs.sort((a, b) => a.start - b.start);
    let pLat = t.lat, pLon = t.lon, pKey = 'START:' + t.id;
    for (const a of jobs) {
      const r = reqById.get(a.request_id);
      if (!r) continue;
      pairs.push([pLat, pLon, r.lat, r.lon, pKey, r.id]);
      pLat = r.lat; pLon = r.lon; pKey = r.id;
    }
  }
  if (pairs.length) {
    S.geomWant = pairs.length;
    worker.postMessage({ cmd: 'route', pairs });
  }
}

window.addEventListener('error', (e) => { console.error('BOOTERR', e.message, e.filename + ':' + e.lineno, e.error && e.error.stack); });
main().catch((e) => { console.error('BOOTCATCH', (e && e.stack) || e); S.lastErr = String((e && e.stack) || e); S.phase = 'boot-failed'; expose(); });
