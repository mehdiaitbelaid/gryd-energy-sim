# Gryd Sim talking points

Eight things to speak from. Each is backed by something on screen.

1. **It's a real engine, not a mock-up.** Every half hour balances exactly:
   solar plus import plus discharge equals load plus charge plus export plus any
   curtailment. State of charge tracks a real ~88% round-trip efficiency, export
   is capped and never resold, and `node tests/sim-core.test.js` runs 33 checks,
   including that the optimiser is never worse than a dumb battery.

2. **It uses Gryd's real numbers.** Defaults are a 5.4 kWh battery and ~4 kWp,
   the spec from Gryd's St Ives homes. Hardware is amortised over Gryd's 25-year
   guarantee. At the home's 15% saving floor the model gives about £150/year,
   close to the £158.87 (14.1%) Gryd reported over a real monitored year there.

3. **Real prices and real weather.** Octopus Agile half-hourly prices and
   Open-Meteo solar irradiance, both real, both bundled so it runs offline. Panel
   facing and tilt change the solar shape and yield through the proper geometry:
   south peaks at noon, east peaks in the morning.

4. **The counterfactual is the funded-model pitch.** "What this home saves" is
   measured against the bill they pay today with no solar and no battery, because
   that is the bill Gryd replaces with a subscription. That is why the saving is a
   number a homeowner would recognise.

5. **Alpha is the commercial dial.** One price-rank dispatch (a heuristic, not a solver) fixes the size of
   the daily value; alpha only decides the split between the home (green) and Gryd
   (orange). They always sum to the same total. With Gryd's real small kit the
   margin is realistic but modest, which is honest: the funded model works on a
   long-life asset and scale, not on big daily arbitrage.

6. **Day, week, season, year.** The same engine totals real days into a weekly,
   seasonal or annual figure. The home annual is exact; the fleet annual is scaled
   from representative days and labelled an estimate. This gives a yearly saving to
   quote, not just a single day.

7. **Forecasting: the honest finding.** Turn on the solar forecast and you see the
   uncertainty band widen through the day, but the dispatch cost of getting it
   wrong is about £0. The reason is that Agile prices are published a day ahead, so
   the battery's main signal is certain and a small home battery mostly just
   self-consumes. Forecast accuracy matters far more for committing the fleet's
   flexibility to the grid than for a single home.

8. **One home is small; the fleet is the product.** A single home offers a few
   kilowatts; twenty homes already aggregate into a dispatchable block at the
   evening peak with an estimated flexibility income. That is the virtual power
   plant, and it is where the negative-price and flexibility value really lands.

9. **Nothing to hide: the full breakdown.** The "Full breakdown" card shows every
   line at once: the no-asset bill, the dumb solar+battery bill, the smart-dispatch
   uplift (so solar value is never attributed to the optimiser), Gryd's P&L summing
   to the margin, battery throughput and equivalent cycles, and the battery
   starting and ending the day at the same charge (so the daily numbers are
   repeatable). Curtailed solar is on the chart too.

## Quick demo path

- Start on London, a day in June (the default). Point at the green and orange cards.
- Slide alpha 0 to 1 to show the home-vs-Gryd split move.
- Switch the period to the whole year to show the annual saving.
- Swing panel facing from South to East and watch the solar curve and the saving.
- Toggle "real weather" off and on to show it is driven by actual sun.
- Turn on the solar forecast to make the honest forecasting point.
- Scroll to the fleet, push homes up, and read the megawatts and the flex income.
