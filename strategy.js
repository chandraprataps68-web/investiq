// strategy.js — Multi-leg option strategy P&L computation
//
// A "leg" is one option position: { type: 'CE'|'PE', side: 'BUY'|'SELL',
//   strike, premium, quantity }
// Premium is per share (not per lot). Quantity is in shares (lot-multiplied).
//
// At expiry, each leg's P&L is determined purely by where the underlying lands:
//   Long Call:  max(S-K, 0) - premium
//   Short Call: premium - max(S-K, 0)
//   Long Put:   max(K-S, 0) - premium
//   Short Put:  premium - max(K-S, 0)
// Total P&L is sum across legs × quantity.

// ─── Leg P&L at given underlying price ────────────────────────
function legPnl(leg, S) {
  const intrinsic = leg.type === 'CE'
    ? Math.max(S - leg.strike, 0)
    : Math.max(leg.strike - S, 0);
  const perShare = leg.side === 'BUY'
    ? intrinsic - leg.premium
    : leg.premium - intrinsic;
  return perShare * leg.quantity;
}

// ─── Total strategy P&L at given underlying price ─────────────
function strategyPnl(legs, S) {
  return legs.reduce((sum, leg) => sum + legPnl(leg, S), 0);
}

// ─── Net debit/credit (cost to enter) ─────────────────────────
// Negative = net debit (you pay), positive = net credit (you receive)
function netCost(legs) {
  return legs.reduce((sum, leg) => {
    const sign = leg.side === 'BUY' ? -1 : 1;
    return sum + sign * leg.premium * leg.quantity;
  }, 0);
}

// ─── Build the P&L curve across a range of underlying prices ──
// spotCenter: where to center the curve (typically current spot)
// rangePct: ±% from spot to evaluate (default ±15%)
// steps: number of points (default 100)
function buildPnlCurve(legs, spotCenter, rangePct = 0.15, steps = 100) {
  const lo = spotCenter * (1 - rangePct);
  const hi = spotCenter * (1 + rangePct);
  const stepSize = (hi - lo) / steps;
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const S = lo + i * stepSize;
    points.push({ S, pnl: strategyPnl(legs, S) });
  }
  return points;
}

// ─── Find breakevens (where P&L = 0) by linear interpolation ──
function findBreakevens(curve) {
  const breakevens = [];
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if ((a.pnl <= 0 && b.pnl >= 0) || (a.pnl >= 0 && b.pnl <= 0)) {
      if (a.pnl === b.pnl) continue;
      // Linear interp between a and b
      const t = -a.pnl / (b.pnl - a.pnl);
      const S = a.S + t * (b.S - a.S);
      breakevens.push(S);
    }
  }
  return breakevens;
}

// ─── Max profit and max loss within evaluated range ───────────
function findExtremes(curve) {
  let maxProfit = -Infinity, maxLoss = Infinity;
  let maxProfitAt = null, maxLossAt = null;
  for (const p of curve) {
    if (p.pnl > maxProfit) { maxProfit = p.pnl; maxProfitAt = p.S; }
    if (p.pnl < maxLoss) { maxLoss = p.pnl; maxLossAt = p.S; }
  }
  return { maxProfit, maxLoss, maxProfitAt, maxLossAt };
}

// Determine if max profit/loss is bounded or unlimited.
// We compute the net "slope" of the P&L curve at each extreme:
//   At very high S: only calls have intrinsic value. Slope = (long calls - short calls)
//     - Positive slope → P&L rises to infinity → profit unbounded on upside
//     - Negative slope → P&L falls to negative infinity → loss unbounded on upside
//   At very low S: only puts have intrinsic value. As S falls, put value rises,
//     so the slope of P&L vs S is the OPPOSITE of put position.
//     dP&L/dS at low S = (short puts - long puts)
//     - Negative slope → P&L rises as S falls → profit unbounded on downside
//     - Positive slope → P&L falls as S falls → loss unbounded on downside
function characterizeStrategy(legs) {
  const netCallsLong = legs.filter(l => l.type === 'CE' && l.side === 'BUY')
    .reduce((s, l) => s + l.quantity, 0);
  const netCallsShort = legs.filter(l => l.type === 'CE' && l.side === 'SELL')
    .reduce((s, l) => s + l.quantity, 0);
  const netPutsLong = legs.filter(l => l.type === 'PE' && l.side === 'BUY')
    .reduce((s, l) => s + l.quantity, 0);
  const netPutsShort = legs.filter(l => l.type === 'PE' && l.side === 'SELL')
    .reduce((s, l) => s + l.quantity, 0);

  const callsNet = netCallsLong - netCallsShort;
  const putsNet  = netPutsLong  - netPutsShort;

  // Upside (S → ∞): slope = callsNet
  const upsideProfitUnbounded = callsNet > 0;
  const upsideLossUnbounded = callsNet < 0;

  // Downside (S → 0): P&L slope vs S = -putsNet (since put value rises as S falls)
  // → if putsNet > 0 (long puts), P&L rises as S falls → profit unbounded on downside
  // → if putsNet < 0 (short puts), P&L falls as S falls → loss unbounded on downside
  const downsideProfitUnbounded = putsNet > 0;
  const downsideLossUnbounded = putsNet < 0;

  return {
    profitUnbounded: upsideProfitUnbounded || downsideProfitUnbounded,
    lossUnbounded: upsideLossUnbounded || downsideLossUnbounded,
  };
}

// ─── Compute everything in one call ───────────────────────────
function analyzeStrategy(legs, spotCenter, rangePct = 0.15) {
  const curve = buildPnlCurve(legs, spotCenter, rangePct);
  const breakevens = findBreakevens(curve);
  const extremes = findExtremes(curve);
  const character = characterizeStrategy(legs);
  const cost = netCost(legs);
  const currentPnl = strategyPnl(legs, spotCenter);
  return {
    curve,
    breakevens,
    maxProfit: character.profitUnbounded ? null : extremes.maxProfit,
    maxLoss: character.lossUnbounded ? null : extremes.maxLoss,
    maxProfitAt: extremes.maxProfitAt,
    maxLossAt: extremes.maxLossAt,
    netCost: cost,
    currentPnl,
    profitUnbounded: character.profitUnbounded,
    lossUnbounded: character.lossUnbounded,
  };
}

// ─── Preset strategies — generators given spot + chain context ─
// Each preset returns { legs, description } given underlying spot price
// and a "chain" lookup function chainAt(strike, type) → option row.
// If chain lookup unavailable, premium estimated from spot.

const PRESETS = {
  longCall: {
    name: 'Long Call',
    sentiment: 'BULLISH',
    description: 'Buy a call. Profit if price rises significantly above strike+premium. Loss limited to premium paid.',
    legs: (spot, lotSize, chainAt) => {
      // ATM call as a default
      const strike = roundToStrike(spot, lotSize);
      const premium = chainAt?.(strike, 'CE')?.ltp ?? estimatePremium(spot, strike, 'CE');
      return [{ type: 'CE', side: 'BUY', strike, premium, quantity: lotSize }];
    },
  },
  longPut: {
    name: 'Long Put',
    sentiment: 'BEARISH',
    description: 'Buy a put. Profit if price falls significantly below strike-premium. Loss limited to premium paid.',
    legs: (spot, lotSize, chainAt) => {
      const strike = roundToStrike(spot, lotSize);
      const premium = chainAt?.(strike, 'PE')?.ltp ?? estimatePremium(spot, strike, 'PE');
      return [{ type: 'PE', side: 'BUY', strike, premium, quantity: lotSize }];
    },
  },
  bullCallSpread: {
    name: 'Bull Call Spread',
    sentiment: 'MODERATELY BULLISH',
    description: 'Buy ATM call, sell OTM call. Lower cost than long call, but profit capped. Defined risk.',
    legs: (spot, lotSize, chainAt) => {
      const stepWidth = strikeWidth(spot);
      const buyStrike = roundToStrike(spot, lotSize);
      const sellStrike = buyStrike + stepWidth * 4; // 4 strikes OTM
      const buyPremium = chainAt?.(buyStrike, 'CE')?.ltp ?? estimatePremium(spot, buyStrike, 'CE');
      const sellPremium = chainAt?.(sellStrike, 'CE')?.ltp ?? estimatePremium(spot, sellStrike, 'CE');
      return [
        { type: 'CE', side: 'BUY',  strike: buyStrike,  premium: buyPremium,  quantity: lotSize },
        { type: 'CE', side: 'SELL', strike: sellStrike, premium: sellPremium, quantity: lotSize },
      ];
    },
  },
  ironCondor: {
    name: 'Iron Condor',
    sentiment: 'NEUTRAL / RANGE-BOUND',
    description: 'Sell OTM call+put, buy further OTM call+put. Profit if price stays within range. Defined risk both sides.',
    legs: (spot, lotSize, chainAt) => {
      const w = strikeWidth(spot);
      const sellPutStrike  = roundToStrike(spot, lotSize) - w * 3;
      const buyPutStrike   = sellPutStrike - w * 3;
      const sellCallStrike = roundToStrike(spot, lotSize) + w * 3;
      const buyCallStrike  = sellCallStrike + w * 3;
      const sellPutPrem  = chainAt?.(sellPutStrike,  'PE')?.ltp ?? estimatePremium(spot, sellPutStrike,  'PE');
      const buyPutPrem   = chainAt?.(buyPutStrike,   'PE')?.ltp ?? estimatePremium(spot, buyPutStrike,   'PE');
      const sellCallPrem = chainAt?.(sellCallStrike, 'CE')?.ltp ?? estimatePremium(spot, sellCallStrike, 'CE');
      const buyCallPrem  = chainAt?.(buyCallStrike,  'CE')?.ltp ?? estimatePremium(spot, buyCallStrike,  'CE');
      return [
        { type: 'PE', side: 'BUY',  strike: buyPutStrike,   premium: buyPutPrem,   quantity: lotSize },
        { type: 'PE', side: 'SELL', strike: sellPutStrike,  premium: sellPutPrem,  quantity: lotSize },
        { type: 'CE', side: 'SELL', strike: sellCallStrike, premium: sellCallPrem, quantity: lotSize },
        { type: 'CE', side: 'BUY',  strike: buyCallStrike,  premium: buyCallPrem,  quantity: lotSize },
      ];
    },
  },
  longStraddle: {
    name: 'Long Straddle',
    sentiment: 'HIGH VOLATILITY EXPECTED',
    description: 'Buy ATM call + ATM put. Profit if price moves big in either direction. Loss if it stays put.',
    legs: (spot, lotSize, chainAt) => {
      const strike = roundToStrike(spot, lotSize);
      const callPremium = chainAt?.(strike, 'CE')?.ltp ?? estimatePremium(spot, strike, 'CE');
      const putPremium  = chainAt?.(strike, 'PE')?.ltp ?? estimatePremium(spot, strike, 'PE');
      return [
        { type: 'CE', side: 'BUY', strike, premium: callPremium, quantity: lotSize },
        { type: 'PE', side: 'BUY', strike, premium: putPremium,  quantity: lotSize },
      ];
    },
  },
};

// ─── Helpers ──────────────────────────────────────────────────
// Round spot to nearest valid strike. Indices use 50-point increments
// for Nifty, 100-point for Bank Nifty. Use heuristic based on spot magnitude.
function strikeWidth(spot) {
  if (spot < 1000) return 10;       // small stocks
  if (spot < 5000) return 50;       // most stocks, Nifty
  if (spot < 20000) return 100;     // Bank Nifty range
  if (spot < 50000) return 100;
  return 500;                        // very high indices
}

function roundToStrike(spot, lotSize) {
  const w = strikeWidth(spot);
  return Math.round(spot / w) * w;
}

// Crude premium estimate when no live chain is available.
// Approximates ATM IV ~15%, scales by sqrt(time) ~ short-dated weekly.
function estimatePremium(spot, strike, type) {
  const dist = Math.abs(spot - strike);
  const moneyness = dist / spot;
  // Rough heuristic: ATM ≈ 0.5% of spot, decays exponentially as OTM
  const atmPrice = spot * 0.005;
  const otmDecay = Math.exp(-moneyness * 30);
  return Math.max(0.5, atmPrice * otmDecay);
}

module.exports = {
  legPnl, strategyPnl, netCost,
  buildPnlCurve, findBreakevens, findExtremes,
  analyzeStrategy,
  PRESETS,
  strikeWidth, roundToStrike,
};
