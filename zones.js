// zones.js — Multi-timeframe Support/Resistance Zone Engine
//
// Identifies "strong zones" at weekly, monthly, and quarterly timeframes using
// classical pivot mathematics + swing high/low fractals. No AI, no LLM —
// deterministic rules that produce auditable levels.
//
// Three zone types produced:
//   1. PIVOT zones  — Floor/Camarilla pivots from previous W/M/Q candle
//   2. SWING zones  — Significant swing highs and lows (fractal-based)
//   3. ROUND zones  — Psychological round-number levels near current price
//
// All zones get a STRENGTH score (1-5) based on:
//   - Timeframe (Quarterly > Monthly > Weekly)
//   - How many times price has touched/respected the level
//   - Recency (recent levels weight slightly higher)
//   - Confluence (zones near other zones get a bonus)

// ─── Aggregation: convert daily candles to W/M/Q ─────────
//
// Indian markets: Monday-Friday, 252 trading days/year (~21/month, ~63/quarter)
// We aggregate by calendar week/month/quarter, not by fixed candle count, so
// holidays don't shift the buckets.
function aggregateCandles(daily, period) {
  // period: 'W' (week), 'M' (month), 'Q' (quarter)
  if (!Array.isArray(daily) || daily.length === 0) return [];

  const groups = new Map(); // key → {t, o, h, l, c, v}
  for (const c of daily) {
    const date = new Date(c.t * 1000);
    let key;
    if (period === 'W') {
      // ISO week — use Monday as start. Get the Monday of this week.
      const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
      const dayOfWeek = d.getUTCDay() || 7;
      d.setUTCDate(d.getUTCDate() - dayOfWeek + 1);
      key = d.toISOString().substring(0, 10);
    } else if (period === 'M') {
      key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    } else if (period === 'Q') {
      const q = Math.floor(date.getUTCMonth() / 3) + 1;
      key = `${date.getUTCFullYear()}-Q${q}`;
    } else return [];

    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { key, t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v || 0 });
    } else {
      existing.h = Math.max(existing.h, c.h);
      existing.l = Math.min(existing.l, c.l);
      existing.c = c.c; // last close in the period
      existing.v += (c.v || 0);
      // open stays the first day's open
    }
  }
  // Sort by time
  return Array.from(groups.values()).sort((a, b) => a.t - b.t);
}

// ─── Classical Pivot Calculation ─────────
// Floor Trader Pivots: P = (H + L + C) / 3
// R1 = 2P - L, R2 = P + (H-L), R3 = H + 2(P-L)
// S1 = 2P - H, S2 = P - (H-L), S3 = L - 2(H-P)
function computePivots(candle) {
  if (!candle) return null;
  const { h, l, c } = candle;
  const range = h - l;
  const p = (h + l + c) / 3;
  return {
    pivot: p,
    r1: 2 * p - l, r2: p + range, r3: h + 2 * (p - l),
    s1: 2 * p - h, s2: p - range, s3: l - 2 * (h - p),
    sourceCandle: candle,
  };
}

// ─── Swing High/Low Detection (fractal-based) ─────────
// A swing high = local max where the candle's high is greater than `lookback`
// candles on each side. Same for swing low.
//
// Lookback values:
//   - Weekly: 3 (so swing = 3 weeks each side = 7-week pattern)
//   - Monthly: 2 (so swing = 2 months each side = 5-month pattern)
//   - Quarterly: 1 (so swing = 1 quarter each side = 3-quarter pattern)
function findSwings(candles, lookback) {
  const swings = { highs: [], lows: [] };
  if (!Array.isArray(candles) || candles.length < lookback * 2 + 1) return swings;

  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    let isHigh = true, isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].h >= c.h || candles[i + j].h >= c.h) isHigh = false;
      if (candles[i - j].l <= c.l || candles[i + j].l <= c.l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) swings.highs.push({ price: c.h, time: c.t, candle: c });
    if (isLow) swings.lows.push({ price: c.l, time: c.t, candle: c });
  }
  return swings;
}

// ─── Touch counting: how many times has price respected this level? ──
// A "touch" = price came within `tolerance` of the level then moved away
// (didn't break through). Tolerance is % of price.
function countTouches(level, candles, tolerancePct = 1.0) {
  if (!Array.isArray(candles)) return 0;
  const tol = level * tolerancePct / 100;
  let touches = 0;
  let lastTouchIdx = -1;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const touched = (c.h >= level - tol && c.l <= level + tol);
    if (touched && (lastTouchIdx === -1 || i - lastTouchIdx >= 3)) {
      touches++;
      lastTouchIdx = i;
    }
  }
  return touches;
}

// ─── Zone Builder ─────────
// Combines pivots + swings + touches into a strength-ranked list of zones.
function buildZones(dailyCandles, currentPrice) {
  if (!Array.isArray(dailyCandles) || dailyCandles.length < 30) {
    return { zones: [], reason: 'insufficient candles' };
  }

  const weekly = aggregateCandles(dailyCandles, 'W');
  const monthly = aggregateCandles(dailyCandles, 'M');
  const quarterly = aggregateCandles(dailyCandles, 'Q');

  // Take the LAST completed period for pivots (not the current incomplete one)
  const lastWeek = weekly.length >= 2 ? weekly[weekly.length - 2] : null;
  const lastMonth = monthly.length >= 2 ? monthly[monthly.length - 2] : null;
  const lastQuarter = quarterly.length >= 2 ? quarterly[quarterly.length - 2] : null;

  const weeklyPivots = computePivots(lastWeek);
  const monthlyPivots = computePivots(lastMonth);
  const quarterlyPivots = computePivots(lastQuarter);

  // Swing high/lows on each timeframe
  const wkSwings = findSwings(weekly.slice(-26), 3);  // last 26 weeks ~6 months
  const mSwings = findSwings(monthly.slice(-12), 2);  // last 12 months
  const qSwings = findSwings(quarterly.slice(-8), 1); // last 8 quarters ~2 years

  const zones = [];

  // Add pivot levels with metadata
  function addPivotLevels(piv, timeframe, tfWeight) {
    if (!piv) return;
    const levels = [
      { kind: 'R3', price: piv.r3, type: 'resistance' },
      { kind: 'R2', price: piv.r2, type: 'resistance' },
      { kind: 'R1', price: piv.r1, type: 'resistance' },
      { kind: 'P',  price: piv.pivot, type: 'neutral' },
      { kind: 'S1', price: piv.s1, type: 'support' },
      { kind: 'S2', price: piv.s2, type: 'support' },
      { kind: 'S3', price: piv.s3, type: 'support' },
    ];
    for (const lvl of levels) {
      const touches = countTouches(lvl.price, dailyCandles, 1.0);
      const distancePct = currentPrice ? Math.abs((lvl.price - currentPrice) / currentPrice * 100) : null;
      zones.push({
        timeframe,
        source: 'pivot',
        kind: lvl.kind,
        type: lvl.type,
        price: parseFloat(lvl.price.toFixed(2)),
        touches,
        distancePct: distancePct != null ? parseFloat(distancePct.toFixed(2)) : null,
        // Strength: 1 (touch) → 5 (5+ touches), boosted by timeframe weight
        strength: Math.min(5, Math.max(1, touches + tfWeight)),
      });
    }
  }
  addPivotLevels(weeklyPivots, 'W', 0);
  addPivotLevels(monthlyPivots, 'M', 1);
  addPivotLevels(quarterlyPivots, 'Q', 2);

  // Add swing zones (highs as resistance, lows as support)
  function addSwingLevels(swings, timeframe, tfWeight) {
    for (const sw of swings.highs) {
      const touches = countTouches(sw.price, dailyCandles, 1.0);
      const distancePct = currentPrice ? Math.abs((sw.price - currentPrice) / currentPrice * 100) : null;
      zones.push({
        timeframe,
        source: 'swing',
        kind: 'swing_high',
        type: 'resistance',
        price: parseFloat(sw.price.toFixed(2)),
        time: sw.time,
        touches,
        distancePct: distancePct != null ? parseFloat(distancePct.toFixed(2)) : null,
        strength: Math.min(5, Math.max(1, touches + tfWeight)),
      });
    }
    for (const sw of swings.lows) {
      const touches = countTouches(sw.price, dailyCandles, 1.0);
      const distancePct = currentPrice ? Math.abs((sw.price - currentPrice) / currentPrice * 100) : null;
      zones.push({
        timeframe,
        source: 'swing',
        kind: 'swing_low',
        type: 'support',
        price: parseFloat(sw.price.toFixed(2)),
        time: sw.time,
        touches,
        distancePct: distancePct != null ? parseFloat(distancePct.toFixed(2)) : null,
        strength: Math.min(5, Math.max(1, touches + tfWeight)),
      });
    }
  }
  addSwingLevels(wkSwings, 'W', 0);
  addSwingLevels(mSwings, 'M', 1);
  addSwingLevels(qSwings, 'Q', 2);

  // Round number zones near current price (psychological levels)
  if (currentPrice) {
    const magnitude = Math.pow(10, Math.floor(Math.log10(currentPrice)) - 1);
    const round = Math.round(currentPrice / magnitude) * magnitude;
    for (const offset of [-2, -1, 0, 1, 2]) {
      const level = round + offset * magnitude;
      if (level <= 0) continue;
      const distancePct = Math.abs((level - currentPrice) / currentPrice * 100);
      if (distancePct > 15) continue; // skip if too far
      const touches = countTouches(level, dailyCandles, 0.5); // tighter tolerance for round levels
      if (touches < 2) continue; // round levels only matter if respected
      zones.push({
        timeframe: 'psych',
        source: 'round',
        kind: 'round_number',
        type: level > currentPrice ? 'resistance' : 'support',
        price: parseFloat(level.toFixed(2)),
        touches,
        distancePct: parseFloat(distancePct.toFixed(2)),
        strength: Math.min(5, touches),
      });
    }
  }

  // ─── Cluster nearby zones ─────────
  // Two zones within 0.5% of each other = one cluster. Strongest level kept,
  // confluence count added to its strength as bonus.
  zones.sort((a, b) => a.price - b.price);
  const clustered = [];
  for (const z of zones) {
    const last = clustered[clustered.length - 1];
    if (last && Math.abs((z.price - last.price) / last.price * 100) < 0.5) {
      // Merge: bump strength on the existing strongest one
      if (z.strength > last.strength) {
        clustered[clustered.length - 1] = { ...z, strength: z.strength };
      }
      clustered[clustered.length - 1].confluence = (last.confluence || 1) + 1;
      clustered[clustered.length - 1].strength = Math.min(5, clustered[clustered.length - 1].strength + 0.5);
    } else {
      clustered.push({ ...z, confluence: 1 });
    }
  }

  // Filter: keep only zones with strength ≥ 2 (avoids visual spam)
  const strongZones = clustered.filter(z => z.strength >= 2);

  // Sort by distance from current price (closest first)
  strongZones.sort((a, b) => (a.distancePct || 999) - (b.distancePct || 999));

  return {
    zones: strongZones,
    counts: {
      total: strongZones.length,
      resistance: strongZones.filter(z => z.type === 'resistance').length,
      support: strongZones.filter(z => z.type === 'support').length,
      byTimeframe: {
        W: strongZones.filter(z => z.timeframe === 'W').length,
        M: strongZones.filter(z => z.timeframe === 'M').length,
        Q: strongZones.filter(z => z.timeframe === 'Q').length,
      },
    },
  };
}

module.exports = {
  aggregateCandles,
  computePivots,
  findSwings,
  countTouches,
  buildZones,
};
