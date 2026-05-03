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

// ─── Preset strategies — timeframe-aware, chain-aware ──────────
// Each preset returns legs with REAL premiums from live option chain.
// Weekly uses tighter OTM widths (1-2 strikes); monthly uses wider (3-5 strikes)
// because monthly options have more time, so a wider spread is realistic.

const PRESETS = {
  longCall: {
    name: 'Long Call',
    sentiment: 'BULLISH',
    description: 'Buy a call. Profit if price rises significantly above strike+premium. Loss limited to premium paid.',
    legs: (spot, lotSize, chainAt, timeframe) => {
      const strike = roundToStrike(spot, lotSize);
      const opt = chainAt?.(strike, 'CE');
      const premium = opt?.ltp ?? estimatePremium(spot, strike, 'CE', timeframe);
      return [{ type: 'CE', side: 'BUY', strike, premium, quantity: lotSize }];
    },
  },
  longPut: {
    name: 'Long Put',
    sentiment: 'BEARISH',
    description: 'Buy a put. Profit if price falls significantly below strike-premium. Loss limited to premium paid.',
    legs: (spot, lotSize, chainAt, timeframe) => {
      const strike = roundToStrike(spot, lotSize);
      const opt = chainAt?.(strike, 'PE');
      const premium = opt?.ltp ?? estimatePremium(spot, strike, 'PE', timeframe);
      return [{ type: 'PE', side: 'BUY', strike, premium, quantity: lotSize }];
    },
  },
  bullCallSpread: {
    name: 'Bull Call Spread',
    sentiment: 'MODERATELY BULLISH',
    description: 'Buy ATM call, sell OTM call. Lower cost than long call, but profit capped. Defined risk.',
    legs: (spot, lotSize, chainAt, timeframe) => {
      const w = strikeWidth(spot);
      // Weekly: 2 strikes wide. Monthly: 5 strikes wide.
      const widthMultiplier = timeframe === 'monthly' ? 5 : 2;
      const buyStrike = roundToStrike(spot, lotSize);
      const sellStrike = buyStrike + w * widthMultiplier;
      const buyPremium = chainAt?.(buyStrike, 'CE')?.ltp ?? estimatePremium(spot, buyStrike, 'CE', timeframe);
      const sellPremium = chainAt?.(sellStrike, 'CE')?.ltp ?? estimatePremium(spot, sellStrike, 'CE', timeframe);
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
    legs: (spot, lotSize, chainAt, timeframe) => {
      const w = strikeWidth(spot);
      // Weekly: short strikes 2 OTM, long strikes 4 OTM (tight wings).
      // Monthly: short 4 OTM, long 8 OTM (wider, more theta to collect).
      const inner = timeframe === 'monthly' ? 4 : 2;
      const outer = timeframe === 'monthly' ? 8 : 4;
      const atm = roundToStrike(spot, lotSize);
      const sellPutStrike  = atm - w * inner;
      const buyPutStrike   = atm - w * outer;
      const sellCallStrike = atm + w * inner;
      const buyCallStrike  = atm + w * outer;
      const sellPutPrem  = chainAt?.(sellPutStrike,  'PE')?.ltp ?? estimatePremium(spot, sellPutStrike,  'PE', timeframe);
      const buyPutPrem   = chainAt?.(buyPutStrike,   'PE')?.ltp ?? estimatePremium(spot, buyPutStrike,   'PE', timeframe);
      const sellCallPrem = chainAt?.(sellCallStrike, 'CE')?.ltp ?? estimatePremium(spot, sellCallStrike, 'CE', timeframe);
      const buyCallPrem  = chainAt?.(buyCallStrike,  'CE')?.ltp ?? estimatePremium(spot, buyCallStrike,  'CE', timeframe);
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
    legs: (spot, lotSize, chainAt, timeframe) => {
      const strike = roundToStrike(spot, lotSize);
      const callPremium = chainAt?.(strike, 'CE')?.ltp ?? estimatePremium(spot, strike, 'CE', timeframe);
      const putPremium  = chainAt?.(strike, 'PE')?.ltp ?? estimatePremium(spot, strike, 'PE', timeframe);
      return [
        { type: 'CE', side: 'BUY', strike, premium: callPremium, quantity: lotSize },
        { type: 'PE', side: 'BUY', strike, premium: putPremium,  quantity: lotSize },
      ];
    },
  },
};

// ─── Recommendation engine ────────────────────────────────────
// Given current market context + strategy + timeframe, return verdict.
// marketContext = {
//   premarketScore: -8 to +8 (from /api/premarket)
//   indiaVix: number (current VIX level)
//   spot: current underlying price
//   maxPainStrike: max-pain strike from option chain
//   pcrOI: put-call ratio of OI
// }
//
// Returns: { score: 0-10, verdict: 'ENTER'|'WAIT'|'AVOID', signals: [{label, ok}] }

function recommendStrategy(name, timeframe, ctx) {
  const signals = [];
  let score = 0;

  // Helper to log a signal
  const sig = (label, ok, weight = 1) => {
    signals.push({ label, ok });
    if (ok) score += weight;
  };

  // VIX thresholds differ by timeframe — monthly absorbs more vol
  const vixLow = timeframe === 'monthly' ? 16 : 14;
  const vixHigh = timeframe === 'monthly' ? 24 : 20;
  // Pre-market score weight: weekly uses raw, monthly halves it (less relevant)
  const pmScale = timeframe === 'monthly' ? 0.5 : 1.0;
  const pmScore = (ctx.premarketScore || 0) * pmScale;

  switch (name) {
    case 'longCall': {
      // Wants: bullish bias + low IV + spot below max pain (room to rally)
      sig(`Pre-market bias bullish (score ${(ctx.premarketScore || 0).toFixed(0)})`, pmScore >= 2, 4);
      sig(`India VIX low (${ctx.indiaVix?.toFixed(1) || '?'} < ${vixLow})`, ctx.indiaVix < vixLow, 3);
      sig(`Spot below max pain (₹${ctx.spot?.toFixed(0)} < ₹${ctx.maxPainStrike})`, ctx.maxPainStrike > ctx.spot, 3);
      break;
    }
    case 'longPut': {
      // Wants: bearish bias + low IV + spot above max pain (room to fall)
      sig(`Pre-market bias bearish (score ${(ctx.premarketScore || 0).toFixed(0)})`, pmScore <= -2, 4);
      sig(`India VIX low (${ctx.indiaVix?.toFixed(1) || '?'} < ${vixLow})`, ctx.indiaVix < vixLow, 3);
      sig(`Spot above max pain (₹${ctx.spot?.toFixed(0)} > ₹${ctx.maxPainStrike})`, ctx.maxPainStrike < ctx.spot, 3);
      break;
    }
    case 'bullCallSpread': {
      // Wants: moderately bullish (1-3 bias) + IV elevated (selling some)
      // + spot in lower half of range
      const pmOk = pmScore >= 1 && pmScore <= 4;
      sig(`Pre-market mildly bullish (score 1-4)`, pmOk, 4);
      sig(`India VIX in mid range (${vixLow}-${vixHigh})`, ctx.indiaVix >= vixLow && ctx.indiaVix <= vixHigh, 3);
      sig(`Spot near or below max pain (₹${ctx.maxPainStrike})`, ctx.maxPainStrike >= ctx.spot, 3);
      break;
    }
    case 'ironCondor': {
      // Wants: neutral bias + HIGH IV (selling premium) + spot at max pain
      sig(`Pre-market neutral (score -2 to +2)`, Math.abs(pmScore) <= 2, 4);
      sig(`India VIX elevated (> ${vixLow})`, ctx.indiaVix > vixLow, 3);
      const distFromPain = Math.abs((ctx.spot || 0) - (ctx.maxPainStrike || 0));
      const distPct = ctx.spot > 0 ? (distFromPain / ctx.spot) : 1;
      sig(`Spot within 1.5% of max pain (₹${ctx.maxPainStrike})`, distPct < 0.015, 3);
      break;
    }
    case 'longStraddle': {
      // Wants: low IV (cheap to buy both) + flat near-term (will move soon)
      // For monthly, want a known event coming (we approximate via PCR extreme = sentiment shift)
      sig(`India VIX low (< ${vixLow}) - cheap to buy vol`, ctx.indiaVix < vixLow, 4);
      sig(`Pre-market direction unclear (|score| < 3)`, Math.abs(pmScore) < 3, 3);
      const pcrExtreme = ctx.pcrOI && (ctx.pcrOI > 1.4 || ctx.pcrOI < 0.7);
      sig(`PCR at extreme (${ctx.pcrOI?.toFixed(2) || '?'}) - sentiment flip possible`, pcrExtreme, 3);
      break;
    }
  }

  // Verdict thresholds (max possible score = 10 for all strategies)
  let verdict;
  if (score >= 7) verdict = 'ENTER';
  else if (score >= 4) verdict = 'WAIT';
  else verdict = 'AVOID';

  return { score, verdict, signals, timeframe };
}

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
// Monthly premiums are ~2x weekly (sqrt(28/7) = 2)
function estimatePremium(spot, strike, type, timeframe) {
  const dist = Math.abs(spot - strike);
  const moneyness = dist / spot;
  // Weekly: ATM ≈ 0.5% of spot. Monthly: ATM ≈ 1.0% of spot.
  const atmFactor = timeframe === 'monthly' ? 0.010 : 0.005;
  const atmPrice = spot * atmFactor;
  const otmDecay = Math.exp(-moneyness * (timeframe === 'monthly' ? 15 : 30));
  return Math.max(0.5, atmPrice * otmDecay);
}

module.exports = {
  legPnl, strategyPnl, netCost,
  buildPnlCurve, findBreakevens, findExtremes,
  analyzeStrategy,
  PRESETS,
  recommendStrategy,
  strikeWidth, roundToStrike,
};
