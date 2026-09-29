# demo_bundle — m2-72x12 (JSON, без СУБД)

- scenario: m2-72x12, date 2026-08-17, seed 42
- counts: requests=72, teams=12, members=12, matrix_pairs=828 (feasible из 864)
- sources: data/m2_orders_72.csv, data/m2_workers_12.csv + specs/workers.toml, specs/skills.toml, specs/vehicles.toml, specs/work_norms.toml, specs/dispatcher/REFERENCE_DATA.md (weights), ui/scenario_base197.js (CAFE_01), data/processed/traffic_hourly_moscow_v1.json, data/m5_valhalla_72x12.csv
- alternates (в бандл НЕ входят): data/base_requests_clean.csv (197), data/canonical/requests_100.csv + teams_100.csv, data/realistic1000_*.csv, data/synth10000_*.csv
- excluded (гигабайты, только ссылки в territories.json): valhalla PBF/tiles, transit raw/stop_times/metro, traffic raw html/jsonp, tz audio/video, *.npz/osrm_cache/geocode_cache, traces
- use: t(h)=time_s*k[h]; overrides из team_members.json поверх teams.json по id; геометрия legs — прямая (формат ui/app.js mockRoadServe), замена — solver-адаптер
- provenance: geo/coords — real (Nominatim/Valhalla); durations/priority/costing/cafe/shifts — synthetic; norms — curator-real (Нормативы.xlsx); traffic k(h) — derived real (TCI)
