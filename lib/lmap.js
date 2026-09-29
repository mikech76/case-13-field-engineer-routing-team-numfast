// Copyright (c) 2026 NumFast
// SPDX-License-Identifier: AGPL-3.0-only
// Leaflet-backed map for ui2.
//
// This replaces the hand-rolled canvas slippy map (lib/tiles.js) with the exact
// mechanism the other front uses: vendored Leaflet 1.x, two raster sources
// (Esri WorldStreetMap + OSM fallback), polylines/markers as real DOM+SVG
// objects inside Leaflet panes. Everything (routes, request pins, team bases,
// cafes, labels) therefore pans and zooms with the basemap, gets a real
// cursor/hover, and a real hit area -- which is what the canvas version kept
// getting wrong (stale overlay while dragging, invisible markers, jumps).
//
// The layer model is unchanged: app.js still hands us {marks, points, lines}
// in GEOGRAPHIC coordinates (`geo: [lon, lat]`), so app.js is untouched apart
// from the import.

const L = globalThis.L;

const SOURCES = {
  esri: {
    name: 'Esri Street',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    max: 19,
    attribution: 'Esri',
  },
  esriSat: {
    name: 'Esri Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    max: 19,
    attribution: 'Esri',
  },
  osm: {
    name: 'OSM standard',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    max: 19,
    attribution: '© OpenStreetMap',
  },
};

// CSS custom properties are NOT valid in SVG/canvas attribute values, so
// resolve them once to real colours. app.js pushes 'var(--ok)' etc.
const CSSV = {};
function cssColor(v, fallback) {
  if (!v) return fallback;
  if (v.charCodeAt(0) !== 118 /* v */) return v;   // not "var(...)"
  const m = /var\((--[a-z0-9-]+)\)/i.exec(v);
  if (!m) return fallback;
  const n = m[1];
  if (!CSSV[n]) {
    CSSV[n] = (getComputedStyle(document.documentElement).getPropertyValue(n) || '').trim();
  }
  return CSSV[n] || fallback;
}

function arrowIcon(color, deg, size) {
  const s = Math.max(7, size || 11);
  const h = s * 0.62;
  return L.divIcon({
    className: '',
    iconSize: [s, s],
    iconAnchor: [s / 2, s / 2],
    html: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" style="transform:rotate(${deg}deg)">
      <path d="M4 3 L21 12 L4 21 L9 12 Z" fill="${color}" stroke="#080b12" stroke-width="1.6"
            stroke-linejoin="round"/></svg>`,
  });
}

function labelIcon(text, color, cls) {
  return L.divIcon({
    className: 'lmk ' + (cls || ''),
    html: `<b style="color:${color}">${text}</b>`,
    iconSize: null,
  });
}

function bearing(a, b) {
  // a,b = [lon,lat]
  const p = (Math.PI / 180);
  const dLon = (b[0] - a[0]) * p;
  const y = Math.sin(dLon) * Math.cos(b[1] * p);
  const x = Math.cos(a[1] * p) * Math.sin(b[1] * p) - Math.sin(a[1] * p) * Math.cos(b[1] * p) * Math.cos(dLon);
  return (Math.atan2(y, x) / p + 360) % 360;
}

export class Map {
  constructor(host, opts = {}) {
    this.host = host;
    this.opts = opts;
    this.sourceName = opts.source || 'esri';
    this.srcKey = this.sourceName;
    this._layers = { marks: [], points: [], lines: [] };
    this._flow = null;
    this._raf = 0;

    const s = SOURCES[this.srcKey] || SOURCES.esri;
    this.map = L.map(host, {
      center: [55.75, 37.62],
      zoom: 11,
      zoomControl: true,
      attributionControl: false,
      preferCanvas: false,       // SVG paths: crisper arrows + cheaper animation
      fadeAnimation: false,
      zoomAnimation: true,
      worldCopyJump: false,
    });
    this.tile = L.tileLayer(s.url, {
      maxZoom: s.max,
      maxNativeZoom: s.max,
      crossOrigin: false,
      keepBuffer: 3,
      updateWhenIdle: false,
      attribution: s.attribution,
    }).addTo(this.map);

    this.paneLine = L.layerGroup().addTo(this.map);
    this.panePt = L.layerGroup().addTo(this.map);
    this.paneMk = L.layerGroup().addTo(this.map);
    this.paneTop = L.layerGroup().addTo(this.map);

    // onView fires on every move: it only refreshes the scale readout.
    // Rebuilding layers from here would fight Leaflet's own animation frames
    // (the overlay ends up positioned against a stale pixel origin), so the
    // layer rebuild goes through the separate onZoomEnd hook, once, when the
    // animation is over.
    this.map.on('move zoom', () => {
      if (this.opts.onView) this.opts.onView(this.view());
    });
    this.map.on('zoomend', () => {
      if (this.opts.onZoomEnd) this.opts.onZoomEnd(this.view());
    });
    this.map.on('click', () => {
      // background click clears the leg isolator
    });
    this._ro = new ResizeObserver(() => this.map.invalidateSize({ pan: false }));
    this._ro.observe(host);
    setTimeout(() => this.map.invalidateSize(), 60);
  }

  get z() { return this.map.getZoom(); }
  get w() { return this.host.clientWidth || 640; }
  get h() { return this.host.clientHeight || 320; }

  view() {
    const c = this.map.getCenter();
    return { lon: c.lng, lat: c.lat, z: this.map.getZoom() };
  }

  sourceList() {
    return Object.keys(SOURCES).map((k) => [k, SOURCES[k].name]);
  }

  setSource(name) {
    if (!SOURCES[name]) return;
    this.srcKey = name;
    const s = SOURCES[name];
    this.tile.setUrl(s.url, { noRedraw: false });
    this.tile.options.attribution = s.attribution;
  }

  // app.js still calls project() to fill the (now unused) `pts` field.
  project(lon, lat) { return [lon, lat]; }

  setLayers(l) {
    this._layers = {
      marks: (l && l.marks) || [],
      points: (l && l.points) || [],
      lines: (l && l.lines) || [],
    };
    this._lastLayers = this._layers;
  }

  draw() { this._render(); }

  // ------------------------------------------------------------------ render
  _render() {
    const Lg = [this.paneLine, this.panePt, this.paneMk, this.paneTop];
    for (const g of Lg) g.clearLayers();
    if (this._flow) { this._flow = null; }
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }

    const geoOK = (g) => g && Number.isFinite(g[0]) && Number.isFinite(g[1])
      && g[0] > -180 && g[0] < 180 && g[1] > -85 && g[1] > 0;

    // ---- routes ---------------------------------------------------------
    for (const ln of this._layers.lines) {
      if (!ln || !ln.geo || ln.geo.length < 2) continue;
      const lls = ln.geo.filter(geoOK).map((g) => [g[1], g[0]]);
      if (lls.length < 2) continue;
      const col = cssColor(ln.c, '#96a9d7');
      const base = {
        color: col,
        weight: ln.w || 2,
        opacity: ln.a == null ? 1 : ln.a,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false,
        smoothFactor: 1.2,
      };
      if (ln.casing) {
        L.polyline(lls, Object.assign({}, base, {
          color: ln.casing, weight: (ln.w || 2) + 2.4, opacity: 1,
        })).addTo(this.paneLine);
      }
      if (ln.dash) base.dashArray = ln.dash.join(' ');
      // always draw the coloured leg first, so the selected segment keeps its
      // rainbow colour; the animated dashes are an ADDITIONAL overlay on top
      const main = L.polyline(lls, Object.assign({}, base, {
        interactive: !!ln.sid, bubblingMouseEvents: false,
      })).addTo(this.paneLine);
      if (ln.sid) {
        const sid = ln.sid;
        main.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          this._opts.onSegClick && this._opts.onSegClick(sid);
        });
        main.on('mouseover', () => main.setStyle({ weight: (ln.w || 2) + 1.6 }));
        main.on('mouseout', () => main.setStyle({ weight: base.weight }));
      }
      if (ln.flow) {
        const pl = L.polyline(lls, {
          color: cssColor(ln.flow, '#fff'),
          weight: (ln.w || 2) + 1.4,
          opacity: 0.95,
          dashArray: '3 13',
          lineCap: 'butt',
          interactive: false,
          smoothFactor: 1.2,
        }).addTo(this.paneLine);
        this._flow = pl;
      }
      // direction arrow at the far end of the leg
      if (ln.arrow && lls.length > 1) {
        const a = lls[Math.max(0, lls.length - 6)];
        const b = lls[lls.length - 1];
        L.marker(lls[lls.length - 1], {
          icon: arrowIcon(col, bearing([a[1], a[0]], [b[1], b[0]]), ln.arrowSize),
          interactive: false,
          keyboard: false,
        }).addTo(this.paneTop);
      }
    }

    // ---- request / team pins -------------------------------------------
    for (const p of this._layers.points) {
      if (!p || !geoOK(p.geo)) continue;
      const m = L.circleMarker([p.geo[1], p.geo[0]], {
        radius: p.r || 5,
        color: p.sel ? '#ffffff' : '#080b12',
        weight: p.sel ? 2.4 : 1.6,
        opacity: 1,
        fillColor: cssColor(p.c, '#3ddc97'),
        fillOpacity: 1,
      });
      m.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        if (this.opts.onClick) this.opts.onClick(p.ref, p.kind || 'req');
      });
      m.on('mouseover', () => { m.setStyle({ weight: 2.4, color: '#ffffff' }); });
      m.on('mouseout', () => { m.setStyle({ weight: p.sel ? 2.4 : 1.6, color: p.sel ? '#ffffff' : '#080b12' }); });
      m.addTo(this.panePt);
    }

    // ---- labels: owning team id, bases, cafe ---------------------------
    for (const mk of this._layers.marks) {
      if (!mk || !mk.label || !geoOK(mk.geo)) continue;
      const ic = labelIcon(mk.label, cssColor(mk.c, '#e9edf6'),
        mk.kind === 'team' ? 'team' : (mk.kind === 'place' ? 'place' : 'req'));
      const m = L.marker([mk.geo[1], mk.geo[0]], {
        icon: ic,
        interactive: true,
        keyboard: false,
        riseOnHover: true,
      });
      m.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        if (this.opts.onClick) this.opts.onClick(mk.ref, mk.kind || 'mark');
      });
      m.addTo(mk.kind === 'req' ? this.paneTop : this.paneMk);
    }

    if (this._flow) this._startFlow();
  }

  // running dash on the single selected segment
  _startFlow() {
    const t0 = performance.now();
    const tick = () => {
      if (!this._flow || !this.map) { this._raf = 0; return; }
      const off = -((((performance.now() - t0) / 55) | 0) % 16);
      this._flow.setStyle({ dashArray: '3 13', dashOffset: off });
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  // hit list, same shape the canvas map exposed (used by tools/ztest.mjs)
  get hit() {
    const out = [];
    const put = (o) => {
      const pt = this.map.latLngToContainerPoint([o.geo[1], o.geo[0]]);
      out.push({ x: pt.x, y: pt.y, r: Math.max(12, o.r || 11), ref: o.ref, kind: o.kind || 'mark' });
    };
    for (const p of this._layers.points) if (p && p.geo) put({ geo: p.geo, ref: p.ref, kind: p.kind, r: (p.r || 5) + 7 });
    for (const m of this._layers.marks) if (m && m.geo && m.label) put({ geo: m.geo, ref: m.ref, kind: m.kind, r: 14 });
    return out;
  }

  // ------------------------------------------------------------------ camera
  flyTo(lon, lat, z) {
    if (z == null) z = this.map.getZoom();
    this.map.setView([lat, lon], z, { animate: false });
    if (this._lastLayers) this._render();
  }

  panTo(lon, lat) {
    this.map.panTo([lat, lon], { animate: true, duration: 0.25 });
  }

  fit(minLon, minLat, maxLon, maxLat, padPx) {
    const b = [[minLat, minLon], [maxLat, maxLon]];
    this.map.fitBounds(L.latLngBounds(b).pad(-0.08), { padding: [padPx || 24, padPx || 24], animate: false });
    this.map.invalidateSize({ pan: false, animate: false });
    if (this._lastLayers) this._render();
  }

  // is the box already (mostly) on screen? used to stop the "zoom jumps"
  visible(minLon, minLat, maxLon, maxLat) {
    try {
      const b = L.latLngBounds([[minLat, minLon], [maxLat, maxLon]]).pad(0.05);
      return this.map.getBounds().contains(b);
    } catch (_) { return false; }
  }

  resize() { if (this.map) this.map.invalidateSize({ pan: false }); }

  // Smoothly frame ONE route leg so it fills ~3/4 of the map pane, centred.
  // frac = fraction of the pane the leg should span (0.75 -> three quarters).
  fitSeg(geo, frac) {
    const pts = (geo || []).filter((g) => g && Number.isFinite(g[0]) && Number.isFinite(g[1]))
      .map((g) => [g[1], g[0]]);
    if (pts.length < 2) return;
    const b = L.latLngBounds(pts).pad(0.12);
    const m = this.map;
    const z0 = m.getZoom();
    const zFit = m.getBoundsZoom(b, false, [40, 40]);
    // fill `frac` of the pane: zoom in by log2(1/frac) from the "just fits" zoom
    const want = Math.max(2, Math.min(19, Math.min(zFit + Math.log2(1 / (frac || 0.75)), z0 + 4)));
    m.fitBounds(b, { padding: [40, 40], maxZoom: want, animate: false });
    m.invalidateSize({ pan: false, animate: false });
    if (this._lastLayers) this._render();
  }
}

export default Map;
