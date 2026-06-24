/*
 * visuals.js — parametric SVG visuals that react to the controls:
 *   renderSchematic  a house whose solar panel tilts and re-orients and whose
 *                    battery grows, with the sun positioned by panel facing
 *   renderFleetHouses a grid of homes that grows with the fleet size
 *   renderPeriod      daily saving across the chosen period
 *   renderForecast    the MPC view: solar actual vs a widening forecast band,
 *                     and battery state of charge under perfect vs forecast control
 */
(function (global) {
  "use strict";
  const rad = (d) => (d * Math.PI) / 180;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const mapr = (x, a, b, c, d) => c + ((x - a) / (b - a)) * (d - c);

  // live system schematic
  function renderSchematic(el, cfg) {
    const W = 380, H = 230;
    const tilt = clamp(cfg.tiltDeg, 5, 55);
    const az = clamp(cfg.azimuthDeg, -90, 90); // -90 east, 0 south, +90 west
    const kwp = cfg.solarKwp, kwh = cfg.batteryKwh;
    const ground = 196;

    // sun position by facing: east -> left, west -> right
    const sunX = mapr(az, -90, 90, 70, 320);
    const sunY = 44;
    // panel hinged at the left eave, rising at the tilt angle
    const px0 = 96, py0 = 150;
    const L = 124;
    const px1 = px0 + L * Math.cos(rad(tilt));
    const py1 = py0 - L * Math.sin(rad(tilt));
    const th = 9; // panel thickness, drawn perpendicular to its face
    const nx = Math.sin(rad(tilt)) * th, ny = Math.cos(rad(tilt)) * th;
    const panel = `${px0},${py0} ${px1},${py1} ${px1 + nx},${py1 + ny} ${px0 + nx},${py0 + ny}`;
    // how square-on the panel faces the sun (1 = facing it), drives the glow
    const aim = clamp(1 - Math.abs(az) / 130, 0.35, 1);
    const panelFill = `rgba(40,52,60,${0.78 + 0.0})`;
    // battery height scales with kWh
    const bh = mapr(clamp(kwh, 3, 16), 3, 16, 26, 86);
    const bx = 250, bw = 30, by = ground - bh;

    // panel cell lines
    let cells = "";
    for (let i = 1; i < 5; i++) {
      const fx = i / 5;
      const ax = px0 + (px1 - px0) * fx, ay = py0 + (py1 - py0) * fx;
      cells += `<line x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${(ax + nx).toFixed(1)}" y2="${(ay + ny).toFixed(1)}" stroke="rgba(255,255,255,0.25)" stroke-width="1"/>`;
    }
    let rays = "";
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      rays += `<line x1="${(sunX + Math.cos(ang) * 15).toFixed(1)}" y1="${(sunY + Math.sin(ang) * 15).toFixed(1)}" x2="${(sunX + Math.cos(ang) * 21).toFixed(1)}" y2="${(sunY + Math.sin(ang) * 21).toFixed(1)}" stroke="#e8a33d" stroke-width="2" stroke-linecap="round"/>`;
    }
    const facing = az <= -68 ? "East" : az <= -23 ? "South-East" : az < 23 ? "South" : az < 68 ? "South-West" : "West";

    el.innerHTML =
      `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="House with a ${facing}-facing solar panel tilted at ${Math.round(tilt)} degrees and a ${kwh.toFixed(1)} kilowatt-hour battery">` +
      `<defs><radialGradient id="sun" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#ffd089"/><stop offset="100%" stop-color="#e8a33d"/></radialGradient></defs>` +
      // sky glow toward the sun
      `<rect x="0" y="0" width="${W}" height="${ground}" fill="rgba(232,163,61,${(aim * 0.10).toFixed(3)})"/>` +
      // ground
      `<rect x="0" y="${ground}" width="${W}" height="${H - ground}" fill="rgba(31,158,107,0.18)"/>` +
      `<line x1="0" y1="${ground}" x2="${W}" y2="${ground}" stroke="rgba(135,40,35,0.25)"/>` +
      // sun + a soft beam to the panel
      rays +
      `<line x1="${sunX}" y1="${sunY}" x2="${((px0 + px1) / 2 + nx / 2).toFixed(1)}" y2="${((py0 + py1) / 2 + ny / 2).toFixed(1)}" stroke="rgba(232,163,61,${(aim * 0.5).toFixed(2)})" stroke-width="2" stroke-dasharray="2 4"/>` +
      `<circle cx="${sunX}" cy="${sunY}" r="14" fill="url(#sun)"/>` +
      // house wall
      `<rect x="92" y="150" width="120" height="${ground - 150}" fill="#fff" stroke="var(--maroon)" stroke-width="2"/>` +
      `<rect x="120" y="166" width="22" height="22" fill="rgba(135,40,35,0.12)" stroke="var(--maroon)" stroke-width="1.5"/>` +
      `<rect x="172" y="166" width="22" height="${ground - 166}" fill="rgba(135,40,35,0.12)" stroke="var(--maroon)" stroke-width="1.5"/>` +
      // eave
      `<line x1="88" y1="150" x2="216" y2="150" stroke="var(--maroon)" stroke-width="2"/>` +
      // solar panel (tilts with the slider)
      `<polygon points="${panel}" fill="${panelFill}" stroke="var(--maroon)" stroke-width="1.5"/>` +
      cells +
      // panel glow when it faces the sun
      `<polygon points="${panel}" fill="rgba(255,208,137,${(aim * 0.5).toFixed(2)})"/>` +
      // battery (grows with kWh)
      `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="5" fill="rgba(29,138,133,0.18)" stroke="var(--c-soc)" stroke-width="2"/>` +
      `<rect x="${bx + 4}" y="${by + 4}" width="${bw - 8}" height="${(bh - 8).toFixed(0)}" rx="3" fill="rgba(29,138,133,0.30)"/>` +
      `<rect x="${bx + 10}" y="${by - 4}" width="10" height="4" rx="1" fill="var(--c-soc)"/>` +
      // labels
      `<text x="${bx + bw / 2}" y="${ground + 14}" text-anchor="middle" class="sch-l">${kwh.toFixed(1)} kWh</text>` +
      `<text x="150" y="${ground + 14}" text-anchor="middle" class="sch-l">${kwp.toFixed(2)} kWp · ${facing} · ${Math.round(tilt)}°</text>` +
      `<style>.sch-l{font:11px var(--font-body);fill:var(--ink-soft);}</style>` +
      `</svg>`;
  }

  // fleet of houses
  function renderFleetHouses(el, cfg) {
    const n = cfg.nHomes;
    const shown = Math.min(n, 100);
    const cols = Math.min(12, Math.ceil(Math.sqrt(shown * 1.6)));
    const rows = Math.ceil(shown / cols);
    const cw = 30, ch = 28, pad = 6;
    const W = cols * cw + pad * 2, H = rows * ch + pad * 2;
    let g = "";
    for (let i = 0; i < shown; i++) {
      const r = Math.floor(i / cols), c = i % cols;
      const x = pad + c * cw, y = pad + r * ch;
      // little house: body + a solar roof
      g +=
        `<g transform="translate(${x},${y})">` +
        `<rect x="6" y="13" width="18" height="11" fill="#fff" stroke="var(--maroon)" stroke-width="1"/>` +
        `<polygon points="4,13 15,5 26,13" fill="rgba(40,52,60,0.85)" stroke="var(--maroon)" stroke-width="1"/>` +
        `<polygon points="9,11 15,6.5 21,11" fill="rgba(255,208,137,0.55)"/>` +
        `</g>`;
    }
    el.innerHTML =
      `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${n} homes in the fleet, each with rooftop solar">${g}</svg>`;
  }

  // saving over the period (daily)
  function renderPeriod(el, cfg) {
    const W = 820, H = 220, padL = 46, padR = 14, padT = 14, padB = 26;
    const x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
    const days = cfg.perDay;
    const n = days.length;
    if (!n) { el.innerHTML = ""; return; }
    const vals = days.map((d) => d.homeSaving);
    const gv = days.map((d) => d.grydMargin);
    const lo = Math.min(0, ...vals, ...gv);
    const hi = Math.max(0.1, ...vals, ...gv) * 1.1;
    const xFor = (i) => x0 + (n === 1 ? 0.5 : i / (n - 1)) * (x1 - x0);
    const yFor = (v) => y1 - ((v - lo) / (hi - lo)) * (y1 - y0);
    const zeroY = yFor(0);
    let s = `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Daily home saving and Gryd margin across the period"><style>.ax{font:10px var(--font-body);fill:var(--c-axis);}</style>`;
    // axis
    for (let k = 0; k <= 3; k++) {
      const v = lo + ((hi - lo) * k) / 3, y = yFor(v);
      s += `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="rgba(135,40,35,0.1)"/>`;
      s += `<text x="${x0 - 6}" y="${y + 3}" text-anchor="end" class="ax">£${v.toFixed(1)}</text>`;
    }
    if (n <= 16) {
      const bw = Math.min(26, ((x1 - x0) / n) * 0.36);
      days.forEach((d, i) => {
        const cx = xFor(i);
        s += `<rect x="${(cx - bw - 1).toFixed(1)}" y="${Math.min(zeroY, yFor(d.homeSaving)).toFixed(1)}" width="${bw}" height="${Math.abs(yFor(d.homeSaving) - zeroY).toFixed(1)}" fill="var(--green)" opacity="0.85"/>`;
        s += `<rect x="${(cx + 1).toFixed(1)}" y="${Math.min(zeroY, yFor(d.grydMargin)).toFixed(1)}" width="${bw}" height="${Math.abs(yFor(d.grydMargin) - zeroY).toFixed(1)}" fill="var(--orange)" opacity="0.85"/>`;
      });
    } else {
      const path = (arr, col) => {
        let p = arr.map((v, i) => (i ? "L" : "M") + xFor(i).toFixed(1) + " " + yFor(v).toFixed(1)).join(" ");
        return `<path d="${p}" fill="none" stroke="${col}" stroke-width="1.8"/>`;
      };
      s += `<path d="${vals.map((v, i) => (i ? "L" : "M") + xFor(i).toFixed(1) + " " + yFor(v).toFixed(1)).join(" ")} L${x1} ${zeroY} L${x0} ${zeroY} Z" fill="rgba(31,158,107,0.14)" stroke="none"/>`;
      s += path(vals, "var(--green-deep)");
      s += path(gv, "var(--orange)");
    }
    s += `<line x1="${x0}" y1="${zeroY}" x2="${x1}" y2="${zeroY}" stroke="rgba(135,40,35,0.3)"/>`;
    s += "</svg>";
    el.innerHTML = s;
  }

  // MPC: real Agile price vs a forecast built from history, plus the battery
  // charge under each plan so you can see it act at different times.
  function renderPriceMpc(el, cfg) {
    const W = 820, H = 240, padL = 44, padR = 14, padT = 16, padB = 26;
    const x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
    const actual = cfg.actualPrice, fc = cfg.fcPrice, n = actual.length;
    const socP = cfg.socPerfect, socF = cfg.socForecast, socCap = cfg.socCap || 10;
    const pmax = Math.max(0.05, ...actual, ...fc) * 1.12;
    const hx = (i) => x0 + (i / (n - 1)) * (x1 - x0);
    const yP = (v) => y1 - (v / pmax) * (y1 - y0);
    const ySoc = (v) => y1 - (v / socCap) * (y1 - y0);
    const path = (arr, yfn) => arr.map((v, i) => (i ? "L" : "M") + hx(i).toFixed(1) + " " + yfn(v).toFixed(1)).join(" ");
    let s = `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Real Agile price versus a price forecast, and the battery charge under each"><style>.ax{font:10px var(--font-body);fill:var(--c-axis);}</style>`;
    for (let k = 0; k <= 3; k++) {
      const v = (pmax * k) / 3, y = yP(v);
      s += `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="rgba(135,40,35,0.08)"/>`;
      s += `<text x="${x0 - 6}" y="${y + 3}" text-anchor="end" class="ax">£${v.toFixed(2)}</text>`;
    }
    for (const t of [0, 6, 12, 18, 24]) {
      const x = x0 + (t / 24) * (x1 - x0);
      s += `<text x="${x}" y="${y1 + 16}" text-anchor="middle" class="ax">${t}:00</text>`;
    }
    // battery charge under each plan, faint
    if (socP) s += `<path d="${path(socP, ySoc)}" fill="none" stroke="var(--c-soc)" stroke-width="1.5" opacity="0.5"/>`;
    if (socF) s += `<path d="${path(socF, ySoc)}" fill="none" stroke="var(--c-soc)" stroke-width="1.5" stroke-dasharray="5 3" opacity="0.5"/>`;
    // forecast price (dashed) and real price (solid)
    s += `<path d="${path(fc, yP)}" fill="none" stroke="var(--c-price)" stroke-width="2" stroke-dasharray="5 3" opacity="0.75"/>`;
    s += `<path d="${path(actual, yP)}" fill="none" stroke="var(--c-price)" stroke-width="2.6"/>`;
    s += "</svg>";
    el.innerHTML = s;
  }

  global.Visuals = { renderSchematic, renderFleetHouses, renderPeriod, renderPriceMpc };
})(typeof window !== "undefined" ? window : this);
