/*
 * app.js — drives the page from the bundled dataset.
 * Builds the day list for the chosen period, runs the engine (exact for the home,
 * sampled for the fleet annual), updates the cards, charts and the optional
 * forecast-error (MPC) panel. Heavy recompute is debounced.
 */
(function () {
  "use strict";
  const S = window.SimCore, V = window.Visuals, Ch = window.Charts;
  const $ = (id) => document.getElementById(id);
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const hasGsap = typeof window.gsap !== "undefined";

  const REGION_NAMES = {
    A: "East England", B: "East Midlands", C: "London", D: "Merseyside & N Wales",
    E: "West Midlands", F: "North East", G: "North West", H: "Southern",
    I: "North Scotland", J: "South East", K: "South Wales", L: "South West",
    M: "Yorkshire", N: "South Scotland",
  };
  const PERIOD_WORD = { day: "today", week: "this week", summer: "this summer", winter: "this winter", year: "this year" };
  const MPC_SEED = 7919;

  let DATA = null, timer = null;
  const state = {
    period: "day", date: null, region: "C",
    solarKwp: 4.0, azimuthDeg: 0, tiltDeg: 35, batteryKwh: 5.4, dailyLoadKwh: 10,
    nHomes: 20, subPct: 15, alpha: 0.5, flexPrice: 60,
    useWeather: true, useMpc: false, histDays: 7,
  };

  const isWeekend = (s) => { const d = new Date(s + "T00:00:00Z").getUTCDay(); return d === 0 || d === 6; };

  // Forecast a day's prices from the last k days of the SAME type (weekday vs
  // weekend), averaged half hour by half hour. This is the strategy that worked
  // best in the Piclo project.
  function forecastPricesFor(date, region, k) {
    const weekend = isWeekend(date);
    const idx = DATA.dates.indexOf(date);
    const imp = [], exp = [];
    for (let j = idx - 1; j >= 0 && imp.length < k; j--) {
      const d = DATA.dates[j];
      if (isWeekend(d) !== weekend) continue;
      const r = DATA.regions[region] && DATA.regions[region][d];
      if (r) { imp.push(r.i); exp.push(r.e); }
    }
    if (!imp.length) return null;
    return { import: S.averageProfiles(imp), export: S.averageProfiles(exp), days: imp.length };
  }

  // formatters
  const gbpA = (v) => (Math.abs(v) < 100 ? (v < 0 ? "-£" + Math.abs(v).toFixed(2) : "£" + v.toFixed(2)) : (v < 0 ? "-£" + Math.abs(v).toFixed(0) : "£" + v.toFixed(0)));
  const gbp = (v) => (v < 0 ? "-£" + Math.abs(v).toFixed(2) : "£" + v.toFixed(2));
  const gbp0 = (v) => (v < 0 ? "-£" + Math.abs(v).toFixed(0) : "£" + Math.round(v));
  const signed = (v) => (v >= 0 ? "+" + gbpA(v) : "-£" + Math.abs(v).toFixed(2));
  const pct = (v) => Math.round(v) + "%";
  const azName = (a) => (a <= -68 ? "East" : a <= -23 ? "South-East" : a < 23 ? "South" : a < 68 ? "South-West" : "West");
  const doy = (s) => { const d = new Date(s + "T00:00:00Z"); return Math.floor((d - new Date(Date.UTC(d.getUTCFullYear(), 0, 0))) / 86400000); };
  const fmtDate = (s) => new Date(s + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

  function tween(el, to, fmt) {
    if (!el) return;
    el.textContent = fmt(to);
    if (!el._p) el._p = { v: to };
    if (reduce || !hasGsap) { el._p.v = to; return; }
    const from = el._p.v;
    if (Math.abs(from - to) < 1e-9) return;
    window.gsap.killTweensOf(el._p);
    el._p.v = from;
    window.gsap.to(el._p, { v: to, duration: 0.5, ease: "power2.out", onUpdate: () => (el.textContent = fmt(el._p.v)) });
    clearTimeout(el._t);
    el._t = setTimeout(() => { el._p.v = to; el.textContent = fmt(to); }, 650);
  }
  const setText = (id, t) => { const e = $(id); if (e) e.textContent = t; };
  const setHTML = (id, t) => { const e = $(id); if (e) e.innerHTML = t; };

  function economics() { return Object.assign({}, S.DEFAULT_ECON, { homeownerSavingPct: state.subPct, flexPriceGbpPerMwH: state.flexPrice }); }
  function config() {
    return {
      solarKwp: state.solarKwp, azimuthDeg: state.azimuthDeg, tiltDeg: state.tiltDeg,
      batteryKwh: state.batteryKwh, batteryPowerKw: Math.max(2.5, Math.min(5, 0.55 * state.batteryKwh)),
      dailyLoadKwh: state.dailyLoadKwh, exportCapKw: 3.68,
    };
  }

  function periodDates() {
    const all = DATA.dates;
    if (state.period === "day") return all.includes(state.date) ? [state.date] : [all[0]];
    if (state.period === "week") {
      const start = new Date(state.date + "T00:00:00Z");
      const out = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
        if (DATA.regions.C[d]) out.push(d);
      }
      return out.length ? out : [state.date];
    }
    const r = state.period === "summer" ? DATA.seasons.summer2025 : state.period === "winter" ? DATA.seasons.winter2026 : DATA.seasons.year2025;
    return all.filter((d) => d >= r[0] && d <= r[1]);
  }
  const regionFor = (d, reg) => (DATA.regions[reg] && DATA.regions[reg][d] ? reg : "C");
  function homeDays(dates) {
    return dates.map((d) => { const r = DATA.regions[regionFor(d, state.region)][d]; return { date: d, dayOfYear: doy(d), import: r.i, export: r.e, ghi: DATA.weather[d] && DATA.weather[d].ghi }; });
  }
  function fleetDays(dates) {
    return dates.map((d) => { const regions = {}; for (const rg of DATA.meta.regions) if (DATA.regions[rg][d]) regions[rg] = { import: DATA.regions[rg][d].i, export: DATA.regions[rg][d].e }; return { date: d, dayOfYear: doy(d), regions, ghi: DATA.weather[d] && DATA.weather[d].ghi }; });
  }

  function compute() {
    const dates = periodDates();
    const wantMpc = state.useMpc && (state.period === "day" || state.period === "week");
    const econ = economics(), cfg = config(), alpha = state.alpha, useWeather = state.useWeather;

    // The MPC comparison runs on the representative day; forecast its prices from history.
    let priceForecast = null;
    if (wantMpc) {
      const repDate = dates[Math.floor((dates.length - 1) / 2)];
      priceForecast = forecastPricesFor(repDate, state.region, state.histDays);
    }

    const hp = S.runPeriod(homeDays(dates), { config: cfg, economics: econ, alpha, useWeather, priceForecast });
    const fp = S.runFleetPeriod(fleetDays(dates), { nHomes: state.nHomes, primaryRegion: state.region, economics: econ, alpha, useWeather, sampleDays: 24 });

    const yearDates = DATA.dates.filter((d) => d.slice(0, 4) === "2025");
    const hy = state.period === "year" ? hp : S.runPeriod(homeDays(yearDates), { config: cfg, economics: econ, alpha, useWeather });
    const fy = state.period === "year" ? fp : S.runFleetPeriod(fleetDays(yearDates), { nHomes: state.nHomes, primaryRegion: state.region, economics: econ, alpha, useWeather, sampleDays: 18 });

    render(hp, fp, hy, fy, dates);
  }

  function render(hp, fp, hy, fy, dates) {
    const t = hp.totals, ft = fp.totals, rep = hp.rep;
    const word = PERIOD_WORD[state.period];
    const homePct = t.noAssetBillGbp > 0 ? (100 * t.homeSavingGbp) / t.noAssetBillGbp : 0;
    const nDays = hp.nDays;
    const hwTotal = rep.hardwareAmortisationGbp * nDays;

    // hero
    setText("hero-unit", word);
    tween($("hero-saving"), t.homeSavingGbp, gbpA);
    tween($("hero-pct"), homePct, pct);
    setText("hero-year", gbp0(hy.totals.homeSavingGbp));

    // home card
    document.querySelectorAll(".per").forEach((e) => (e.textContent = word));
    tween($("home-saving"), t.homeSavingGbp, gbpA);
    tween($("home-pct"), homePct, pct);
    setText("home-sub", gbpA(t.subscriptionGbp));
    setText("home-bill", gbpA(t.noAssetBillGbp));
    setText("home-year", gbp0(hy.totals.homeSavingGbp));
    setText("bd-bill", gbpA(t.noAssetBillGbp));
    setText("bd-sub", gbpA(t.subscriptionGbp));
    setText("bd-save", gbpA(t.homeSavingGbp));

    // gryd card
    tween($("gryd-margin"), t.grydMarginGbp, gbpA);
    setText("gryd-year", gbp0(hy.totals.grydMarginGbp));
    setText("bd-subin", signed(t.subscriptionGbp));
    setText("bd-flex", signed(t.flexRevenueGbp));
    setText("bd-energy", signed(-t.operatingCostGbp));
    setText("bd-hw", signed(-hwTotal));

    // negative-price banner (representative day)
    const neg = [];
    rep.importPrice.forEach((p, i) => { if (p < 0) neg.push(i); });
    const banner = $("neg-banner");
    if (neg.length) { banner.classList.add("show"); setText("neg-text", `Negative prices in ${neg.length} half-hours: the battery is paid to charge and never exports.`); }
    else banner.classList.remove("show");

    // one-day chart
    const s = rep.optimised.schedule;
    Ch.renderHome($("home-chart"), { price: rep.importPrice, solar: rep.solar, load: rep.load, soc: s.soc, import: s.import, export: s.export, curtail: s.curtail, socCap: rep.battery.eCap, flexWindow: [rep.economics.flexWindowStart, rep.economics.flexWindowEnd], negativeSlots: neg });
    const repDate = nDays === 1 ? dates[0] : hp.perDay[Math.floor((nDays - 1) / 2)].date;
    setText("day-tag", (nDays === 1 ? fmtDate(repDate) : "representative day · " + fmtDate(repDate)) + (rep.weatherDriven ? " · real sun" : " · clear-sky"));

    // period chart
    V.renderPeriod($("period-chart"), { perDay: hp.perDay });
    setText("period-hint", nDays === 1 ? "pick a longer period to see the spread" : nDays + " days");

    // fleet
    const mw = fp.peakFlexMw, inKw = mw < 1;
    $("fleet-flex").innerHTML = (inKw ? Math.round(mw * 1000) : mw.toFixed(2)) + ` <small>${inKw ? "kW" : "MW"}</small>`;
    document.querySelectorAll(".per2").forEach((e) => (e.textContent = word));
    setText("fleet-flexrev", gbp0(ft.flexRevenueGbp));
    tween($("fleet-gryd"), ft.grydMarginGbp, gbp0);
    setText("fleet-home", gbp0(ft.homeownerSavingGbp));
    setText("fleet-year", gbp0(fy.totals.homeownerSavingGbp));
    const agg = fp.rep.aggregate, win = fp.rep.metrics.flexWindow;
    let peakIdx = null, pv = -1;
    agg.totalFlex.forEach((v, i) => { const h = (i + 0.5) * 0.5; if (h >= win[0] && h < win[1] && v > pv) { pv = v; peakIdx = i; } });
    const big = Math.max.apply(null, agg.totalFlex) >= 1000;
    Ch.renderFleet($("fleet-chart"), { flex: big ? agg.totalFlex.map((v) => v / 1000) : agg.totalFlex, flexWindow: win, peakIdx, unit: big ? "MW" : "kW" });
    setText("fleet-hint", "capped at inverter power · " + win[0] + ":00 to " + win[1] + ":00 shaded");

    // Price-forecast MPC card: trade on prices forecast from recent same-type
    // days (the Piclo strategy), settle on real prices, compare to perfect.
    const stats = $("mpc-stats"), note = $("mpc-note");
    const pm = rep.priceMpc;
    if (pm) {
      stats.style.display = "";
      note.style.display = "";
      tween($("mpc-perfect"), pm.perfectCostGbp, gbpA);
      tween($("mpc-cost"), pm.forecastCostGbp, gbpA);
      tween($("mpc-gap"), Math.max(0, pm.gapGbp), gbpA);
      V.renderPriceMpc($("mpc-chart"), { actualPrice: rep.importPrice, fcPrice: pm.forecastImport, socPerfect: pm.perfectSoc, socForecast: pm.forecastSoc, socCap: rep.battery.eCap });
      setHTML("mpc-note", `The battery trades on a price forecast (the average of recent ${isWeekend(dates[Math.floor((nDays - 1) / 2)]) ? "weekend days" : "weekdays"}), then pays the real bill. Trading the forecast costs <b>${gbpA(Math.max(0, pm.gapGbp))}</b> more than knowing the prices, which is the value of Agile's day-ahead publication.`);
      setText("mpc-hint", "forecast from the last " + state.histDays + " similar days");
    } else {
      stats.style.display = "none";
      note.style.display = "none";
      $("mpc-chart").innerHTML = "";
      setText("mpc-hint", state.useMpc ? "shown for a day or a week" : "turn on “Forecast prices (MPC)”");
    }

    // Full breakdown (CFO view): every line item over the period.
    setText("cfo-hint", "over " + word + (nDays > 1 ? " · " + nDays + " days" : ""));
    setText("cfo-noasset", gbpA(t.noAssetBillGbp));
    setText("cfo-dumb", gbpA(t.dumbBillGbp));
    setText("cfo-uplift", gbpA(t.dispatchSavingGbp));
    setText("cfo-subin", gbpA(t.subscriptionGbp));
    setText("cfo-flex", gbpA(t.flexRevenueGbp));
    setText("cfo-import", gbpA(t.importCostGbp));
    setText("cfo-export", gbpA(t.exportRevenueGbp));
    setText("cfo-standing", gbpA(t.standingGbp));
    setText("cfo-degr", gbpA(t.degradationGbp));
    setText("cfo-hw", gbpA(t.hardwareGbp));
    setText("cfo-gryd", gbpA(t.grydMarginGbp));
    setText("cfo-sub", gbpA(t.subscriptionGbp));
    setText("cfo-home", gbpA(t.homeSavingGbp) + " (" + Math.round(homePct) + "%)");
    setText("cfo-throughput", t.throughputKwh.toFixed(1) + " kWh");
    setText("cfo-cycles", (t.throughputKwh / rep.battery.eCap).toFixed(1));
    const soc = rep.optimised.schedule.socFull;
    setText("cfo-soc", soc[0].toFixed(1) + " → " + soc[soc.length - 1].toFixed(1) + " kWh");
    setText("cfo-value", gbpA(t.valueGbp));
  }

  function schedule() { clearTimeout(timer); timer = setTimeout(compute, 150); }

  function bindRange(id, key, fmtLabel, heavy) {
    const el = $(id), out = $(id + "-val");
    el.value = state[key];
    const setLabel = () => { state[key] = parseFloat(el.value); const label = fmtLabel(state[key]); if (out) out.textContent = label; el.setAttribute("aria-valuetext", label); };
    el.addEventListener("input", () => { setLabel(); heavy ? schedule() : compute(); });
    setLabel();
  }
  const fillSelect = (el, opts, value) => { el.innerHTML = opts.map((o) => `<option value="${o.v}"${o.v === value ? " selected" : ""}>${o.l}</option>`).join(""); };

  function refreshDataLabel() {
    const reg = REGION_NAMES[state.region] || state.region;
    const note = (state.period === "day" || state.period === "week") && regionFor(state.date, state.region) !== state.region ? " (London data)" : "";
    setHTML("data-source", `<b>Octopus Agile</b> · ${reg}${note} · ${state.useWeather ? "Open-Meteo sun" : "clear-sky"} · ${DATA.meta.start} to ${DATA.meta.end}`);
  }
  function syncPeriodUi() {
    $("date-field").style.display = state.period === "day" || state.period === "week" ? "" : "none";
    $("ferror-field").classList.toggle("off", !state.useMpc);
  }

  function buildLegends() {
    const sw = (c, line) => `<span class="sw${line ? " line" : ""}" style="${line ? "border-color" : "background"}:${c}"></span>`;
    const item = (c, label, line) => `<span class="k">${sw(c, line)}${label}</span>`;
    const C = Ch.COL;
    const dash = (c, label) => `<span class="k"><span class="sw dash" style="border-color:${c}"></span>${label}</span>`;
    setHTML("home-legend", item(C.price, "Price", true) + item(C.solar, "Solar") + item(C.load, "Load", true) + dash(C.soc, "Battery charge") + dash(C.imp, "Grid import") + item(C.exp, "Grid export", true) + dash(C.curtail, "Curtailed"));
    setHTML("fleet-legend", item(C.exp, "Dispatchable flexibility", true) + item("rgba(253,87,50,0.18)", "Evening flex window"));
    setHTML("period-legend", item("var(--green)", "Home saving") + item("var(--orange)", "Gryd margin"));
    setHTML("mpc-legend", item(C.price, "Real Agile price", true) + item(C.price, "Forecast price (dashed)", true) + item(C.soc, "Battery charge: real vs forecast", true));
  }

  function heroIntro() {
    if (reduce || !hasGsap) return;
    const els = document.querySelectorAll(".hero .eyebrow, .hero h1, .hero-lead, .hero-figure, .cta-row");
    window.gsap.from(els, { y: 18, opacity: 0, duration: 0.7, stagger: 0.08, ease: "power2.out" });
    const path = document.getElementById("price-path");
    if (path && path.getTotalLength) { const len = path.getTotalLength(); window.gsap.fromTo(path, { strokeDasharray: len, strokeDashoffset: len }, { strokeDashoffset: 0, duration: 1.1, ease: "power1.inOut", delay: 0.2 }); }
    setTimeout(() => { window.gsap.killTweensOf(els); window.gsap.set(els, { clearProps: "opacity,transform" }); if (path) { window.gsap.killTweensOf(path); window.gsap.set(path, { strokeDashoffset: 0 }); } }, 1300);
  }

  function init() {
    fetch("./data/dataset.json").then((r) => r.json()).then((d) => {
      DATA = d;
      state.date = d.defaultDate;
      // Only offer regions we actually have data for, so the fleet never crashes.
      fillSelect($("region"), d.meta.regions.map((r) => ({ v: r, l: r + " · " + (REGION_NAMES[r] || "region " + r) })), "C");
      fillSelect($("date"), d.dates.map((x) => ({ v: x, l: fmtDate(x) })), state.date);
      $("period").value = state.period;

      $("period").addEventListener("change", () => { state.period = $("period").value; syncPeriodUi(); refreshDataLabel(); compute(); });
      $("date").addEventListener("change", () => { state.date = $("date").value; refreshDataLabel(); compute(); });
      $("region").addEventListener("change", () => { state.region = $("region").value; $("region-val").textContent = REGION_NAMES[state.region] || state.region; refreshDataLabel(); compute(); });

      bindRange("solar", "solarKwp", (v) => v.toFixed(2) + " kWp");
      bindRange("azimuth", "azimuthDeg", (v) => azName(v) + " (" + (v > 0 ? "+" : "") + v + "°)");
      bindRange("tilt", "tiltDeg", (v) => v + "°");
      bindRange("battery", "batteryKwh", (v) => v.toFixed(1) + " kWh");
      bindRange("load", "dailyLoadKwh", (v) => v.toFixed(1) + " kWh");
      bindRange("sub", "subPct", (v) => v + "%", true);
      bindRange("alpha", "alpha", (v) => (v < 0.34 ? "home first" : v > 0.66 ? "Gryd first" : "balanced") + " (" + v.toFixed(2) + ")", true);
      bindRange("flex", "flexPrice", (v) => "£" + v + "/MW/h", true);
      bindRange("homes", "nHomes", (v) => v + "", true);
      // Forecast error: the slider is a percent, the engine wants a fraction.
      const ferrEl = $("ferror"), ferrOut = $("ferror-val");
      const ferrUpdate = () => { state.histDays = parseInt(ferrEl.value, 10); const l = state.histDays + (state.histDays === 1 ? " day" : " days"); ferrOut.textContent = l; ferrEl.setAttribute("aria-valuetext", l); };
      ferrEl.addEventListener("input", () => { ferrUpdate(); compute(); });
      ferrUpdate();

      const wEl = $("weather"); wEl.checked = state.useWeather;
      wEl.addEventListener("change", () => { state.useWeather = wEl.checked; refreshDataLabel(); compute(); });
      const mEl = $("mpc"); mEl.checked = state.useMpc;
      mEl.addEventListener("change", () => { state.useMpc = mEl.checked; syncPeriodUi(); compute(); });

      $("region-val").textContent = REGION_NAMES[state.region];
      $("period-val").textContent = "";
      buildLegends();
      syncPeriodUi();
      refreshDataLabel();
      compute();
      heroIntro();
    }).catch(() => setText("data-source", "Could not load the dataset."));
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
