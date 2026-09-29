# CONDITIONS_SPEC — каталог условий планирования (task3)

> Только документация. Кода нет. Источники: `data/m2_orders_72.csv` (72, cp1251, `;`), `data/m2_workers_12.csv` (12), `specs/data_model.toml`, `specs/workers.toml`, `specs/work_norms.toml`, `specs/vehicles.toml`, `specs/routing.toml`, `specs/traffic_profile.toml`, `specs/scenario.toml`. Синтетика помечена `synthetic=true` там же.

## 1. Участки (districts / sectors)

- Словарь: `district: string (cp1251) -> district_id: u8 (0..31)`. Маппинг строится при загрузке CSV, канонические имена — как в `district` колонке (пример: Царицыно и др.; полный список = `uniq(district)` из 72 строк).
- Индекс: `district_id -> {office_id, brigade_ids[], request_ids[]}`. Хранится на CPU; на GPU только `request.district: u8` (см. `data_model.toml`).
- Свой офис: каждый участок привязан к одному офису из §4 (A/B/C). Правило: `office_of(district) = argmax офиса по числу заявок участка` (факт из `workers.toml`: кластеры A/B/C).
- Свои заявки/бригады: заявка принадлежит участку по `district`; бригада — по `home_base`/`cluster` (Vostok=A, SouthEast=B, SouthCenter=C).
- Дробление районов: район дробится внутри на подсекции `district_id:sub` (суффикс `:N`) без изменения `district_id` — только для балансировки; маршрутизация и skill/window-фильтры работают по `district_id`, саб-секция — CPU-хинт для префильтра `dist2 keep 80`.
- РЕШЕНИЕ: новые районы добавляются без миграции — `district_id` выдаётся инкрементом, `office_of` пересчитывается.

## 2. Заявки (requests)

### 2.1 Типы (из данных, ничего не потеряно)
Канонических BK-типов 4 (колонка `BK_type`, 72 шт.: 27/19/16/10). Пятый пункт заказчика «авария» = подтип глобальной:
| # | BK_type (данные) | HD-примеры (данные) | req_mask | vehicle_req (преобл.) |
|---|---|---|---|---|
| 1 | Подключение | — | 1 (19 шт.) | bicycle/auto |
| 2 | Локальная заявка | Рост ошибок на порту и др. (24 — «Отдельная услуга»-класс) | 1/5 | bicycle |
| 3 | Глобальная проблема | авария/ТКД-класс | 6 (10 шт.) | auto |
| 4 | Дозаказ (доп. оборудование) | — | 5 (27 шт.) | auto/scooter |
| 5 | Авария = Глобальная + `priority=P1` + `sla_hours<=8` | — | 6 | auto |
- Маппинг HD: `HD_type` (16 уникальных в 72) — только CPU-строка, на планирование влияет только через `req_mask` + норму длительности (§6). TODO из `work_norms.toml [mapping.hd]` — не выдумывать, заполнить по кураторам.
- Окно: `[ws,we]` в формате `чч:мм` (мин. 0..1439, `uint16`). Источник: колонки `begin/end` (`17.08.2026 HH:MM`); дата отбрасывается, берётся время. `window_start=ws`, `window_end=we` (конец = latest finish, см. `data_model.toml`).

### 2.2 Статусы — РЕШЕНИЕ
Базовые 4 от заказчика + 3 доп. (обоснование ниже). Канонические коды:
| code | human-ru | terminal | обоснование |
|---|---|---|---|
| `UNASSIGNED` | не распределена | нет | базовый |
| `ASSIGNED` | распределена — ожидается | нет | базовый |
| `IN_PROGRESS` | выполняется | нет | базовый |
| `DONE` | выполнено | да | базовый |
| `CANCELLED` | отменена | да | нужен: в данных `BK_status` есть «Отменена» (23 шт. непустых статусов), без него funnel врёт |
| `IMPOSSIBLE` | невозможна (окно/навык/гео) | да | нужен: терминал для death-tree (M3B держит 7 UNASSIGNED как тест); отделяет «не взяли» от «невозможно» |
| `RESCHEDULED` | перенесена | нет | нужен: окно уехало за смену/день; иначе перенос маскируется под UNASSIGNED |
- Исходный `BK_status` из CSV (8 уникальных incl. пусто) — сырой вход, маппится в канон при загрузке; пусто = `UNASSIGNED`.
- Переходы: `UNASSIGNED->ASSIGNED->IN_PROGRESS->DONE`; из любого нетерминала `->CANCELLED/RESCHEDULED`; `RESCHEDULED->UNASSIGNED` (новое окно); `IMPOSSIBLE` — только из `UNASSIGNED` по итогу funnel (§2.3).

### 2.3 Причины неназначения — РЕШЕНИЕ (enum + human + funnel-счётчики)
Формат зафиксирован (одна строка на отказ):
`{code: UPPER_SNAKE, human_ru: string, stage: prefilter|routing|scoring, counters+: funnel_stage++}`.
Funnel-счётчики для аналитики: каждый отказ инкрементит `funnel[code]++` и `funnel_by_stage[stage]++`; аналитика читает только `funnel`, не логи.
| code | human-ru | stage |
|---|---|---|
| `NO_SKILL` | нет навыка у бригады | prefilter |
| `NO_WINDOW` | окно не пересекает смену/разрыв | prefilter |
| `NO_SHIFT` | нет смены (выходной/availability=false) | prefilter |
| `NO_VEHICLE` | транспорт несовместим | prefilter |
| `NO_EQUIP` | нет оборудования на складе/у бригады | scoring |
| `OVERLOAD_TIME` | не влезает по времени (дорога+работа+обед+дела) | scoring |
| `UNREACHABLE` | маршрут >60 мин cut / absent==unreachable | routing |
| `CANCELLED_OP` | снята оператором (BK_status=Отменена) | prefilter |
- Порядок funnel = порядок строк (первый зафейленный предикат — причина; дальше не проверять).

## 3. Бригады (workers/teams)

- Словарь навыков: `{connect:0, local:1, global:2}` (3 бита). Битовая маска `skill_mask: u8 0..7` (см. `data_model.toml`, `workers.toml`). Покрытие M2: mask_1=2, mask_2=2, mask_5=2, mask_6=2, mask_3=2, mask_7=2. Совместимость: `(worker.mask & req.mask) == req.mask`.
- Смены: `shift_start/shift_end: мин (uint16) + start_x/start_y + home_x/home_y (int32 м, проекция lat0=55.6557643 lon0=37.6768915)`. Факт: A 08–20 (480–1200), B/C 09–21 (540–1260). Несколько смен: список `shifts[]` (1..N) на бригаду; пересечения запрещены, сортировка по `shift_start`.
- Личные дела = разрыв смены: `gap {point_x,point_y, t_end, t_start}` — бригада обязана быть в точке к `t_end` и свободна с `t_start`; планировщик трактует как жёсткое окно-барьер (не обед: не сдвигается).
- Конечная точка — 3 варианта (РЕШЕНИЕ, радиокнопка на бригаду, дефолт B):
  - `OPEN` — где угодно (конец = последняя заявка, штрафа за возврат нет);
  - `NEAR` — ближе к точке (дом/офис; штраф `home_penalty = dist(last,anchor)*cost_km`, см. `data_model [plan.penalty]`);
  - `ANCHOR` — среди дня + доезд до цели типа поликлиники (якорь `mid {point, t_earliest,t_latest}` + финальная цель `target {point}`; опоздание к якорю = `OVERLOAD_TIME`).
- Транспорт: словарь `{foot=пешком+ОТ, bicycle=вело, scooter=мото/самокат 25, auto=авто}`. Маппинг Valhalla costing: `foot->pedestrian, bicycle->bicycle, scooter->motor_scooter+top25, auto->auto` (см. `vehicles.toml`, `routing.toml`). Факт парка M2: auto=5, scooter=3, bicycle=2, foot=2.
- Грузоподъёмность по транспорту (мест оборудования, настраиваемо): дефолт `foot=5, bicycle=5, scooter=8, auto=10` (заказчик: 5/8/10 + настраиваемо; bicycle=5 как foot — решение: iguales по багажнику). Глобально в §6 + `overrides` на бригаду.

## 4. Точки карты (geo points)

| вид | поля | примечание |
|---|---|---|
| офис | `office_id, lat,lon, x,y` | 3 шт. (A Восток 55.7004/37.7495, B Бирюлёвская 55.6021/37.6653, C Симферопольский 55.6648/37.6158, via Nominatim 2026-09-15) |
| дом бригады | `home_x/home_y + lat/lon` | джиттер seed 42: start ±400м, home ±600м |
| адрес личного дела | `point_x/point_y + t_end/t_start` | см. §3 gap |
| кафе (обед) | `point, lunch_window [ls,le], deadline` | обед: окно `ls..le` + граничное время `deadline` (позже deadline обед пропускается со штрафом, не барьером — в отличие от дел) |
- Все координаты канонически `int32` метры в локальной проекции (§3); `lat/lon` — только для геокодирования/Valhalla.

## 5. Оборудование (inventory)

- 3 вида: `router` (роутеры), `stb` (приставки), `alice` (Алиса/колонка). Коды `0,1,2`; счётчики `u8/u16`.
- Склад с утра: `stock_office[office_id][sku] = N` — выдача на бригаду до выезда; дефицит = `NO_EQUIP`.
- Счётчик у бригады: `inv[brigade][sku]`, кап = грузоподъёмность (§3/§6); расход по заявке: `need[req_type][sku]` (дефолт: подключение=router1+stb1, дозаказ=по строке дозаказа, локальная/глобальная=0, авария ТКД=по факту; настраиваемо в §6). Пополнение только со склада/офиса, среди дня — нет (кроме тумблера `resupply_midday`, дефолт off).
- Инвариант: `sum(inv)+sum(stock)==const` за день (без midday-resupply).

## 6. Матрицы настроек (всё числовое; глобально + overrides на бригаду)

Глобальные дефолты (источники указаны). Индивидуальные overrides: `overrides[brigade_id][param]=value` (пусто = глобал).

### 6.1 Приоритеты типов (вес скоринга; больше = раньше/важнее)
| param | подключение | локальная | глобальная | дозаказ | авария(P1) |
|---|---|---|---|---|---|
| `w_type` | 100 | 60 | 150 | 40 | 200 |
- `priority P1/P2/P3 -> w_prio = {200,100,50}` (факт: P1=10, P2=27, P3=35 из 72). Итог: `score = w_type + w_prio - travel_min*1.0 - wait_min*0.5 - home_penalty_km*cost_km`.

### 6.2 Скорости по транспортам (для эвристик; истина = Valhalla)
| транспорт | implied км/ч (эвристика) | costing |
|---|---|---|
| foot (+ОТ) | 5 | pedestrian |
| bicycle | 15 | bicycle |
| scooter | 23.8 (замер §routing M2: 6.919км/1092.3с) | motor_scooter top25 |
| auto | 30 город (эталон, не км/40) | auto |
- Правило: эвристика только для префильтра; решение — только `time_s` из матрицы (`routing.toml`: topK, 60min cut).

### 6.3 Грузоподъёмность (шт.)
| транспорт | default | override-пример |
|---|---|---|
| foot | 5 | ENG-11=6 |
| bicycle | 5 | — |
| scooter | 8 | — |
| auto | 10 | ENG-01=12 |

### 6.4 Нормы длительностей, мин (curator-real, `work_norms.toml`)
| тип | road | work | docs | total |
|---|---|---|---|---|
| подключение (connect_base) | 20 | 60 | 10 | 90 |
| авария ТКД (accident_tkd) | 20 | 80 | 0 | 100 |
| дозаказ (extra_equipment) | 20 | 10 | 10 | 40 |
| локальная (local_repair) | 20 | 30 | 0 | 50 |
- `duration_min` синтетика в CSV — только seed; план использует `total` выше; `road 20` — норматив для бенчмарка против реального routing.

### 6.5 Коэффициенты
| param | default | note |
|---|---|---|
| `traffic_factor(bucket,class,dir,district)` | §traffic_profile (1.00–1.60; утро 1.45, вечер 1.60) | synthetic-v1-coarse; `t=t0*factor` |
| `cost_rub_km` | auto 25, scooter 12, bicycle 3, foot 0 | `workers.toml [cost_fix]`, synthetic |
| `cost_rub_h` | по бригаде (495–814) | из `workers.toml` |
| `wait_weight / travel_weight` | 0.5 / 1.0 | скоринг §6.1 |
| `lunch_miss_penalty` | 30 (очков) | настраиваемо |
| `topK_sparse / dist2_keep / hard_cut` | 8 (M2) / 80 / 60 мин | `scenario.toml`/`routing.toml` |

## 7. Опциональность (тумблеры)

- Обязательны всегда: заявки (§2) + бригады (§3: навыки, смены, транспорт). Без них план невозможен.
- Остальное — тумблеры (дефолт off, кроме возврата B?): `lunch{on,ls,le,deadline}`, `personal_gaps{on}`, `end_mode{OPEN|NEAR|ANCHOR}`, `inventory{on}`, `return_to_office{off}`, `home_end{off}`, `traffic{off}`, `resupply_midday{off}`.
- Выключенный тумблер = предикат всегда true, счётчик funnel не трогается.

## 8. Codegen: компиляция условий в ExecutionGraph/предикаты numfast (схема, не код)

- Вход: CONDITIONS_SPEC (§1–§7) + `overrides[brigade]` + тумблеры. Выход на план: `ExecutionGraph {nodes: predicates[], edges: funnel-order}` + `SoA-buffers` по `data_model.toml`.
- Схема (5 стадий, порядок = funnel §2.3):
  1. `Load`: CSV->SoA (`request.*`, `worker.*` int32/маски/минуты; строки только CPU). Словари (`district`, навыки, sku) -> `id`-таблицы.
  2. `Bind`: `overrides` мержатся в per-бригаду константы (`cap, w_type, cost_km, end_mode, lunch/gap окна`); тумблеры off вычёркивают узлы.
  3. `Prefilter (CPU, dist2)`: предикаты `SKILL & WINDOW & SHIFT & VEHICLE & CANCELLED` -> `keep80 -> topK(8/15)` кандидаты; отказ пишет `funnel[code]`.
  4. `Route (Valhalla batch)`: `sources_to_targets + departure(bucket)` -> `time_s/dist_m/valid (absent==unreachable)`; `UNREACHABLE` при `time<0|>60мин`; трафик = `t0*factor` (§6.5).
  5. `Score (GPU-потребитель)`: предикаты `EQUIP & TIME_FIT & LUNCH/GAP/ANCHOR` + `score` (§6.1); `plan{worker,order,penalty}` + `event{arrival,slack,verdict}`; `slack<0 -> OVERLOAD_TIME`.
- Предикат = чистая функция над SoA-строкой `(req, worker, t, inv)` -> `{pass, code?}`; порядок предикатов = порядок строк §2.3 (первый fail = причина). Новые условия добавляются новым узлом, старые графы не меняются.
- Инварианты кодогена: `int32` логика / `int64` аккумуляторы / `float64` только показ; `time>=0 valid`; seed 42 для синтетики; funnel-счётчики — единственный канал аналитики.

## 9. Решения по открытым вопросам (фиксация)

1. Статусы: база 4 + `CANCELLED/IMPOSSIBLE/RESCHEDULED` (§2.2).
2. Причины: 8 кодов `NO_SKILL/NO_WINDOW/NO_SHIFT/NO_VEHICLE/NO_EQUIP/OVERLOAD_TIME/UNREACHABLE/CANCELLED_OP`, формат `{code,human_ru,stage,counters+}` (§2.3).
3. Конечная точка: 3 режима `OPEN/NEAR/ANCHOR`, дефолт `NEAR` (§3).
4. Авария: не отдельный BK, а `Глобальная+P1+sla<=8` (§2.1).
5. Обед vs дела: обед сдвигаем/пропускаем со штрафом; дела — жёсткий барьер (§3–§4).
6. HD-маппинг: не выдумывать, ждёт кураторов (`work_norms [mapping.hd]` TODO).

## 10. Кодировки (UTF8-ALL): все новые/производные данные — только UTF-8; legacy cp1251 читать только на входе (`open(..., encoding='cp1251')`), исходники `tz/` не трогать.
- Сконвертировано cp1251→UTF-8 (13, 2026-09-27): `data/m2_orders_72.csv`, `data/m3a_excluded.csv`, `data/processed/geocode_batch_request.csv`, `data/processed/geocode_cache.csv`, `data/processed/geocode_problems.csv`, `data/processed/geocoded.csv`, `data/processed/offices_start_candidates.csv`, `data/processed/SC_control_clean.csv`, `data/processed/SC_synt_clean.csv`, `data/processed/SE_control_clean.csv`, `data/processed/SE_synt_clean.csv`, `data/processed/Vostok_control_clean.csv`, `data/processed/Vostok_synt_clean.csv`; `tz/*.csv` (6) не тронуты.
