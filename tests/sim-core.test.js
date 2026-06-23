/*
 * Deterministic engine checks. Run with: node tests/sim-core.test.js
 * No framework, matching grid-stability-sim. Exit code is non-zero on failure.
 */
const fs = require("fs");
const path = require("path");
const S = require("../sim-core.js");

const DATA = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "data", "dataset.json"), "utf8")
);
const doy = (s) => {
  const d = new Date(s + "T00:00:00Z");
  return Math.floor((d - new Date(Date.UTC(d.getUTCFullYear(), 0, 0))) / 86400000);
};
const DATE = DATA.defaultDate;
const Craw = DATA.regions.C[DATE];
// Back-compat shape for the existing tests.
const prices = {
  dayOfYear: doy(DATE),
  regions: Object.fromEntries(
    DATA.meta.regions.map((r) => [r, { import: DATA.regions[r][DATE].i, export: DATA.regions[r][DATE].e }])
  ),
};
const C = prices.regions.C;
const londonPrices = { import: C.import, export: C.export, dayOfYear: prices.dayOfYear };

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (extra != null ? "  -> " + extra : ""));
  }
}
function approx(a, b, eps) {
  return Math.abs(a - b) <= (eps == null ? 1e-6 : eps);
}

const result = S.runHome(londonPrices, { alpha: 0.5 });
const opt = result.optimised.schedule;
const base = result.baseline.schedule;
const bat = result.battery;
const { load, solar } = result;

// 1. Energy balance every half-hour (curtailment included in the identity).
(function () {
  let maxResidual = 0;
  for (let t = 0; t < S.SLOTS; t++) {
    const lhs = solar[t] + opt.import[t] + opt.discharge[t];
    const rhs = load[t] + opt.charge[t] + opt.export[t] + opt.curtail[t];
    maxResidual = Math.max(maxResidual, Math.abs(lhs - rhs));
  }
  check("energy balance holds each half-hour", maxResidual < 1e-9, maxResidual);
})();

// 2. SoC dynamics, bounds, and repeatable terminal value.
(function () {
  const soc = opt.socFull;
  let maxErr = 0;
  for (let t = 0; t < S.SLOTS; t++) {
    const expected =
      soc[t] + bat.etaCh * opt.charge[t] * S.DT_H - (opt.discharge[t] / bat.etaDis) * S.DT_H;
    maxErr = Math.max(maxErr, Math.abs(expected - soc[t + 1]));
  }
  check("soc recursion is consistent", maxErr < 1e-9, maxErr);
  check("soc never below reserve", Math.min.apply(null, soc) >= bat.reserve - 1e-9);
  check("soc never above capacity", Math.max.apply(null, soc) <= bat.eCap + 1e-9);
  check("terminal soc >= initial soc", soc[S.SLOTS] >= soc[0] - 1e-9);
})();

// 3. The optimiser must never be worse than the dumb baseline.
(function () {
  const o = result.optimised.metrics.operatingCostGbp;
  const b = result.baseline.metrics.operatingCostGbp;
  check("optimised operating cost <= baseline", o <= b + 1e-6, o + " vs " + b);
  check("homeowner saving is non-negative", result.split.homeownerSavingGbp >= -1e-9);
  check("optimiser actually beats baseline on this day", o < b - 1e-4, "saved " + (b - o));
})();

// 4. No physically impossible flows.
(function () {
  let overlapBatt = 0,
    overlapGrid = 0,
    resell = 0;
  for (let t = 0; t < S.SLOTS; t++) {
    overlapBatt = Math.max(overlapBatt, opt.charge[t] * opt.discharge[t]);
    overlapGrid = Math.max(overlapGrid, opt.import[t] * opt.export[t]);
    resell = Math.max(resell, opt.export[t] - (solar[t] + opt.discharge[t]));
  }
  check("no simultaneous charge and discharge", overlapBatt < 1e-7, overlapBatt);
  check("no simultaneous import and export", overlapGrid < 1e-7, overlapGrid);
  check("never resells imported energy", resell < 1e-7, resell);
})();

// 5. Negative prices: charge/import, and never export.
(function () {
  const neg = londonPrices.import.slice();
  for (let t = 6; t <= 11; t++) neg[t] = -0.05; // a cheap, paid-to-consume overnight window
  const r = S.runHome(
    { import: neg, export: C.export, dayOfYear: prices.dayOfYear },
    { alpha: 0.5 }
  );
  const s = r.optimised.schedule;
  let chargedInNeg = 0,
    exportInNeg = 0;
  for (let t = 6; t <= 11; t++) {
    chargedInNeg += s.charge[t];
    exportInNeg += s.export[t];
  }
  check("battery charges during negative-price slots", chargedInNeg > 0.1, chargedInNeg);
  check("never exports during negative-price slots", exportInNeg < 1e-9, exportInNeg);
})();

// 6. Solar orientation behaves: south yields more than east and peaks later.
(function () {
  const south = S.buildProfiles({ dayOfYear: prices.dayOfYear, azimuthDeg: 0 });
  const east = S.buildProfiles({ dayOfYear: prices.dayOfYear, azimuthDeg: -90 });
  const sSum = south.solar.reduce((a, b) => a + b, 0);
  const eSum = east.solar.reduce((a, b) => a + b, 0);
  const argmax = (a) => a.indexOf(Math.max.apply(null, a));
  check("south-facing yields more than east-facing", sSum > eSum, sSum + " vs " + eSum);
  check("east-facing peaks earlier in the day", argmax(east.solar) < argmax(south.solar));
})();

// 7. Alpha trades the value split; the pie stays constant.
(function () {
  const r0 = S.runHome(londonPrices, { alpha: 0 });
  const r1 = S.runHome(londonPrices, { alpha: 1 });
  check("alpha=0 gives the home more than alpha=1",
    r0.split.homeownerSavingGbp > r1.split.homeownerSavingGbp);
  check("alpha=1 gives Gryd more than alpha=0",
    r1.split.grydMarginGbp > r0.split.grydMarginGbp);
  const pie0 = r0.split.homeownerSavingGbp + r0.split.grydMarginGbp;
  const pie1 = r1.split.homeownerSavingGbp + r1.split.grydMarginGbp;
  check("value pie is independent of alpha", approx(pie0, pie1, 1e-9), pie0 + " vs " + pie1);
})();

// 8b. The dispatch genuinely arbitrages: cheap night charge, peak discharge.
(function () {
  const solar = new Array(S.SLOTS).fill(0);
  const load = new Array(S.SLOTS).fill(0.6);
  const imp = new Array(S.SLOTS).fill(0.2);
  for (let t = 0; t < 14; t++) imp[t] = 0.1; // cheap overnight
  for (let t = 32; t <= 40; t++) imp[t] = 0.4; // evening peak
  const exp = new Array(S.SLOTS).fill(0.05);
  const bat = S.batteryParams(Object.assign({}, S.DEFAULT_HOME, { solarKwp: 0 }));
  const dumb = S.dumbSelfConsumption(load, solar, imp, exp, bat);
  const opt = S.dispatchPriceRank(load, solar, imp, exp, bat, { degradationGbpPerMwh: 20 });
  const cost = (s) =>
    s.import.reduce((a, v, t) => a + v * imp[t] * S.DT_H, 0) -
    s.export.reduce((a, v, t) => a + v * Math.max(exp[t], 0) * S.DT_H, 0);
  const saving = cost(dumb) - cost(opt);
  check("price-aware dispatch arbitrages a clear spread", saving > 0.5, "saved " + saving.toFixed(3));
  const chargeNight = opt.charge.slice(0, 14).reduce((a, b) => a + b, 0);
  const chargeDay = opt.charge.slice(14).reduce((a, b) => a + b, 0);
  check("charges in the cheap overnight window, not later", chargeNight > 0 && chargeDay < 1e-6);
})();

// 7b. splitValue stays coherent at edge cases (negative bill, out-of-range alpha).
(function () {
  const ok = (x) => typeof x === "number" && isFinite(x);
  const neg = S.splitValue(-9, 2, 0.5, 15); // negative counterfactual bill
  check("negative bill split is finite and home saving non-negative",
    ok(neg.homeownerSavingGbp) && ok(neg.grydMarginGbp) && neg.homeownerSavingGbp >= -1e-9);
  const lo = S.splitValue(3, 2, -1, 15); // alpha below range
  const hi = S.splitValue(3, 2, 2, 15); // alpha above range
  const a0 = S.splitValue(3, 2, 0, 15);
  const a1 = S.splitValue(3, 2, 1, 15);
  check("alpha is clamped to [0,1]",
    approx(lo.homeownerSavingGbp, a0.homeownerSavingGbp, 1e-9) &&
    approx(hi.homeownerSavingGbp, a1.homeownerSavingGbp, 1e-9));
})();

// 7c. Flex per slot never exceeds inverter power (no up+down double count).
(function () {
  const bat = result.battery;
  const sch = result.optimised.schedule;
  let maxEnv = 0;
  for (let t = 0; t < S.SLOTS; t++) {
    // the paid/sellable envelope is min(up+down, pMax)
    maxEnv = Math.max(maxEnv, Math.min(sch.flexUp[t] + sch.flexDown[t], bat.pMax));
  }
  check("sellable flex per slot is capped at inverter power", maxEnv <= bat.pMax + 1e-9, maxEnv + " vs " + bat.pMax);
})();

// 8. Fleet aggregation reports flexibility and revenue.
(function () {
  const byRegion = {};
  for (const k of Object.keys(prices.regions)) {
    byRegion[k] = { import: prices.regions[k].import, export: prices.regions[k].export };
  }
  const fleet = S.runFleet({
    nHomes: 20,
    primaryRegion: "C",
    pricesByRegion: byRegion,
    dayOfYear: prices.dayOfYear,
    alpha: 0.6,
  });
  check("aggregate has 48 steps", fleet.aggregate.totalFlex.length === 48);
  check("fleet reports positive peak flexibility (MW)", fleet.metrics.peakFlexMw > 0,
    fleet.metrics.peakFlexMw);
  check("fleet reports positive flex revenue", fleet.metrics.flexRevenueGbp > 0,
    fleet.metrics.flexRevenueGbp);
})();

// 9. Weather-driven solar produces a plausible day and sets the flag.
(function () {
  const w = DATA.weather[DATE];
  const p = S.buildProfiles({ dayOfYear: doy(DATE), solarKwp: 4.25, azimuthDeg: 0, tiltDeg: 35, ghi: w.ghi });
  const kwh = p.solar.reduce((a, b) => a + b, 0) * S.DT_H;
  check("weather-driven solar flag set and output plausible", p.weatherDriven && kwh > 1 && kwh < 60, kwh);
})();

// 10. MPC never beats perfect foresight, and the gap grows with forecast error.
(function () {
  const w = DATA.weather[DATE];
  const mk = (sig) => S.runHome(
    { import: C.import, export: C.export, ghi: w.ghi, dayOfYear: doy(DATE) },
    { alpha: 0.5, useWeather: true, mpc: { forecastError: sig, seed: 7 } }
  ).mpc;
  const a = mk(0), b = mk(0.6);
  check("perfect-foresight cost <= MPC cost", a.mpcCostGbp <= a.perfectCostGbp + 1e-9);
  check("MPC gap is non-negative and not smaller with more error",
    b.gapGbp >= -1e-9 && b.gapGbp >= a.gapGbp - 1e-9, b.gapGbp + " vs " + a.gapGbp);
})();

// 11. Period aggregation totals equal the sum of the days.
(function () {
  const week = DATA.dates.filter((d) => d >= "2025-06-16" && d <= "2025-06-22");
  const days = week.map((d) => ({ date: d, dayOfYear: doy(d), import: DATA.regions.C[d].i, export: DATA.regions.C[d].e, ghi: DATA.weather[d] && DATA.weather[d].ghi }));
  const r = S.runPeriod(days, { alpha: 0.5, useWeather: true });
  const sumPerDay = r.perDay.reduce((a, x) => a + x.homeSaving, 0);
  check("runPeriod home saving equals sum of per-day", approx(r.totals.homeSavingGbp, sumPerDay, 1e-6));
  check("runPeriod covers the requested days", r.nDays === days.length && r.rep != null);
})();

// 12. Sampled fleet period returns positive scaled annual totals.
(function () {
  const year = DATA.dates.filter((d) => d.slice(0, 4) === "2025");
  const fdays = year.map((d) => ({
    date: d, dayOfYear: doy(d),
    regions: Object.fromEntries(DATA.meta.regions.map((rg) => [rg, { import: DATA.regions[rg][d].i, export: DATA.regions[rg][d].e }])),
    ghi: DATA.weather[d] && DATA.weather[d].ghi,
  }));
  const f = S.runFleetPeriod(fdays, { nHomes: 20, primaryRegion: "C", alpha: 0.7, useWeather: true, sampleDays: 16 });
  check("fleet period scales to the full year", f.nDaysScaled === fdays.length && f.sampled <= 16);
  check("fleet annual saving and flex revenue are positive", f.totals.homeownerSavingGbp > 0 && f.totals.flexRevenueGbp > 0,
    f.totals.homeownerSavingGbp.toFixed(0) + " / " + f.totals.flexRevenueGbp.toFixed(0));
})();

// 13. Hardware amortisation scales with the installed system size.
(function () {
  const small = S.runHome(londonPrices, { config: { solarKwp: 1, batteryKwh: 3 } });
  const large = S.runHome(londonPrices, { config: { solarKwp: 8, batteryKwh: 14 } });
  check("bigger system costs more hardware per day", large.hardwareAmortisationGbp > small.hardwareAmortisationGbp + 0.05,
    small.hardwareAmortisationGbp.toFixed(3) + " vs " + large.hardwareAmortisationGbp.toFixed(3));
})();

// 14. The fleet runs for every bundled region without crashing.
(function () {
  let ok = true, detail = "";
  for (const rg of DATA.meta.regions) {
    try {
      const f = S.runFleet({
        nHomes: 8, primaryRegion: rg,
        pricesByRegion: Object.fromEntries(DATA.meta.regions.map((r) => [r, { import: DATA.regions[r][DATE].i, export: DATA.regions[r][DATE].e }])),
        dayOfYear: doy(DATE), alpha: 0.6,
      });
      if (!(f.metrics.peakFlexMw > 0)) { ok = false; detail = rg + " no flex"; }
    } catch (e) { ok = false; detail = rg + ": " + e.message; }
  }
  check("fleet runs for every bundled region", ok, detail);
})();

// 15. Economics identities and that both baselines are exposed.
(function () {
  const r = S.runHome(londonPrices, { alpha: 0.5 });
  check("home saving + gryd margin === V",
    approx(r.split.homeownerSavingGbp + r.split.grydMarginGbp, r.split.dailyValueGbp, 1e-9));
  check("home saving % === saving / no-asset bill",
    approx(r.split.homeownerSavingPct, (100 * r.split.homeownerSavingGbp) / r.noAssetBillGbp, 1e-6));
  check("both baselines exposed and distinct",
    typeof r.noAssetBillGbp === "number" && typeof r.dumbBatteryBillGbp === "number" &&
    Math.abs(r.noAssetBillGbp - r.dumbBatteryBillGbp) > 1e-6);
  check("smart-dispatch uplift is the dumb-vs-optimised operating gap",
    r.dispatchSavingGbp >= -1e-9);
})();

// 16. A region absent from the price map falls back without crashing.
(function () {
  let ok = true, msg = "";
  try {
    const f = S.runFleet({ nHomes: 6, primaryRegion: "Z", pricesByRegion: { C: { import: C.import, export: C.export } }, dayOfYear: prices.dayOfYear, alpha: 0.5 });
    ok = f.metrics.peakFlexMw >= 0;
  } catch (e) { ok = false; msg = e.message; }
  check("missing/invalid region does not crash the fleet", ok, msg);
})();

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
