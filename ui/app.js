// Copyright (c) 2026 NumFast
// SPDX-License-Identifier: AGPL-3.0-only
/* UI-FIX4 API-BASE: единый API_BASE (дефолт http://127.0.0.1:8901, serve.py).
   UI serve.py:8901 = основной (статика+API). Порт 9999 (голый http.server) = тестовый, API там нет.
   Переопределение: window.__API_BASE. Статика (default_100.json) — относительно страницы. */
const API_BASE = (typeof window !== "undefined" && window.__API_BASE) || "http://127.0.0.1:8901";
/* UI-APP-3: Vue 3 + real solver. Boot: demo_bundle -> POST /api/assign (S0).
   Solve: POST /api/assign | /api/replan (+frozen from time-machine). No mocks in solve path. */
const { createApp } = Vue;
const fmt = m => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(Math.round(m % 60)).padStart(2, "0");
const parseHM = s => { const m = String(s || "").match(/(\d+):(\d+)/); return m ? (+m[1]) * 60 + (+m[2]) : null; };
const COLORS = { UNASSIGNED: "#9e9e9e", ASSIGNED: "#1f77b4", IN_PROGRESS: "#ff7f0e", DONE: "#2ca02c", CANCELLED: "#d62728", IMPOSSIBLE: "#7f0000", RESCHEDULED: "#9467bd" };
const STNAME = { UNASSIGNED: "не распределена", ASSIGNED: "распределена — ожидается", IN_PROGRESS: "выполняется", DONE: "выполнено", CANCELLED: "отменена", IMPOSSIBLE: "невозможна", RESCHEDULED: "перенесена" };
// UI-FIX6: цвета маршрутов по времени дня (4 корзины + легенда). Ноги без geometry из API — прямые пунктирные ("схематично", не выдавать за дороги).
const TOD = [
  { id: "утро", lo: 480, hi: 720, c: "#1f77b4" },
  { id: "день", lo: 720, hi: 960, c: "#2ca02c" },
  { id: "вечер", lo: 960, hi: 1200, c: "#ff7f0e" },
  { id: "поздно", lo: 1200, hi: 1440, c: "#9467bd" },
];
function todColor(m) { const t = TOD.find(b => m >= b.lo && m < b.hi); return t ? t.c : "#666"; }
function todName(m) { const t = TOD.find(b => m >= b.lo && m < b.hi); return t ? t.id : "?"; }
// UI-FIX7: радуга ног — цвет по индексу сегмента (hsl-градиент), не по времени дня.
function rainbowColor(i, n) { const d = Math.max(1, n || 1); return "hsl(" + Math.round((i * 360 / d) % 360) + " 80% 42%)"; }
// UI-ARROWS: стрелки направления вдоль ног (только отображение).
// Метод: маркеры-треугольники (SVG, повёрнутые по азимуту сегмента), цвет наследует ногу.
function legBearingDeg(aLat, aLon, bLat, bLon) {
  const dLo = (bLon - aLon) * Math.cos((aLat + bLat) * Math.PI / 360);
  const dLa = (bLat - aLat);
  return (Math.atan2(dLo, dLa) * 180 / Math.PI + 360) % 360;
}
function arrowIcon(color, bearing, cls) {
  const b = Math.round(((bearing % 360) + 360) % 360);
  return L.divIcon({ html: `<div class="leg-arrow${cls ? " " + cls : ""}"><svg width="14" height="14" viewBox="0 0 10 10"><path d="M5 0.5 L9.5 9.5 L0.5 9.5 Z" fill="${color}" stroke="#fff" stroke-width="0.9" transform="rotate(${b} 5 5)"/></svg></div>`, iconSize: [14, 14], iconAnchor: [7, 7], className: "" });
}
function addLegArrows(pts, color, sel) {
  // UI-FIX12: одна стрелка на КОНЦЕ микромаршрута порт→порт (у точки прибытия,
  // курс финального сегмента). Равномерной расстановки по линии нет.
  // sel=true — класс leg-arrow-sel (CSS-пульс keyframes legpulse).
  if (!Array.isArray(pts) || pts.length < 2 || !this._g || !this._g.route) return;
  try {
    const b = pts[pts.length - 1], a = pts[pts.length - 2];
    L.marker([b[0], b[1]], { icon: arrowIcon(color, legBearingDeg(a[0], a[1], b[0], b[1]), sel ? "leg-arrow-sel" : ""), interactive: false, keyboard: false }).addTo(this._g.route);
  } catch (e) { /* стрелка не прячет ногу */ }
}
// UI-FIX6 help: рейс TEAM-SE-08 (12 сегментов, ноги 62/60/41 мин вперемешку с 1-5 мин):
// синтетические точки плотные (Гаусс вокруг баз), реальные адреса разреженнее;
// 12 заявок/бригаду при плотной застройке — норма.
const SE08_HELP = "TEAM-SE-08: 12 перегонов, перегоны 62/60/41 мин вперемешку с 1–5 мин — синтетические точки плотные (Гаусс вокруг баз), реальные адреса разреженнее; 12 заявок/бригаду при плотной застройке — норма.";
// GENERAL-ROUTE: три честных бейджа (P0: старые тексты "вне дорожной сети,
// unreachable — см. UI_FULLQ.md" врали: UNREACH-PROOF доказал достижимость
// всех 6 ног в full-CSR — пак их просто не покрывает).
const GR_BADGE_LIVE = "pack-miss: печёного трека нет — считается живьём (/api/route full: snap→Dijkstra→polyline), не unreachable";
const GR_BADGE_NOPATH = "нет пути (точный Dijkstra исчерпал достижимую компоненту)";
const GR_BADGE_FOOT = "вне графа (foot/bike вне CSR-free кластерной карты: оценка haversine, не точное)";
function legGeom(a, b, geom) {
  // UI-RGJS-BIND: ломаная приоритет: roadgraph-js (клиент) > API geometry > прямая.
  // geom может нести {pts, schematic, src}. src: 'rgjs' | 'api' | 'schematic'.
  if (geom && Array.isArray(geom.pts) && geom.pts.length > 1)
    return { pts: geom.pts, schematic: !!geom.schematic, src: geom.src || "api" };
  if (Array.isArray(geom) && geom.length > 1) return { pts: geom.map(p => (Array.isArray(p) ? [p[0], p[1]] : [p.lat, p.lon])), schematic: false, src: "api" };
  return { pts: [[a.lat, a.lon], [b.lat, b.lon]], schematic: true, src: "schematic" };
}
// UI-FIX12: exact_geometry лениво per leg. Порты (CSR node ids) берутся снапом
// квантовой карты (RG.map). UI-FIX16: добора RG.mod.route нет — только батч
// enrichLegsRg (Q-lookup + port-polylines через RG.mod.batch); здесь кэш-only.
// Реальная геометрия из кэша enrich повышается до exact без пересчёта.
// Масса (контракт, Q-времена arrive/start/end) не затрагивается.
function ensureExactLeg(app, teamId, idx) {
  const stops = (app.stops || {})[teamId] || [];
  const s = stops[idx];
  if (!s || s.exact_geometry) return s ? s.exact_geometry : null;
  const team = (app.teamById || {})[teamId];
  const prev = idx === 0 ? (team && (team.start || team.home)) : app.reqById[stops[idx - 1].req];
  const cur = app.reqById[s.req];
  if (!prev || !cur || prev.lon == null || cur.lon == null || !RG.map || !RG.mod) return null;
  let porta = -1, portb = -1;
  try {
    porta = RG.mod.snap(RG.map, prev.lon, prev.lat).node;
    portb = RG.mod.snap(RG.map, cur.lon, cur.lat).node;
  } catch (_) { /* порты остались -1 */ }
  const key = teamId + "|" + s.req;
  const cached = (app._rgGeom || {})[key];
  const g0 = s.geometry;
  const src = (!cached || cached.schematic) && g0 && !g0.schematic && Array.isArray(g0.pts) && g0.pts.length > 1 ? g0 : cached;
  if (src && !src.schematic && Array.isArray(src.pts) && src.pts.length > 1) {
    s.exact_geometry = { pts: src.pts, schematic: false, src: "rgjs-exact", ports: [porta, portb], settled: null, dist_m: null };
    return s.exact_geometry;
  }
  if (src && src.schematic) {
    // enrich уже проверил car прямо/реверс + foot прямо/реверс: точной нет честно.
    s.exact_geometry = { pts: null, schematic: true, src: "schematic (нет точного)", ports: [porta, portb] };
    return s.exact_geometry;
  }
  // UI-FIX16 + UI-FULLDEFAULT: кэш-only остался только для legacy moscow.
  // На full-карте запрошенная нога считается точным одиночным route()
  // (car→car-реверс→foot→foot-реверс, как батч); это единицы вызовов.
  try {
    if (RG.map && RG.mod && RG.src === "full") {
      const team = (app.teamById || {})[teamId];
      const prof0 = rgProfileOf(team && team.vehicle);
      const seq = [[prof0, 1], [prof0, -1], ["foot", 1], ["foot", -1]];
      for (const [prof, dir] of seq) {
        let rr = null;
        try {
          rr = dir < 0
            ? RG.mod.route(RG.map, [cur.lon, cur.lat], [prev.lon, prev.lat], prof)
            : RG.mod.route(RG.map, [prev.lon, prev.lat], [cur.lon, cur.lat], prof);
        } catch (_) { rr = null; }
        if (rr && rr.reachable && Array.isArray(rr.polyline) && rr.polyline.length > 1) {
          const pts = rr.polyline.map(p => [p[1], p[0]]);
          s.exact_geometry = { pts: dir < 0 ? pts.reverse() : pts, schematic: false, src: "rgjs-exact", ports: [porta, portb], settled: rr.settled || null, dist_m: rr.distance_m != null ? rr.distance_m : null };
          return s.exact_geometry;
        }
      }
    }
  } catch (_) { /* ниже честный schematic */ }
  // UI-FIX16: per-leg Dijkstra запрещён — только батч enrichLegsRg (Q-lookup +
  // port-polylines через RG.mod.batch). Здесь кэш-only: точная геометрия уже
  // посчитана батчем; добора route() нет (иначе N×Float64Array(N) и фриз).
  s.exact_geometry = { pts: null, schematic: true, src: "schematic (вне батча: enrich не покрыл)", ports: [porta, portb], reason: "вне батча" };
  return s.exact_geometry;
}
// BROWSER-ONLY: exact legs ONLY from baked q-tracks (ui/q/tracks.json).
// No RG.mod.route / batch / Dijkstra in browser — CSR never loads.
// Miss legs (no baked track) stay honestly schematic-free (pts null → badge,
// no distant straight line).
function ensureExactLeg(app, teamId, idx) {
  const stops = (app.stops || {})[teamId] || [];
  const s = stops[idx];
  if (!s || s.exact_geometry) return s ? s.exact_geometry : null;
  // UI-TRACKS: enrich already set s.geometry via port-pair batch — reuse it.
  const g0 = s.geometry || (app._rgGeom || {})[teamId + "|" + s.req];
  if (g0 && !g0.schematic && Array.isArray(g0.pts) && g0.pts.length > 1) {
    s.exact_geometry = { pts: g0.pts, schematic: false, src: g0.src || "q-track", dur_ms: g0.dur_ms != null ? g0.dur_ms : null };
    return s.exact_geometry;
  }
  const key = teamId + "|" + s.req;
  const tr = (app._qTrack || {})[key]
    || (QL && QL.trackByPair ? QL.trackByPair(idx === 0 ? ("START:" + teamId) : stops[idx - 1].req, s.req) : null);
  if (tr && Array.isArray(tr.pts) && tr.pts.length > 1) {
    s.exact_geometry = { pts: tr.pts, schematic: false, src: tr.src || "q-track", dur_ms: tr.dur_ms != null ? tr.dur_ms : null };
    return s.exact_geometry;
  }
  s.exact_geometry = { pts: null, schematic: true, src: "q-miss", reason: GR_BADGE_LIVE };
  return s.exact_geometry;
}
// BROWSER-ONLY: roadgraph-js CSR loader REMOVED (9M full 332MB + moscow 24MB
// never fetched). Travel source = static quant pack ui/q/ (ClusterBuild
// matrices + QuantFull s1000/r3600 car/foot + snap/ports + baked tracks,
// ~17MB). RG.* names kept for status plumbing only.
const RG = { map: null, mod: null, status: "idle", note: "", real: 0, total: 0, src: "quant", _loading: null };
let QL = null;
function rgProfileOf(vehicle) {
  const v = String(vehicle || "auto").toLowerCase();
  return v === "foot" ? "foot" : "car";
}
async function apiEngine() {
  return apiFetch(["/api/engine"]);
}
async function loadQuantOnce(cb) {
  if (QL && QL.quant()) { if (cb) cb(); return QL.quant(); }
  if (RG._loading) { try { await RG._loading; } catch (_) {} if (cb) cb(); return QL ? QL.quant() : null; }
  RG.status = "loading";
  RG._loading = (async () => {
    QL = await import("./qlegs.js");
    const q = await QL.loadQuant("q");
    RG.status = "ready";
    RG.note = "quant s1000/r3600 car+foot, C=" + q.meta.C + ", tracks=" + Object.keys(q.tracks.legs || {}).length + " (CSR не грузится)";
  })();
  try { await RG._loading; }
  catch (e) { RG.status = "off"; RG.note = "quant недоступен: " + ((e && e.message) || e); }
  RG._loading = null;
  if (cb) cb();
  return QL ? QL.quant() : null;
}
async function loadRgMap(cb) { return loadQuantOnce(cb); }
function visibleTeamOf(app) {
  // UI-FIX22: геометрия лениво только видимой бригады (батч единиц ног,
  // не всех 78): выбор ноги > показанный путь > выбранная бригада > первая.
  if (!app) return null;
  if (app.selLeg && app.selLeg.team) return app.selLeg.team;
  if (app.showRouteTeam) return app.showRouteTeam;
  if (app.selTeam) return app.selTeam;
  const ts = app.teams || [];
  return ts.length ? ts[0].id : null;
}
// GENERAL-ROUTE: живой фолбэк вместо schematic. Miss-нога (нет печёного трека)
// считается живьём через GET /api/route (snap→порты→Dijkstra по port-графу,
// любая пара без предрасчёта): время/порты обновляются, линией не рисуем
// (трека нет — только пунктиры дом→порт). Schematic остаётся только при
// proven-no-path (точный Dijkstra) / foot-вне-графа. Только scope-бригада,
// последовательно (каждый запрос ~50мс).
async function enrichMissLive(app, legs) {
  // COLD31-DIAG: sequential full-CSR Dijkstra per miss leg (~2-15с/нога,
  // Python heapq N=9M, timeout 25с) — причина 31.7с первой бригады.
  // Инструментировано: console.time cold31:live + спиннер-прогресс live i/n.
  // Кэш пар frm|to|mode: повтор той же ноги стоит 0 (re-pick 0.07с).
  let live = 0, ms = 0;
  const t0 = performance.now();
  try { console.time("cold31:live"); } catch (_) {}
  app._liveCache = app._liveCache || {};
  let i = 0;
  for (const l of legs) {
    i++;
    const cacheKey = (l.frm || "") + "|" + (l.to || "") + "|" + (l.prof || "car");
    const hit = app._liveCache[cacheKey];
    if (hit) {
      const s = l.s;
      s.geometry = hit.g; try { app._rgGeom[l.key] = hit.g; } catch (_) {}
      if (hit.liveMin != null) { s.travelMinLive = hit.liveMin; l.liveMin = hit.liveMin; }
      if (hit.counted) live++;
      continue;
    }
    const s = l.s;
    const g = s && s.geometry;
    if (!g || !g.schematic || (g.pts && g.pts.length > 1)) continue;
    let r = null;
    try {
      try { if (app && app.spin) app.spin.label = "live " + i + "/" + legs.length; } catch (_) {}
      const u = "/api/route?lat1=" + l.alat + "&lon1=" + l.alon + "&lat2=" + l.blat + "&lon2=" + l.blon + "&mode=" + (l.prof === "foot" ? "foot" : "car");
      const resp = await fetch(u);
      if (!resp.ok) continue;
      r = await resp.json();
    } catch (_) { continue; }
    if (!r || r.error) continue;
    ms += r.live_ms || 0;
    // MISS-LIVE: достижимое живьём — трек в кэш и отрисовка (не schematic).
    // Schematic только после proven-no-path / foot-вне-графа.
    const poly = Array.isArray(r.polyline) ? r.polyline : null;
    const hasTrack = !!(r.ok && poly && poly.length > 1);
    const ng = {
      pts: hasTrack ? poly : null, schematic: !hasTrack,
      src: hasTrack ? "live-full" : "live-miss",
      reason: r.badge || GR_BADGE_LIVE,
      live: !!r.ok, live_s: r.duration_s != null ? r.duration_s : null,
      live_ms: r.live_ms != null ? r.live_ms : null,
      live_km: r.distance_m != null ? Math.round(r.distance_m / 10) / 100 : null,
      settled: r.settled != null ? r.settled : null,
      ports: r.ports || g.ports || null,
    };
    if (r.ok && r.duration_s != null) {
      l.liveMin = Math.round(r.duration_s / 60 * 100) / 100;
      s.travelMinLive = l.liveMin;
      if (hasTrack) live++;
    }
    s.geometry = ng;
    try { app._rgGeom[l.key] = ng; } catch (_) {}
    try { app._liveCache[cacheKey] = { g: ng, liveMin: l.liveMin != null ? l.liveMin : (s.travelMinLive != null ? s.travelMinLive : null), counted: !!(r.ok && hasTrack) }; } catch (_) {}
  }
  try { console.timeEnd("cold31:live"); } catch (_) {}
  return { live, ms: Math.round((performance.now() - t0) * 10) / 10 };
}
async function enrichLegsQ(app, onlyTeam) {
  // BROWSER-ONLY quant legs: времена батчем Q-lookup + геометрия из печёных
  // q-треков (ui/q/tracks.json). CSR не грузится, Dijkstra нет, сервер не
  // вызывается. План (done/assign) НЕ меняется — паритет по построению.
  // Miss-ноги (нет трека) получают pts:null + бейдж: дальних schematic-прямых нет.
  if (!app) return { real: 0, total: 0, ms: 0 };
  const t0 = performance.now();
  try { console.time("cold31:quant"); } catch (_) {}
  try { await loadQuantOnce(); } catch (_) {}
  try { console.timeEnd("cold31:quant"); } catch (_) {}
  if (!QL || !QL.quant()) {
    app.rgStatus = "quant: недоступен (" + RG.note + ") — перегоны бейджем, прямых нет";
    app.rgPct = 0;
    return { real: 0, total: 0, ms: Math.round(performance.now() - t0) };
  }
  const scope = onlyTeam || visibleTeamOf(app);
  app._rgGeom = app._rgGeom || {};
  app._qTrack = ((QL.quant().tracks || {}).legs) || {};
  const legs = [];
  for (const tid of Object.keys(app.stops || {})) {
    if (scope && tid !== scope) continue;
    const stops = app.stops[tid] || [];
    const team = (app.teamById || {})[tid];
    const prof = rgProfileOf(team && team.vehicle);
    const sh0 = (team && team.shift && team.shift[0]) || 480;
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      const prev = i === 0 ? (team && (team.start || team.home)) : app.reqById[stops[i - 1].req];
      const cur = app.reqById[s.req];
      if (!prev || !cur || prev.lon == null || cur.lon == null) continue;
      if ((prev.lat === 0 && prev.lon === 0) || (cur.lat === 0 && cur.lon === 0)) continue;
      legs.push({ key: tid + "|" + s.req, s, prof,
        frm: i === 0 ? ("START:" + tid) : stops[i - 1].req, to: s.req,
        alat: prev.lat, alon: prev.lon, blat: cur.lat, blon: cur.lon,
        planMin: Math.max(0, s.arrive - (i === 0 ? sh0 : stops[i - 1].end)) });
    }
  }
  try { console.time("cold31:batch"); } catch (_) {}
  const batch = QL.batchLegs(legs);
  try { console.timeEnd("cold31:batch"); } catch (_) {}
  try { console.log("cold31:batch", batch.ms + "мс legs=" + legs.length); } catch (_) {}
  let real = 0, qhit = 0;
  for (const r of batch.legs) {
    if (r.qHit) qhit++;
    if (r.track && Array.isArray(r.track.pts) && r.track.pts.length > 1) {
      const g = { pts: r.track.pts, schematic: false, src: r.track.src || "q-track", dur_ms: r.track.dur_ms != null ? r.track.dur_ms : null, q_ms: r.qExact_ms };
      app._rgGeom[r.key] = g;
      const s = (legs.find(l => l.key === r.key) || {}).s;
      if (s) s.geometry = g;
      real++;
    } else {
      const g = { pts: null, schematic: true, src: "q-miss",
        reason: GR_BADGE_LIVE + "; Q-lookup " + (r.qExact_ms != null ? ("hit " + Math.round(r.qExact_ms / 600) / 100 + "мин") : "miss") + ", snap≈" + r.snapA.d_m + "/" + r.snapB.d_m + "м",
        ports: (r.portA && r.portB) ? { pa: [r.portA[1], r.portA[0]], pb: [r.portB[1], r.portB[0]], snap_m: [r.snapA.d_m, r.snapB.d_m] } : null };
      app._rgGeom[r.key] = g;
      const s = (legs.find(l => l.key === r.key) || {}).s;
      if (s) s.geometry = g;
    }
  }
  const ms = Math.round((performance.now() - t0) * 10) / 10;
  RG.real = real; RG.total = legs.length;
  // GENERAL-ROUTE: miss-ноги scope-бригады — живьём (/api/route), не schematic-прямые.
  let liveInfo = "";
  try {
    const miss = legs.filter(l => { const s = (l.s && l.s.geometry); return s && s.schematic && !(s.pts && s.pts.length > 1); });
    if (miss.length) {
      const lr = await enrichMissLive(app, miss);
      liveInfo = ", live " + lr.live + "/" + miss.length + " (" + lr.ms + "мс)";
    }
  } catch (_) {}
  app.rgStatus = "quant: " + real + "/" + legs.length + " перегонов q-треки (" + (scope || "all") + ": Q-hit " + qhit + ", без ответа " + (legs.length - real) + " (бейдж, линии нет)" + liveInfo + ", batch " + batch.ms + "мс, load " + (QL.quant().load_ms || 0) + "мс)";
  app.rgPct = legs.length ? Math.round(real * 100 / legs.length) : null;
  app.runClientMs = ms;
  return { real, total: legs.length, ms };
}
async function enrichLegsRg_DEAD(app, onlyTeam) {
  // Пересчёт ног реальными ломаными route() поверх серверного плана.
  // План (done/assign) НЕ меняется — только geometry. Паритет done — по построению.
  // UI-FIX22: времена ног — серверный батч (assign Q-lookup, arrive/start/end);
  // здесь только геометрия, и только бригады onlyTeam (дефолт=видимая).
  // UI-FIX23: времена ног — серверный Q-lookup (assign arrive/start/end, legs-стадия
  // ~0.2мс); геометрия — лениво поверх готовых времён (port-polylines из матрицы:
  // 2-точечные отрезки порт→порт, без пересчёта). RG.mod.batch/route (full-Dijkstra
  // поштучно: moscow ~37мс/нога, full ~1.9с/нога → 13 ног до 29с с full-фолбэком)
  // здесь НЕ вызывается — только по явному opt-in app._rgFull. Паритет done — по построению.
  if (!app) return { real: 0, total: 0, ms: 0 };
  const t0 = performance.now();
  // UI-FULLDEFAULT: дефолт full — времена серверным батчем (assign Q-lookup),
  // геометрия лениво видимой бригаде батчем full-карты; exact-Dijkstra только
  // запрошенным ногам (ensureExactLeg). qlookup-ветка — только legacy moscow.
  if (!app._rgFull && RG.src !== "full") {
    const scope = onlyTeam || visibleTeamOf(app);
    app._rgGeom = app._rgGeom || {};
    let real = 0, total = 0;
    for (const tid of Object.keys(app.stops || {})) {
      if (scope && tid !== scope) continue;
      const stops = app.stops[tid] || [];
      const team = (app.teamById || {})[tid];
      for (let i = 0; i < stops.length; i++) {
        const s = stops[i];
        total++;
        const key = tid + "|" + s.req;
        const prev = i === 0 ? (team && (team.start || team.home)) : app.reqById[stops[i - 1].req];
        const cur = app.reqById[s.req];
        if (app._rgGeom[key] && app._rgGeom[key].src === "rgjs") { real++; continue; }
        if (prev && cur && prev.lat != null && cur.lat != null && prev.lon != null && cur.lon != null
          && !(prev.lat === 0 && prev.lon === 0) && !(cur.lat === 0 && cur.lon === 0)) {
          const g = { pts: [[prev.lat, prev.lon], [cur.lat, cur.lon]], schematic: true, src: "qlookup" };
          app._rgGeom[key] = g;
          if (!s.geometry) s.geometry = g;
        }
      }
    }
    const ms = Math.round(performance.now() - t0);
    app.rgStatus = "roadgraph-js: qlookup " + real + "/" + total + " (" + (scope || "all") + ", без Dijkstra, " + ms + "ms)";
    app.rgPct = total ? Math.round(real * 100 / total) : null;
    app.runClientMs = ms;
    return { real, total, ms };
  }
  try { await loadRgMap(); } catch (_) {}
  if (!RG.map || !RG.mod) {
    app.rgStatus = "roadgraph-js: недоступен (" + RG.note + ") — перегоны schematic";
    app.rgPct = 0;
    return { real: 0, total: 0, ms: Math.round(performance.now() - t0) };
  }
  let real = 0, total = 0, rev = 0, out = 0;
  app._rgGeom = app._rgGeom || {};
  // UI-FIX22: scope=onlyTeam||видимая (подсчёт real/total — в пределах scope,
  // чужие ноги не трогаем и не считаем).
  const scope = onlyTeam || visibleTeamOf(app);
  // UI-FIX13 п.4: короткие ноги первые (микрорайон 2-мин чинится раньше длинных).
  const jobs = [];
  for (const tid of Object.keys(app.stops || {})) {
    if (scope && tid !== scope) continue;
    const stops = app.stops[tid] || [];
    const team = (app.teamById || {})[tid];
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      const prev = i === 0 ? (team && (team.start || team.home)) : app.reqById[stops[i - 1].req];
      const cur = app.reqById[s.req];
      if (!prev || !cur || prev.lon == null || cur.lon == null) continue;
      const dLa = (cur.lat - prev.lat) * 111.0, dLo = (cur.lon - prev.lon) * 71.0;
      jobs.push({ tid, i, s, prev, cur, team, dh: dLa * dLa + dLo * dLo });
    }
  }
  jobs.sort((a, b) => a.dh - b.dh);
  // UI-FIX15: ноги батчем (RG.mod.batch, chunk 10 с yieldUi), не по 1с/шт:
  // один batch-проход на профиль вместо N синхронных Dijkstra (каждый со
  // своим Float64Array(N)); спиннер живёт — batch отдаёт управление UI.
  // Семантика та же: car-прямо → car-реверс → foot-прямо → foot-реверс.
  const okPoly = rr => !!(rr && rr.reachable && Array.isArray(rr.polyline) && rr.polyline.length > 1);
  const need = [];
  for (const j of jobs) {
    total++;
    const key = j.tid + "|" + j.s.req;
    if (app._rgGeom[key] && app._rgGeom[key].src === "rgjs") { real++; continue; }
    need.push(j);
  }
  const prog = (done, n) => {
    try { app.rgStatus = "roadgraph-js: считаю ноги " + done + "/" + n + " (" + RG.note + ")"; } catch (_) {}
  };
  const groups = {};
  for (const j of need) {
    const p = rgProfileOf(j.team && j.team.vehicle);
    (groups[p] || (groups[p] = [])).push(j);
  }
  const fwdMiss = [];
  for (const prof of Object.keys(groups)) {
    const g = groups[prof];
    const pairs = g.map(j => [j.prev.lon, j.prev.lat, j.cur.lon, j.cur.lat]);
    let res = [];
    try { res = await RG.mod.batch(RG.map, pairs, prof, 10, (d, n) => prog(d, total)); }
    catch (_) { res = []; }
    for (let k = 0; k < g.length; k++) {
      const j = g[k], r = res[k];
      if (okPoly(r)) {
        const pts = r.polyline.map(p => [p[1], p[0]]);
        const key = j.tid + "|" + j.s.req;
        app._rgGeom[key] = { pts, schematic: false, src: "rgjs" };
        j.s.geometry = app._rgGeom[key];
        real++;
      } else {
        j._fwdSnap = r ? r.snap_mm.map(Math.round) : null;
        j._prof = prof;
        fwdMiss.push(j);
      }
    }
  }
  // UI-FIX9: реверс батчем (те же дороги, полилиния реверсируется).
  const revMiss = [];
  {
    const rgroups = {};
    for (const j of fwdMiss) {
      const p = j._prof || "car";
      (rgroups[p] || (rgroups[p] = [])).push(j);
    }
    for (const prof of Object.keys(rgroups)) {
      const g = rgroups[prof];
      const pairs = g.map(j => [j.cur.lon, j.cur.lat, j.prev.lon, j.prev.lat]);
      let res = [];
      try { res = await RG.mod.batch(RG.map, pairs, prof, 10, (d, n) => prog(d, total)); }
      catch (_) { res = []; }
      for (let k = 0; k < g.length; k++) {
        const j = g[k], rr = res[k];
        if (okPoly(rr)) {
          const pts = rr.polyline.map(p => [p[1], p[0]]).reverse();
          const key = j.tid + "|" + j.s.req;
          app._rgGeom[key] = { pts, schematic: false, src: "rgjs-rev" };
          j.s.geometry = app._rgGeom[key];
          real++; rev++;
        } else {
          j._revSnap = rr ? rr.snap_mm.map(Math.round) : null;
          revMiss.push(j);
        }
      }
    }
  }
  // UI-FIX11: foot-фолбэк батчами (вперёд, затем реверс).
  const footMiss = [];
  {
    const pairs = revMiss.map(j => [j.prev.lon, j.prev.lat, j.cur.lon, j.cur.lat]);
    let res = [];
    if (pairs.length) {
      try { res = await RG.mod.batch(RG.map, pairs, "foot", 10, (d, n) => prog(d, total)); }
      catch (_) { res = []; }
    }
    for (let k = 0; k < revMiss.length; k++) {
      const j = revMiss[k], fr = res[k];
      if (okPoly(fr)) {
        const pts = fr.polyline.map(p => [p[1], p[0]]);
        const key = j.tid + "|" + j.s.req;
        app._rgGeom[key] = { pts, schematic: false, src: "rgjs-foot" };
        j.s.geometry = app._rgGeom[key];
        real++; rev++;
      } else {
        j._footSnap = fr ? fr.snap_mm.map(Math.round) : null;
        footMiss.push(j);
      }
    }
  }
  {
    const pairs = footMiss.map(j => [j.cur.lon, j.cur.lat, j.prev.lon, j.prev.lat]);
    let res = [];
    if (pairs.length) {
      try { res = await RG.mod.batch(RG.map, pairs, "foot", 10, (d, n) => prog(d, total)); }
      catch (_) { res = []; }
    }
    const stillMiss = [];
    for (let k = 0; k < footMiss.length; k++) {
      const j = footMiss[k], fr2 = res[k];
      if (okPoly(fr2)) {
        const pts = fr2.polyline.map(p => [p[1], p[0]]).reverse();
        const key = j.tid + "|" + j.s.req;
        app._rgGeom[key] = { pts, schematic: false, src: "rgjs-foot-rev" };
        j.s.geometry = app._rgGeom[key];
        real++; rev++;
      } else {
        j._footRevSnap = fr2 ? fr2.snap_mm.map(Math.round) : null;
        stillMiss.push(j);
      }
    }
    // UI-FIX20: snap-miss moscow -> автопересчёт этих ног на full, пометка src=full.
    // Обе вне покрытия -> честный schematic с причиной.
    let fullFb = 0;
    if (RG.src === "moscow" && stillMiss.length) {
      try {
        const fmap = await rgFullMapCached();
        const runBatch = async (list, prof, dir) => {
          const pairs = list.map(j => dir < 0 ? [j.cur.lon, j.cur.lat, j.prev.lon, j.prev.lat] : [j.prev.lon, j.prev.lat, j.cur.lon, j.cur.lat]);
          let rr = [];
          try { rr = await RG.mod.batch(fmap, pairs, prof, 10, (d, n) => prog(d, total)); }
          catch (_) { rr = []; }
          return rr;
        };
        let pending = stillMiss.splice(0, stillMiss.length);
        // Проход 1: исходный профиль прямо на full.
        {
          const byP = {};
          for (const j of pending) { const p = j._prof || "car"; ((byP[p] = byP[p] || [])).push(j); }
          const next = [];
          for (const p of Object.keys(byP)) {
            const g = byP[p], rr = await runBatch(g, p, 1);
            for (let k = 0; k < g.length; k++) {
              const j = g[k], r = rr[k];
              if (okPoly(r)) {
                const pts = r.polyline.map(q => [q[1], q[0]]);
                const key = j.tid + "|" + j.s.req;
                app._rgGeom[key] = { pts, schematic: false, src: "rgjs-full" };
                j.s.geometry = app._rgGeom[key];
                j._fullSnap = r.snap_mm.map(Math.round);
                real++; fullFb++;
              } else { j._fullSnap = r ? r.snap_mm.map(Math.round) : null; next.push(j); }
            }
          }
          pending = next;
        }
        // Проход 2: реверс на full.
        if (pending.length) {
          const byP = {};
          for (const j of pending) { const p = j._prof || "car"; ((byP[p] = byP[p] || [])).push(j); }
          const next = [];
          for (const p of Object.keys(byP)) {
            const g = byP[p], rr = await runBatch(g, p, -1);
            for (let k = 0; k < g.length; k++) {
              const j = g[k], r = rr[k];
              if (okPoly(r)) {
                const pts = r.polyline.map(q => [q[1], q[0]]).reverse();
                const key = j.tid + "|" + j.s.req;
                app._rgGeom[key] = { pts, schematic: false, src: "rgjs-full-rev" };
                j.s.geometry = app._rgGeom[key];
                j._fullRevSnap = r.snap_mm.map(Math.round);
                real++; rev++; fullFb++;
              } else { j._fullRevSnap = r ? r.snap_mm.map(Math.round) : null; next.push(j); }
            }
          }
          pending = next;
        }
        // Проход 3-4: foot прямо плюс реверс на full.
        if (pending.length) {
          const rr = await runBatch(pending, "foot", 1);
          const next = [];
          for (let k = 0; k < pending.length; k++) {
            const j = pending[k], r = rr[k];
            if (okPoly(r)) {
              const pts = r.polyline.map(q => [q[1], q[0]]);
              const key = j.tid + "|" + j.s.req;
              app._rgGeom[key] = { pts, schematic: false, src: "rgjs-full-foot" };
              j.s.geometry = app._rgGeom[key];
              real++; rev++; fullFb++;
            } else { j._fullFootSnap = r ? r.snap_mm.map(Math.round) : null; next.push(j); }
          }
          pending = next;
        }
        if (pending.length) {
          const rr = await runBatch(pending, "foot", -1);
          const next = [];
          for (let k = 0; k < pending.length; k++) {
            const j = pending[k], r = rr[k];
            if (okPoly(r)) {
              const pts = r.polyline.map(q => [q[1], q[0]]).reverse();
              const key = j.tid + "|" + j.s.req;
              app._rgGeom[key] = { pts, schematic: false, src: "rgjs-full-foot-rev" };
              j.s.geometry = app._rgGeom[key];
              real++; rev++; fullFb++;
            } else { next.push(j); }
          }
          pending = next;
        }
        for (const j of pending) stillMiss.push(j);
        try { console.warn("[fix20] full-fallback", "fixed=" + fullFb, "left=" + stillMiss.length); } catch (_) {}
        app._fullFb = fullFb;
      } catch (e) { try { console.warn("[fix20] full-fallback fail", String((e && e.message) || e)); } catch (_) {} app._fullFb = 0; }
    }
    for (let k = 0; k < stillMiss.length; k++) {
      const j = stillMiss[k];
      {
        out++;
        const key = j.tid + "|" + j.s.req;
        // UI-FIX16: точная причина schematic (бейдж в панели showRoute, списком).
        // UI-FIX19: разрыв конец–дом >300м → автодиагностика в лог (координаты
        // обоих концов + причина); снап >300м → OUTLIER + адрес честно, не молча.
        const _snaps = [j._fwdSnap, j._revSnap, j._footSnap, j._fullSnap, j._fullRevSnap, j._fullFootSnap].filter(s => s && s.every(v => v != null && v >= 0));
        const _maxSnapM = _snaps.length ? Math.max(..._snaps.flat()) / 1000 : -1;
        const snapBad = [j._fwdSnap, j._revSnap, j._footSnap].some(s => !s || s.some(v => v == null || v < 0));
        const outlier = snapBad || _maxSnapM > 300;
        // UI-MERGE (ui2 §СНАП/§6): честная метка прямых: нулевая нога = same-cluster, иначе unreachable/вне покрытия.
        const _same = Math.abs((j.cur.lat || 0) - (j.prev.lat || 0)) < 1e-9 && Math.abs((j.cur.lon || 0) - (j.prev.lon || 0)) < 1e-9;
        const base = _same ? "same-cluster (нулевая нога)" : (snapBad ? "вне покрытия (snap -1)" : "unreachable (car+foot прямо/реверс недостижимы)");
        const reason = (outlier ? "OUTLIER " : "") + base + " (снап≈" + (_maxSnapM < 0 ? "?" : Math.round(_maxSnapM) + "м") + "; " + (j.cur.addr || j.cur.address || "адрес из заявки") + "; full-тоже вне покрытия)";
        try { console.warn("[rgjs] schematic", key, reason, "frm=[" + j.prev.lat + "," + j.prev.lon + "] to=[" + j.cur.lat + "," + j.cur.lon + "]",
          "fwd_snap_mm=" + JSON.stringify(j._fwdSnap),
          "rev_snap_mm=" + JSON.stringify(j._revSnap),
          "foot_snap_mm=" + JSON.stringify(j._footSnap),
          "full_snap_mm=" + JSON.stringify(j._fullSnap),
          "full_rev_snap_mm=" + JSON.stringify(j._fullRevSnap),
          "full_foot_snap_mm=" + JSON.stringify(j._fullFootSnap)); } catch (_) {}
        app._rgGeom[key] = { pts: [[j.prev.lat, j.prev.lon], [j.cur.lat, j.cur.lon]], schematic: true, src: "schematic (" + reason + ")", reason };
        if (!j.s.geometry) j.s.geometry = app._rgGeom[key];
        else if (j.s.geometry.schematic) { j.s.geometry.src = "schematic (" + reason + ")"; j.s.geometry.reason = reason; }
      }
    }
  }
  const ms = Math.round(performance.now() - t0);
  RG.real = real; RG.total = total;
  app.rgStatus = "roadgraph-js: " + real + "/" + total + " ног реальные (" + (scope || "all") + ": прямо " + (real - rev) + " + реверс " + rev + ", schematic " + out + ", full-fallback " + (app._fullFb || 0) + ", " + RG.note + ", " + ms + "ms)";
  app.rgPct = total ? Math.round(real * 100 / total) : null;
  app.runClientMs = ms;
  return { real, total, ms };
}
// Compact 20px divIcon pins (UI-FIX5.5): заявки — кружки, здания — квадратики,
// бригады — по транспорту (3 вида: foot/bicycle/auto). Задел: анимированные фигурки геймдизайнера v2.
function pin(emoji, cls) { return L.divIcon({ html: `<div class="pin ${cls || ""}">${emoji}</div>`, iconSize: [20, 20], iconAnchor: [10, 10], popupAnchor: [0, -10], className: "" }); }
// UI-FIX16: жирные концы выбранной ноги (×1.5 + обводка 3px, 30px divIcon).
function pinEnd(emoji, cls) { return L.divIcon({ html: `<div class="pin-endpoint ${cls || ""}">${emoji}</div>`, iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -15], className: "" }); }
const PINS = { off: () => pin("🏢", "pin-bld"), team: () => pin("🚐", "pin-team-auto"), cafe: () => pin("☕", "pin-bld"), home: () => pin("🏠", "pin-bld") };
const TEAM_PIN = { foot: () => pin("🚶", "pin-team-foot"), bicycle: () => pin("🚲", "pin-team-bike") };
function teamPin(vehicle) { return (TEAM_PIN[vehicle] || PINS.team)(); }
// Server reject codes -> human (display map only, codes come from /api/* responses)
const REASONS = {
  no_skill: "нет навыка у бригады", NO_SKILL: "нет навыка у бригады",
  NO_WINDOW_FIT: "окно не пересекает смену/план", NO_WINDOW: "окно не пересекает смену",
  OVERLOAD_HOUR: "не влезает по времени (дорога+работа)", OVERLOAD_TIME: "не влезает по времени",
  NO_CAPACITY: "нет вместимости у бригады", NO_SHIFT: "нет смены",
  NO_VEHICLE: "транспорт несовместим", NO_EQUIP: "нет оборудования",
  UNREACHABLE: "маршрут недостижим", CANCELLED_OP: "снята оператором",
  TRAVEL_INFEASIBLE: "не успеть до конца окна (дорога)", window_missed: "старт вне окна",
  overload: "не влезает в смену", TRAVEL: "дорога",
};
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
async function apiFetch(paths, opts) {
  // UI-FIX4: paths = ["/api/x"]; сначала API_BASE, затем same-origin (работа через 8901 без CORS)
  const urls = [];
  for (const p of paths) { urls.push(API_BASE + p); urls.push(p); }
  let lastErr = null;
  for (const u of urls) {
    try {
      const r = await fetch(u, opts);
      if (!r.ok) { lastErr = new Error(u + " " + r.status); continue; }
      return r.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("fetch failed");
}
async function apiAssign(payload) {
  return apiFetch(["/api/assign"], { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}
async function apiReplan(payload) {
  return apiFetch(["/api/replan"], { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}
async function apiStrategies() {
  return apiFetch(["/api/strategies"]);
}
// SOLVER-JS: S0 целиком в браузере (solver.js, ESM). Паритет vs Python assign(S0):
// toy4 3/3, canon100 82/82, canon1000 903/903, violations 0 (см. SOLVER_JS.md).
// S1–S4 только на сервере. roadgraph-js здесь не подмешивается (parity-режим legs+haversine).
async function solveBrowser(payload) {
  const mod = await import("./solver.js");
  const cfg = (payload && payload.config) || {};
  const r = mod.assign(payload.requests, payload.teams, payload.travel, { strategy: "S0", seed: cfg.seed ?? 42 });
  r.engine = "browser"; r.assign_ms = r.wall_ms; r.frozen = 0; r.doneNew = r.done;
  return r;
}
function skillsOf(mask, bits) {
  const out = [];
  for (const [bit, name] of Object.entries(bits || { 1: "connect", 2: "cable_repair", 4: "gigabit_climb" }))
    if ((mask & bit) === +bit) out.push(name);
  return out;
}
function havKm(aLat, aLon, bLat, bLon) {  const R = 6371.0, dLa = (bLat - aLat) * Math.PI / 180, dLo = (bLon - aLon) * Math.PI / 180;
  const s = Math.sin(dLa / 2) ** 2 + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const SPEEDS = { auto: 28.0, scooter: 28.0, bicycle: 14.0, foot: 4.5 };
// UI-FIX24 п.13: витрина оборудования (display-only, API не меняется):
// склад из inventory (serve: stock via contract equip/stock), взято — из модели
// (детерминированно от числа назначенных заявок бригады, без новых endpoint).
const INVENTORY = { stock: { router: 40, stb: 40, alice: 20 } };
// NO-SCHEMATIC: честный счётчик времён как у ui2 (точные/приближённые/без ответа).
// miss (без ответа) — бейдж+счётчик, не silent 15мин/3км.
function travelCounter(res) {
  if (!res || (res._travelLeg == null && res._travelFb == null && res._travelUniform == null)) return "";
  const leg = res._travelLeg ?? 0, fb = res._travelFb ?? 0, un = res._travelUniform ?? 0;
  return ` · времён: точные ${leg} · приближённые ${fb} · без ответа ${un}` + (un > 0 ? " (бейдж, не 15мин/3км)" : "");
}
function bundleToContract(reqs, teams, bits, legs) {
  // F1 TRAVEL-WIRE-FIX: real travel legs (OSRM-cache on server + haversinex1.3 here).
  // Uniform default_t/default_km = last-resort UNRELIABLE only, never silent real travel.
  // region "": demo_bundle single-area (teams have no district) + solver
  // prefilters team.region_id != req.region_id; toy precedent ""=="".
  // Travel GAP: solver looks up START:{team}->req / req->req; matrix has
  // (req,team) only -> server default_t/default_km applies. Passthrough kept.
  const requests = reqs.map(r => ({
    id: r.id, region: "", ws: r.window[0], we: r.window[1],
    dur: r.duration_min || 50, skills: skillsOf(r.req_mask || 0, bits),
    equip: {}, appear: r.window[0], prio: 1.0, rtype: "repair", lat: r.lat || 0, lon: r.lon || 0 }));
  const tm = teams.map(t => ({
    id: t.id, region: "", skills: skillsOf(t.skill_mask || 0, bits),
    mode: t.vehicle || "auto", sh0: t.shift[0], sh1: t.shift[1], lat: t.start.lat, lon: t.start.lon }));
  let outLegs = legs || [];
  if (!outLegs.length) {
    outLegs = [];
    const pt = {};
    for (const r of reqs) pt[r.id] = [r.lat || 0, r.lon || 0];
    for (const t of teams) pt["START:" + t.id] = [t.start.lat, t.start.lon];
    const pushLeg = (frm, to, mode) => {
      const a = pt[frm], b = pt[to];
      if (!a || !b) return;
      const km = havKm(a[0], a[1], b[0], b[1]) * 1.3;
      const sp = SPEEDS[mode] || SPEEDS[String(mode).toLowerCase()] || 28.0;
      outLegs.push({ frm, to, mode: "auto", t_min: Math.round(km / sp * 60), d_km: Math.round(km * 1000) / 1000 });
    };
    for (const t of teams) for (const r of reqs) pushLeg("START:" + t.id, r.id, t.vehicle || "auto");
    for (const a of reqs) for (const b of reqs) if (a.id !== b.id) pushLeg(a.id, b.id, "auto");
  }
  return { requests, teams: tm, travel: { legs: outLegs, default_t: 15, default_km: 3.0 } };
}
function applyServerPlan(reqs, res, keepIds) {
  const keep = keepIds instanceof Set ? keepIds : new Set(keepIds || []);
  const byId = Object.fromEntries(res.assignments.map(a => [a.request_id, a]));
  for (const r of reqs) {
    if (keep.has(r.id)) continue; // UI-FIX1.4 frozen prefix stays untouched
    const a = byId[r.id];
    if (a) {
      r.status = "ASSIGNED"; r.team = a.team_id; delete r.reason;
      r.plan = { team: a.team_id, arrive: a.arrive, start: a.start, end: a.end, travel_min: Math.max(0, a.start - a.arrive) };
    } else if (res.rejected && res.rejected[r.id]) {
      r.status = "IMPOSSIBLE"; r.team = null; r.reason = res.rejected[r.id]; delete r.plan;
    } else if (r.status !== "CANCELLED" && r.status !== "RESCHEDULED") {
      r.status = "UNASSIGNED"; r.team = null; delete r.plan; delete r.reason;
    }
  }
}

createApp({
  data() {
    return {
      proj: "Москва Билайн", tab: "map", bootErr: "", busy: false,
      reqs: [], teams: [], members: {}, offices: [], cafes: [], districts: [],
      reqById: {}, teamById: {}, byTeam: {}, stops: {}, travelLegs: [], skillBits: null,
      strategies: [], optionsSpec: {}, prodBaseline: null,
      strategy: "S0", seed: 42, solverPlace: "browser", engine: "cpu", engineInfo: null, gpuReason: "",
      rgStatus: "roadgraph-js: не загружен", rgPct: null, runClientMs: null, toggles: { lunch: false, homeEnd: false, warehouse: false, footTransit: false },
       // UI-FIX10: спиннер расчёта (угол + "считаю... Nс"), блокирует дабл-клики через busy+оверлей.
      spin: { on: false, label: "", sec: 0 },
       // UI-FIX15 + UI-FULLDEFAULT: logOpen — свернуть/развернуть плавающий профайлер кликом по
       // спиннеру или крестиком; rgSrc — travel-источник, дефолт full
       // (ЦФО, канон v1), moscow только явным выбором "legacy".
       bootLog: [], logOpen: true, rgSrc: "full",
      prog: 0, solveMetrics: "", genInfo: "Пресеты задают N/M; решение — реальным solver через /api/assign.",
      runs: [], projInfoText: "", routeInfo: "Клик по бригаде → только её полный путь.",
      flt: { q: "", team: "all", district: "all", status: ["UNASSIGNED", "ASSIGNED", "IN_PROGRESS", "DONE", "IMPOSSIBLE"], showCancelled: false },
       layers: { off: true, req: true, team: true, cafe: true, route: true, transit: true },
       // UI-FIX17: TransitLayer — 12k остановок ОТ (ui/transit_stops.json),
       // кластеризованно/зум-зависимо (grid-кластер, кап ~2000 маркеров).
       transit: { pts: [], loaded: false, rendered: "" },
       now: 480, selTeam: null, showRouteTeam: null, selReq: null, selLeg: null, frozenIds: new Set(), autoFit: true,
      statuses: ["UNASSIGNED", "ASSIGNED", "IN_PROGRESS", "DONE", "IMPOSSIBLE"],
      reqStatus: "", reqReason: "", reqTimes: "", reqForm: { addr: "", ws: "", we: "", type: "", contact: "", desc: "" },
      teamStatus: "", teamForm: { connect: false, cable: false, gig: false, shift: "", note: "", phone: "" },
      selCafe: null, cafeForm: { label: "", lunch: "" }, cafeOpen: true, teamEquip: "",
      genN: 100, genM: 12,
      T0: 480, T1: 1320, PXMIN: 1.6,
    };
  },
  computed: {
    axisW() { return Math.round((this.T1 - this.T0) * this.PXMIN); },
    axisTicks() { const t = []; for (let x = this.T0; x <= this.T1; x += 60) t.push(x); return t; },
    projInfo() { return this.projInfoText; },
    eventInfo() {
      const ev = (this.showRouteTeam || this.selTeam) ? this.planEvents() : this.planEvents();
      const nx = ev.find(t => t > this.now);
      const scope = (this.showRouteTeam || this.selTeam) ? (this.showRouteTeam || this.selTeam) : "все";
      return `событий ${ev.length} · scope ${scope} · след. ${nx != null ? fmt(nx) : "—"}`;
    },
    sortedTeams() {
      const cnt = id => ((this.byTeam[id] || []).length);
      return [...this.teams].sort((a, b) => { const d = cnt(b.id) - cnt(a.id); return d !== 0 ? d : String(a.id).localeCompare(String(b.id)); });
    },
    gridRows() {
      const rows = [...this.teams.map(t => ({ id: t.id, kind: "team", blocks: (this.byTeam[t.id] || []).filter(r => this.reqVisible(r)) }))];
      rows.push({ id: "UNASSIGNED", kind: "pool", blocks: this.reqs.filter(r => !r.team && this.reqVisible(r)) });
      return rows;
    },
  },
  methods: {
    fmt(m) { return fmt(m); }, shortId(id) { return String(id).replace("M2-", ""); },
    teamIcon(v) { const k = String(v || "auto").toLowerCase(); return k === "foot" ? "🚶" : k === "bicycle" ? "🚲" : k === "scooter" ? "🛵" : "🚐"; },
    color(s) { return COLORS[s] || "#666"; }, stName(s) { return STNAME[s] || s; },
    diff(d) { return (d >= 0 ? "+" : "") + d; },
    effStatus(r) {
      if (!r.plan || ["CANCELLED", "RESCHEDULED", "IMPOSSIBLE", "UNASSIGNED"].includes(r.status)) return r.status;
      if (this.now >= r.plan.end) return "DONE";
      if (this.now >= r.plan.start) return "IN_PROGRESS";
      return "ASSIGNED";
    },
    reqVisible(r) {
      if (r.status === "CANCELLED" || r.status === "RESCHEDULED") { if (!this.flt.showCancelled) return false; }
      else if (!this.flt.status.includes(r.status)) return false;
      if (this.flt.team !== "all" && r.team !== this.flt.team && !(this.flt.team === "UNASSIGNED" && !r.team)) return false;
      if (this.flt.district !== "all" && r.district !== this.flt.district) return false;
      const q = (this.flt.q || "").trim().toLowerCase();
      if (q && !((r.id + " " + (r.address || "") + " " + (r.bk || "")).toLowerCase().includes(q))) return false;
      return true;
    },
    optSupported(k) { const o = this.optionsSpec[k]; return o ? !!o.supported : true; },
    gapTitle(k) { const o = this.optionsSpec[k]; return o ? o.note : ""; },
    // UI-FIX13: живая строка лога загрузки (wall с 3 знаками, сразу в панель).
    blog(msg) {
      try {
        const t = (typeof performance !== "undefined" ? performance.now() : Date.now()) - (this._bootT0 || 0);
        this.bootLog.push((t / 1000).toFixed(3) + "с · " + msg);
      } catch (_) {}
    },
    spinStart(label) {
      if (this.busy && this.spin.on) return false;
      this.busy = true; this.spin.on = true; this.spin.label = label || ""; this.spin.sec = 0;
      this.spin.t0 = Date.now();
      try { clearInterval(this._spinT); } catch (_) {}
      this._spinT = setInterval(() => { try { this.spin.sec = Math.floor((Date.now() - this.spin.t0) / 1000); } catch (_) {} }, 250);
      return true;
    },
    spinStop() {
      try { clearInterval(this._spinT); } catch (_) {}
      this._spinT = null; this.spin.on = false; this.busy = false;
    },
    // UI-FIX14: клик по спиннеру = toggle плавающего профайлера.
    toggleLog() { this.logOpen = !this.logOpen; },
     // UI-FIX15: смена travel-источника full/moscow (только geometry, план не трогаем).
     // full = дефолт (ЦФО, канон v1); moscow = выбор "legacy" (лёгкая, без Домодедово).
    async rgSwitch() {
      const src = this.rgSrc === "full" ? "full" : "moscow";
      this.rgSrc = src;
      if (!this.spinStart("карта " + src)) return;
      try {
        RG.map = null;
        await loadRgMap(null, src);
        this.rgStatus = RG.status === "ready" ? "roadgraph-js: карта готова (" + RG.note + ")" : "roadgraph-js: " + RG.note;
        const rg = await enrichLegsRg(this);
        this.rebuild(); this._fitEpoch = (this._fitEpoch || 0) + 1; this.refresh();
        this.blog("карта " + src + ": rgjs " + rg.real + "/" + rg.total);
      } finally { this.spinStop(); }
    },
    // BROWSER-ONLY: видимая по умолчанию — бригада с максимумом q-треков
    // (демо витрины кванта; ручной выбор selectTeam не тронут).
    pickVisibleTeam() {
      let bestTid = (this.teams[0] || {}).id || null, bestN = -1;
      for (const t of this.teams) {
        const stops = (this.stops || {})[t.id] || [];
        let n = 0;
        for (let i = 0; i < stops.length; i++) {
          const s = stops[i];
          const tr = (this._qTrack || {})[t.id + "|" + s.req]
            || (QL && QL.trackByPair ? QL.trackByPair(i === 0 ? ("START:" + t.id) : stops[i - 1].req, s.req) : null);
          if (tr && Array.isArray(tr.pts) && tr.pts.length > 1) n++;
        }
        if (n > bestN) { bestN = n; bestTid = t.id; }
      }
      return bestTid;
    },
    // --- map (Leaflet, imperative) ---
    initMap() {
      this._map = L.map("map").setView([55.64, 37.70], 10);
      const esriAttr = "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics | &copy; OpenStreetMap contributors";
      const osmAttr = "&copy; OpenStreetMap contributors | Tiles &copy; Esri";
      // UI-FIX5.6: локальная докачка ОСТАНОВЛЕНА (папка tiles/ как есть, без prefetch);
      // дефолт — Esri, fallback — OSM. Переключатель локальных убран.
      this._esri = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: esriAttr });
      this._osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: osmAttr });
      this._esri.addTo(this._map);
      this._esri.on("tileerror", () => { if (!this._map.hasLayer(this._osm)) this._osm.addTo(this._map); });
      L.control.layers({ "Esri WorldStreetMap (default)": this._esri, "OSM standard (fallback)": this._osm }, null, { collapsed: true }).addTo(this._map);
      this._g = { off: L.layerGroup().addTo(this._map), req: L.layerGroup().addTo(this._map), team: L.layerGroup().addTo(this._map), cafe: L.layerGroup().addTo(this._map), route: L.layerGroup().addTo(this._map), transit: L.layerGroup().addTo(this._map) };
      this._reqMarkers = {};
      // UI-FIX17: TransitLayer + обратная связка сегмент→список живут здесь;
      // рендер остановок — по moveend/zoomend (debounce 150мс).
      try { let _tt = null; this._map.on("moveend zoomend", () => { try { clearTimeout(_tt); } catch (_) {} _tt = setTimeout(() => { try { this.renderTransit(); } catch (_) {} }, 150); }); } catch (_) {}
      // UI-FIX10: попапы полупрозрачные (CSS .85, hover 1), клик по попапу — скрыть.
      try { this._map.on("popupopen", e => {
        const el = e.popup && e.popup.getElement ? e.popup.getElement() : null;
        if (el && !el._fix10) { el._fix10 = true; el.addEventListener("click", () => { try { this._map.closePopup(); } catch (_) {} }); }
      }); } catch (_) {}
    },
    routeGeom(teamId) {
      const stops = this.stops[teamId] || [];
      const team = this.teamById[teamId];
      const home = (team && (team.start || team.home)) || { lat: 55.64, lon: 37.70 };
      const seq = [{ lat: home.lat, lon: home.lon },
        ...stops.map(s => this.reqById[s.req]).filter(p => p && p.lat != null).map(p => ({ lat: p.lat, lon: p.lon }))];
      return seq.filter(p => p.lat != null && p.lon != null).map(p => [p.lat, p.lon]);
    },
    teamPosAt(teamId, t) {
      const team = this.teamById[teamId], stops = this.stops[teamId] || [];
      const home = (team && (team.start || team.home)) || { lat: 55.64, lon: 37.70 };
      if (!team || !stops.length || t <= team.shift[0]) return home;
      for (let i = 0; i < stops.length; i++) {
        const s = stops[i], p = this.reqById[s.req]; if (!p) continue;
        const prev = i === 0 ? home : (this.reqById[stops[i - 1].req] || home);
        const prevEnd = i === 0 ? team.shift[0] : stops[i - 1].end;
        if (t < s.arrive) { const k = (t - prevEnd) / Math.max(1, s.arrive - prevEnd); return { lat: prev.lat + (p.lat - prev.lat) * k, lon: prev.lon + (p.lon - prev.lon) * k }; }
        if (t <= s.end) return p;
      }
      return this.reqById[stops[stops.length - 1].req] || home;
    },
    // UI-FIX2: события плана (arrive/start/end по leg'ам) + ожидание (arrive<start или arrive<ws)
    isWaiting(r) { return !!(r && r.plan && r.team && (r.plan.arrive < r.plan.start - 0.5 || r.plan.arrive < (r.window ? r.window[0] : 1e9) - 0.5)); },
    planEvents() {
      const only = this.showRouteTeam || this.selTeam;
      const ev = [];
      for (const r of this.reqs) {
        if (!r.plan || !r.team) continue;
        if (only && r.team !== only) continue;
        for (const k of ["arrive", "start", "end"]) if (r.plan[k] != null) ev.push(r.plan[k]);
      }
      return [...new Set(ev)].sort((a, b) => a - b);
    },
    nextEvent() {
      const ev = this.planEvents();
      const nx = ev.find(t => t > this.now);
      if (nx != null) { this.now = nx; this.refresh(); if (this.selReq) this.selectReq(this.selReq, true); }
    },
    stepTime(d) { this.now = Math.min(1320, Math.max(480, this.now + d)); this.refresh(); },
    // UI-AUTOFIT: чекбокс "Авто" (вкл по умолчанию). При смене данных/выбора плавно
    // вписывает все заявки либо маршрут выбранной бригады. Выкл — ручной зум не трогаем.
    autoFitChanged() { if (this.autoFit) this.autoFitView(); },
    autoFitView() {
      if (!this.autoFit || !this._map) return;
      try {
        let pts = [];
        const tid = this.showRouteTeam || this.selTeam;
        if (tid && this.teamById[tid]) {
          if (this.selLeg && this.selLeg.team === tid) {
            const stops = this.stops[tid] || [], s = stops[this.selLeg.idx];
            if (s) {
              const prev = this.selLeg.idx === 0 ? ((this.teamById[tid] || {}).start || (this.teamById[tid] || {}).home) : this.reqById[stops[this.selLeg.idx - 1].req];
              const cur = this.reqById[s.req];
              if (prev && cur) pts = legGeom(prev, cur, s.exact_geometry || s.geometry || s.geom).pts;
            }
          } else pts = this.routeGeom(tid);
        } else pts = this.reqs.filter(r => this.reqVisible(r)).map(r => [r.lat, r.lon]);
        pts = (pts || []).filter(p => p && p[0] != null && p[1] != null);
        if (!pts.length) return;
        // Паддинг ~1/4 краёв: контент занимает ~3/4 центра. maxZoom cap от перезума.
        const opt = { paddingTopLeft: [48, 48], paddingBottomRight: [48, 48], maxZoom: 14, animate: true, duration: 0.6 };
        if (pts.length === 1) { this._map.flyTo(pts[0], Math.min(14, this._map.getZoom() || 14), { duration: 0.6 }); return; }
        const b = L.latLngBounds(pts);
        if (this._map.flyToBounds) this._map.flyToBounds(b, opt);
        else this._map.fitBounds(b, opt);
      } catch (_) {}
    },
    // UI-FIX21: остановки по требованию — только транзит-бригады/сегмента.
    // Все 12k синхронно не рисуем (душило 74с). Источник: transit-legs плана =
    // ноги выбранной бригады (routeGeom bbox); если бригада не transit
    // (vehicle!=='foot' и toggles.footTransit выкл) — слой пуст.
    async loadTransit() {
      if (this.transit.loaded || this._transitLoading) return;
      this._transitLoading = true;
      try {
        const d = await (await fetch("transit_stops.json")).json();
        const arr = Array.isArray(d) ? d : (d.stops || d.features || []);
        this.transit.pts = arr.map(s => {
          if (Array.isArray(s)) return { lat: s[0], lon: s[1] };
          if (s.lat != null && s.lon != null) return { lat: +s.lat, lon: +s.lon, n: s.n || s.name || "", id: s.id };
          if (s.geometry && s.geometry.coordinates) return { lat: s.geometry.coordinates[1], lon: s.geometry.coordinates[0] };
          return null;
        }).filter(p => p && isFinite(p.lat) && isFinite(p.lon));
        this.transit.loaded = true;
        this.renderTransit();
      } catch (_) { this.transit.loaded = false; }
      this._transitLoading = false;
    },
    renderTransit() {
      if (!this._map || !this._g || !this._g.transit) return;
      const g = this._g.transit;
      g.clearLayers();
      if (!this.layers.transit || !this.transit.loaded || !this.transit.pts.length) { this.transit.rendered = "off"; return; }
      const tid = (this.selLeg && this.selLeg.team) || this.showRouteTeam || this.selTeam;
      if (!tid) { this.transit.rendered = "off: no team"; return; }
      const team = (this.teamById || {})[tid];
      const isTransit = !!team && (team.vehicle === "foot" || (this.toggles && this.toggles.footTransit));
      if (!isTransit) { this.transit.rendered = "off: non-transit " + tid; return; }
      let pts = [];
      try { pts = this.routeGeom(tid) || []; } catch (_) { pts = []; }
      if (!pts.length) { this.transit.rendered = "off: no route " + tid; return; }
      let s = 90, n = -90, w = 180, e = -180;
      for (const p of pts) { if (p[0] < s) s = p[0]; if (p[0] > n) n = p[0]; if (p[1] < w) w = p[1]; if (p[1] > e) e = p[1]; }
      const pad = 0.02;
      s -= pad; n += pad; w -= pad; e += pad;
      const inBox = [];
      const all = this.transit.pts;
      for (let i = 0; i < all.length; i++) {
        const p = all[i];
        if (p.lat >= s && p.lat <= n && p.lon >= w && p.lon <= e) inBox.push(p);
        if (inBox.length >= 300) break;
      }
      for (const p of inBox) {
        const m = L.circleMarker([p.lat, p.lon], { radius: 3, weight: 1, color: "#0d47a1", fillColor: "#42a5f5", fillOpacity: 0.9 });
        const tip = (p.n || p.id != null ? String(p.n || p.id) : "остановка");
        try { m.bindTooltip(tip); } catch (_) {}
        m.addTo(g);
      }
      this.transit.rendered = "team:" + tid + " stops:" + inBox.length;
    },
    refresh() {
      if (!this._map) return;
      Object.values(this._g).forEach(g => g.clearLayers());
      this._reqMarkers = {};
      const Lyr = this.layers;
      if (Lyr.off) this.offices.forEach(o => L.marker([o.lat, o.lon], { title: "Офис " + o.id, icon: PINS.off() }).bindPopup(`Офис ${o.id}<br>${o.home_base || ""}`).addTo(this._g.off));
      if (Lyr.cafe) this.cafes.forEach(c => L.marker([c.lat, c.lon], { title: c.id, icon: PINS.cafe() }).bindPopup(c.label || c.id).addTo(this._g.cafe));
      if (Lyr.req) for (const r of this.reqs) {
        if (!this.reqVisible(r)) continue;
        const st = this.effStatus(r);
        const done = this.frozenIds.has(r.id) || st === "DONE";
        const wait = this.isWaiting(r);
        const m = L.marker([r.lat, r.lon], { title: r.id, icon: pin(wait ? "⏳" : done ? "✔" : "📋", wait ? "pin-wait pin-req" : "pin-req"), opacity: done ? 0.55 : 1 })
          .bindPopup(`<b>${r.id}</b> · ${st}${wait ? " · ⏳ожидание " + fmt(r.plan.arrive) + "–" + fmt(r.plan.start) : ""}<br>${r.address || ""}<br>окно ${fmt(r.window[0])}–${fmt(r.window[1])} · ${r.bk || ""}<br>бригада: ${r.team || "—"}`);
        m.on("click", () => this.selectReq(r.id));
        this._reqMarkers[r.id] = m; this._g.req.addLayer(m);
      }
      if (Lyr.team) for (const t of this.teams) {
        const home = (t.start || t.home);
        if (home) L.marker([home.lat, home.lon], { title: "Дом " + t.id, icon: PINS.home(), opacity: 0.85 }).bindPopup(`Дом бригады ${t.id}`).addTo(this._g.team);
        const pos = this.teamPosAt(t.id, this.now);
        const sel = this.selTeam === t.id;
        const m = L.marker([pos.lat, pos.lon], { title: t.id, icon: teamPin(t.vehicle), opacity: sel ? 1 : 0.9 }).bindPopup(`Бригада ${t.id}<br>mask=${t.skill_mask} · ${t.vehicle}<br>клик → только её путь`);
        m.on("click", () => this.selectTeam(t.id));
        this._g.team.addLayer(m);
      }
      if (Lyr.route) {
        // UI-FIX7: цвет ноги = радуга по индексу сегмента; пунктир=схематично.
        // UI-FIX11: selLeg (клик по строке seg) — подсветка вместо изолята:
        // выбранная нога рисуется поверх + бегущий пунктир-оверлей (CSS-анимация
        // legmarch) + пульсирующие стрелки; остальные ноги ТУСКНЕЮТ (opacity),
        // не исчезают. Esc — снять выделение (clearSelLeg).
        // Вид "все бригады" (showRouteTeam=null): только ПЕРВЫЙ шаг каждого рейса.
        const drawTeam = (id, onlyFirst) => {
          const stops = this.stops[id] || [];
          const selOn = this.selLeg && this.selLeg.team === id ? this.selLeg.idx : -1;
          const list = stops.map((s, i) => ({ s, i }));
          const vis = onlyFirst && selOn < 0 ? list.slice(0, 1) : list;
          vis.forEach(({ s, i }) => {
            const prev = i === 0 ? ((this.teamById[id] || {}).start || (this.teamById[id] || {}).home) : this.reqById[stops[i - 1].req];
            const cur = this.reqById[s.req]; if (!prev || !cur) return;
            // UI-FIX13 п.2: координат нет/нули — линии в пустоту нет (бейдж в showRoute).
            if (prev.lat == null || prev.lon == null || cur.lat == null || cur.lon == null) return;
            if ((prev.lat === 0 && prev.lon === 0) || (cur.lat === 0 && cur.lon === 0)) return;
            // UI-FIX14b: пустая exact (pts null) не маскирует реальную geometry —
            // иначе свои же ноги пропадают при выбранном seg. Своя бригада видна вся.
            const ex = (s.exact_geometry && Array.isArray(s.exact_geometry.pts) && s.exact_geometry.pts.length > 1) ? s.exact_geometry : null;
            const g = legGeom(prev, cur, ex || s.geometry || s.geom);
            // UI-FIX13 п.2: schematic с пустыми pts — линию не рисуем.
            // GENERAL-ROUTE: но пунктиры дом→порт рисуем (общий путь: трек —
            // port-граф живьём, концы — пешеходные пунктиры до домов).
            if (!g.pts || g.pts.length < 2) {
              try {
                const _pp = (s.geometry && s.geometry.ports) || (ex && ex.ports) || null;
                if (_pp && _pp.pa && _pp.pb) {
                  L.polyline([[prev.lat, prev.lon], _pp.pa], { color: "#888", weight: 1, opacity: 0.8, dashArray: "2 4", interactive: false }).addTo(this._g.route);
                  L.polyline([_pp.pb, [cur.lat, cur.lon]], { color: "#888", weight: 1, opacity: 0.8, dashArray: "2 4", interactive: false }).addTo(this._g.route);
                  L.circleMarker([prev.lat, prev.lon], { radius: 2, weight: 1, color: "#888", fillColor: "#888", fillOpacity: 1, interactive: false }).addTo(this._g.route);
                  L.circleMarker([cur.lat, cur.lon], { radius: 2, weight: 1, color: "#888", fillColor: "#888", fillOpacity: 1, interactive: false }).addTo(this._g.route);
                }
              } catch (_) {}
              return;
            }
            // UI-FIX22: неисправимое — бейджем, не линией: full-тоже вне покрытия
            // / directed-тупик (reason из enrich) линию не рисует, причина видна
            // в панели showRoute (leg-schem/leg-skip).
            // LEGS-DOMODEDOVO: ленивые schematic тоже фантомы — линии нет, только
            // бейдж "схематично" в панели: qlookup (дефолт enrich без Dijkstra,
            // UI-FIX23), "вне батча" (ensureExactLeg cache-only, UI-FIX16),
            // "нет точного" (enrich проверил car/foot прямо/реверс — пусто),
            // bare "schematic" (серверные legs без геометрии, serve._build_legs).
            try {
              const _rsn = String((s.exact_geometry && s.exact_geometry.reason) || (s.geometry && s.geometry.reason) || (s.geometry && s.geometry.src) || g.src || "");
              if (g.schematic && (_rsn.indexOf("full-тоже вне покрытия") >= 0 || _rsn.indexOf("OUTLIER") === 0 || _rsn.indexOf("тупик") >= 0 || _rsn.indexOf("qlookup") >= 0 || _rsn.indexOf("вне батча") >= 0 || _rsn.indexOf("нет точного") >= 0 || _rsn.indexOf("q-miss") >= 0 || _rsn === "schematic" || _rsn === "q-miss")) {
                // POLYLINES: разрыв честно — сплошной нет, только пешеходные пунктиры дом→порт с обоих концов + бейдж в панели.
                try {
                  const _pp = (s.geometry && s.geometry.ports) || (ex && ex.ports) || null;
                  if (_pp && _pp.pa && _pp.pb) {
                    L.polyline([[prev.lat, prev.lon], _pp.pa], { color: "#888", weight: 1, opacity: 0.8, dashArray: "2 4", interactive: false }).addTo(this._g.route);
                    L.polyline([_pp.pb, [cur.lat, cur.lon]], { color: "#888", weight: 1, opacity: 0.8, dashArray: "2 4", interactive: false }).addTo(this._g.route);
                    L.circleMarker([prev.lat, prev.lon], { radius: 2, weight: 1, color: "#888", fillColor: "#888", fillOpacity: 1, interactive: false }).addTo(this._g.route);
                    L.circleMarker([cur.lat, cur.lon], { radius: 2, weight: 1, color: "#888", fillColor: "#888", fillOpacity: 1, interactive: false }).addTo(this._g.route);
                  }
                } catch (_) {}
                return;
              }
            } catch (_) {}
            try {
              const isSel = i === selOn;
              const isDim = selOn >= 0 && !isSel;
              const legColor = rainbowColor(i, stops.length);
              // UI-FIX17: обратная связка сегмент↔список — клик по ноге на карте
              // подсвечивает строку seg (selectLeg); стрелки/оверлей non-interactive.
              const _pl = L.polyline(g.pts, { weight: isSel ? 7 : (this.showRouteTeam ? 5 : 2),
                opacity: isDim ? 0.22 : (this.showRouteTeam ? 1 : 0.7),
                color: legColor, dashArray: g.schematic ? "6 5" : null,
                className: isSel ? "leg-sel" : (isDim ? "leg-dim" : "") }).addTo(this._g.route);
              try { _pl.on("click", () => this.selectLeg(id, i)); } catch (_) {}
              // UI-FIX18: палочка от конца полилинии до дома. Коннектор короткий,
              // стиль другой (тонкий серый dash 2/4), не путать с schematic-прямыми.
              // Только для реальных ног (!schematic): дом→дорога и дорога→дом, тот же слой.
              // UI-FIX19: разрыв конец–дом >300м → автодиагностика в лог
              // (координаты обоих концов + причина), палочка рисуется честно.
              try {
                if (!g.schematic && g.pts.length > 1) {
                  const p0 = g.pts[0], p1 = g.pts[g.pts.length - 1];
                  const samePt = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];
                  const gapM = (h, p) => Math.round(havKm(h[0], h[1], p[0], p[1]) * 1000);
                  if (!samePt([prev.lat, prev.lon], p0)) {
                    L.polyline([[prev.lat, prev.lon], p0], { color: "#888", weight: 1, opacity: 0.8, dashArray: "2 4", interactive: false }).addTo(this._g.route);
                    L.circleMarker([prev.lat, prev.lon], { radius: 2, weight: 1, color: "#888", fillColor: "#888", fillOpacity: 1, interactive: false }).addTo(this._g.route);
                    if (gapM([prev.lat, prev.lon], p0) > 300) try { console.warn("[fix19] gap>300м начало: порт→дом", s.req, "home=[" + prev.lat + "," + prev.lon + "] port=[" + p0[0] + "," + p0[1] + "] gap=" + gapM([prev.lat, prev.lon], p0) + "м (снап на далёкий узел — точка вне дорожной сети?)"); } catch (_) {}
                  }
                  if (!samePt([cur.lat, cur.lon], p1)) {
                    L.polyline([p1, [cur.lat, cur.lon]], { color: "#888", weight: 1, opacity: 0.8, dashArray: "2 4", interactive: false }).addTo(this._g.route);
                    L.circleMarker([cur.lat, cur.lon], { radius: 2, weight: 1, color: "#888", fillColor: "#888", fillOpacity: 1, interactive: false }).addTo(this._g.route);
                    if (gapM([cur.lat, cur.lon], p1) > 300) try { console.warn("[fix19] gap>300м конец: порт→дом", s.req, "home=[" + cur.lat + "," + cur.lon + "] port=[" + p1[0] + "," + p1[1] + "] gap=" + gapM([cur.lat, cur.lon], p1) + "м (снап на далёкий узел — точка вне дорожной сети?)"); } catch (_) {}
                  }
                }
              } catch (e) { /* коннектор не прячет ногу */ }
              if (isSel) {
                // Бегущий пунктир поверх выбранной ноги (CSS keyframes legmarch).
                L.polyline(g.pts, { weight: 3, opacity: 0.95, color: "#ffffff",
                  dashArray: "2 10", lineCap: "round",
                  className: "leg-sel-march", interactive: false }).addTo(this._g.route);
              }
              addLegArrows.call(this, g.pts, legColor, isSel);
            } catch (e) { /* один битый сегмент не прячет остальные */ }
          });
        };
        // UI-FIX13 п.3: при выбранной ноге чужие бригады скрыты, своя видна вся
        // (выбранная анимируется, остальные приглушены); без выбора — как раньше.
        if (this.showRouteTeam) drawTeam(this.showRouteTeam, false);
        else if (this.selLeg && this.selLeg.team) drawTeam(this.selLeg.team, false);
        else this.teams.map(t => t.id).forEach(id => drawTeam(id, true));
        // UI-FIX16: концы выбранной ноги — жирным (×1.5 + обводка), видно откуда-куда.
        try {
          if (this.selLeg && this.selLeg.team) {
            const stops = this.stops[this.selLeg.team] || [], s = stops[this.selLeg.idx];
            if (s) {
              const prev = this.selLeg.idx === 0 ? ((this.teamById[this.selLeg.team] || {}).start || (this.teamById[this.selLeg.team] || {}).home) : this.reqById[stops[this.selLeg.idx - 1].req];
              const cur = this.reqById[s.req];
              if (prev && cur && prev.lat != null && cur.lat != null)
                L.marker([prev.lat, prev.lon], { icon: pinEnd("▶", "pin-endpoint-start"), interactive: false, keyboard: false, zIndexOffset: 500 }).addTo(this._g.route);
              if (cur && cur.lat != null && cur.lon != null)
                L.marker([cur.lat, cur.lon], { icon: pinEnd("●", "pin-endpoint-end"), interactive: false, keyboard: false, zIndexOffset: 500 }).addTo(this._g.route);
            }
          }
        } catch (e) { /* концы не прячут ноги */ }
      }
      [[this._g.off, "off"], [this._g.req, "req"], [this._g.team, "team"], [this._g.cafe, "cafe"], [this._g.route, "route"], [this._g.transit, "transit"]].forEach(([g, k]) => {
        const on = this.layers[k];
        if (on && !this._map.hasLayer(g)) g.addTo(this._map);
        if (!on && this._map.hasLayer(g)) this._map.removeLayer(g);
      });
      // UI-FIX21: transit строго после clear+visibility, иначе clear стирал слой.
      try { this.renderTransit(); } catch (_) {}
      try { const k = [this.reqs.length, this.showRouteTeam, this.selTeam, this.selLeg ? this.selLeg.team + ":" + this.selLeg.idx : "", this.reqs.filter(r => this.reqVisible(r)).length, this.flt.q, this.flt.team, this.flt.district, (this.flt.status || []).join(","), this.flt.showCancelled, this._fitEpoch || 0].join("|"); if (k !== this._fitKey) { this._fitKey = k; if (this.autoFit) this.autoFitView(); } } catch (_) {}
    },
    showRoute(teamId) {
      const team = this.teamById[teamId];
      const stops = this.stops[teamId] || [];
      // UI-FIX12: ленивая exact port→port только показанных ног (единицы).
      for (let i = 0; i < stops.length; i++) { try { ensureExactLeg(this, teamId, i); } catch (_) {} }
      const sh0 = team ? team.shift[0] : 480;
      const home = team ? (team.start || team.home) : null;
      // UI-FIX13 п.2: ноги в пустоту не рисуем; причина фактом + бейдж в панели.
      const skipped = [];
      const segs = stops.map((s, i) => {
        const prev = i === 0 ? home : this.reqById[stops[i - 1].req];
        const cur = this.reqById[s.req];
        const from = i === 0 ? "офис (START)" : stops[i - 1].req;
        if (!prev || !cur) { skipped.push({ from, to: s.req, why: !prev ? "нет точки старта/предыдущей заявки" : ("конец без заявки: " + s.req + " нет в карте") }); return null; }
        if (prev.lat == null || prev.lon == null || cur.lat == null || cur.lon == null) { skipped.push({ from, to: s.req, why: "координаты концов: [" + prev.lat + "," + prev.lon + "]→[" + cur.lat + "," + cur.lon + "]" }); return null; }
        if ((prev.lat === 0 && prev.lon === 0) || (cur.lat === 0 && cur.lon === 0)) { skipped.push({ from, to: s.req, why: "нулевые координаты конца" }); return null; }
        const g = legGeom(prev, cur, s.exact_geometry || s.geometry || s.geom);
        if (!g.pts || g.pts.length < 2) { skipped.push({ from, to: s.req, why: "geometry пустая (" + ((s.exact_geometry || s.geometry || {}).src || "нет src") + ")" }); return null; }
        // UI-FULLQ: подпись сегмента понятно: откуда→куда + время выезда→прибытия.
        const _t0 = i === 0 ? sh0 : stops[i - 1].end;
        return { from, to: s.req, travel: Math.max(0, s.arrive - _t0),
          t0: _t0, t1: s.arrive, w0: s.start, w1: s.end, liveMin: (s.travelMinLive != null ? s.travelMinLive : null),
          color: rainbowColor(i, stops.length), ord: (i + 1) + "/" + stops.length, schematic: g.schematic, src: g.src,
          reason: ((s.exact_geometry || s.geometry || {}).reason) || g.src };
      }).filter(Boolean);
      const tot = segs.reduce((a, s) => a + s.travel, 0);
      const allSchem = segs.every(s => s.schematic);
      const schemList = segs.filter(s => s.schematic);
      const sel = this.selLeg && this.selLeg.team === teamId ? this.selLeg.idx : -1;
      this.routeInfo = `<b>${teamId}</b> · перегонов ${segs.length} · travel≈${tot} мин` +
        (allSchem ? ` <span class="muted">(схематично — прямые, не дороги)</span>` : "") +
        (schemList.length ? `<div class="leg-schem">⚠ схематично ${schemList.length}: ` + schemList.map(s => `${s.from}→${s.to} (${s.reason || s.src})`).join("; ") + `</div>` : "") +
        (skipped.length ? `<div class="leg-skip">⛔ без линии: ` + skipped.map(k => `${k.from}→${k.to} (${k.why})`).join("; ") + `</div>` : "") +
        `<div class="muted">Клик по строке перегона → подсветить перегон (остальные тускнеют, выбранный подсвечивается; повторно/esc — снять выделение).</div>` +
        segs.map((s, i) => `<div class="segrow${i === sel ? " sel" : ""}" data-seg="${i}" style="cursor:pointer;${i === sel ? "font-weight:bold;" : ""}"><span style="color:${s.color}">■</span> нога ${s.ord}: ${s.from} → ${s.to} · выезд ${fmt(s.t0)} → прибытие ${fmt(s.t1)} · в пути ~${s.travel} мин${s.liveMin != null ? " · живьём ~" + s.liveMin + " мин" : ""} · работы ${fmt(s.w0)}–${fmt(s.w1)}${s.schematic ? " · схематично" : ""}${i === sel ? " · ◀ выбран" : ""}</div>`).join("") +
        `<div class="muted">${SE08_HELP}</div>` +
        `<div><button id="route-clear">показать все</button></div>`;
      this.$nextTick(() => { const b = document.getElementById("route-clear"); if (b) b.onclick = () => { this.selLeg = null; this.showRouteTeam = null; this.routeInfo = "Клик по бригаде → только её полный путь."; this.refresh(); };
        document.querySelectorAll("#route-info .segrow").forEach(el => { el.onclick = () => this.selectLeg(teamId, +el.dataset.seg); }); });
    },
    selectLeg(teamId, idx) {
      // UI-FIX11: клик по строке seg → подсветить ногу (остальные тускнеют);
      // повторный/esc → снять выделение, полный путь бригады на месте.
      // UI-FIX13 п.3: запоминаем вид до скрытия чужих, возврат — в clearSelLeg.
      if (this.selLeg && this.selLeg.team === teamId && this.selLeg.idx === idx) { this.clearSelLeg(); return; }
      if (!this.selLeg) this._prevShow = this.showRouteTeam === undefined ? null : this.showRouteTeam;
      this.selTeam = teamId; this.showRouteTeam = teamId; this.selLeg = { team: teamId, idx };
      try { this.flt.team = teamId; } catch (_) {}
      this.showRoute(teamId); this.refresh();
      try { const _st = (this.stops[teamId] || [])[idx]; if (_st && _st.req) this.selectReq(_st.req, true); } catch (_) {}
    },
    clearSelLeg() {
      if (!this.selLeg) return;
      const t = this.selLeg.team; this.selLeg = null;
      // UI-FIX14b: возврат ровно к виду до выбора (включая null = все бригады).
      const hadPrev = (this._prevShow !== undefined);
      const prev = hadPrev ? this._prevShow : this.showRouteTeam;
      this._prevShow = undefined;
      if (prev) { this.showRouteTeam = prev; this.showRoute(prev); }
      else { this.showRouteTeam = null; this.routeInfo = "Клик по бригаде → только её полный путь."; }
      this.refresh();
    },
    onTime() { this.refresh(); if (this.selReq) this.selectReq(this.selReq, true); },
    // --- selection + forms ---
    selectReq(id, keepRoute) {
      this.selReq = id;
      const r = this.reqById[id]; if (!r) return;
      try { if (!keepRoute) { const _m = this._reqMarkers && this._reqMarkers[id]; if (_m && this._map) _m.openPopup(); } } catch (_) {}
      // UI-FIX7: клик ВСЕГДА переключает: назначена → путь её бригады; неназначена → путей нет.
      if (!r.team) {
        this.selTeam = null; this.showRouteTeam = null;
        this.routeInfo = "Клик по бригаде → только её полный путь.";
      } else if (!keepRoute) { this.selTeam = r.team; this.showRouteTeam = r.team; try { this.flt.team = r.team; } catch (_) {} this.fillTeamForm(); this.showRoute(r.team); }
      if (!r.team) this.refresh(); else if (!keepRoute) this.refresh();
      this.reqForm = { addr: r.address || "", ws: fmt(r.window[0]), we: fmt(r.window[1]), type: r.bk || "", contact: r.contact || "", desc: (r.hd || "") + ((!r.team && r.reason) ? " · " + r.reason : "") };
      const st = this.effStatus(r);
      this.reqStatus = `${r.id} · статус: ${this.stName(st)} (${st}) · бригада ${r.team || "—"}`;
      // UI-FIX6 п.1: окно + фактические прибытие/начало/конец (конец после окна — явно).
      if (r.plan && r.team) {
        const late = r.plan.end > r.window[1] ? ` · ⚠ конец после окна +${r.plan.end - r.window[1]} мин` : "";
        this.reqTimes = `окно ${fmt(r.window[0])}–${fmt(r.window[1])} · прибытие ${fmt(r.plan.arrive)} · начало ${fmt(r.plan.start)} · конец ${fmt(r.plan.end)}${late}`;
      } else this.reqTimes = `окно ${fmt(r.window[0])}–${fmt(r.window[1])} · факт: — (не назначена)`;
      if (!r.team) {
        const code = r.reason ? String(r.reason).split(" ").pop() : null;
        this.reqReason = r.reason ? `Причина: ${r.reason} — ${REASONS[code] || REASONS[r.reason] || "см. лог сервера"}` : "Причина: не распределена";
      } else this.reqReason = "";
    },
    reqSave() {
      const r = this.reqById[this.selReq]; if (!r) return;
      r.address = this.reqForm.addr; r.bk = this.reqForm.type; r.contact = this.reqForm.contact;
      const a = parseHM(this.reqForm.ws), b = parseHM(this.reqForm.we);
      if (a != null && b != null) r.window = [a, b];
      this.refresh();
      try { const _t0 = this.reqById[this.selReq], _tid = _t0 && _t0.team, _self = this;
        enrichLegsQ(this, _tid || visibleTeamOf(this)).then(() => { try { _self.rebuild(); if (_tid) _self.showRoute(_tid); _self.refresh(); } catch (_) {} });
      } catch (_) {}
      this.reqStatus += " · сохранено, маршруты пересчитаны";
    },
    reqDel() {
      const r = this.reqById[this.selReq]; if (!r) return;
      this.reqs = this.reqs.filter(x => x !== r); this.rebuild(); this.refresh();
    },
    reqCancel() { const r = this.reqById[this.selReq]; if (r) { r.status = "CANCELLED"; r.reason = "CANCELLED_OP"; delete r.plan; this.rebuild(); this.refresh(); this.selectReq(r.id); } },
    reqPostpone() { const r = this.reqById[this.selReq]; if (r) { r.status = "RESCHEDULED"; r.window = [r.window[0] + 60, r.window[1] + 60]; delete r.plan; this.rebuild(); this.refresh(); this.selectReq(r.id); } },
    selectTeam(id) {
      // UI-FIX2: повторный клик — показать все (снять фильтр), данные маршрутов не удаляются
      // UI-FIX8: смена бригады сбрасывает изолят ноги (selLeg).
      if (this.showRouteTeam === id && this.selTeam === id && !this.selLeg) { this.selTeam = null; this.showRouteTeam = null; this.routeInfo = "Клик по бригаде → только её полный путь."; try { this.flt.team = "all"; } catch (_) {} this.refresh(); return; }
      if (this.showRouteTeam === id && this.selTeam === id && this.selLeg) { this.selLeg = null; this.showRoute(id); this.refresh(); return; }
      this.selTeam = id; this.showRouteTeam = id; this.selLeg = null; try { this.flt.team = id; } catch (_) {} this.fillTeamForm(); this.showRoute(id); this.refresh();
      // UI-FIX22: ленивая догрузка геометрии этой бригады (батч её ног), затем перерис.
      try { const _t = id; enrichLegsQ(this, _t).then(() => { try { this.rebuild(); this.showRoute(_t); this.refresh(); } catch (_) {} }); } catch (_) {} },
    onSelTeam() { this.selectTeam(this.selTeam); },
    onFilterTeam() {
      const v = this.flt.team;
      if (v && v !== "all" && v !== "UNASSIGNED" && this.teamById[v]) { this.selectTeam(v); return; }
      if (v === "UNASSIGNED") { this.selTeam = null; this.showRouteTeam = null; this.selLeg = null; this.routeInfo = "Клик по бригаде → только её полный путь."; }
      else if (v === "all") { this.selTeam = null; this.showRouteTeam = null; this.selLeg = null; this.routeInfo = "Клик по бригаде → только её полный путь."; }
      this.refresh();
    },
    fillTeamForm() {
      const t = this.teamById[this.selTeam]; if (!t) return;
      const m = this.members[this.selTeam] || {};
      const sk = m.skills_check || {};
      this.teamForm = {
        connect: !!sk.connect, cable: !!sk.cable_repair, gig: !!sk.gigabit_climb,
        shift: fmt(t.shift[0]) + "-" + fmt(t.shift[1]),
        note: (m.dossier && m.dossier.note) || "", phone: (m.dossier && m.dossier.phone) || "",
      };
      this.teamStatus = `${t.id} · mask=${t.skill_mask} · ${t.vehicle} · заявок ${(this.byTeam[t.id] || []).length} · смена план ${fmt(t.shift[0])}–${fmt(t.shift[1])}${this.teamShiftPlan(t.id)}`;
      this.teamEquip = this.teamEquipText(t.id);
    },
    teamEquipText(tid) {
      const n = ((this.byTeam[tid] || []).length);
      const st = INVENTORY.stock;
      const take = k => Math.min(n, st[k]);
      return `Оборудование на смену: роутеры ${take("router")}/${st.router} · приставки ${take("stb")}/${st.stb} · Алиса ${take("alice")}/${st.alice} (взято/склад)`;
    },
    teamShiftPlan(tid) {
      // UI-FIX17: карточка бригады — первый выезд и финиш рейса из плана.
      const stops = (this.stops || {})[tid] || [];
      if (!stops.length) return "";
      const a = stops[0], b = stops[stops.length - 1];
      return ` · бригада начала ${fmt(a.start)} (план) · закончила ${fmt(b.end)} (план)`;
    },
    teamSave() {
      const t = this.teamById[this.selTeam]; if (!t) return;
      t.skill_mask = (this.teamForm.connect ? 1 : 0) | (this.teamForm.cable ? 2 : 0) | (this.teamForm.gig ? 4 : 0);
      const m = this.members[this.selTeam] || (this.members[this.selTeam] = {});
      m.dossier = { note: this.teamForm.note, phone: this.teamForm.phone };
      this.refresh(); this.fillTeamForm(); this.teamStatus += " · сохранено локально";
    },
    cafeSync() {
      const c = this.cafes.find(x => x.id === this.selCafe);
      if (c) this.cafeForm = { label: c.label || "", lunch: c.lunch || "12:00-15:00" };
    },
    cafeSave() { const c = this.cafes.find(x => x.id === this.selCafe); if (c) { c.label = this.cafeForm.label; c.lunch = this.cafeForm.lunch; this.refresh(); } },
    cafeAdd() { const id = "CAFE_" + String(this.cafes.length + 1).padStart(2, "0"); this.cafes.push({ id, lat: 55.64, lon: 37.70, label: this.cafeForm.label || id, lunch: this.cafeForm.lunch || "12:00-15:00" }); this.selCafe = id; this.refresh(); },
    cafeDel() { this.cafes = this.cafes.filter(x => x.id !== this.selCafe); this.selCafe = (this.cafes[0] || {}).id || null; this.cafeSync(); this.refresh(); },
    // --- data ---
    rebuild() {
      this.reqById = Object.fromEntries(this.reqs.map(r => [r.id, r]));
      this.teamById = Object.fromEntries(this.teams.map(t => [t.id, t]));
      this.byTeam = Object.fromEntries(this.teams.map(t => [t.id, []]));
      this.stops = {};
      for (const r of this.reqs) if (r.team && r.plan) (this.byTeam[r.team] || (this.byTeam[r.team] = [])).push(r);
      for (const t of this.teams) {
        (this.byTeam[t.id] || []).sort((a, b) => (a.plan?.start ?? 0) - (b.plan?.start ?? 0));
        // UI-FIX8 + UI-RGJS-BIND: ломаная ноги: roadgraph-js (клиент) > API > прямая.
        const gm = this._legGeom || {};
        const rg = this._rgGeom || {};
        this.stops[t.id] = (this.byTeam[t.id] || []).map(r => ({ req: r.id, arrive: r.plan.arrive, start: r.plan.start, end: r.plan.end, kind: "work",
          geometry: rg[t.id + "|" + r.id] || gm[t.id + "|" + r.id] || null }));
      }
      this.districts = [...new Set(this.reqs.map(r => r.district))];
      const done = this.reqs.filter(r => r.team).length;
      this.projInfoText = `Москва Билайн · заявок ${this.reqs.length} · назначено ${done} · бригад ${this.teams.length} (<span class="ok-badge" style="background:#2ca02c;color:#fff;border-radius:4px;padding:0 5px;font-size:11px">REAL</span>)`;
    },
    storeLegs(res) {
      // UI-FIX8: карта geometry per leg из API; сброс изолята при новом решении.
      const gm = {};
      for (const l of (res && res.legs) || []) gm[l.team_id + "|" + l.to] = l.geometry || null;
      this._legGeom = gm;
      this.selLeg = null;
    },
    runWallText(res) {
      // UI-RGJS-BIND: wall с разбивкой travel/assign (+ клиент rgjs).
      // UI-FIX13 п.1: серверные stages с 3 знаками (реальный замер perf_counter).
      if (res && Array.isArray(res.stages) && res.stages.length) {
        const stg = res.stages.map(s => s.name + " " + Number(s.ms).toFixed(3) + "мс").join(" + ");
        let s = `wall=<b>${res.wall_ms}ms</b> [${stg}]`;
        if (res.rgjs_ms != null) s += ` · rgjs ${res.rgjs_ms}ms`;
        return s;
      }
      const w = res.wall_ms, a = res.assign_ms, t = res.travel_ms, c = res.rgjs_ms;
      let s = `wall=<b>${w}ms</b>`;
      if (a != null && t != null) s += ` (assign ${a}ms + travel ${t}ms)`;
      if (c != null) s += ` · rgjs ${c}ms`;
      return s;
    },
    contract() {
      return bundleToContract(this.reqs.filter(r => r.status !== "CANCELLED" && r.status !== "RESCHEDULED"), this.teams, this.skillBits, this.travelLegs);
    },
    frozenState() {
      const done = [], prog = [], ab = {};
      for (const r of this.reqs) {
        if (r.plan) ab[r.id] = { request_id: r.id, team_id: r.team, arrive: r.plan.arrive, start: r.plan.start, end: r.plan.end };
        if (r.plan && ["ASSIGNED", "IN_PROGRESS", "DONE"].includes(r.status)) {
          const e = this.now >= r.plan.end ? "DONE" : this.now >= r.plan.start ? "IN_PROGRESS" : null;
          if (e === "DONE") done.push(r.id); else if (e === "IN_PROGRESS") prog.push(r.id);
        }
      }
      return { done, prog, ab };
    },
    async doSolve() {
      if (!this.spinStart("пересчёт")) return; this.prog = 0.1;
      try {
        const c = this.contract();
        const payload = { ...c, engine: this.engine, config: { strategy: this.strategy, seed: this.seed },
          options: { lunch: this.toggles.lunch, home_end: this.toggles.homeEnd, warehouse: this.toggles.warehouse, foot_transit: this.toggles.footTransit } };
        const f = this.frozenState();
        this.prog = 0.4;
        const frozenActive = f.done.length + f.prog.length > 0;
        // SOLVER-JS: browser beta — только чистый assign S0 без frozen (replan остаётся на сервере).
        const useBrowser = this.solverPlace === "browser" && this.strategy === "S0" && !frozenActive;
        if (this.solverPlace === "browser" && !useBrowser)
          this.blog("browser beta: S1–S4/replan считает сервер (solver.js покрывает только S0 assign)");
        const res = useBrowser ? await solveBrowser(payload)
          : (frozenActive
            ? await apiReplan({ ...payload, state: { t_now: this.now, done: f.done, in_progress: f.prog, assignments: Object.values(f.ab) } })
            : await apiAssign(payload));
        res.strategy = this.strategy;
        res.doneNew = res.done - (res.frozen || 0);
        this.prog = 0.7;
        const keep = new Set([...f.done, ...f.prog]);
        applyServerPlan(this.reqs, res, keep);
        this.frozenIds = keep;
        this.storeLegs(res);
        this.rebuild();
        // UI-FIX22: геометрия лениво только видимой бригады (батч единиц ног).
        const rg = await enrichLegsQ(this, visibleTeamOf(this));
        res.rgjs_ms = rg.ms; res.rg_real = rg.real; res.rg_total = rg.total;
        this.rebuild(); this._fitEpoch = (this._fitEpoch || 0) + 1; this.refresh(); this.prog = 1;
        const prev = this.runs[this.runs.length - 1];
        this.runs.push({ clock: fmt(this.now), ...res });
        setTimeout(() => (this.prog = 0), 600);
        this.solveMetrics = `done=<b>${res.done}</b> (новых ${res.doneNew}, заморожено ${res.frozen || 0}) · teams=<b>${res.teams_used}</b> · km=<b>${res.km}</b> · ${this.runWallText(res)} · ${res.strategy} · engine=${res.engine || this.engine} · rgjs ${rg.real}/${rg.total}${travelCounter(res)} <span class="ok-badge" style="background:#2ca02c;color:#fff;border-radius:4px;padding:0 5px;font-size:11px">REAL</span>` +
          (prev ? `<div class="muted">Δ к прошлому: done ${this.diff(res.done - prev.done)}, km ${(res.km - prev.km).toFixed(1)}</div>` : "");
        if (this.selReq) this.selectReq(this.selReq);
      } catch (e) {
        this.bootErr = "solver недоступен: " + (e && e.message || e);
        this.prog = 0;
      } finally { this.spinStop(); }
    },
    preset(n, m) { this.genN = n; this.genM = m; this.doGen(); },
    async doGen() {
      if (!this.spinStart("генерация+расчёт")) return; this.prog = 0.1;
      try {
        const rnd = mulberry32(this.seed);
        const dists = ["Царицыно", "Бирюлёво", "Орехово", "Зябликово", "Москворечье"];
        const bks = [["Подключение", 1, 90], ["Локальная заявка", 1, 50], ["Дозаказ", 5, 40], ["Глобальная проблема", 6, 100]];
        const vehs = ["auto", "scooter", "bicycle", "foot"], masks = [1, 2, 5, 6, 3, 7];
        this.teams = [];
        for (let i = 0; i < this.genM; i++) {
          const lat = 55.64 + (rnd() - 0.5) * 0.16, lon = 37.70 + (rnd() - 0.5) * 0.22;
          this.teams.push({ id: "GEN-T" + String(i + 1).padStart(2, "0"), skill_mask: masks[i % masks.length],
            vehicle: vehs[i % vehs.length], shift: [i % 3 === 0 ? 480 : 540, i % 3 === 0 ? 1200 : 1260],
            start: { lat, lon }, district: dists[i % dists.length] });
        }
        this.reqs = [];
        for (let i = 0; i < this.genN; i++) {
          const bk = bks[Math.floor(rnd() * bks.length)];
          const ws = 480 + Math.floor(rnd() * 540), we = Math.min(1320, ws + 60 + Math.floor(rnd() * 240));
          this.reqs.push({ id: "GEN-" + String(i + 1).padStart(4, "0"), status: "UNASSIGNED", team: null,
            district: dists[i % dists.length], lat: 55.64 + (rnd() - 0.5) * 0.4, lon: 37.70 + (rnd() - 0.5) * 0.5,
            window: [ws, we], duration_min: bk[2], bk: bk[0], req_mask: bk[1], address: "синтетика " + (i + 1), contact: "", hd: "" });
        }
        this.members = {}; this.travelLegs = [];
        this.prog = 0.4;
        const c = this.contract();
        const _payload = { ...c, engine: this.engine, config: { strategy: this.strategy, seed: this.seed }, options: { warehouse: this.toggles.warehouse, foot_transit: this.toggles.footTransit } };
        // BROWSER-ONLY: S0 дефолтом считает browser; server — fallback.
        let res = null;
        if (this.solverPlace === "browser" && this.strategy === "S0") {
          try { res = await solveBrowser(_payload); }
          catch (_) { res = await apiAssign(_payload); }
        } else res = await apiAssign(_payload);
        res.strategy = this.strategy;
        applyServerPlan(this.reqs, res);
        this.storeLegs(res);
        this.rebuild();
        // UI-FIX22: геометрия лениво только видимой бригады.
        const rg2 = await enrichLegsQ(this, visibleTeamOf(this));
        res.rgjs_ms = rg2.ms; res.rg_real = rg2.real; res.rg_total = rg2.total;
        this.rebuild(); this._fitEpoch = (this._fitEpoch || 0) + 1; this.refresh(); this.prog = 1;
        this.runs.push({ clock: fmt(this.now), ...res });
        this.solveMetrics = `генератор: done=<b>${res.done}</b> · teams=<b>${res.teams_used}</b> · km=<b>${res.km}</b> · ${this.runWallText(res)}${travelCounter(res)} <span class="ok-badge" style="background:#2ca02c;color:#fff;border-radius:4px;padding:0 5px;font-size:11px">REAL</span>`;
        this.genInfo = `Сгенерировано (синтетика): ${this.genN} заявок / ${this.genM} бригад, seed=${this.seed}. Решено сервером ${res.strategy}: done=${res.done}.`;
        setTimeout(() => (this.prog = 0), 600);
        if (this.teams[0]) { this.selTeam = this.teams[0].id; this.fillTeamForm(); }
        if (this.reqs[0]) this.selectReq(this.reqs[0].id);
      } catch (e) { this.bootErr = "генератор/солвер: " + (e && e.message || e); this.prog = 0; }
      finally { this.spinStop(); }
    },
    async boot() {
      this.spinStart("загрузка");
      // UI-FIX13 п.1: живая панель лога (высокая, строки по ходу, wall 3 знака).
      this._bootT0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
      this.bootLog = [];
      const stepT0 = () => ((typeof performance !== "undefined" ? performance.now() : Date.now()) - this._bootT0);
      try {
        // UI-FIX5.2/5.4: слайдер T0 дня (8:00=480) + автозагрузка = эмуляция "100.org"
        // (дефолт-набор default_100.json + авторасчёт плана, карта/сетка без кликов).
        // UI-FIX9: дефолт t_now = начало дня 08:00 (T0); захардкоженные 09:00 убраны.
        this.now = 480;
        this.blog("старт загрузки");
        // UI-DATAFIX: default = canonical 100 (ui/default_100.json, все с lat/lon);
        // fallback — demo_bundle (72). Каждый шаг изолирован: падение strategies/
        // assign не оставляет карту и сетку пустыми.
        let loaded = false;
        let tMap = stepT0();
        try {
          const d = await (await fetch("default_100.json")).json();
          if (!d.requests || !d.teams) throw new Error("default_100.json bad shape");
          this.skillBits = { 1: "connect", 2: "cable_repair", 4: "gigabit_climb" };
          this.reqs = d.requests.map(r => ({ ...r, status: "UNASSIGNED", team: null }));
          this.teams = d.teams.map(t => ({ ...t }));
          this.members = {};
          this.offices = []; this.cafes = [{ id: "CAFE_01", lat: 55.626, lon: 37.668, label: "Кафе (обед 12:00–15:00)", lunch: "12:00-15:00" }];
          this.travelLegs = [];
          this.genInfo = `Дефолт: canonical 100 (заявок ${this.reqs.length} / бригад ${this.teams.length}), geo lat/lon из canonical. Решение — реальным solver через /api/assign.`;
          loaded = true;
        } catch (e) { loaded = false; }
        if (!loaded) {
          const base = "../demo/demo_bundle/";
          const get = async n => { const r = await fetch(base + n); if (!r.ok) throw new Error(n + " " + r.status); return r.json(); };
          const [Rq, Tm, Mm, Te, St, Tr, TM] = await Promise.all(
            ["requests.json", "teams.json", "team_members.json", "territories.json", "settings.json", "traffic.json", "travel_matrix.json"].map(get));
          this.skillBits = St.skills && St.skills.bits;
          this.reqs = Rq.requests.map(r => ({ ...r, status: "UNASSIGNED", team: null }));
          this.teams = Tm.teams.map(t => ({ ...t }));
          this.members = Object.fromEntries((Mm.members || []).map(m => [m.id, m]));
          this.offices = (Te.offices || []).map(o => ({ ...o }));
          this.cafes = (St.cafes || [{ id: "CAFE_01", lat: 55.626, lon: 37.668, label: "Кафе (обед 12:00–15:00)", lunch: "12:00-15:00" }]).map(c => ({ ...c }));
          this.travelLegs = (TM.pairs || []).map(p => ({ frm: p.req, to: p.team, mode: "auto", t_min: Math.round(p.time_s / 60), d_km: p.dist_m / 1000 }));
          this.genInfo = `Fallback: demo_bundle (заявок ${this.reqs.length}). default_100.json недоступен.`;
        }
        this.blog("карты: заявок " + this.reqs.length + " / бригад " + this.teams.length + " · " + ((stepT0() - tMap) / 1000).toFixed(3) + "с");
        this.selCafe = (this.cafes[0] || {}).id || null; this.cafeSync();
        let tStrat = stepT0();
        try {
          const s = await apiStrategies();
          this.strategies = s.strategies || []; this.optionsSpec = s.options || {};
          this.prodBaseline = s.prod_baseline || null;
          this.blog("стратегии: " + this.strategies.length + " · " + ((stepT0() - tStrat) / 1000).toFixed(3) + "с");
        } catch (e) { this.strategies = [{ id: "S0", title: "production narrow-first (browser default)", src: "solver.js" }]; this.optionsSpec = {}; this.blog("стратегии: локально S0 (без сервера) · " + ((stepT0() - tStrat) / 1000).toFixed(3) + "с"); }
        this.strategy = "S0";
        let tEng = stepT0();
        try {
          const eng = await apiEngine();
          this.engineInfo = eng;
          this.gpuReason = (eng && eng.gpu && eng.gpu.reason) || "";
          if (!eng.gpu.available) this.engine = "cpu";
          this.blog("движок: " + this.engine + " · " + ((stepT0() - tEng) / 1000).toFixed(3) + "с");
        } catch (e) { this.engineInfo = { cpu: { available: true, desc: "solver.js S0 (browser)" }, gpu: { available: false, desc: "fused-batch", reason: "без сервера" } }; this.engine = "cpu"; this.gpuReason = "без сервера: только browser/engine cpu"; this.blog("движок: локально cpu (без сервера) · " + ((stepT0() - tEng) / 1000).toFixed(3) + "с"); }
        let tRg = stepT0();
        // UI-FIX15: карту ждём (await) — спиннер висит до конца ВСЕХ этапов,
        // раньше пропадал: fire-and-forget loadRgMap + spinStop в finally
        // гасили спиннер до конца фоновой загрузки 36МБ full-карты.
        try {
          await loadQuantOnce();
          this.rgStatus = RG.status === "ready" ? "quant: готов (" + RG.note + ")" : "quant: " + RG.note;
          this.blog("quant: " + RG.status + " " + RG.note + " · " + ((stepT0() - tRg) / 1000).toFixed(3) + "с");
        } catch (e) { this.blog("rg-карта: ОШИБКА · " + ((stepT0() - tRg) / 1000).toFixed(3) + "с"); }
        let tAssign = stepT0();
        try {
          const c = this.contract();
          // BROWSER-ONLY: дефолт-планом считает browser (solver.js S0);
          // server — только fallback (кнопка solverPlace).
          let res = null;
          try {
            res = await solveBrowser({ ...c, engine: this.engine, config: { strategy: "S0", seed: 42 }, options: {} });
            this.blog("движок: browser (solver.js S0, без сервера)");
          } catch (e) {
            res = await apiAssign({ ...c, engine: this.engine, config: { strategy: "S0", seed: 42 }, options: {} });
            this.blog("движок: server-fallback (" + ((e && e.message) || e) + ")");
          }
          const stg = (res.stages || []).map(s => s.name + " " + Number(s.ms).toFixed(3) + "мс").join(" + ");
          this.blog("распределение: done=" + res.done + " · сервер [" + (stg || ("assign " + res.assign_ms + "мс + travel " + res.travel_ms + "мс")) + "] · круг " + ((stepT0() - tAssign) / 1000).toFixed(3) + "с");
          res.strategy = "S0";
          applyServerPlan(this.reqs, res);
          this.storeLegs(res);
          this.rebuild();
          // COLD31-DIAG: best-first — видимую (максимум q-треков) выбираем ДО
          // первого enrich и батчим ОДИН раз. Старый порядок (teams[0]=SE-01
          // с 3 треками → ~4 live-Dijkstra ≈31.7с, потом re-pick SE-30 14/14
          // за 0.07с) выброшен: enrich худшей бригады был тратой.
          // Прогресс live i/n — в спиннере (enrichMissLive), кэш пар — _liveCache.
          try { console.time("cold31:pick"); } catch (_) {}
          let _best0 = null;
          try { _best0 = this.pickVisibleTeam(); } catch (_) { _best0 = null; }
          try { console.timeEnd("cold31:pick"); } catch (_) {}
          this.selTeam = _best0 || (this.teams[0] || {}).id || null; this.showRouteTeam = this.selTeam;
          let tEnr = stepT0();
          try { console.time("cold31:team"); } catch (_) {}
          const rg0 = await enrichLegsQ(this, visibleTeamOf(this));
          try { console.timeEnd("cold31:team"); } catch (_) {}
          this.blog("видимая бригада " + (visibleTeamOf(this) || "?") + ": quant " + rg0.real + "/" + rg0.total + " · " + ((stepT0() - tEnr) / 1000).toFixed(3) + "с (остальные — лениво при клике)");
          res.rgjs_ms = rg0.ms; res.rg_real = rg0.real; res.rg_total = rg0.total;
          this.rebuild();
          this.runs.push({ clock: fmt(this.now), ...res });
          this.solveMetrics = `boot: done=<b>${res.done}</b> · teams=<b>${res.teams_used}</b> · km=<b>${res.km}</b> · ${this.runWallText(res)} · S0 · engine=${res.engine || this.engine}${travelCounter(res)} <span class="ok-badge" style="background:#2ca02c;color:#fff;border-radius:4px;padding:0 5px;font-size:11px">REAL</span>`;
        } catch (e) {
          this.solveMetrics = `boot без сервера: заявки на карте/сетке без плана. ${e && e.message || e}`;
        }
        this.rebuild();
        try { this.loadTransit(); } catch (_) {}
        if (!this.selTeam) this.selTeam = (this.teams[0] || {}).id || null; this.fillTeamForm();
        if (this.reqs[0]) this.selectReq(this.reqs[0].id);
        this.refresh();
      } catch (e) {
        this.bootErr = "boot: " + (e && e.message || e) + ". Открой через сервер: python ui/serve.py → http://127.0.0.1:8901/ui/";
        try { this.rebuild(); this.refresh(); } catch (_) { /* карта/сетка как есть */ }
      } finally { this.spinStop(); }
    },
  },
  mounted() { this.initMap(); this.boot();
    // UI-FIX8: esc → назад к полному пути бригады (сброс изолята ноги).
    document.addEventListener("keydown", e => { if (e.key === "Escape") this.clearSelLeg(); });
  },
}).mount("#app");
