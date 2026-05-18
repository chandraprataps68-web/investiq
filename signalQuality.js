// signalQuality.js — Phase 15A
//
// Implements three signal-quality enhancements from the post-TATASTEEL
// analysis prompt:
//
//   Module 1: Resistance Cluster Proximity
//   Module 2: Volume Character (close-position-within-range analysis)
//   Module 5: Invalidation Level (mandatory exit price for every signal)
//
// All three are pure functions on candle/zone data — no persistence required.
// They produce penalty/bonus deltas that the confluence engine folds in.
//
// Design principle: never silently reject a signal. Always return the verdict
// + WHY, so the user sees the reasoning. Trust requires auditability.

// ─── Module 1: Resistance Cluster Proximity ─────────
//
// Count resistance levels within 3% above current price. The more stacked,
// the harder the breakout — even good setups fail when there's a shelf above.
//
// Inputs:
//   zones: array from Zones.buildZones() — already filtered + clustered
//   currentPrice: spot price
//
// Returns:
//   {
//     levelsAbove: [217.58, 216.45, ...],  // resistance prices within 3% above
//     count: number,
//     penalty: number (0 to -15),  // negative = penalty
//     label: string,                // human-readable
//     bonus: number,                 // positive if path is clear (0 to +5)
//   }
//
function analyzeResistanceCluster({ zones, currentPrice }) {
  if (!currentPrice || !Array.isArray(zones?.zones)) {
    return { levelsAbove: [], count: 0, penalty: 0, label: 'no zone data', bonus: 0 };
  }

  const ceiling = currentPrice * 1.03;
  // Filter: resistance type, above current, within 3% ceiling
  const levelsAbove = zones.zones
    .filter(z => z.type === 'resistance' && z.price > currentPrice && z.price <= ceiling)
    .map(z => z.price)
    .sort((a, b) => a - b);

  const count = levelsAbove.length;
  let penalty = 0, label = '', bonus = 0;

  if (count === 0) {
    // Clear path overhead — small bonus
    label = 'clear path above';
    bonus = 5;
  } else if (count === 1) {
    label = 'one resistance ahead';
    penalty = 0;
  } else if (count === 2) {
    label = 'approaching resistance';
    penalty = -5;
  } else if (count === 3) {
    label = 'resistance cluster';
    penalty = -10;
  } else {
    label = 'resistance shelf — high rejection risk';
    penalty = -15;
  }

  return { levelsAbove, count, penalty, label, bonus, ceiling: parseFloat(ceiling.toFixed(2)) };
}

// ─── Module 2: Volume Character Analysis ─────────
//
// The same 2.4× volume reading means very different things:
//   - At a breakout with strong close → accumulation, bullish
//   - At resistance with weak close → distribution, bearish
//
// We classify the recent 3 candles using close-position-within-range (CPR):
//   CPR = (close - low) / (high - low)
//   ≥ 0.75 = strong close, demand-driven
//   < 0.40 = weak close, supply-driven
//
// Inputs:
//   candles: array of {o, h, l, c, v} candles (sorted oldest → newest)
//   currentPrice: spot
//   nearestResistance: optional price (used to detect distribution at resistance)
//
// Returns:
//   {
//     category: 'ACCUMULATION' | 'DISTRIBUTION' | 'ABSORPTION' | 'CLIMACTIC' |
//               'STEALTH_BUILDUP' | 'NORMAL',
//     last3CPR: [0.92, 0.34, 0.18],
//     volumeMultiple: 2.4,
//     adjustment: number,  // confluence delta
//     note: string,
//     blockBuySignals: boolean,  // critical override flag
//   }
function analyzeVolumeCharacter({ candles, currentPrice, nearestResistance }) {
  if (!Array.isArray(candles) || candles.length < 25) {
    return { category: 'NORMAL', last3CPR: [], volumeMultiple: null, adjustment: 0, note: 'insufficient candles', blockBuySignals: false };
  }

  const recent3 = candles.slice(-3);
  const cpr = recent3.map(c => {
    const range = c.h - c.l;
    if (range === 0) return 0.5;
    return (c.c - c.l) / range;
  });
  const last3CPR = cpr.map(v => parseFloat(v.toFixed(2)));

  // Volume multiple = today's volume / 20d average
  const last20 = candles.slice(-20);
  const avg20 = last20.reduce((s, c) => s + (c.v || 0), 0) / last20.length;
  const todayVol = candles[candles.length - 1].v || 0;
  const volumeMultiple = avg20 > 0 ? parseFloat((todayVol / avg20).toFixed(2)) : null;

  const todayCandle = candles[candles.length - 1];
  const todayGreen = todayCandle.c > todayCandle.o;
  const todayRed = todayCandle.c < todayCandle.o;
  const todayCPR = cpr[2];
  const todayRange = todayCandle.h - todayCandle.l;
  const upperWick = todayRange > 0 ? (todayCandle.h - Math.max(todayCandle.o, todayCandle.c)) / todayRange : 0;

  // Is today's price at or near a resistance level (within 1.5%)?
  const nearResistance = nearestResistance && currentPrice
    && Math.abs(currentPrice - nearestResistance) / currentPrice < 0.015;

  // 52W context: are we at a multi-month high?
  const last90 = candles.slice(-90);
  const high90 = Math.max(...last90.map(c => c.h));
  const atMultiMonthHigh = todayCandle.c >= high90 * 0.99;

  // Classify (priority order — first match wins)
  let category = 'NORMAL', adjustment = 0, note = '', blockBuySignals = false;

  // 1. CLIMACTIC: extreme volume at multi-month high
  if (volumeMultiple >= 3 && atMultiMonthHigh) {
    category = 'CLIMACTIC';
    adjustment = -6;
    note = 'Extreme volume at multi-month high — exhaustion risk';
  }
  // 2. ABSORPTION: high volume + long upper wick (supply absorbing demand)
  else if (volumeMultiple >= 2 && upperWick > 0.5) {
    category = 'ABSORPTION';
    adjustment = -8;
    note = `Long upper wick (${(upperWick * 100).toFixed(0)}% of range) on ${volumeMultiple}× vol — distribution warning`;
    if (nearResistance) blockBuySignals = true;
  }
  // 3. DISTRIBUTION: high volume + weak close near resistance
  else if (volumeMultiple >= 1.5 && todayCPR < 0.40 && nearResistance) {
    category = 'DISTRIBUTION';
    adjustment = -10;
    note = `${volumeMultiple}× vol with weak close (CPR ${todayCPR.toFixed(2)}) at resistance — distribution`;
    blockBuySignals = true;
  }
  // 4. ACCUMULATION: high volume + strong close + green candle
  else if (volumeMultiple >= 1.5 && todayCPR >= 0.75 && todayGreen) {
    category = 'ACCUMULATION';
    adjustment = 5;
    note = `${volumeMultiple}× vol, strong close (CPR ${todayCPR.toFixed(2)}), green candle — accumulation`;
  }
  // 5. STEALTH_BUILDUP: 5+ consecutive above-avg vol days with avg strong close
  else {
    const last5 = candles.slice(-5);
    const last5Avg20 = candles.slice(-25, -5);
    const baseAvg = last5Avg20.reduce((s, c) => s + (c.v || 0), 0) / Math.max(1, last5Avg20.length);
    const allAboveAvg = last5.every(c => (c.v || 0) >= baseAvg * 1.2);
    const cpr5 = last5.map(c => {
      const r = c.h - c.l;
      return r > 0 ? (c.c - c.l) / r : 0.5;
    });
    const avgCpr5 = cpr5.reduce((s, v) => s + v, 0) / cpr5.length;
    if (allAboveAvg && avgCpr5 >= 0.6) {
      category = 'STEALTH_BUILDUP';
      adjustment = 8;
      note = `5 consecutive days of above-avg volume with strong avg close (${avgCpr5.toFixed(2)}) — quiet accumulation`;
    }
  }

  return {
    category,
    last3CPR,
    volumeMultiple,
    upperWickPct: parseFloat((upperWick * 100).toFixed(0)),
    adjustment,
    note,
    blockBuySignals,
    atMultiMonthHigh,
    nearResistance: !!nearResistance,
  };
}

// ─── Module 5: Invalidation Level Calculator ─────────
//
// Every signal needs a hard exit price. No invalidation = "hold and hope",
// which is how options accounts blow up.
//
// Rules (use the TIGHTEST of three candidate levels):
//   1. Breakout-based: invalidation = breakout level × 0.992 (0.8% below)
//   2. Trend-continuation: invalidation = most recent swing low × 0.995
//   3. Mean-reversion: invalidation = beyond the extreme + 1×ATR
//
// For BUY signals: invalidation is BELOW price. For SELL signals: ABOVE.
//
// Inputs:
//   { signal, currentPrice, candles, zones, atr14 }
//
// Returns:
//   {
//     underlyingPrice: number,
//     underlyingBasis: string,
//     premiumFloorPct: 0.65, // exit if option premium drops below entry × this
//     premiumBasis: string,
//     exitAction: string,
//     distancePct: number, // how far invalidation is from current price
//   }
function computeInvalidation({ signal, currentPrice, candles, zones, atr14 }) {
  if (!currentPrice) {
    return { underlyingPrice: null, underlyingBasis: 'no current price', premiumFloorPct: 0.65, exitAction: '—' };
  }

  const isBuy = signal === 'STRONG BUY' || signal === 'BUY';
  const isSell = signal === 'STRONG SELL' || signal === 'SELL';

  if (!isBuy && !isSell) {
    return {
      underlyingPrice: null,
      underlyingBasis: 'HOLD signal — no directional invalidation',
      premiumFloorPct: 0.65,
      exitAction: 'N/A',
      distancePct: null,
    };
  }

  const candidates = [];

  // Candidate 1: nearest support/resistance from zones (acts as breakout level)
  if (Array.isArray(zones?.zones)) {
    if (isBuy) {
      // Find nearest support below current
      const supportsBelow = zones.zones
        .filter(z => (z.type === 'support' || z.kind === 'P') && z.price < currentPrice)
        .sort((a, b) => b.price - a.price); // closest first
      if (supportsBelow.length > 0) {
        const lvl = supportsBelow[0].price;
        candidates.push({
          price: lvl * 0.992,
          basis: `0.8% below nearest support ₹${lvl.toFixed(2)} (${supportsBelow[0].timeframe}·${supportsBelow[0].kind})`,
        });
      }
    } else {
      // SELL: nearest resistance above
      const resAbove = zones.zones
        .filter(z => (z.type === 'resistance' || z.kind === 'P') && z.price > currentPrice)
        .sort((a, b) => a.price - b.price);
      if (resAbove.length > 0) {
        const lvl = resAbove[0].price;
        candidates.push({
          price: lvl * 1.008,
          basis: `0.8% above nearest resistance ₹${lvl.toFixed(2)} (${resAbove[0].timeframe}·${resAbove[0].kind})`,
        });
      }
    }
  }

  // Candidate 2: most recent swing low (for BUY) / swing high (for SELL)
  // Look at last 30 candles, find the lowest low (BUY) or highest high (SELL)
  if (Array.isArray(candles) && candles.length >= 10) {
    const lookback = candles.slice(-30);
    if (isBuy) {
      const lows = lookback.map(c => c.l);
      const swingLow = Math.min(...lows);
      candidates.push({
        price: swingLow * 0.995,
        basis: `0.5% below 30-day swing low ₹${swingLow.toFixed(2)}`,
      });
    } else {
      const highs = lookback.map(c => c.h);
      const swingHigh = Math.max(...highs);
      candidates.push({
        price: swingHigh * 1.005,
        basis: `0.5% above 30-day swing high ₹${swingHigh.toFixed(2)}`,
      });
    }
  }

  // Candidate 3: ATR-based (1× ATR beyond current)
  if (atr14 && Number.isFinite(atr14) && atr14 > 0) {
    if (isBuy) {
      candidates.push({
        price: currentPrice - atr14,
        basis: `1× ATR (${atr14.toFixed(2)}) below current price`,
      });
    } else {
      candidates.push({
        price: currentPrice + atr14,
        basis: `1× ATR (${atr14.toFixed(2)}) above current price`,
      });
    }
  }

  if (candidates.length === 0) {
    return {
      underlyingPrice: null,
      underlyingBasis: 'insufficient data',
      premiumFloorPct: 0.65,
      exitAction: '—',
      distancePct: null,
    };
  }

  // Pick the TIGHTEST candidate. For BUY: highest price (closest to current).
  // For SELL: lowest price (closest to current).
  let chosen;
  if (isBuy) {
    chosen = candidates.sort((a, b) => b.price - a.price)[0];
  } else {
    chosen = candidates.sort((a, b) => a.price - b.price)[0];
  }

  const distancePct = Math.abs((chosen.price - currentPrice) / currentPrice * 100);

  return {
    underlyingPrice: parseFloat(chosen.price.toFixed(2)),
    underlyingBasis: chosen.basis,
    premiumFloorPct: 0.65,
    premiumBasis: 'Exit option if premium falls below 65% of entry (theta-dominated)',
    exitAction: `MARKET EXIT on confirmed close ${isBuy ? 'below' : 'above'} invalidation`,
    distancePct: parseFloat(distancePct.toFixed(2)),
    allCandidates: candidates.map(c => ({ price: parseFloat(c.price.toFixed(2)), basis: c.basis })),
  };
}

// ─── Combined: enrich a stock analysis with Phase 15A signals ─────────
//
// Single entry point used by /api/analyze. Folds all three module outputs
// into one object that confluence + UI can consume.
function enrichSignalQuality({ candles, currentPrice, zones, signal, atr14 }) {
  const resistanceCluster = analyzeResistanceCluster({ zones, currentPrice });

  // Find nearest resistance for volume-character context
  let nearestResistance = null;
  if (Array.isArray(zones?.zones)) {
    const resAbove = zones.zones
      .filter(z => z.type === 'resistance' && z.price > currentPrice)
      .sort((a, b) => a.price - b.price);
    nearestResistance = resAbove[0]?.price || null;
  }
  const volumeCharacter = analyzeVolumeCharacter({ candles, currentPrice, nearestResistance });

  const invalidation = computeInvalidation({ signal, currentPrice, candles, zones, atr14 });

  // Net adjustment to confluence (sum of all bonuses and penalties)
  const confluenceAdjustment =
    resistanceCluster.penalty +
    resistanceCluster.bonus +
    volumeCharacter.adjustment;

  // Block flag — if true, BUY signals should be downgraded regardless of score
  const blockBuySignal =
    volumeCharacter.blockBuySignals ||
    resistanceCluster.count >= 4;

  return {
    resistanceCluster,
    volumeCharacter,
    invalidation,
    confluenceAdjustment,
    blockBuySignal,
    blockReason: blockBuySignal
      ? (volumeCharacter.blockBuySignals
        ? volumeCharacter.note
        : 'resistance shelf — 4+ levels within 3% above')
      : null,
  };
}

module.exports = {
  analyzeResistanceCluster,
  analyzeVolumeCharacter,
  computeInvalidation,
  enrichSignalQuality,
};
