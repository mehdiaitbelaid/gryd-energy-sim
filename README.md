# Gryd Sim

An interactive, browser-based simulation of a fully funded home solar and battery
under Gryd's subscription model, plus a fleet view of the flexibility those homes
can sell to the grid. It runs as a static page with no backend and no build step.
Open `index.html` over a local server and it works.

A deterministic engine (`sim-core.js`) does the physics and the money; the page
(`app.js`, `charts.js`, `visuals.js`) draws it and reacts to the controls live.

## What it shows

1. **One funded home.** The homeowner's saving against the bill they would
   otherwise pay, side by side with Gryd's margin under the subscription model. A
   half-hourly chart shows price, solar, load, battery state of charge, grid
   import and export against real Octopus Agile prices and real weather.
2. **Periods.** A day, a week, summer, winter, or the whole year, with the saving
   over that period and an annual figure.
3. **The fleet.** A reproducible population of homes aggregated into a single
   dispatchable flexibility figure (MW) with an estimated flexibility income.
4. **Solar forecast.** An optional panel showing the solar forecast band widening
   through the day, with the honest finding that forecast error costs almost
   nothing for dispatch (see below).
5. **Full breakdown.** A CFO-style table with every line behind the headline:
   the three baselines (no-asset bill, dumb solar+battery bill, smart-dispatch
   uplift), Gryd's P&L line by line summing to the margin, battery throughput,
   equivalent full cycles, the representative day's start and end state of charge,
   and the value pool V. The day chart also shows any curtailed solar.

## Run it

```bash
# serve it (a server is required; file:// blocks the data fetch in Chrome)
python3 -m http.server 8137
# then visit http://localhost:8137
```

Run the engine tests with plain Node, no framework:

```bash
node tests/sim-core.test.js
```

Regenerate the bundled dataset (fetches a year of Agile prices and weather):

```bash
node build_data.js
```

## Deploy to Netlify

It is a static site. Drag the `gryd-sim` folder onto
[app.netlify.com/drop](https://app.netlify.com/drop), or connect the repo with an
empty build command and the project root as the publish directory. The bundled
dataset means the deployed site works even with no network. `netlify.toml` is
included.

## The model

One day is 48 half-hour steps, `dt = 0.5 h`. Every step balances exactly:

```
solar + grid_import + battery_discharge = load + battery_charge + grid_export + curtailment
```

State of charge tracks charge and discharge at a round-trip efficiency of about
88%. Export is only ever solar or battery energy and is curtailed, never sold,
when it would not be paid (negative import price, or a non-positive export price).

### Battery dispatch: price-rank, not a solver

Octopus Agile prices are published a day ahead, so the battery can plan. The
dispatch is an explainable price-rank heuristic, not a linear program: solar
serves load first, then trades that strictly lower cost and stay inside every
limit charge in the cheapest slots and discharge into the dearest. Because every
trade only lowers cost, the result is never worse than a dumb battery. When the
import price is negative the home is paid to consume, so it charges and never
exports.

### Solar from real weather

With "real weather" on (the default), solar comes from real half-hourly global
horizontal irradiance (Open-Meteo, London) transposed onto the tilted, oriented
panel and scaled by kWp and a performance ratio. Panel facing and tilt change the
shape and the yield: south peaks at noon and yields most, east peaks in the
morning. With weather off, a deterministic clear-sky model is used instead.

### Periods and the annual figure

The engine runs each real day in the chosen period and totals the value. The home
annual sums every available day of 2025 (DST transition days, which have 46 or 50
half-hours, are excluded, so it is 363 days). The fleet annual is scaled from a
set of representative real days and labelled as an estimate, because running the
whole fleet over a year live would be too slow.

### The solar forecast panel (honest finding)

A rolling controller can only forecast solar and demand, not see them. The panel
shows that forecast as a band that widens through the day. The notable result:
the dispatch cost of getting the forecast wrong is about £0, because Agile prices
(the main signal) are known a day ahead and a small home battery mostly just
self-consumes its own solar. Forecast accuracy matters far more when committing a
fleet's flexibility to the grid than for a single home's dispatch.

## Economics (every assumption stated)

All figures are per the chosen period.

The homeowner's counterfactual is the bill they pay today for all their
electricity with no solar and no battery of their own:

```
no_asset_bill = sum(load * import_price * dt) + standing_charge
```

This is the right baseline for a funded model, because Gryd installs the assets at
zero cost and the homeowner pays a subscription instead of that bill.

Gryd's running cost is the net energy it pays plus a small wear provision:

```
operating_cost = import_cost - export_revenue + standing_charge + wear
```

Flexibility income is an availability estimate over the evening peak window
(16:00 to 20:00), capped at inverter power (turn-up and turn-down cannot be
delivered at once), at an assumed £60/MW/h of availability.

The daily value the system creates is:

```
V = no_asset_bill - operating_cost + flex_income - hardware_per_day
```

The alpha control splits `V` between the home and Gryd. Subscription % sets the
home's guaranteed floor saving; alpha distributes the rest. At alpha = 0 the home
keeps all of `V` (up to a free bill, so the subscription never goes negative); at
alpha = 1 the home keeps only its floor and Gryd keeps the rest. They always sum
to `V`.

### Defaults follow Gryd's real spec

- **Battery 5.4 kWh, solar ~4 kWp.** Gryd's St Ives case homes use 10 panels and
  a 5.4 kWh battery. ([case study](https://gryd.energy/funded-solar-and-battery-for-three-new-build-homes-in-st-ives-cornwall-a-year-with-a-gryd-solar-subscription/))
- **Hardware capex scales with the system** (base install + £700/kWp + £350/kWh,
  about £6,500 for the default), amortised over a **25-year life + 2.5%/yr
  upkeep** (covering a mid-life battery replacement), matching Gryd's 25-year
  guarantee. ([gryd.energy](https://gryd.energy/))
- At the home's 15% saving floor the model gives about £150/year saved, close to
  the £158.87 (14.1%) Gryd reported over a real monitored year at St Ives.
- Standing charge £0.60/day. Round-trip efficiency 88%.

These are demo assumptions for illustration, not Gryd disclosures.

## Data

- **Prices.** Octopus Agile import (`AGILE-24-10-01`) and Agile Outgoing export
  (`AGILE-OUTGOING-19-05-13`), half-hourly, inc VAT, from the public API, for DNO
  regions B, C, D and E across 2025 into 2026. Where a region lacks Agile Outgoing
  on a day, export falls back to a flat 15p/kWh.
- **Weather.** Hourly solar irradiance (GHI) for London from Open-Meteo's ERA5
  archive over the same range, applied across each half hour.
- Everything is bundled in `data/dataset.json` so the demo runs with no network.
  The data source and date range are shown in the controls.

## Files

```
index.html          structure
styles.css          brand theme (maroon / orange / green / cream, grain, Outfit)
sim-core.js         pure engine: solar, load, dispatch, accounting, MPC, periods, fleet
charts.js           dependency-free SVG charts (day + fleet flexibility)
visuals.js          period saving chart + solar forecast band
app.js              controls, periods, live data, GSAP motion
data/dataset.json   bundled real Octopus + weather (offline)
build_data.js       regenerates data/dataset.json
tests/sim-core.test.js   energy balance, SoC, baseline, negatives, weather, MPC, periods, fleet
vendor/gsap.min.js  vendored for offline animation
assets/             Outfit font + hero photo
```

## How this maps to Gryd's business

The funded asset moves the optimisation boundary. The home sees a fixed discount
on the bill it would otherwise pay and carries no upfront cost. Gryd owns the
tariff exposure, the battery wear and the hardware, and keeps the export and
flexibility value. One home is a few kilowatts, but the same constrained batteries
aggregated across many homes become a measurable up and down envelope Gryd can
contract as a virtual power plant, with every assumption left inspectable.
