// rangeBehavior.js — Phase 15B Module 3
//
// Detects when a stock is in a defined trading range so we can route to range
// strategies (credit spreads, iron condors) instead of directional bets.
//
// "Range-bound at upper third" is the textbook scenario where retail buys CE
// options on the breakout that never comes. This module flags those setups.

// ─── ADX (Average Directional Index) ─────────
//
// Wilder's ADX measures trend strength regardless of direction.
//   ADX < 20 = no trend (ranging)
//   ADX 20-25 = trend forming
//   ADX > 25 = trending
//   ADX > 40 = strong trend
//
// Inputs: arrays of highs, lows, closes (same length, oldest → newest).
// Returns: array of ADX values (NaN for the first ~2*period-1 candles).
function computeADX(highs, lows, closes, period = 14) {
  const n = closes.length;
  if (n < period * 2 + 1) return [];

  const tr = new Array(n).fill(0);
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM[i] = (up > down && up > 0) ? up : 0;
    minusDM[i] = (down > up && down > 0) ? down : 0;
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
  }

  // Smooth using Wilder's smoothing (RMA): first value is sum of first `period`,
  // then RMA[i] = RMA[i-1] - RMA[i-1]/period + value[i]
  function smooth(arr) {
    const out = new Array(n).fill(NaN);
    let sum = 0;
    for (let i = 1; i <= period; i++) sum += arr[i];
    out[period] = sum;
    for (let i = period + 1; i < n; i++) {
      out[i] = out[i - 1] - out[i - 1] / period + arr[i];
    }
    return out;
  }

  const smoothTR = smooth(tr);
  const smoothPlusDM = smooth(plusDM);
  const smoothMinusDM = smooth(minusDM);

  const plusDI = new Array(n).fill(NaN);
  const minusDI = new Array(n).fill(NaN);
  const dx = new Array(n).fill(NaN);
  for (let i = period; i < n; i++) {
    if (smoothTR[i] && smoothTR[i] !== 0) {
      plusDI[i] = (smoothPlusDM[i] / smoothTR[i]) * 100;
      minusDI[i] = (smoothMinusDM[i] / smoothTR[i]) * 100;
      const denom = plusDI[i] + minusDI[i];
      if (denom > 0) {
        dx[i] = (Math.abs(plusDI[i] - minusDI[i]) / denom) * 100;
      }
    }
  }

  // ADX = Wilder-smoothed DX over `period` candles
  const adx = new Array(n).fill(NaN);
  let dxSum = 0;
  const firstAdxIdx = period * 2;
  for (let i = period; i < firstAdxIdx && i < n; i++) {
    if (Number.isFinite(dx[i])) dxSum += dx[i];
  }
  if (firstAdxIdx < n) {
    adx[firstAdxIdx] = dxSum / period;
    for (let i = firstAdxIdx + 1; i < n; i++) {
      if (Number.isFinite(dx[i])) {
        adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
      } else {
        adx[i] = adx[i - 1];
      }
    }
  }

  return adx;
}

// ─── Range Behavior Classifier ─────────
//
// Analyzes last 40 candles to classify state:
//   TRENDING        — ADX > 25, normal directional signals allowed
//   RANGE_BOUND     — defined high/low, multiple touches both sides, ADX < 22
//   BREAKING_OUT    — range exists but current candle clears with vol + close
//   UNCLEAR         — doesn't fit any pattern, treat as TRENDING for safety
//
// Inputs:
//   candles: array of {o,h,l,c,v} (sorted oldest → newest)
//   currentPrice: spot
//
// Returns:
//   {
//     state, rangeHigh, rangeLow, rangeWidthPct, currentPosition,
//     touchesUpper, touchesLower, adx, recommendedStrategy, suppressDirectional,
//   }
function classifyRangeBehavior({ candles, currentPrice }) {
  if (!Array.isArray(candles) || candles.length < 45) {
    return { state: 'UNCLEAR', reason: 'insufficient candles (need 45)', adx: null };
  }

  const lookback = candles.slice(-40);
  const highs = lookback.map(c => c.h);
  const lows = lookback.map(c => c.l);
  const closes = lookback.map(c => c.c);
  const rangeHigh = Math.max(...highs);
  const rangeLow = Math.min(...lows);
  const rangeWidth = rangeHigh - rangeLow;
  const rangeWidthPct = (rangeWidth / rangeLow) * 100;

  // ADX over the full candles array (we only need the last value)
  // Need full history for accurate ADX (period × 2 = 28 warmup)
  const adxAll = computeADX(
    candles.map(c => c.h),
    candles.map(c => c.l),
    candles.map(c => c.c),
    14
  );
  const adx = adxAll[adxAll.length - 1];

  // Count touches in upper third and lower third
  // Upper third = range_low + 2/3 of range up
  const upperBound = rangeLow + rangeWidth * (2/3);
  const lowerBound = rangeLow + rangeWidth * (1/3);
  let touchesUpper = 0, touchesLower = 0;
  for (let i = 0; i < lookback.length; i++) {
    const c = lookback[i];
    if (c.h >= upperBound) touchesUpper++;
    if (c.l <= lowerBound) touchesLower++;
  }

  // Current position within range
  let currentPosition = 'mid';
  if (currentPrice >= upperBound) currentPosition = 'upper_third';
  else if (currentPrice <= lowerBound) currentPosition = 'lower_third';

  // Sustained higher-high + higher-low sequence? (>5 candles trending)
  let hhhlStreak = 0, maxHHHL = 0;
  for (let i = 1; i < lookback.length; i++) {
    if (lookback[i].h > lookback[i-1].h && lookback[i].l > lookback[i-1].l) {
      hhhlStreak++;
      maxHHHL = Math.max(maxHHHL, hhhlStreak);
    } else {
      hhhlStreak = 0;
    }
  }

  // Range criteria (from the spec):
  //   - Range width < 18%
  //   - Touches upper third ≥ 3
  //   - Touches lower third ≥ 3
  //   - No sustained HH+HL > 5 candles
  //   - ADX < 22
  const isRangeBound =
    rangeWidthPct < 18 &&
    touchesUpper >= 3 &&
    touchesLower >= 3 &&
    maxHHHL <= 5 &&
    Number.isFinite(adx) && adx < 22;

  // Breaking out: range was bound, but current candle clears with 2x volume
  // and strong close, OR closes >0.5% beyond range edge.
  const today = candles[candles.length - 1];
  const last20Vol = candles.slice(-21, -1);
  const avgVol = last20Vol.reduce((s, c) => s + (c.v || 0), 0) / Math.max(1, last20Vol.length);
  const volMult = avgVol > 0 ? today.v / avgVol : 0;
  const todayCPR = today.h !== today.l ? (today.c - today.l) / (today.h - today.l) : 0.5;
  const isBreakoutUp = today.c > rangeHigh * 1.005 && volMult >= 2 && todayCPR >= 0.7;
  const isBreakoutDown = today.c < rangeLow * 0.995 && volMult >= 2 && todayCPR <= 0.3;

  let state, recommendedStrategy, suppressDirectional = false;
  if (isBreakoutUp) {
    state = 'BREAKING_OUT_UP';
    recommendedStrategy = '2-day confirmation needed; current candle clears range with volume';
  } else if (isBreakoutDown) {
    state = 'BREAKING_OUT_DOWN';
    recommendedStrategy = '2-day confirmation needed; current candle breaks range with volume';
  } else if (isRangeBound) {
    state = 'RANGE_BOUND';
    if (currentPosition === 'upper_third') {
      recommendedStrategy = `Bear Call Spread near ₹${rangeHigh.toFixed(2)} — sell upper edge`;
      suppressDirectional = true;
    } else if (currentPosition === 'lower_third') {
      recommendedStrategy = `Bull Put Spread near ₹${rangeLow.toFixed(2)} — sell lower edge`;
      suppressDirectional = true;
    } else {
      recommendedStrategy = 'Mid-range — no edge, wait for price to reach a boundary';
      suppressDirectional = true;
    }
  } else if (Number.isFinite(adx) && adx > 25) {
    state = 'TRENDING';
    recommendedStrategy = 'Normal directional signals allowed';
  } else {
    state = 'UNCLEAR';
    recommendedStrategy = 'No clear range or trend — proceed with caution on directional signals';
  }

  return {
    state,
    rangeLow: parseFloat(rangeLow.toFixed(2)),
    rangeHigh: parseFloat(rangeHigh.toFixed(2)),
    rangeWidthPct: parseFloat(rangeWidthPct.toFixed(2)),
    currentPosition,
    touchesUpper,
    touchesLower,
    maxHHHLStreak: maxHHHL,
    adx: Number.isFinite(adx) ? parseFloat(adx.toFixed(1)) : null,
    volumeMultiple: parseFloat(volMult.toFixed(2)),
    recommendedStrategy,
    suppressDirectional,
  };
}

module.exports = { computeADX, classifyRangeBehavior };
