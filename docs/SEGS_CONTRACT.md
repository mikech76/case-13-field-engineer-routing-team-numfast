# SEGS_CONTRACT — общий формат segs (оба фронта / оба бэка)

Один рейс = один seg. Хронология на команду: сортировка по `(start, end)`.

## 1. Таблица полей seg

| Поле | Тип | Обяз. | Значения / формат |
|---|---|---|---|
| `team` | string | да | id бригады, напр. `FIT-SE-01` |
| `frm` | string\|null | да | id точки старта; `START:<team>` для первой ноги; null только если `status=done` без гео |
| `to` | string | да | id точки финиша: `SYNTH-*`, `CAFE_*`, `DEPOT`, `START:<team>` |
| `arrive` | string | да | `YYYY-MM-DD HH:MM`, факт прибытия в `to` |
| `start` | string | да | `YYYY-MM-DD HH:MM`, начало работ/обеда/движения; инвариант `arrive <= start <= end` |
| `end` | string | да | `YYYY-MM-DD HH:MM`, конец сегмента |
| `kind` | enum | да | `work` / `lunch` / `restock` / `personal` / `travel` / `wait` |
| `geometry` | polyline\|null | да | `[[lon,lat],...]` либо null + обязательное `src` |
| `src` | enum | да, если geometry null | `q-full` / `exact-dijkstra` / `haversine` / `schematic` |
| `status` | enum | да | `done` / `plan` / `predicted` |

Правила:
- `work`: `to` = заявка; `arrive` = приезд, `start`/`end` = окно работ.
- `lunch`: `to` = конкретная кафешка (`CAFE_01`), не абстрактный "обед". `frm` = предыдущая точка, `arrive=start` конца переезда, `end=start+60мин`.
- `travel`/`wait`: служебные ноги между работами; `travel`: `arrive=end` (чистый переезд); `wait`: `arrive<start` (ожидание окна).
- `restock`/`personal`: как `lunch`, `to` = `DEPOT` / точка.
- Первая нога маршрута: `frm=START:<team>`, `kind=travel|wait`, `to` = первая заявка/кафе.
- `geometry=null` допустим только с `src=haversine|schematic`; фронт рисует прямую/пунктир. `q-full`/`exact-dijkstra` требуют полилинию.

## 2. Replan-контракт

```json
{"frozen_prefix": ["seg-id-1", "seg-id-2"], "avail": {"FIT-SE-01": {"avail_t": "2026-08-17 14:00", "avail_p": [37.61, 55.75]}}}
```

- `frozen_prefix`: id segs со `status=done` — не двигать, не удалять, не перенумеровывать.
- `avail_t` / `avail_p`: время и позиция освобождения команды; реплан строит только ноги со `start >= avail_t` от `avail_p`.
- Ноги `START:<team>` пересоздавать запрещено для frozen-части; для активной части `frm` первой свободной ноги = последняя frozen-точка (или `START:<team>`, если frozen пуст).

## 3. Пример JSON (один рейс: работа + обед)

```json
[
  {"team": "FIT-SE-04", "frm": "SYNTH-0021", "to": "CAFE_01", "arrive": "2026-08-17 13:50", "start": "2026-08-17 13:50", "end": "2026-08-17 14:50", "kind": "lunch", "geometry": [[37.62, 55.74], [37.63, 55.75]], "src": "q-full", "status": "plan"},
  {"team": "FIT-SE-04", "frm": "START:FIT-SE-04", "to": "SYNTH-0231", "arrive": "2026-08-17 08:01", "start": "2026-08-17 10:00", "end": "2026-08-17 11:40", "kind": "work", "geometry": null, "src": "haversine", "status": "done"}
]
```

## 4. Маппинг dayplan ↔ segs

dayplan CSV: `team;seq;req;arrive;start;end;kind` (пример: `FIT-SE-04;3;CAFE_01;2026-08-17 13:50;2026-08-17 13:50;2026-08-17 14:50;lunch`).

| dayplan | segs |
|---|---|
| `team` | `team` |
| `req` | `to` |
| `arrive/start/end/kind` | те же поля 1:1 |
| `seq` порядок | порядок `(start, end)`; `seq` не хранится |
| (нет) | `frm` = prev.`to` (или `START:<team>` для seq=1) |
| (нет) | `geometry` + `src` + `status` дописывает бэк |
| `lunch` с `req=CAFE_*` | `kind=lunch`, `to=CAFE_*` сохраняется явно |

Конверсия: dayplan→segs — достроить `frm` цепочкой + `geometry/src/status` (default `status=plan`, `src=haversine` при отсутствии трека); segs→dayplan — сбросить `frm/geometry/src/status`, перенумеровать `seq` по `(start,end)`, отфильтровать `kind=travel/wait` (в dayplan только `work/lunch/restock/personal`).
