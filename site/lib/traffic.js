// Copyright (c) 2026 NumFast
// SPDX-License-Identifier: AGPL-3.0-only
// traffic.js — time-of-day speed factor k(h) for travel times.
//
// WHAT THIS IS
//   A single city-uniform multiplier applied to every road time, read from a
//   fixed slot so a real per-edge table can be dropped in later without
//   touching the solver, the router or the UI.
//
//   TrafficSrc : 'uniform-2015'
//   Src        : ymarchive.ru «Пробки в Москве» 2015, суточные коэффициенты
//   Basis      : city-uniform, ГОРИзонтальные срезы по часам. Значения
//                k(09)=2.23 и k(19)=2.58 — реальные из таблицы; остальные
//                часы интерполированы по кубическому сплайну между
//                опорными точками и НЕ являются измерением.
//   Honest     : пока per-edge растр (картинки пробок) не смаплен на рёбра
//                OSM, k зависит только от часа выезда, а не от участка.
//                Это заявлено в UI, чтобы не выдавать оценку за измерение.
//
// ИНТЕРФЕЙС (единый слот)
//   loadTraffic(cfg) -> Traffic
//   Traffic = { src, label, on, kAt(hourFloat) }
//   Для замены на настоящие данные достаточно вернуть объект с теми же
//   полями: src/label/on/kAt. Больше нигде ничего менять не нужно.

const YEAR = 2015;

// Опорные часы: ночь 1.00, утренний пик 2.23 (09:00), вечерний 2.58 (19:00).
// Между опорами — кубический сплайн Катмулла–Рома по часам, значения
// нормированы так, чтобы ночь была ровно 1.00.
const ANCHOR = [
  [0, 1.00], [3, 1.00], [5, 1.06], [6, 1.25], [7, 1.70],
  [8, 2.05], [9, 2.23], [10, 2.05], [11, 1.80], [12, 1.70],
  [13, 1.70], [14, 1.72], [15, 1.85], [16, 2.00], [17, 2.25],
  [18, 2.50], [19, 2.58], [20, 2.30], [21, 1.70], [22, 1.40],
  [24, 1.00],
];

function catmull(p0, p1, p2, p3, u) {
  const u2 = u * u;
  const u3 = u2 * u;
  return 0.5 * ((2 * p1) + (-p0 + p2) * u
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2
    + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}

function kRaw(h) {
  const x = ((h % 24) + 24) % 24;
  let i = 0;
  while (i < ANCHOR.length - 2 && ANCHOR[i + 1][0] <= x) i++;
  const [x1, y1] = ANCHOR[i];
  const [x2, y2] = ANCHOR[i + 1];
  const u = (x - x1) / (x2 - x1);
  const y0 = ANCHOR[Math.max(0, i - 1)][1];
  const y3 = ANCHOR[Math.min(ANCHOR.length - 1, i + 2)][1];
  return catmull(y0, y1, y2, y3, u);
}

// Таблица на 24*10 значений: трафик меняется плавно, а часовые переходы
// на пешеходских/велосипедных ногах давали бы ступеньки в минутах.
const STEP = 0.1;
const TAB = new Float64Array(24 / STEP);
for (let i = 0; i < TAB.length; i++) TAB[i] = kRaw(i * STEP);

export const TRAFFIC_META = {
  src: 'uniform-2015',
  label: 'пробки: k(час) city-uniform, ymarchive 2015 (историческая)',
  note: 'k(09)=2.23, k(19)=2.58 — из суточной таблицы; остальные часы '
    + 'интерполированы. Зависит только от часа выезда, не от участка: '
    + 'почасовой растр на рёбра OSM ещё не смаплен.',
  year: YEAR,
};

export function loadTraffic(cfg) {
  const c = cfg || {};
  const on = c.on !== false;
  return {
    src: TRAFFIC_META.src,
    label: TRAFFIC_META.label,
    note: TRAFFIC_META.note,
    year: TRAFFIC_META.year,
    on,
    // minute — абсолютный час суток (0..1440) из планировщика
    kAt(minute) { return on ? TAB[Math.round(minute / 6) % TAB.length] : 1.0; },
  };
}

export const kTable = TAB;
