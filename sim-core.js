/*
 * sim-core.js — Gryd Sim engine.
 *
 * Pure, deterministic, no DOM. The same file runs in the browser (attaches to
 * window.SimCore) and under node for the tests (module.exports). It is a JS port
 * of the validated gryd-engine model. The one deliberate change: the per-home
 * battery dispatch uses an explainable price-rank heuristic instead of a linear
 * program, because this runs live in a browser with no solver. Solar gains an
 * orientation model (azimuth + tilt) that the Python version did not have.
 *
 * Units: power in kW, energy in kWh, prices in GBP/kWh, money in GBP. One day is
 * 48 half-hour steps, dt = 0.5 h. Sign convention for panel azimuth: 0 = due
 * south, negative = east, positive = west.
 */
(function (global) {
  "use strict";

  const DT_H = 0.5;
  const SLOTS = 48;
  const REGIONS = "ABCDEFGHIJKLMN".split("");
  const DEFAULT_REGION = "C";
  const DEFAULT_EXPORT_GBP_PER_KWH = 0.15; // flat export fallback, flagged in UI
  const LAT_DEG = 51.5; // London, used for the solar geometry

  // small helpers

  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  const zeros = (n) => new Array(n).fill(0);
  const rad = (deg) => (deg * Math.PI) / 180;

  // mulberry32: a tiny seeded PRNG so the fleet is reproducible across runs.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // battery parameters

  // 93.81% each way (~88% round trip) matches the Piclo source the model reuses.
  function batteryParams(cfg) {
    const eCap = cfg.batteryKwh;
    const reserve = Math.min(0.5, 0.1 * eCap); // keep a small floor for the home
    return {
      eCap,
      pMax: cfg.batteryPowerKw,
      etaCh: 0.9381,
      etaDis: 0.9381,
      reserve,
      exportCap: cfg.exportCapKw != null ? cfg.exportCapKw : 3.68, // single-phase G98 limit
      dt: DT_H,
      // A repeatable day starts and must end at the same inventory, so a one-day
      // run cannot claim free energy it did not pay for.
      initialSoc: Math.max(reserve, 0.5 * eCap),
    };
  }

  // solar and load profiles

  // Astronomical day length from latitude and solar declination.
  function daylightHours(dayOfYear, latDeg = LAT_DEG) {
    const lat = rad(latDeg);
    const decl = rad(23.44) * Math.sin((2 * Math.PI * (284 + dayOfYear)) / 365);
    const cosH = clamp(-Math.tan(lat) * Math.tan(decl), -1, 1);
    return (24 * Math.acos(cosH)) / Math.PI;
  }

  // Sun elevation and the cosine of incidence on the tilted, oriented panel,
  // per half hour. Standard solar geometry from latitude and declination.
  function sunGeom(dayOfYear, azimuthDeg, tiltDeg, latDeg = LAT_DEG) {
    const lat = rad(latDeg);
    const decl = rad(23.44) * Math.sin((2 * Math.PI * (284 + dayOfYear)) / 365);
    const beta = rad(tiltDeg);
    const gamma = rad(azimuthDeg); // panel azimuth from south, east negative
    const sinElev = zeros(SLOTS), cosInc = zeros(SLOTS);
    for (let t = 0; t < SLOTS; t++) {
      const hour = (t + 0.5) * DT_H;
      const H = rad(15 * (hour - 12));
      const se = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(H);
      sinElev[t] = se;
      if (se <= 0) continue;
      const ce = Math.cos(Math.asin(clamp(se, -1, 1)));
      const sinAz = (Math.cos(decl) * Math.sin(H)) / ce;
      const cosAz = (se * Math.sin(lat) - Math.sin(decl)) / (ce * Math.cos(lat));
      const sunAz = Math.atan2(sinAz, cosAz);
      cosInc[t] = se * Math.cos(beta) + ce * Math.sin(beta) * Math.cos(sunAz - gamma);
    }
    return { sinElev, cosInc };
  }

  function poaShape(dayOfYear, azimuthDeg, tiltDeg, latDeg = LAT_DEG) {
    const { sinElev, cosInc } = sunGeom(dayOfYear, azimuthDeg, tiltDeg, latDeg);
    const diffuseFraction = 0.18; // rough clear-sky diffuse share
    const skyView = (1 + Math.cos(rad(tiltDeg))) / 2;
    const shape = zeros(SLOTS);
    for (let t = 0; t < SLOTS; t++) {
      if (sinElev[t] <= 0) continue;
      const direct = Math.max(cosInc[t], 0) * sinElev[t];
      const diffuse = sinElev[t] * skyView;
      shape[t] = (1 - diffuseFraction) * direct + diffuseFraction * diffuse;
    }
    return shape;
  }

  // Cache the south-optimal peak per day so orientation reads as a fraction.
  function southOptimalPeak(dayOfYear) {
    const ref = poaShape(dayOfYear, 0, 35);
    return Math.max(1e-9, Math.max.apply(null, ref));
  }

  const PERF_RATIO = 0.86; // system losses (inverter, wiring, soiling, temperature)

  function buildProfiles(opts) {
    const {
      dayOfYear,
      solarKwp = 4.25,
      dailyLoadKwh = 10.0,
      clearSkyFactor = 0.72,
      azimuthDeg = 0,
      tiltDeg = 35,
      ghi = null, // optional real half-hourly global horizontal irradiance, W/m2
    } = opts;

    // UK domestic demand: small base load, a breakfast bump, a stronger evening
    // peak around 19:00, then scaled exactly to the requested daily kWh.
    const loadShape = zeros(SLOTS);
    for (let t = 0; t < SLOTS; t++) {
      const h = (t + 0.5) * DT_H;
      loadShape[t] =
        0.2 +
        0.65 * Math.exp(-0.5 * Math.pow((h - 7.5) / 1.25, 2)) +
        1.35 * Math.exp(-0.5 * Math.pow((h - 19.0) / 2.0, 2));
    }
    const loadScale = dailyLoadKwh / (sum(loadShape) * DT_H);
    const load = loadShape.map((v) => v * loadScale);

    let solar, weatherDriven = false;
    if (ghi && ghi.length === SLOTS) {
      // Real-irradiance model: transpose measured horizontal irradiance onto the
      // tilted, oriented panel, then convert to AC power by kWp and a performance
      // ratio. Orientation enters through the incidence/elevation ratio.
      weatherDriven = true;
      const { sinElev, cosInc } = sunGeom(dayOfYear, azimuthDeg, tiltDeg);
      const df = 0.2; // diffuse share, spread isotropically over the sky view
      const viewFactor = (1 + Math.cos(rad(tiltDeg))) / 2;
      solar = zeros(SLOTS);
      for (let t = 0; t < SLOTS; t++) {
        if (ghi[t] <= 0 || sinElev[t] <= 0) continue;
        const beamFactor = clamp(Math.max(cosInc[t], 0) / Math.max(sinElev[t], 0.1), 0, 1.4);
        const poa = ghi[t] * ((1 - df) * beamFactor + df * viewFactor);
        solar[t] = solarKwp * PERF_RATIO * (poa / 1000);
      }
    } else {
      // Clear-sky fallback: orientation gives the shape, season/clear-sky/kWp the size.
      const daylight = daylightHours(dayOfYear);
      const seasonal = clamp(0.4 + (0.6 * (daylight - 8.0)) / 8.0, 0.35, 1.0);
      const shape = poaShape(dayOfYear, azimuthDeg, tiltDeg);
      const peakRef = southOptimalPeak(dayOfYear);
      solar = shape.map((v) => solarKwp * clearSkyFactor * seasonal * (v / peakRef));
    }

    return { load, solar, weatherDriven };
  }

  // flexibility headroom (one-slot deliverability)

  /*
   * Up-flex is unused discharge power backed by stored energy; down-flex is
   * unused charge power backed by empty capacity. They are separate market
   * products, not a simultaneous call. Computed the same way for baseline and
   * optimised dispatch so the accounting is objective-independent. Mirrors the
   * gryd-engine LP's flex constraints.
   */
  function flexHeadroom(sch, bat, load) {
    const { pMax, etaCh, etaDis, reserve, eCap, exportCap, dt } = bat;
    const n = sch.charge.length;
    const flexUp = zeros(n);
    const flexDown = zeros(n);
    for (let t = 0; t < n; t++) {
      const soc = sch.soc[t];
      let up = Math.min(
        pMax - sch.discharge[t],
        Math.max(((soc - reserve) * etaDis) / dt - sch.discharge[t], 0)
      );
      up = Math.min(up, sch.import[t] + exportCap - sch.export[t]);
      let down = Math.min(
        pMax - sch.charge[t],
        Math.max((eCap - soc) / (etaCh * dt) - sch.charge[t], 0)
      );
      down = Math.min(down, sch.export[t] + load[t] + pMax - sch.import[t]);
      flexUp[t] = Math.max(0, up);
      flexDown[t] = Math.max(0, down);
    }
    return { flexUp, flexDown };
  }

  // Derive grid flows from a battery schedule and the energy balance.
  // export is curtailed (never sold) when it would not be paid, and is capped by
  // the inverter limit and by "no reselling imported energy".
  function gridFlows(load, solar, charge, discharge, importPrice, exportPrice, bat) {
    const n = load.length;
    const imp = zeros(n);
    const exp = zeros(n);
    const curtail = zeros(n);
    for (let t = 0; t < n; t++) {
      const net = load[t] + charge[t] - solar[t] - discharge[t];
      if (net >= 0) {
        imp[t] = net;
      } else {
        let want = -net; // surplus available to export
        const ceiling = Math.min(bat.exportCap, solar[t] + discharge[t]);
        // Never export when it would not be paid: the home is paid to consume
        // (import price negative), or the export price itself is non-positive.
        if (importPrice[t] < 0 || exportPrice[t] <= 0) {
          curtail[t] = want;
        } else {
          exp[t] = Math.min(want, ceiling);
          curtail[t] = want - exp[t];
        }
      }
    }
    return { imp, exp, curtail };
  }

  function socFrom(charge, discharge, bat, startSoc) {
    const n = charge.length;
    const soc = zeros(n + 1);
    soc[0] = startSoc == null ? bat.initialSoc : startSoc;
    for (let t = 0; t < n; t++) {
      soc[t + 1] =
        soc[t] + bat.etaCh * charge[t] * bat.dt - (discharge[t] / bat.etaDis) * bat.dt;
    }
    return soc;
  }

  function assembleSchedule(load, solar, charge, discharge, importPrice, exportPrice, bat) {
    const soc = socFrom(charge, discharge, bat);
    const { imp, exp, curtail } = gridFlows(
      load, solar, charge, discharge, importPrice, exportPrice, bat
    );
    const sch = {
      charge,
      discharge,
      import: imp,
      export: exp,
      curtail,
      soc: soc.slice(1), // per-slot end-of-step SoC, matching gryd-engine frame
      socFull: soc,
    };
    const flex = flexHeadroom({ ...sch, soc: soc }, bat, load);
    sch.flexUp = flex.flexUp;
    sch.flexDown = flex.flexDown;
    return sch;
  }

  // dumb baseline

  // Price-blind decisions over a horizon of any length: charge only from surplus
  // solar, discharge only into load, never spending below floorSoc. Returns the
  // charge/discharge arrays only (no accounting).
  function dumbPlan(load, solar, bat, startSoc, floorSoc) {
    const n = load.length;
    const charge = zeros(n), discharge = zeros(n);
    let soc = startSoc;
    for (let t = 0; t < n; t++) {
      const surplus = solar[t] - load[t];
      if (surplus >= 0) {
        const room = (bat.eCap - soc) / (bat.etaCh * bat.dt);
        charge[t] = Math.min(surplus, bat.pMax, Math.max(room, 0));
        soc += bat.etaCh * charge[t] * bat.dt;
      } else {
        const avail = ((soc - floorSoc) * bat.etaDis) / bat.dt;
        discharge[t] = Math.min(-surplus, bat.pMax, Math.max(avail, 0));
        soc -= (discharge[t] / bat.etaDis) * bat.dt;
      }
    }
    return { charge, discharge };
  }

  function dumbSelfConsumption(load, solar, importPrice, exportPrice, bat) {
    const { charge, discharge } = dumbPlan(load, solar, bat, bat.initialSoc, bat.initialSoc);
    return assembleSchedule(load, solar, charge, discharge, importPrice, exportPrice, bat);
  }

  // Horizon greedy, shared by the full-day optimiser and every MPC re-plan.
  // Starts from the dumb baseline and only takes trades that lower cost and stay
  // feasible: charge a cheap slot and discharge a dearer one (Move A), or re-time
  // stored solar to the priciest import slots (Move B). So it is never worse than
  // dumb. Works over [startSoc..], never spending below floorSoc.
  function greedyPlan(load, solar, importPrice, exportPrice, bat, startSoc, floorSoc, degr) {
    const n = load.length;
    const etaRT = bat.etaCh * bat.etaDis;
    const dt = bat.dt;
    const EPS = 1e-7;
    const wearPerKwh = (degr || 20.0) / 1000.0;

    const base = dumbPlan(load, solar, bat, startSoc, floorSoc);
    const charge = base.charge.slice();
    const discharge = base.discharge.slice();
    let soc = socFrom(charge, discharge, bat, startSoc);
    const residualImport = () =>
      gridFlows(load, solar, charge, discharge, importPrice, exportPrice, bat).imp;

    const maxIters = 6 * n * n + 10;
    for (let iter = 0; iter < maxIters; iter++) {
      const imp = residualImport();
      let best = null; // {type, i, j, step, gain}

      // Move A: grid-charge at i (<j), discharge to offset import at j.
      for (let j = 0; j < n; j++) {
        if (charge[j] > EPS || imp[j] <= EPS) continue;
        for (let i = 0; i < j; i++) {
          if (discharge[i] > EPS) continue;
          const rate = importPrice[j] * etaRT - importPrice[i] - wearPerKwh * etaRT;
          if (rate <= EPS) continue;
          let headroom = Infinity;
          for (let k = i + 1; k <= j; k++) headroom = Math.min(headroom, bat.eCap - soc[k]);
          const dcMax = Math.min(
            bat.pMax - charge[i],
            (bat.pMax - discharge[j]) / etaRT,
            imp[j] / etaRT,
            headroom / (bat.etaCh * dt)
          );
          if (dcMax <= EPS) continue;
          const gain = rate * dcMax * dt;
          if (!best || gain > best.gain) best = { type: "A", i, j, step: dcMax, gain };
        }
      }

      // Move B: shift existing discharge from cheap slot a to dearer slot b.
      for (let a = 0; a < n; a++) {
        if (discharge[a] <= EPS) continue;
        for (let b = 0; b < n; b++) {
          if (b === a || charge[b] > EPS || imp[b] <= EPS) continue;
          const rate = importPrice[b] - importPrice[a];
          if (rate <= EPS) continue;
          const deliver = bat.pMax - discharge[b];
          if (deliver <= EPS) continue;
          let step = Math.min(discharge[a], deliver, imp[b]);
          if (b > a) {
            let head = Infinity;
            for (let k = a + 1; k <= b; k++) head = Math.min(head, bat.eCap - soc[k]);
            step = Math.min(step, (head / dt) * bat.etaDis);
          } else {
            let floor = Infinity;
            for (let k = b + 1; k <= a; k++) floor = Math.min(floor, soc[k] - bat.reserve);
            step = Math.min(step, (floor / dt) * bat.etaDis);
          }
          if (step <= EPS) continue;
          const gain = rate * step * dt;
          if (!best || gain > best.gain) best = { type: "B", i: a, j: b, step, gain };
        }
      }

      if (!best || best.gain <= EPS) break;
      if (best.type === "A") {
        charge[best.i] += best.step;
        discharge[best.j] += best.step * etaRT;
      } else {
        discharge[best.i] -= best.step;
        discharge[best.j] += best.step;
      }
      soc = socFrom(charge, discharge, bat, startSoc);
    }
    return { charge, discharge };
  }

  // Full-day dispatch with perfect day-ahead foresight; repeatable (ends no lower
  // than the day's starting inventory).
  function dispatchPriceRank(load, solar, importPrice, exportPrice, bat, opts) {
    const degr = (opts && opts.degradationGbpPerMwh) || 20.0;
    const { charge, discharge } = greedyPlan(
      load, solar, importPrice, exportPrice, bat, bat.initialSoc, bat.initialSoc, degr
    );
    return assembleSchedule(load, solar, charge, discharge, importPrice, exportPrice, bat);
  }

  // Rolling controller: each half hour, forecast the rest of the day (error grows
  // with horizon), re-plan, take the first action, settle against the actual sun
  // and load. forecastError = 0 is perfect foresight; the gap to it is the cost
  // of not knowing.
  function mpcDispatch(load, solar, importPrice, exportPrice, bat, opts) {
    const degr = (opts && opts.degradationGbpPerMwh) || 20.0;
    const sigma = (opts && opts.forecastError) || 0;
    const rng = mulberry32((opts && opts.seed) || 7919);
    const n = load.length;
    const actCharge = zeros(n), actDischarge = zeros(n);
    let cur = bat.initialSoc;
    for (let t = 0; t < n; t++) {
      const m = n - t;
      const fLoad = new Array(m), fSolar = new Array(m), hImp = new Array(m), hExp = new Array(m);
      for (let k = 0; k < m; k++) {
        const s = t + k;
        const grow = Math.min(1.6, Math.sqrt(k * DT_H)); // error widens with horizon
        const eS = k === 0 ? 0 : (rng() * 2 - 1) * sigma * grow;
        const eL = k === 0 ? 0 : (rng() * 2 - 1) * sigma * 0.5 * grow;
        fSolar[k] = Math.max(0, solar[s] * (1 + eS));
        fLoad[k] = Math.max(0, load[s] * (1 + eL));
        hImp[k] = importPrice[s];
        hExp[k] = exportPrice[s]; // prices are published day ahead, so no error
      }
      const plan = greedyPlan(fLoad, fSolar, hImp, hExp, bat, cur, bat.initialSoc, degr);
      let ch = Math.min(plan.charge[0], bat.pMax, Math.max(0, (bat.eCap - cur) / (bat.etaCh * DT_H)));
      let di = Math.min(plan.discharge[0], bat.pMax, Math.max(0, ((cur - bat.reserve) * bat.etaDis) / DT_H));
      if (ch > 1e-9 && di > 1e-9) { if (ch >= di) di = 0; else ch = 0; }
      actCharge[t] = ch;
      actDischarge[t] = di;
      cur = cur + bat.etaCh * ch * DT_H - (di / bat.etaDis) * DT_H;
    }
    return assembleSchedule(load, solar, actCharge, actDischarge, importPrice, exportPrice, bat);
  }

  // per-home accounting

  // Is half-hour t inside the evening flexibility window [start, end) hours?
  function inFlexWindow(t, econ) {
    const hour = (t + 0.5) * DT_H;
    return hour >= econ.flexWindowStart && hour < econ.flexWindowEnd;
  }

  function rawMetrics(load, solar, sch, importPrice, exportPrice, econ, bat) {
    let importCost = 0,
      exportRevenue = 0,
      throughput = 0,
      flexEnergy = 0, // only the evening window is contracted and paid
      windowPeakFlex = 0,
      importKwh = 0,
      exportKwh = 0;
    for (let t = 0; t < SLOTS; t++) {
      importCost += sch.import[t] * importPrice[t] * DT_H;
      exportRevenue += sch.export[t] * Math.max(exportPrice[t], 0) * DT_H;
      throughput += sch.discharge[t] * DT_H;
      importKwh += sch.import[t] * DT_H;
      exportKwh += sch.export[t] * DT_H;
      if (inFlexWindow(t, econ)) {
        // Turn-up and turn-down are separate products and a single inverter
        // cannot deliver both at once, so the firm sellable response per slot is
        // capped at its power rating rather than the sum of both directions.
        const env = Math.min(sch.flexUp[t] + sch.flexDown[t], bat.pMax);
        flexEnergy += env * DT_H;
        windowPeakFlex = Math.max(windowPeakFlex, env);
      }
    }
    const standing = econ.standingChargeGbp;
    const degradation = (throughput * econ.degradationGbpPerMwh) / 1000.0;
    // Availability payment: flexibility envelope across the evening window only.
    const flexRevenue = (flexEnergy * econ.flexPriceGbpPerMwH) / 1000.0;
    const tariffBill = importCost - exportRevenue + standing; // net energy cost
    return {
      importKwh,
      exportKwh,
      throughputKwh: throughput,
      importCostGbp: importCost,
      exportRevenueGbp: exportRevenue,
      tariffBillGbp: tariffBill,
      retailBillGbp: importCost + standing, // counterfactual import bill, no export credit
      degradationGbp: degradation,
      operatingCostGbp: tariffBill + degradation,
      flexRevenueGbp: flexRevenue,
      windowPeakFlexKw: windowPeakFlex,
      peakFlexUpKw: Math.max.apply(null, sch.flexUp),
      peakFlexDownKw: Math.max.apply(null, sch.flexDown),
    };
  }

  // Hardware capex scales with the installed system so the amortisation moves
  // when solar or battery size changes. Calibrated so the default (~4 kWp,
  // 5.4 kWh) lands near £6,500: base install + inverter, then per-kWp and per-kWh.
  function hardwareCapex(cfg) {
    return 1800 + 700 * cfg.solarKwp + 350 * cfg.batteryKwh;
  }

  function dailyAmortisation(econ) {
    const capital = econ.hardwareCapexGbp / (365.25 * econ.hardwareLifeYears);
    const maint = (econ.hardwareCapexGbp * econ.annualMaintenancePct) / 100.0 / 365.25;
    return capital + maint;
  }

  /*
   * Split the daily value the funded + optimised system creates between the home
   * and Gryd. The pie is fixed by the dispatch:
   *   V = baseline_bill - operating_cost + flex_revenue - hardware_amortisation
   * Subscription % sets the homeowner's guaranteed floor saving. Alpha then
   * distributes the surplus above the floor: alpha=0 gives the home all of V,
   * alpha=1 leaves the home at the floor and Gryd keeps the rest. The two always
   * sum to V, so both figures move as alpha changes.
   */
  function splitValue(baselineBill, V, alpha, subscriptionPct) {
    alpha = clamp(alpha, 0, 1);
    // Guard the degenerate case where the counterfactual bill is non-positive
    // (sustained negative prices): there is no bill to discount, so cap at zero.
    const bill = Math.max(baselineBill, 0);
    // The floor is the saving the customer is promised, at most a free bill.
    const floor = clamp((subscriptionPct / 100.0) * bill, 0, bill);
    const surplus = Math.max(V - floor, 0); // shareable value above the promise
    // The home keeps the floor plus an alpha-weighted slice of the surplus, but
    // never more than its whole bill (so the subscription stays non-negative).
    const homeownerSaving = clamp(floor + (1 - alpha) * surplus, floor, bill);
    // Gryd takes the remainder. On a thin day this can be negative: Gryd still
    // honours the customer's floor and eats the shortfall. That is the real risk
    // the funded model carries, and it is shown honestly rather than hidden.
    const grydMargin = V - homeownerSaving;
    const subscription = baselineBill - homeownerSaving;
    return {
      homeownerSavingGbp: homeownerSaving,
      grydMarginGbp: grydMargin,
      subscriptionGbp: subscription,
      homeownerSavingPct: baselineBill > 0 ? (100 * homeownerSaving) / baselineBill : 0,
      dailyValueGbp: V,
      floorSavingGbp: floor,
    };
  }

  const DEFAULT_ECON = {
    homeownerSavingPct: 15.0, // floor saving the customer is promised
    flexPriceGbpPerMwH: 60.0,
    flexWindowStart: 16.0, // evening peak window when flexibility is contracted
    flexWindowEnd: 20.0,
    degradationGbpPerMwh: 20.0,
    hardwareCapexGbp: 6500.0,
    hardwareLifeYears: 25.0, // Gryd quotes a 25-year guarantee on the system
    annualMaintenancePct: 2.5, // servicing + a reserve for a mid-life battery replacement
    standingChargeGbp: 0.6,
  };

  const DEFAULT_HOME = {
    solarKwp: 4.25,
    dailyLoadKwh: 10.0,
    clearSkyFactor: 0.72,
    batteryKwh: 9.5,
    batteryPowerKw: 5.0,
    exportCapKw: 3.68,
    azimuthDeg: 0,
    tiltDeg: 35,
  };

  function runHome(prices, opts) {
    const cfg = Object.assign({}, DEFAULT_HOME, (opts && opts.config) || {});
    const econ = Object.assign({}, DEFAULT_ECON, (opts && opts.economics) || {});
    // Hardware capex always scales with the installed system size.
    econ.hardwareCapexGbp = hardwareCapex(cfg);
    const alpha = opts && opts.alpha != null ? opts.alpha : 0.5;
    const dayOfYear = (opts && opts.dayOfYear) || prices.dayOfYear || 172;

    const importPrice = prices.import;
    const exportPrice = prices.export;
    const bat = batteryParams(cfg);
    const { load, solar, weatherDriven } = buildProfiles({
      dayOfYear,
      solarKwp: cfg.solarKwp,
      dailyLoadKwh: cfg.dailyLoadKwh,
      clearSkyFactor: cfg.clearSkyFactor,
      azimuthDeg: cfg.azimuthDeg,
      tiltDeg: cfg.tiltDeg,
      ghi: (opts && opts.useWeather && prices.ghi) ? prices.ghi : null,
    });

    const baseSch = dumbSelfConsumption(load, solar, importPrice, exportPrice, bat);
    const optSch = dispatchPriceRank(load, solar, importPrice, exportPrice, bat, {
      degradationGbpPerMwh: econ.degradationGbpPerMwh,
    });

    const baseM = rawMetrics(load, solar, baseSch, importPrice, exportPrice, econ, bat);
    const optM = rawMetrics(load, solar, optSch, importPrice, exportPrice, econ, bat);

    // The homeowner's real counterfactual under the funded model: the bill they
    // pay today for all their electricity, with no solar and no battery of their
    // own. Gryd installs the assets for free and replaces this bill with a
    // subscription, so this is what "what this home saves" is measured against.
    let noAssetBill = econ.standingChargeGbp;
    for (let t = 0; t < SLOTS; t++) noAssetBill += load[t] * importPrice[t] * DT_H;

    const amort = dailyAmortisation(econ);
    // The daily value the funded + optimised system creates, net of Gryd's
    // running cost, hardware, and including the flexibility income.
    const V = noAssetBill - optM.operatingCostGbp + optM.flexRevenueGbp - amort;
    const split = splitValue(noAssetBill, V, alpha, econ.homeownerSavingPct);

    // Optional MPC analysis: a perfect-foresight rolling controller versus one
    // working off an imperfect forecast. The gap is the cost of uncertainty.
    let mpc = null;
    if (opts && opts.mpc) {
      const fe = opts.mpc.forecastError || 0;
      const seed = opts.mpc.seed || 7919;
      const common = { degradationGbpPerMwh: econ.degradationGbpPerMwh, seed };
      const perfectSch = mpcDispatch(load, solar, importPrice, exportPrice, bat, Object.assign({ forecastError: 0 }, common));
      const mpcSch = mpcDispatch(load, solar, importPrice, exportPrice, bat, Object.assign({ forecastError: fe }, common));
      const perfectM = rawMetrics(load, solar, perfectSch, importPrice, exportPrice, econ, bat);
      const mpcM = rawMetrics(load, solar, mpcSch, importPrice, exportPrice, econ, bat);
      mpc = {
        forecastError: fe,
        perfectCostGbp: perfectM.operatingCostGbp,
        mpcCostGbp: mpcM.operatingCostGbp,
        gapGbp: mpcM.operatingCostGbp - perfectM.operatingCostGbp,
        perfectSchedule: perfectSch,
        mpcSchedule: mpcSch,
      };
    }

    return {
      load,
      solar,
      weatherDriven,
      mpc,
      importPrice,
      exportPrice,
      baseline: { schedule: baseSch, metrics: baseM },
      optimised: { schedule: optSch, metrics: optM },
      battery: bat,
      economics: econ,
      config: cfg,
      hardwareAmortisationGbp: amort,
      baselineBillGbp: noAssetBill, // headline counterfactual
      noAssetBillGbp: noAssetBill,
      dumbBatteryBillGbp: baseM.retailBillGbp, // solar + dumb battery, for the dispatch comparison
      split,
      // The pre-subscription energy saving the price-aware dispatch produces over
      // the dumb battery: shows that smart dispatch beats dumb dispatch.
      dispatchSavingGbp: baseM.operatingCostGbp - optM.operatingCostGbp,
      directBillSavingGbp: baseM.tariffBillGbp - optM.tariffBillGbp,
    };
  }

  // fleet

  function generateFleet(nHomes, primaryRegion, seed) {
    if (nHomes < 1) throw new Error("nHomes must be positive");
    const rng = mulberry32(seed || 42);
    const start = REGIONS.indexOf((primaryRegion || DEFAULT_REGION).toUpperCase());
    const pool = [0, 1, 13, 2].map((o) => REGIONS[(start + o) % REGIONS.length]);
    const homes = [];
    for (let i = 0; i < nHomes; i++) {
      const batteryKwh = 5.0 + rng() * 8.5;
      homes.push({
        homeId: "H" + String(i + 1).padStart(3, "0"),
        region: pool[i % pool.length],
        config: {
          solarKwp: 3.0 + rng() * 2.8,
          dailyLoadKwh: 7.5 + rng() * 9.5,
          clearSkyFactor: 0.58 + rng() * 0.24,
          batteryKwh,
          batteryPowerKw: Math.min((0.45 + rng() * 0.15) * batteryKwh, 5.0),
          // Orientation varies across the fleet, so the aggregate solar shape is
          // smeared across the day rather than a single sharp noon spike.
          azimuthDeg: -90 + rng() * 180, // east through west
          tiltDeg: 20 + rng() * 25,
          exportCapKw: 3.68,
        },
      });
    }
    return homes;
  }

  function runFleet(opts) {
    const nHomes = opts.nHomes || 20;
    const primaryRegion = opts.primaryRegion || DEFAULT_REGION;
    const seed = opts.seed || 42;
    const econ = Object.assign({}, DEFAULT_ECON, opts.economics || {});
    const alpha = opts.alpha != null ? opts.alpha : 0.5;
    const dayOfYear = opts.dayOfYear || 172;
    const pricesByRegion = opts.pricesByRegion; // { A: {import,export}, ... }

    const homes = generateFleet(nHomes, primaryRegion, seed);
    const aggLoad = zeros(SLOTS),
      aggSolar = zeros(SLOTS),
      aggBatt = zeros(SLOTS),
      aggImport = zeros(SLOTS),
      aggExport = zeros(SLOTS),
      aggFlexUp = zeros(SLOTS),
      aggFlexDown = zeros(SLOTS),
      aggDeliverable = zeros(SLOTS); // per-home flex capped at inverter power, then summed
    let flexRevenue = 0,
      grydMargin = 0,
      homeownerSaving = 0,
      energyKwh = 0;

    for (const home of homes) {
      // Fall back to any available region's prices so a missing region never crashes.
      const prices =
        pricesByRegion[home.region] || pricesByRegion[primaryRegion.toUpperCase()] ||
        pricesByRegion[Object.keys(pricesByRegion)[0]];
      // runHome sizes the hardware capex per home from its own config.
      const r = runHome(prices, {
        config: home.config,
        economics: econ,
        alpha,
        dayOfYear,
        useWeather: opts.useWeather,
      });
      const s = r.optimised.schedule;
      for (let t = 0; t < SLOTS; t++) {
        aggLoad[t] += r.load[t];
        aggSolar[t] += r.solar[t];
        aggBatt[t] += s.discharge[t] - s.charge[t];
        aggImport[t] += s.import[t];
        aggExport[t] += s.export[t];
        aggFlexUp[t] += s.flexUp[t];
        aggFlexDown[t] += s.flexDown[t];
        aggDeliverable[t] += Math.min(s.flexUp[t] + s.flexDown[t], r.battery.pMax);
      }
      flexRevenue += r.optimised.metrics.flexRevenueGbp;
      grydMargin += r.split.grydMarginGbp;
      homeownerSaving += r.split.homeownerSavingGbp;
      energyKwh += r.optimised.metrics.importKwh;
    }

    // The sellable envelope is the per-home capped deliverable, summed.
    const totalFlex = aggDeliverable;
    // Headline MW is the peak the fleet can offer during the contracted evening
    // window, since that is when the grid actually calls on it.
    let windowPeakFlex = 0;
    for (let t = 0; t < SLOTS; t++) {
      if (inFlexWindow(t, econ)) windowPeakFlex = Math.max(windowPeakFlex, totalFlex[t]);
    }
    return {
      homes,
      aggregate: {
        load: aggLoad,
        solar: aggSolar,
        battery: aggBatt,
        import: aggImport,
        export: aggExport,
        flexUp: aggFlexUp,
        flexDown: aggFlexDown,
        totalFlex,
      },
      metrics: {
        nHomes,
        peakFlexMw: windowPeakFlex / 1000.0,
        dayPeakFlexMw: Math.max.apply(null, totalFlex) / 1000.0,
        peakFlexUpMw: Math.max.apply(null, aggFlexUp) / 1000.0,
        peakFlexDownMw: Math.max.apply(null, aggFlexDown) / 1000.0,
        flexWindow: [econ.flexWindowStart, econ.flexWindowEnd],
        flexRevenueGbp: flexRevenue,
        grydMarginGbp: grydMargin,
        homeownerSavingGbp: homeownerSaving,
        fleetImportKwh: energyKwh,
      },
    };
  }

  // multi-period aggregation

  // Pick k roughly evenly spaced entries from an array.
  function sampleEven(arr, k) {
    if (arr.length <= k) return arr.slice();
    const out = [];
    for (let i = 0; i < k; i++) out.push(arr[Math.round((i * (arr.length - 1)) / (k - 1))]);
    return out;
  }

  // Run one home exactly across many real days and total the value. MPC, if
  // requested, is computed only on the representative day (it is expensive).
  // days: [{ date, dayOfYear, import[48], export[48], ghi[48]? }]
  function runPeriod(days, opts) {
    const n = days.length;
    const repIdx = Math.floor((n - 1) / 2);
    const t = {
      homeSavingGbp: 0, grydMarginGbp: 0, noAssetBillGbp: 0, dumbBillGbp: 0,
      subscriptionGbp: 0, flexRevenueGbp: 0, dispatchSavingGbp: 0, operatingCostGbp: 0,
      importCostGbp: 0, exportRevenueGbp: 0, standingGbp: 0, degradationGbp: 0,
      hardwareGbp: 0, throughputKwh: 0, valueGbp: 0,
    };
    const perDay = [];
    let rep = null;
    for (let i = 0; i < n; i++) {
      const d = days[i];
      const r = runHome(
        { import: d.import, export: d.export, ghi: d.ghi, dayOfYear: d.dayOfYear },
        {
          config: opts.config, economics: opts.economics, alpha: opts.alpha,
          dayOfYear: d.dayOfYear, useWeather: opts.useWeather,
          mpc: opts.mpc && i === repIdx ? opts.mpc : null,
        }
      );
      const m = r.optimised.metrics;
      t.homeSavingGbp += r.split.homeownerSavingGbp;
      t.grydMarginGbp += r.split.grydMarginGbp;
      t.noAssetBillGbp += r.noAssetBillGbp;
      t.dumbBillGbp += r.dumbBatteryBillGbp;
      t.subscriptionGbp += r.split.subscriptionGbp;
      t.flexRevenueGbp += m.flexRevenueGbp;
      t.dispatchSavingGbp += r.dispatchSavingGbp;
      t.operatingCostGbp += m.operatingCostGbp;
      t.importCostGbp += m.importCostGbp;
      t.exportRevenueGbp += m.exportRevenueGbp;
      t.standingGbp += r.economics.standingChargeGbp;
      t.degradationGbp += m.degradationGbp;
      t.hardwareGbp += r.hardwareAmortisationGbp;
      t.throughputKwh += m.throughputKwh;
      t.valueGbp += r.split.dailyValueGbp;
      perDay.push({ date: d.date, homeSaving: r.split.homeownerSavingGbp, grydMargin: r.split.grydMarginGbp, bill: r.noAssetBillGbp });
      if (i === repIdx) rep = r;
    }
    return { nDays: n, totals: t, perDay, rep };
  }

  // Run the fleet across a sampled set of days and scale to the full period.
  // fleetDays: [{ date, dayOfYear, regions: {C:{import,export},...}, ghi[48]? }]
  function runFleetPeriod(fleetDays, opts) {
    const k = opts.sampleDays || 24;
    const sample = sampleEven(fleetDays, k);
    const scale = fleetDays.length / sample.length;
    const repIdx = Math.floor((sample.length - 1) / 2);
    let gryd = 0, home = 0, flexRev = 0, peakSum = 0;
    let rep = null;
    for (let i = 0; i < sample.length; i++) {
      const d = sample[i];
      const pbr = {};
      for (const reg in d.regions) pbr[reg] = { import: d.regions[reg].import, export: d.regions[reg].export, ghi: d.ghi };
      const f = runFleet({
        nHomes: opts.nHomes, primaryRegion: opts.primaryRegion, pricesByRegion: pbr,
        economics: opts.economics, alpha: opts.alpha, dayOfYear: d.dayOfYear, useWeather: opts.useWeather,
      });
      gryd += f.metrics.grydMarginGbp;
      home += f.metrics.homeownerSavingGbp;
      flexRev += f.metrics.flexRevenueGbp;
      peakSum += f.metrics.peakFlexMw;
      if (i === repIdx) rep = f;
    }
    return {
      nDaysScaled: fleetDays.length, sampled: sample.length, rep,
      peakFlexMw: peakSum / sample.length, // typical evening peak across the period
      totals: { grydMarginGbp: gryd * scale, homeownerSavingGbp: home * scale, flexRevenueGbp: flexRev * scale },
    };
  }

  const SimCore = {
    DT_H,
    SLOTS,
    REGIONS,
    DEFAULT_REGION,
    DEFAULT_EXPORT_GBP_PER_KWH,
    DEFAULT_ECON,
    DEFAULT_HOME,
    clamp,
    mulberry32,
    daylightHours,
    sunGeom,
    poaShape,
    buildProfiles,
    batteryParams,
    dumbSelfConsumption,
    dispatchPriceRank,
    mpcDispatch,
    greedyPlan,
    flexHeadroom,
    rawMetrics,
    splitValue,
    runHome,
    generateFleet,
    runFleet,
    sampleEven,
    runPeriod,
    runFleetPeriod,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = SimCore;
  else global.SimCore = SimCore;
})(typeof self !== "undefined" ? self : this);
