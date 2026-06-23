/*
 * build_data.js — regenerate data/dataset.json, the bundled offline dataset.
 *
 * Pulls real half-hourly Octopus Agile import + Agile Outgoing export across a
 * year-plus for four DNO regions, plus real half-hourly solar irradiance (GHI)
 * for London from Open-Meteo. Indexed by local date so the app can render any
 * day, week, season or the whole year. Run with: node build_data.js
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

const IMPORT_PRODUCT = "AGILE-24-10-01";
const EXPORT_PRODUCT = "AGILE-OUTGOING-19-05-13";
const REGIONS = ["B", "C", "D", "E"]; // London (C) + the fleet's neighbours
const START = "2025-01-01";
const PRICE_END = "2026-06-22";
const WEATHER_END = "2026-06-10"; // ERA5 archive lags a few days
const LAT = 51.51, LON = -0.13; // London
const SLOTS = 48;

function get(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "gryd-sim/2.0" } }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      })
      .on("error", reject);
  });
}
async function getRetry(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try { return await get(url); }
    catch (e) { if (i === tries - 1) throw e; }
  }
}

function londonDate(iso) {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}

// Fetch every half-hourly rate for a product/region across the range, following
// the API's pagination, and group into 48-slot days keyed by local date.
async function fetchProductByDay(product, region) {
  const base =
    `https://api.octopus.energy/v1/products/${product}/electricity-tariffs/` +
    `E-1R-${product}-${region}/standard-unit-rates/`;
  let url = `${base}?period_from=${START}T00:00:00Z&period_to=${PRICE_END}T23:59:59Z&page_size=1500`;
  const rows = [];
  let pages = 0;
  while (url && pages < 60) {
    const j = await getRetry(url);
    for (const r of j.results || []) rows.push({ t: r.valid_from, v: r.value_inc_vat / 100 });
    url = j.next;
    pages++;
  }
  rows.sort((a, b) => (a.t < b.t ? -1 : 1));
  const byDay = {};
  for (const r of rows) {
    const d = londonDate(r.t);
    (byDay[d] = byDay[d] || []).push(+r.v.toFixed(4));
  }
  return byDay;
}

async function fetchWeatherByDay() {
  const url =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${LAT}&longitude=${LON}` +
    `&start_date=${START}&end_date=${WEATHER_END}&hourly=shortwave_radiation&timezone=Europe%2FLondon`;
  const j = await getRetry(url);
  const times = j.hourly.time, ghi = j.hourly.shortwave_radiation;
  const byDay = {};
  for (let i = 0; i < times.length; i++) {
    const d = times[i].slice(0, 10);
    const hour = parseInt(times[i].slice(11, 13), 10);
    const arr = (byDay[d] = byDay[d] || new Array(SLOTS).fill(0));
    const w = Math.max(0, Math.round(ghi[i] || 0));
    arr[hour * 2] = w;
    arr[hour * 2 + 1] = w; // step the hourly value across both half hours
  }
  return byDay;
}

(async function main() {
  console.log("fetching prices for", REGIONS.join(","), START, "to", PRICE_END, "...");
  const imp = {}, exp = {};
  for (const r of REGIONS) {
    imp[r] = await fetchProductByDay(IMPORT_PRODUCT, r);
    console.log("  import", r, Object.keys(imp[r]).length, "days");
    try {
      exp[r] = await fetchProductByDay(EXPORT_PRODUCT, r);
      console.log("  export", r, Object.keys(exp[r]).length, "days");
    } catch (e) { exp[r] = {}; console.warn("  export", r, "failed:", e.message); }
  }
  console.log("fetching weather ...");
  let weatherByDay = {};
  try { weatherByDay = await fetchWeatherByDay(); console.log("  weather", Object.keys(weatherByDay).length, "days"); }
  catch (e) { console.warn("  weather failed:", e.message); }

  // Keep only dates where region C has a full 48-slot day (skips DST days).
  const dates = Object.keys(imp.C).filter((d) => imp.C[d].length === SLOTS).sort();
  const regions = {};
  for (const r of REGIONS) {
    regions[r] = {};
    for (const d of dates) {
      const i = imp[r][d];
      if (!i || i.length !== SLOTS) continue;
      const e = exp[r] && exp[r][d] && exp[r][d].length === SLOTS ? exp[r][d] : new Array(SLOTS).fill(0.15);
      regions[r][d] = { i, e };
    }
  }
  const weather = {};
  for (const d of dates) if (weatherByDay[d] && weatherByDay[d].length === SLOTS) weather[d] = { ghi: weatherByDay[d] };

  const doy = (d) => {
    const dt = new Date(d + "T00:00:00Z");
    return Math.floor((dt - new Date(Date.UTC(dt.getUTCFullYear(), 0, 0))) / 86400000);
  };
  const out = {
    meta: {
      source: "Octopus Agile (public API), inc VAT, GBP/kWh; solar GHI from Open-Meteo ERA5",
      productImport: IMPORT_PRODUCT, productExport: EXPORT_PRODUCT,
      regions: REGIONS, start: dates[0], end: dates[dates.length - 1],
      note: "Real half-hourly data bundled so the demo runs with no network. Export falls back to a flat 15p/kWh on days a region lacks Agile Outgoing.",
    },
    dates,
    defaultDate: dates.includes("2025-06-21") ? "2025-06-21" : dates[dates.length - 1],
    seasons: {
      summer2025: ["2025-06-01", "2025-08-31"],
      winter2026: ["2026-01-01", "2026-02-28"],
      year2025: ["2025-01-01", "2025-12-31"],
    },
    regions,
    weather,
  };
  fs.writeFileSync(path.join(__dirname, "data", "dataset.json"), JSON.stringify(out));
  const kb = Math.round(fs.statSync(path.join(__dirname, "data", "dataset.json")).size / 1024);
  console.log(`\nwrote data/dataset.json: ${dates.length} dates (${out.meta.start}..${out.meta.end}), ${Object.keys(weather).length} weather days, ${kb}KB`);
})();
