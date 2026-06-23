/*
 * charts.js — dependency-free SVG charts for Gryd Sim.
 * Pure rendering: takes plain arrays, returns SVG markup. Themed by the CSS
 * variables in styles.css so the brand palette stays in one place.
 */
(function (global) {
  "use strict";

  const W = 820, H = 360;
  const PAD = { l: 46, r: 54, t: 18, b: 30 };
  const x0 = PAD.l, x1 = W - PAD.r, y0 = PAD.t, y1 = H - PAD.b;

  const COL = {
    price: "var(--c-price)",
    solar: "var(--c-solar)",
    load: "var(--c-load)",
    soc: "var(--c-soc)",
    imp: "var(--c-import)",
    exp: "var(--c-export)",
    grid: "rgba(135,40,35,0.10)",
    axis: "var(--c-axis)", // readable tick labels
    band: "rgba(253,87,50,0.08)",
    curtail: "#c0392b",
  };

  const fmt = (n, d) => Number(n).toFixed(d == null ? 1 : d);

  function hx(hour) { return x0 + (hour / 24) * (x1 - x0); }
  function lerpY(v, vmin, vmax) {
    if (vmax - vmin < 1e-9) return y1;
    return y1 - ((v - vmin) / (vmax - vmin)) * (y1 - y0);
  }

  // points: [{h, v}], returns an "M..L.." line. yFn maps value -> y.
  function line(points, yFn) {
    return points.map((p, i) => (i ? "L" : "M") + hx(p.h).toFixed(1) + " " + yFn(p.v).toFixed(1)).join(" ");
  }
  function area(points, yFn) {
    if (!points.length) return "";
    const top = line(points, yFn);
    return top + " L" + hx(points[points.length - 1].h).toFixed(1) + " " + y1 + " L" + hx(points[0].h).toFixed(1) + " " + y1 + " Z";
  }

  function hoursOf(n) {
    const a = [];
    for (let i = 0; i < n; i++) a.push((i + 0.5) * 0.5);
    return a;
  }
  function pts(hours, arr) { return hours.map((h, i) => ({ h, v: arr[i] })); }

  function timeAxis() {
    let s = "";
    for (const t of [0, 6, 12, 18, 24]) {
      const x = hx(t);
      s += `<line x1="${x}" y1="${y0}" x2="${x}" y2="${y1}" stroke="${COL.grid}"/>`;
      s += `<text x="${x}" y="${y1 + 18}" text-anchor="middle" class="ax">${t}:00</text>`;
    }
    return s;
  }
  function yGrid(vmax, unit, side) {
    let s = "";
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const v = (vmax * i) / steps;
      const y = lerpY(v, 0, vmax);
      if (side === "l") {
        s += `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${COL.grid}"/>`;
        s += `<text x="${x0 - 7}" y="${y + 3}" text-anchor="end" class="ax">${fmt(v, v < 5 ? 1 : 0)}</text>`;
      } else {
        s += `<text x="${x1 + 8}" y="${y + 3}" text-anchor="start" class="ax">${fmt(v, 2)}</text>`;
      }
    }
    if (side === "l") s += `<text x="${x0 - 7}" y="${y0 - 6}" text-anchor="end" class="axu">${unit}</text>`;
    else s += `<text x="${x1 + 8}" y="${y0 - 6}" text-anchor="start" class="axu">${unit}</text>`;
    return s;
  }

  function windowBand(win) {
    if (!win) return "";
    const a = hx(win[0]), b = hx(win[1]);
    return `<rect x="${a}" y="${y0}" width="${b - a}" height="${y1 - y0}" fill="${COL.band}"/>` +
      `<text x="${(a + b) / 2}" y="${y0 + 13}" text-anchor="middle" class="axband">evening flex</text>`;
  }

  const STYLE = `<style>
    .ax{ font:10px var(--font-body); fill:${COL.axis}; }
    .axu{ font:9px var(--font-body); fill:${COL.axis}; letter-spacing:.04em; }
    .axband{ font:9px var(--font-body); fill:rgba(253,87,50,0.8); letter-spacing:.08em; text-transform:uppercase; }
  </style>`;

  function svgOpen(label) {
    const safe = String(label || "Chart").replace(/[<&]/g, "");
    return `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${safe}"><title>${safe}</title>${STYLE}`;
  }

  // single-home chart
  function renderHome(el, d) {
    const hours = hoursOf(d.price.length);
    const pmaxRaw = Math.max(0.1, ...d.solar, ...d.load, ...d.import, ...d.export, ...(d.curtail || [0]));
    const pmax = pmaxRaw * 1.12;
    const prMin = Math.min(0, ...d.price);
    const prMax = Math.max(0.05, ...d.price) * 1.12;
    const yP = (v) => lerpY(v, 0, pmax);
    const yPr = (v) => lerpY(v, prMin, prMax);
    const ySoc = (v) => lerpY(v, 0, d.socCap);

    let s = svgOpen("One home over the day: price, solar, load, battery, grid import and export");
    s += windowBand(d.flexWindow);
    s += yGrid(pmax, "kW", "l");
    s += yGrid(prMax, "£/kWh", "r");
    s += timeAxis();
    if (prMin < 0) { const yz = yPr(0); s += `<line x1="${x0}" y1="${yz}" x2="${x1}" y2="${yz}" stroke="rgba(135,40,35,0.3)" stroke-dasharray="3 3"/>`; }

    // battery charge as a faint backdrop area
    s += `<path d="${area(pts(hours, d.soc), ySoc)}" fill="rgba(43,166,160,0.12)" stroke="none"/>`;
    s += `<path d="${line(pts(hours, d.soc), ySoc)}" fill="none" stroke="${COL.soc}" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.85"/>`;
    // solar generation area
    s += `<path d="${area(pts(hours, d.solar), yP)}" fill="rgba(232,163,61,0.22)" stroke="none"/>`;
    s += `<path d="${line(pts(hours, d.solar), yP)}" fill="none" stroke="${COL.solar}" stroke-width="2"/>`;
    // curtailed solar (surplus that could not be stored or paid to export)
    if (d.curtail && Math.max.apply(null, d.curtail) > 1e-6) {
      s += `<path d="${area(pts(hours, d.curtail), yP)}" fill="rgba(253,87,50,0.16)" stroke="none"/>`;
      s += `<path d="${line(pts(hours, d.curtail), yP)}" fill="none" stroke="${COL.curtail}" stroke-width="1.5" stroke-dasharray="2 2"/>`;
    }
    // grid import (dashed, to read apart from the solid load line) and export
    s += `<path d="${line(pts(hours, d.import), yP)}" fill="none" stroke="${COL.imp}" stroke-width="1.8" stroke-dasharray="5 3"/>`;
    s += `<path d="${line(pts(hours, d.export), yP)}" fill="none" stroke="${COL.exp}" stroke-width="1.8"/>`;
    // household load
    s += `<path d="${line(pts(hours, d.load), yP)}" fill="none" stroke="${COL.load}" stroke-width="2"/>`;
    // price (protagonist) on right axis, draw-on animatable
    const pricePath = line(pts(hours, d.price), yPr);
    s += `<path id="price-path" d="${pricePath}" fill="none" stroke="${COL.price}" stroke-width="2.6" stroke-linejoin="round"/>`;
    // negative-price markers
    if (d.negativeSlots && d.negativeSlots.length) {
      for (const t of d.negativeSlots) s += `<circle cx="${hx(hours[t])}" cy="${yPr(d.price[t])}" r="3" fill="${COL.price}"/>`;
    }
    s += "</svg>";
    el.innerHTML = s;
  }

  // fleet flexibility chart
  // Single sellable envelope: each home's deliverable flex capped at its inverter
  // power, then summed. One area keeps it consistent with the headline figure.
  function renderFleet(el, d) {
    const flex = d.flex;
    const hours = hoursOf(flex.length);
    const fmax = Math.max(0.1, ...flex) * 1.15;
    const yF = (v) => lerpY(v, 0, fmax);
    const unit = d.unit || "kW";

    let s = svgOpen("Aggregate dispatchable flexibility across the day, in " + unit);
    s += windowBand(d.flexWindow);
    s += yGrid(fmax, unit, "l");
    s += timeAxis();
    const fPts = pts(hours, flex);
    s += `<path d="${area(fPts, yF)}" fill="rgba(31,158,107,0.18)" stroke="none"/>`;
    s += `<path d="${line(fPts, yF)}" fill="none" stroke="${COL.exp}" stroke-width="2.4"/>`;
    // peak marker within the window
    if (d.peakIdx != null) {
      const px = hx(hours[d.peakIdx]), py = yF(flex[d.peakIdx]);
      s += `<circle cx="${px}" cy="${py}" r="4" fill="${COL.price}"/>`;
      s += `<line x1="${px}" y1="${py}" x2="${px}" y2="${y1}" stroke="${COL.price}" stroke-width="1" stroke-dasharray="2 3" opacity="0.5"/>`;
    }
    s += "</svg>";
    el.innerHTML = s;
  }

  global.Charts = { renderHome, renderFleet, COL };
})(typeof window !== "undefined" ? window : this);
