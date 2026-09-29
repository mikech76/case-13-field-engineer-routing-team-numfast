# Copyright (c) 2026 NumFast
# SPDX-License-Identifier: AGPL-3.0-only
"""UI API-server (UI-APP-3 + UI-FIX4): static + POST /api/assign, POST /api/replan, GET /api/strategies.

Run from task3 root: python ui/serve.py  -> http://127.0.0.1:8901/ui/  (основной: статика+API).
Порт 9999 (голый http.server) — тестовый, API там нет. API_BASE в ui/app.js = http://127.0.0.1:8901.
Канонические пути /api/*; /ui/api/* оставлены как legacy-алиас (serve.py не ломать).
No solver-semantics change: delegates to AlgoRegistry.assign (S0-S4) or
production data/scratch_real5/_lib/run.solve_shard for fixture prod100/prod1000.
"""
import json
import os
import sys
import time
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
ALGO_DIR = os.path.join(ROOT, "AlgoRegistry")
if ALGO_DIR not in sys.path:
    sys.path.insert(0, ALGO_DIR)

import _lib.registry as REG  # noqa: E402  (Builder mount, tooling only)

TOY_REQUESTS = [
    {"id": "R1", "ws": 480, "we": 600, "dur": 50, "skills": [], "appear": 420,
     "prio": 1.0, "rtype": "repair", "lat": 0.0, "lon": 0.0},
    {"id": "R2", "ws": 480, "we": 600, "dur": 50, "skills": [], "appear": 420,
     "prio": 1.0, "rtype": "repair", "lat": 0.0, "lon": 0.0},
    {"id": "R3", "ws": 480, "we": 600, "dur": 50, "skills": [], "appear": 420,
     "prio": 1.0, "rtype": "repair", "lat": 0.0, "lon": 0.0},
    {"id": "R4", "ws": 480, "we": 600, "dur": 50, "skills": ["needX"], "appear": 420,
     "prio": 1.0, "rtype": "repair", "lat": 0.0, "lon": 0.0},
]
TOY_TEAMS = [
    {"id": "T1", "skills": [], "mode": "auto", "sh0": 480, "sh1": 1200, "lat": 0.0, "lon": 0.0},
    {"id": "T2", "skills": [], "mode": "auto", "sh0": 480, "sh1": 1200, "lat": 0.0, "lon": 0.0},
]

# options support matrix (honest GAP flags; solver semantics untouched)
OPTIONS_SPEC = {
    "lunch": {"supported": False, "note": "GAP: fit_lunch not in solve path"},
    "home_end": {"supported": False, "note": "GAP: no ReturnHome in solver"},
    "warehouse": {"supported": True, "note": "stock via contract equip/stock"},
    "foot_transit": {"supported": True, "note": "travel mode passthrough"},
}


def _load_real5_run():
    """Load data/scratch_real5/_lib/run.py by file path (bypasses broken
    package __init__ `from _lib.run import ...`). Solver semantics untouched."""
    import importlib.util
    p = os.path.join(ROOT, "data", "scratch_real5", "_lib", "run.py")
    spec = importlib.util.spec_from_file_location("real5_run", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _prod_teams_for(shards):
    """Single shared team source: FIT teams for full run (canon, run.py unchanged)."""
    import importlib.util
    fp = os.path.join(ROOT, "data", "scratch_greed", "fit_loader.py")
    spec = importlib.util.spec_from_file_location("fit_loader", fp)
    fit_loader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fit_loader)
    _, cur = fit_loader.get()  # (reqs, {shard: [teams]})
    return [t for sh in shards for t in cur[sh]]


def _prod_materialize(plans, un, km_tot, viol, assigns, teams_used_set, rejected, reasons):
    """Single shared plans->assigns materialization (one copy, no dup)."""
    total_km = float(km_tot or 0.0)
    total_viol = int(viol or 0)
    for tid, rows in (plans or {}).items():
        for r in rows or []:
            if r.get("kind") != "work":
                continue
            assigns.append({"request_id": str(r["req"]), "team_id": str(tid),
                            "arrive": int(r["arrive"]), "start": int(r["start"]),
                            "end": int(r["end"])})
            teams_used_set.add(str(tid))
    for rid, code in (un or []):
        rejected[str(rid)] = str(code)
        reasons[str(rid)] = "%s %s" % (rid, code)
    return total_km, total_viol


def _prod_fixture(n):
    """Canonical production path: single shared code via scratch_real5 run.py
    (load_inputs/load_cache/Travel/solve_shard). No local insertion logic.
    UNIFY-ASSIGN: assign-path delegates here; run.py semantics untouched."""
    R = _load_real5_run()
    os.chdir(ROOT)
    reqs, teams = R.load_inputs()
    cache = R.load_cache()
    travel = R.Travel(cache, real_ok=False)
    if n == 100:
        reqs = sorted(reqs, key=lambda r: r["id"])[:100]
        shards = sorted({r["shard"] for r in reqs})
    else:
        shards = sorted({r["shard"] for r in reqs})
        try:
            teams = _prod_teams_for(shards)
        except Exception:
            pass
    t0 = time.perf_counter()
    total_km, total_viol = 0.0, 0
    teams_used_set = set()
    assigns, rejected, reasons = [], {}, {}
    for sh in shards:
        # solve_shard -> (plans, un, km_tot, viol, final_legs, t_ins, t_sc);
        # plans: {team_id: [rows {req,arrive,start,end,kind}]}; un: [(id, code)]
        plans, un, km_tot, viol, _legs, _ti, _ts = R.solve_shard(sh, reqs, teams, travel)
        dk, dv = _prod_materialize(plans, un, km_tot, viol, assigns,
                                   teams_used_set, rejected, reasons)
        total_km += dk
        total_viol += dv
    total_done = len(assigns)
    wall = (time.perf_counter() - t0) * 1000.0
    assigns.sort(key=lambda a: (a["team_id"], a["start"], a["request_id"]))
    return {"strategy": "S0", "assignments": assigns, "done": total_done,
            "rejected": rejected, "reasons": reasons, "teams_used": len(teams_used_set),
            "km": round(total_km, 3), "wall_ms": round(wall, 1), "violations": total_viol,
            "fixture": "prod100" if n == 100 else "prod1000"}


# UI-FIX8: geometry per leg. Источник ломаной — только существующий
# RoadServe-путь: POST localhost:8002 /route -> trip.legs[].shape
# (polyline6) -> decode -> [[lat,lon]]. Сервис недоступен (refused) —
# geometry=null, schematic=true ЧЕСТНО (дороги не выдумываются).
# OSRM-cache (data/osrm_cache.json) хранит только время/км, геометрии нет.
import urllib.request as _url

_VALHALLA = "http://127.0.0.1:8002/route"
_VALHALLA_PROBE = {"up": None, "ts": 0.0}

# UI-FIX14: дефолт travel-источника full (public_full из data/map_full CSR);
# moscow (public) оставлен fallback-выбором. Семантика solver не тронута.
# GENERAL-ROUTE: общий маршрутизатор "любое здание→любое здание" по кластерной
# карте: snap(дом)→порты→Dijkstra по port-графу (нативный nf_sssp)→трек→пунктиры
# до домов. Для ЛЮБОЙ пары, без предрасчёта. Reuse: roadgraph RoadServe
# (cluster-portal exact, build-time CSR Dijkstra; query-time только лёгкая
# кластерная карта, CSR в запросе не открывается). Pack-miss → живой расчёт
# (не прямая!). Schematic только при proven-no-path / foot-вне-графа.
_RG_SERVE_MOD = None


def _general_backend():
    """Lazy roadgraph RoadServe backend (один импорт, дальше кэш)."""
    global _RG_SERVE_MOD
    if _RG_SERVE_MOD is not None:
        return _RG_SERVE_MOD
    import importlib.util as _ilu
    libd = os.path.join("C:/App/numfast/roadgraph", "RoadServe", "_lib")
    if libd not in sys.path:
        sys.path.insert(0, libd)  # sssp_kernel сосед по _lib (Builder mount в проде)
    p = os.path.join("C:/App/numfast/roadgraph", "RoadServe", "_lib", "serve.py")
    spec = _ilu.spec_from_file_location("rg_general_serve", p)
    mod = _ilu.module_from_spec(spec)
    spec.loader.exec_module(mod)
    _RG_SERVE_MOD = mod
    return mod


# MISS-LIVE: живой full-карта Dijkstra (public_full CSR bins, N=9056213).
# Кластерный RoadServe (snap_light+port-граф) Домодедово не видит
# (0089 снап 30км при капе 2км → мусорный узел → UNREACHABLE).
# Full-снап плотный (31/3м) + точный Dijkstra + polyline. Только car;
# foot/bike — вне графа (оценка, не точное). Schematic только после
# proven-no-path (INF в обе стороны) / foot-вне-графа.
_FULL = {}
_FULL_DIR = "C:/App/numfast/roadgraph/roadgraph-js/public_full"


def _full_load():
    if _FULL.get("ok"):
        return _FULL
    import numpy as _np
    import os as _os
    need = ["node_lon.bin", "node_lat.bin", "offsets.bin", "heads.bin",
            "length.bin", "speed.bin"]
    for n in need:
        if not _os.path.isfile(_os.path.join(_FULL_DIR, n)):
            _FULL.update(ok=False, err="missing " + n)
            return _FULL
    _FULL["lon"] = _np.memmap(_FULL_DIR + "/node_lon.bin", dtype=_np.int32,
                              mode="r")
    _FULL["lat"] = _np.memmap(_FULL_DIR + "/node_lat.bin", dtype=_np.int32,
                              mode="r")
    _FULL["off"] = _np.memmap(_FULL_DIR + "/offsets.bin", dtype=_np.int32,
                              mode="r")
    _FULL["heads"] = _np.memmap(_FULL_DIR + "/heads.bin", dtype=_np.int32,
                                mode="r")
    _FULL["length"] = _np.memmap(_FULL_DIR + "/length.bin", dtype=_np.uint32,
                                 mode="r")
    _FULL["speed"] = _np.memmap(_FULL_DIR + "/speed.bin", dtype=_np.uint32,
                                mode="r")
    _FULL["N"] = len(_FULL["lon"])
    _FULL["ok"] = True
    return _FULL


def _full_snap(la, lo):
    import numpy as _np
    import math as _m
    F = _full_load()
    if not F.get("ok"):
        return -1, float("inf")
    lon, lat = F["lon"], F["lat"]
    qx, qy = int(lo * 1e7), int(la * 1e7)
    for box in (50000, 200000, 500000, 2000000):
        m = ((lon.astype(_np.int64) - qx < box)
             & (qx - lon.astype(_np.int64) < box)
             & (lat.astype(_np.int64) - qy < box)
             & (qy - lat.astype(_np.int64) < box))
        idx = _np.where(m)[0]
        if len(idx) == 0:
            continue
        dx = ((lon[idx].astype(_np.float64) - qx) / 1e7 * 111320
              * _m.cos(_m.radians(la)))
        dy = (lat[idx].astype(_np.float64) - qy) / 1e7 * 111320
        j = int(_np.argmin(dx * dx + dy * dy))
        return int(idx[j]), float(_m.sqrt(float(dx[j] ** 2 + dy[j] ** 2)))
    return -1, float("inf")


def _full_route(a, b):
    """Full-CSR Dijkstra car: snap + Dijkstra(bbox 0.3) + polyline≤100.
    Возвращает dict(ok,duration_s,distance_m,snap_mm,polyline,settled)
    либо ok=False с proven (INF обе стороны). Одна нога ~2-4с."""
    import heapq as _hq
    import time as _t
    F = _full_load()
    if not F.get("ok"):
        return {"ok": False, "err": F.get("err", "no full map")}
    t0 = _t.perf_counter()
    na, da = _full_snap(a[0], a[1])
    nb, db = _full_snap(b[0], b[1])
    if na < 0 or nb < 0:
        return {"ok": False, "status": "OUT_OF_COVERAGE",
                "snap_mm": [da, db], "proven": False}
    lon, lat, off = F["lon"], F["lat"], F["off"]
    heads, length, speed = F["heads"], F["length"], F["speed"]
    N = F["N"]
    la1, lo1 = float(lat[na]) / 1e7, float(lon[na]) / 1e7
    la2, lo2 = float(lat[nb]) / 1e7, float(lon[nb]) / 1e7
    mg = 0.3
    lo_min, lo_max = min(lo1, lo2) - mg, max(lo1, lo2) + mg
    la_min, la_max = min(la1, la2) - mg, max(la1, la2) + mg
    import numpy as _np
    INF = float("inf")
    dist = _np.full(N, INF, dtype=_np.float64)
    prev = _np.full(N, -1, dtype=_np.int32)
    preve = _np.full(N, -1, dtype=_np.int32)
    dist[na] = 0.0
    h = [(0.0, na)]
    settled = 0
    # Двунаправленная проверка достижимости: прямо; при INF — реверс
    # (proven только если оба INF).
    for src, dst in ((na, nb), (nb, na)):
        dist[:] = INF
        prev[:] = -1
        preve[:] = -1
        dist[src] = 0.0
        h = [(0.0, src)]
        settled = 0
        while h:
            du, u = _hq.heappop(h)
            if du != dist[u]:
                continue
            settled += 1
            if u == dst:
                break
            if settled > 5000000:
                break
            if (_t.perf_counter() - t0) > 25.0:
                break
            for e in range(int(off[u]), int(off[u + 1])):
                v = int(heads[e])
                s = int(speed[e])
                if s <= 0:
                    continue
                lv = lon[v] / 1e7
                if lv < lo_min or lv > lo_max:
                    continue
                av = lat[v] / 1e7
                if av < la_min or av > la_max:
                    continue
                w = max(1, (int(length[e]) * 1000) // s)
                nd = du + w
                if nd < dist[v]:
                    dist[v] = nd
                    prev[v] = u
                    preve[v] = e
                    _hq.heappush(h, (nd, v))
        if dist[dst] != INF:
            if src != na:  # реверс нашёл путь — разворачиваем
                pass
            dur_ms = float(dist[dst])
            # Восстановить путь src->dst
            path = []
            c = dst
            dm = 0.0
            while c != src and c >= 0:
                path.append(c)
                e = int(preve[c])
                if e >= 0:
                    dm += float(length[e]) / 1000.0
                c = int(prev[c])
            path.append(src)
            path.reverse()
            if src != na:  # путь считали в реверсе — он dst->src; строим заново
                # Проще: вернуть путь реверса развёрнутым
                path = path[::-1]
            stride = max(1, (len(path) + 99) // 100)
            poly = [[round(float(lat[n]) / 1e7, 6),
                     round(float(lon[n]) / 1e7, 6)] for n in path[::stride]]
            last = [round(float(lat[dst]) / 1e7, 6),
                    round(float(lon[dst]) / 1e7, 6)]
            if poly[-1] != last:
                poly.append(last)
            if src != na:
                poly = poly[::-1]
            ms = (_t.perf_counter() - t0) * 1000.0
            return {"ok": True, "duration_s": dur_ms / 1000.0,
                    "distance_m": round(dm, 1),
                    "snap_mm": [da, db], "snap_node": [na, nb],
                    "polyline": poly, "settled": settled,
                    "live_ms": round(ms, 1), "rev": src != na}
    ms = (_t.perf_counter() - t0) * 1000.0
    return {"ok": False, "status": "UNREACHABLE", "proven": True,
            "snap_mm": [da, db], "snap_node": [na, nb],
            "settled": settled, "live_ms": round(ms, 1)}


# GENERAL-ROUTE badges (MISS-LIVE: schematic только после proven).
GR_BADGE_LIVE = ("pack-miss: печёного трека нет — считается живьём "
                 "(/api/route full: snap→Dijkstra→polyline), не unreachable")
GR_BADGE_NOPATH = "нет пути (точный Dijkstra исчерпал достижимую компоненту)"
GR_BADGE_FOOT = ("вне графа (foot/bike вне CSR-free кластерной карты: "
                 "оценка haversine*1.3, не точное)")


def _do_route(q):
    """GET /api/route?lat1&lon1&lat2&lon2&mode=car → живой маршрут."""
    try:
        a = (float(q.get("lat1")), float(q.get("lon1")))
        b = (float(q.get("lat2")), float(q.get("lon2")))
    except Exception:
        return {"error": "bad coords (need lat1,lon1,lat2,lon2)"}
    mode = str(q.get("mode", "car")).strip().lower()
    if mode not in ("car", "foot", "bike"):
        return {"error": "bad mode (car|foot|bike)"}
    # MISS-LIVE: car сразу на full-Dijkstra (кластер Домодедово не видит).
    if mode == "car":
        try:
            f = _full_route(a, b)
        except Exception as e:
            return {"error": "full-backend: %s" % e}
        if f.get("ok"):
            n = len(f.get("polyline") or [])
            return {"ok": True, "status": "OK", "mode": mode,
                    "duration_s": f.get("duration_s"),
                    "duration_base_s": f.get("duration_s"),
                    "distance_m": f.get("distance_m"),
                    "distance_estimated": False, "estimated": False,
                    "fallback": ("rev" if f.get("rev") else None),
                    "snap_mm": f.get("snap_mm"), "snap_node": f.get("snap_node"),
                    "ports": None, "schematic": False, "badge": GR_BADGE_LIVE,
                    "polyline": f.get("polyline"), "npts": n,
                    "settled": f.get("settled"),
                    "live_ms": f.get("live_ms")}
        if f.get("proven"):
            return {"ok": False, "status": "UNREACHABLE", "mode": mode,
                    "duration_s": None, "distance_m": None,
                    "distance_estimated": False, "estimated": False,
                    "fallback": None, "snap_mm": f.get("snap_mm"),
                    "snap_node": f.get("snap_node"), "ports": None,
                    "schematic": True, "badge": GR_BADGE_NOPATH,
                    "settled": f.get("settled"), "live_ms": f.get("live_ms")}
    S = _general_backend()
    t0 = time.perf_counter()
    try:
        r = S.route(a, b, mode=mode)
    except Exception as e:
        return {"error": "backend: %s" % e}
    ms = (time.perf_counter() - t0) * 1000.0
    status = r.get("status")
    snap_node, ports = r.get("snap_node"), None
    if isinstance(snap_node, dict) and snap_node.get("a") is not None:
        sc = S._load_light()
        ports = {"pa": [float(sc["lat"][int(snap_node["a"])]) / 1e7,
                        float(sc["lon"][int(snap_node["a"])]) / 1e7],
                 "pb": [float(sc["lat"][int(snap_node["b"])]) / 1e7,
                        float(sc["lon"][int(snap_node["b"])]) / 1e7]}
    if r.get("reachable") and not r.get("estimated"):
        badge, schem = GR_BADGE_LIVE, False
    elif r.get("reachable") and r.get("estimated") and mode == "car":
        badge = ("live-оценка (ниже точности кластера: %s; время "
                 "haversine*1.3, не точное)" % (r.get("fallback") or "intra"))
        schem = True
    elif mode in ("foot", "bike") and r.get("reachable"):
        badge, schem = GR_BADGE_FOOT, True
    elif status == "OUT_OF_COVERAGE":
        badge = ("вне покрытия (точка дальше snap-капа %.0fм; маршрут не "
                 "выдуман)" % S.SNAP_CAP_M)
        schem = True
    else:
        # Кластерный граф пути не видит — НЕ proven (UNREACH-PROOF: full-CSR
        # точный Dijkstra достижимость доказал). Линией не рисуем, прямая
        # запрещена — только бейдж.
        badge = ("кластер-точность: port-граф пути не видит (не proven-no-path; "
                 "точный Dijkstra — следующим шагом); линией не рисуем")
        schem = True
    return {"ok": bool(r.get("reachable")), "status": status, "mode": mode,
            "duration_s": r.get("duration_s"),
            "duration_base_s": r.get("duration_base_s"),
            "distance_m": r.get("distance_m"),
            "distance_estimated": bool(r.get("distance_estimated",
                                            r.get("estimated", False))),
            "estimated": bool(r.get("estimated", False)),
            "fallback": r.get("fallback"),
            "snap_mm": r.get("snap_mm"), "snap_node": snap_node,
            "ports": ports, "schematic": schem, "badge": badge,
            "live_ms": round(ms, 1)}

_RG_PUBLIC = "C:/App/numfast/roadgraph/roadgraph-js/public"
_RG_PUBLIC_FULL = "C:/App/numfast/roadgraph/roadgraph-js/public_full"
_RG_DIST = "C:/App/numfast/roadgraph/roadgraph-js/dist"


def _engine_status():
    """CPU/GPU toggle source of truth. CPU = REG.assign (Q-lookup/matrix path).
    GPU = fused-batch (roadgraph GPU_QSSSP/GPU_FUSED): в этом окружении нет
    рабочего fused assign-endpoint (только доки GPU_FUSED.md/GPU_QSSSP.md),
    поэтому gpu.available=false с причиной, UI дизейблит тоггл."""
    import importlib.util as _ilu
    fused = False
    detail = "no fused assign endpoint in env"
    for cand in (os.path.join(ROOT, "GPU_FUSED.py"),
                 os.path.join(ROOT, "GPU_QSSSP.py"),
                 os.path.join(ROOT, "GPU_FUSED", "_lib", "fused.py")):
        if os.path.isfile(cand):
            fused, detail = True, cand
            break
    try:
        import wgpu  # noqa: F401
        wgpu_ok = True
    except Exception as e:
        wgpu_ok, detail = False, "wgpu import: %s" % e
    gpu_ok = bool(fused and wgpu_ok)
    reason = None if gpu_ok else (
        "GPU fused-batch недоступен: %s (wgpu=%s)" % (detail, wgpu_ok))
    return {"cpu": {"available": True,
                    "desc": "Q-lookup/matrix path (REG.assign + DictTravel)"},
            "gpu": {"available": gpu_ok,
                    "desc": "fused-batch roadgraph GPU_QSSSP/GPU_FUSED",
                    "reason": reason}}


def _valhalla_up():
    """Один быстрый пробник на ответ (кэш 60с): мёртвый RoadServe —
    все ноги сразу schematic, без N×timeout зависания.
    UI-FIX15: timeout 0.25с (было 0.8с) — мёртвый сервис съедал ~800мс
    legs-стадии каждого дефолт-плана; геометрия не меняется (down в обоих
    случаях, ноги schematic честно)."""
    now = time.time()
    if now - _VALHALLA_PROBE["ts"] < 60.0 and _VALHALLA_PROBE["up"] is not None:
        return _VALHALLA_PROBE["up"]
    up = False
    try:
        body = json.dumps({"locations": [{"lat": 55.75, "lon": 37.61},
                                          {"lat": 55.76, "lon": 37.62}],
                           "costing": "auto"}).encode()
        q = _url.Request(_VALHALLA, data=body,
                         headers={"Content-Type": "application/json"})
        r = _url.urlopen(q, timeout=0.25)
        up = r.status == 200
    except Exception:
        up = False
    _VALHALLA_PROBE.update(up=up, ts=now)
    return up


def _decode_polyline6(s):
    """Decode Valhalla shape (polyline6) -> [(lat,lon)]. Pure python."""
    coords, lat, lon, i = [], 0, 0, 0
    n = len(s or "")
    while i < n:
        for k in (0, 1):
            shift, res = 0, 0
            while True:
                b = ord(s[i]) - 63
                i += 1
                res |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            d = ~(res >> 1) if (res & 1) else (res >> 1)
            if k == 0:
                lat += d
            else:
                lon += d
        coords.append((lat / 1e6, lon / 1e6))
    return coords


def _fetch_route_geom(a, b, mode="auto"):
    """RoadServe route->polyline. Возвращает [[lat,lon]] или None."""
    costing = {"auto": "auto", "scooter": "motor_scooter",
               "bicycle": "bicycle", "foot": "pedestrian"}.get(
        str(mode).strip().lower(), "auto")
    body = json.dumps({"locations": [{"lat": a[0], "lon": a[1]},
                                     {"lat": b[0], "lon": b[1]}],
                       "costing": costing}).encode()
    q = _url.Request(_VALHALLA, data=body,
                     headers={"Content-Type": "application/json"})
    try:
        r = _url.urlopen(q, timeout=1.5)
        t = json.loads(r.read().decode("utf-8"))
        shape = (t.get("trip", {}).get("legs") or [{}])[0].get("shape", "")
        pts = _decode_polyline6(shape)
        if len(pts) < 2:
            return None
        if len(pts) > 100:  # decimate для UI
            step = len(pts) / 100.0
            pts = [pts[int(i * step)] for i in range(100)] + [pts[-1]]
        return [[round(la, 6), round(lo, 6)] for la, lo in pts]
    except Exception:
        return None  # честно: нет данных


def _build_legs(res, requests, teams):
    """Дослать к ответу legs: [{team_id,idx,frm,to,geometry,schematic}].
    UI-FIX22: времена ног — батч-матрица сервера (REG.assign Q-lookup, arrival/
    start/end уже в assignments); геометрия здесь НЕ считается: всегда
    schematic-заглушка (geometry=null), реальную ломаную лениво строит клиент
    enrichLegsRg только видимой бригады. Пробника Valhalla и per-leg fetch
    нет — legs-стадия ~0мс вместо ~260мс (пробник 0.25с при мёртвом 8002)."""
    coords = {}
    for t in teams or []:
        la = t.get("lat", t.get("start_lat", 0.0)) or 0.0
        lo = t.get("lon", t.get("start_lon", 0.0)) or 0.0
        try:
            coords["START:" + str(t.get("id"))] = (float(la), float(lo))
        except Exception:
            continue
    for r in requests or []:
        try:
            coords[str(r.get("id"))] = (float(r.get("lat", 0.0) or 0.0),
                                        float(r.get("lon", 0.0) or 0.0))
        except Exception:
            continue
    by_team = {}
    for a in res.get("assignments", []):
        by_team.setdefault(str(a.get("team_id")), []).append(a)
    legs = []
    # UI-FIX22: без геометрии — клиент enrich добьёт только видимую бригаду.
    for tid, lst in by_team.items():
        lst = sorted(lst, key=lambda a: (a.get("start", 0),
                                         a.get("request_id", "")))
        prev = "START:" + tid
        for i, a in enumerate(lst):
            to = str(a.get("request_id"))
            legs.append({"team_id": tid, "idx": i, "frm": prev, "to": to,
                         "geometry": None, "schematic": True,
                         "exact_geometry": None})  # UI-FIX12: lazy per-leg exact port->port, fills on leg request
            prev = to
    res["legs"] = legs
    res["legs_real"] = sum(1 for l in legs if not l["schematic"])
    return res


def _do_assign(body):
    t_all0 = time.perf_counter()
    if body.get("fixture") in ("prod100", "prod1000"):
        res = _prod_fixture(100 if body["fixture"] == "prod100" else 1000)
        wall_all = (time.perf_counter() - t_all0) * 1000.0
        res["stages"] = [{"name": "assign", "ms": round(float(res.get("wall_ms", wall_all)), 3)},
                         {"name": "legs", "ms": 0.0}]
        return res
    if str(body.get("engine", "cpu")).lower() == "gpu":
        st = _engine_status()
        if not st["gpu"]["available"]:
            raise RuntimeError("engine=gpu rejected: %s" % st["gpu"]["reason"])
    requests = body.get("requests", [])
    teams = body.get("teams", [])
    travel = body.get("travel", {})
    config = dict(body.get("config", {}))
    config.setdefault("strategy", "S0")
    config.setdefault("seed", 42)
    opts = body.get("options", config.get("options", {}))
    gaps = {k: v for k, v in OPTIONS_SPEC.items() if not v["supported"]}
    t_a0 = time.perf_counter()
    res = REG.assign(requests, teams, travel, config)
    assign_ms = (time.perf_counter() - t_a0) * 1000.0
    res["options_applied"] = {k: bool(opts.get(k, False)) for k in OPTIONS_SPEC}
    res["gaps"] = gaps
    res["seed"] = int(config.get("seed", 42))
    res["engine"] = str(body.get("engine", "cpu")).lower()
    res["assign_ms"] = round(assign_ms, 1)
    t_l0 = time.perf_counter()
    res = _build_legs(res, requests, teams)
    legs_ms = (time.perf_counter() - t_l0) * 1000.0
    res["travel_ms"] = round(legs_ms, 1)
    res["wall_ms"] = round(float(res.get("wall_ms", 0.0)) + res["travel_ms"], 1)
    # UI-FIX13: реальные stage timings (замер perf_counter, не выдумка; additive only).
    res["stages"] = [{"name": "assign", "ms": round(assign_ms, 3)},
                     {"name": "legs", "ms": round(legs_ms, 3)}]
    return res


def _do_replan(body):
    requests = body.get("requests", [])
    teams = [dict(t) for t in body.get("teams", [])]
    travel = body.get("travel", {})
    config = dict(body.get("config", {}))
    config.setdefault("strategy", "S0")
    config.setdefault("seed", 42)
    state = body.get("state", {})
    t_now = int(state.get("t_now", 540))
    done_ids = set(map(str, state.get("done", [])))
    prog_ids = set(map(str, state.get("in_progress", [])))
    frozen_ids = done_ids | prog_ids
    # end time of in-progress ops per team from last assignments (remainder starts after them)
    end_by_team = {}
    for a in state.get("assignments", []):
        if str(a.get("request_id")) in prog_ids:
            tid = str(a.get("team_id"))
            end_by_team[tid] = max(end_by_team.get(tid, t_now), int(a.get("end", t_now)))
    for t in teams:
        avail = t.get("avail_t", t.get("sh0", 480))
        try:
            avail = int(avail)
        except Exception:
            avail = 480
        bump = max(t_now, end_by_team.get(str(t.get("id")), t_now))
        t["avail_t"] = max(avail, bump)
        if str(t.get("id")) in end_by_team:
            # avail point = last in-progress request of that team
            last = [a for a in state.get("assignments", [])
                    if str(a.get("team_id")) == str(t.get("id"))
                    and str(a.get("request_id")) in prog_ids]
            if last:
                last.sort(key=lambda a: int(a.get("end", 0)))
                t["avail_p"] = last[-1]["request_id"]
    remain = [r for r in requests if str(r.get("id")) not in frozen_ids]
    t_a0 = time.perf_counter()
    res = REG.assign(remain, teams, travel, config)
    res["assign_ms"] = round((time.perf_counter() - t_a0) * 1000.0, 1)
    res["frozen"] = len(frozen_ids)
    res["pending"] = len(remain)
    res["t_now"] = t_now
    res["gaps"] = {k: v for k, v in OPTIONS_SPEC.items() if not v["supported"]}
    res["seed"] = int(config.get("seed", 42))
    res["engine"] = str(body.get("engine", "cpu")).lower()
    t_l0 = time.perf_counter()
    res = _build_legs(res, requests, teams)
    legs_ms = (time.perf_counter() - t_l0) * 1000.0
    res["travel_ms"] = round(legs_ms, 1)
    res["wall_ms"] = round(float(res.get("wall_ms", 0.0)) + res["travel_ms"], 1)
    # UI-FIX13: реальные stage timings (additive only).
    res["stages"] = [{"name": "assign", "ms": round(float(res.get("assign_ms", 0.0)), 3)},
                     {"name": "legs", "ms": round(legs_ms, 3)}]
    return res


def _strategies():
    out = []
    for s in REG.list_strategies():
        r = REG.assign(TOY_REQUESTS, TOY_TEAMS, {}, {"strategy": s["id"], "seed": 42})
        out.append({"id": s["id"], "title": s["title"], "src": s["src"],
                    "profile": {"fixture": "toy4", "done": r["done"],
                                "teams_used": r["teams_used"], "km": r["km"],
                                "wall_ms": r["wall_ms"], "violations": r["violations"],
                                "rejected": len(r["rejected"])}})
    return {"strategies": out, "seed": 42,
            "prod_baseline": {"S0": {"prod100": 89, "prod1000": 787}},
            "options": OPTIONS_SPEC}


class Handler(SimpleHTTPRequestHandler):
    def _send(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def _serve_file(self, rel, ctype):
        p = os.path.join(ROOT, rel)
        if not os.path.isfile(p):
            self.send_error(404)
            return
        with open(p, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path in ("/api/strategies", "/ui/api/strategies"):
            try:
                return self._send(_strategies())
            except Exception as e:
                return self._send({"error": str(e)}, 500)
        if path in ("/api/engine", "/ui/api/engine"):
            try:
                return self._send(_engine_status())
            except Exception as e:
                return self._send({"error": str(e)}, 500)
        # GENERAL-ROUTE: живой маршрут любой пары (pack-miss fallback, не прямая).
        if path in ("/api/route", "/ui/api/route"):
            try:
                q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                q = {k: (v[0] if isinstance(v, list) else v) for k, v in q.items()}
                return self._send(_do_route(q))
            except Exception as e:
                return self._send({"error": str(e)}, 500)
        # BROWSER-ONLY: static quant pack ui/q/ (matrices/ports/quants/tracks).
        # CSR routes (/rg/, /rg_full/, /rgjs/) kept but never used by front.
        if path.startswith("/q/"):
            qbase = os.path.join(ROOT, "ui", "q", path[len("/q/"):])
            if not os.path.isfile(qbase):
                return self._send({"error": "quant artifact not found"}, 404)
            with open(qbase, "rb") as f:
                data = f.read()
            ct = "application/json; charset=utf-8" if qbase.endswith(".json") else "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", ct)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)
            return
        # UI-FULLQ: south addition ui/q_south/ (hybrid pack: moscow base + south tracks).
        if path.startswith("/q_south/"):
            qbase = os.path.join(ROOT, "ui", "q_south", path[len("/q_south/"):])
            if not os.path.isfile(qbase):
                return self._send({"error": "quant-south artifact not found"}, 404)
            with open(qbase, "rb") as f:
                data = f.read()
            ct = "application/json; charset=utf-8" if qbase.endswith(".json") else "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", ct)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)
            return
        if path.startswith("/rg_full/"):
            base = _RG_PUBLIC_FULL + "/" + path[len("/rg_full/"):]
            if not os.path.isfile(base):
                return self._send({"error": "rg artifact not found"}, 404)
            with open(base, "rb") as f:
                data = f.read()
            ct = "application/json; charset=utf-8" if base.endswith(".json") else "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", ct)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)
            return
        if path.startswith("/rg/"):
            base = _RG_PUBLIC + path[3:]
            if not os.path.isfile(base):
                return self._send({"error": "rg artifact not found"}, 404)
            with open(base, "rb") as f:
                data = f.read()
            ct = "application/json; charset=utf-8" if base.endswith(".json") else "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", ct)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)
            return
        if path.startswith("/rgjs/"):
            base = _RG_DIST + path[5:]
            if not os.path.isfile(base):
                return self._send({"error": "rgjs not found"}, 404)
            with open(base, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)
            return
        # UI-FIX5.1 root-mapping: / отдаёт UI (index.html), API только /api/*.
        if path in ("/", "/index.html"):
            return self._serve_file("ui/index.html", "text/html; charset=utf-8")
        if path in ("/app.js", "/styles.css", "/qlegs.js", "/solver.js",
                      "/default_100.json", "/transit_stops.json"):
            ct = "text/css; charset=utf-8" if path.endswith(".css") else (
                "application/json; charset=utf-8" if path.endswith(".json") else "text/javascript; charset=utf-8")
            return self._serve_file("ui" + path, ct)
        if path.startswith(("/vendor/", "/tiles/")):
            ext = os.path.splitext(path)[1].lower()
            ct = {".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png"}.get(ext, "application/octet-stream")
            return self._serve_file("ui" + path, ct)
        return super().do_GET()

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path not in ("/api/assign", "/api/replan",
                        "/ui/api/assign", "/ui/api/replan"):
            return self._send({"error": "not found"}, 404)
        try:
            n = int(self.headers.get("Content-Length", 0) or 0)
            body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        except Exception as e:
            return self._send({"error": "bad json: %s" % e}, 400)
        try:
            if path.endswith("/api/assign"):
                return self._send(_do_assign(body))
            return self._send(_do_replan(body))
        except Exception as e:
            return self._send({"error": str(e)}, 500)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


if __name__ == "__main__":
    os.chdir(ROOT)
    print("UI+API on http://127.0.0.1:8901/ui/  (POST /api/assign /api/replan, GET /api/strategies)")
    ThreadingHTTPServer(("127.0.0.1", 8901), Handler).serve_forever()
