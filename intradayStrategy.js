// intradayStrategy.js — Daily setup + intraday levels for index trading
//
// Generates pre-market and intraday playbook for Bank Nifty / Nifty 50.
// Output: BUY zone (with entry/target/stop) + SELL zone (with entry/target/stop)
// based on classic floor-trader pivots, ATR-based sizing, and option OI walls.
//
// Philosophy: this is a SETUP MAP, not a live trade alert. We compute realistic
// zones for both directions because intraday markets resolve either way. The
// trader picks based on which scenario plays out after open.

const TA = require('./ta');

// Classic floor-trader pivots from yesterday's HLC
function computePivots(yHigh, yLow, yClose) {
  const pp = (yHigh + yLow + yClose) / 3;
  const r1 = 2 * pp - yLow;
  const s1 = 2 * pp - yHigh;
  const r2 = pp + (yHigh - yLow);
  const s2 = pp - (yHigh - yLow);
  const r3 = yHigh + 2 * (pp - yLow);
  const s3 = yLow - 2 * (yHigh - pp);
  return { pp, r1, r2, r3, s1, s2, s3 };
}

// Compute trend context from daily candles
function computeTrendContext(candles) {
  if (!Array.isArray(candles) || candles.length < 50) {
    return { trend: 'UNKNOWN', dma20: null, dma50: null, dma200: null };
  }
  const closes = candles.map(c => c.c);
  const ema20 = TA.ema(closes, 20);
  const ema50 = TA.ema(closes, 50);
  const ema200 = closes.length >= 200 ? TA.ema(closes, 200) : null;
  const lastClose = closes[closes.length - 1];
  const e20 = ema20[ema20.length - 1];
  const e50 = ema50[ema50.length - 1];
  const e200 = ema200 ? ema200[ema200.length - 1] : null;

  let trend = 'NEUTRAL';
  if (e20 > e50 && lastClose > e20) trend = 'BULLISH';
  else if (e20 < e50 && lastClose < e20) trend = 'BEARISH';
  else if (lastClose > e20) trend = 'MILD_BULLISH';
  else trend = 'MILD_BEARISH';

  // ATR(14) for sizing
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  const atrSeries = TA.atr(highs, lows, closes, 14);
  const atr = atrSeries[atrSeries.length - 1] || (lastClose * 0.01);

  // RSI(14) for momentum
  const rsi = TA.rsi(closes, 14);
  const lastRsi = rsi[rsi.length - 1];

  return {
    trend,
    dma20: e20,
    dma50: e50,
    dma200: e200,
    atr,
    rsi: lastRsi,
    lastClose,
  };
}

// Decide directional bias for the day from pivots, OI walls, trend
function determineBias({ spot, pivots, oiWalls, maxPain, trend, ydHigh, ydLow }) {
  let score = 0;
  const reasons = [];

  // Pivot proximity
  if (spot > pivots.pp) {
    score += 1;
    reasons.push(`Spot above PP (${pivots.pp.toFixed(0)})`);
  } else {
    score -= 1;
    reasons.push(`Spot below PP (${pivots.pp.toFixed(0)})`);
  }

  // Trend context
  if (trend === 'BULLISH') { score += 2; reasons.push('Daily trend bullish (20>50, price>20)'); }
  else if (trend === 'BEARISH') { score -= 2; reasons.push('Daily trend bearish (20<50, price<20)'); }
  else if (trend === 'MILD_BULLISH') { score += 1; reasons.push('Daily trend mildly bullish'); }
  else if (trend === 'MILD_BEARISH') { score -= 1; reasons.push('Daily trend mildly bearish'); }

  // OI walls — distance to support and resistance asymmetry
  if (oiWalls?.resistance && oiWalls?.support) {
    const distToRes = oiWalls.resistance.strike - spot;
    const distToSup = spot - oiWalls.support.strike;
    if (distToSup < distToRes * 0.6) {
      score += 1;
      reasons.push(`Closer to OI support (${oiWalls.support.strike}) than resistance — bid likely`);
    } else if (distToRes < distToSup * 0.6) {
      score -= 1;
      reasons.push(`Closer to OI resistance (${oiWalls.resistance.strike}) — selling pressure likely`);
    }
  }

  // Max Pain magnetism (only relevant within ~2% of expiry)
  if (maxPain && Math.abs(spot - maxPain) / spot < 0.02) {
    if (maxPain > spot) {
      reasons.push(`Max pain ${maxPain} above spot — drift up bias toward expiry`);
      score += 0.5;
    } else if (maxPain < spot) {
      reasons.push(`Max pain ${maxPain} below spot — drift down bias toward expiry`);
      score -= 0.5;
    }
  }

  // Yesterday's range break
  if (ydHigh && spot > ydHigh) {
    score += 1;
    reasons.push(`Above yesterday's high (${ydHigh.toFixed(0)}) — breakout`);
  } else if (ydLow && spot < ydLow) {
    score -= 1;
    reasons.push(`Below yesterday's low (${ydLow.toFixed(0)}) — breakdown`);
  }

  // Translate score to bias
  let bias;
  if (score >= 2.5) bias = 'BULLISH';
  else if (score >= 1) bias = 'MILD_BULLISH';
  else if (score <= -2.5) bias = 'BEARISH';
  else if (score <= -1) bias = 'MILD_BEARISH';
  else bias = 'NEUTRAL';

  return { bias, score: Math.round(score * 10) / 10, reasons };
}

// Compute BUY zone: where to long if a pullback/setup forms
// Compute SELL zone: where to short if a rejection/breakdown forms
// Both use ATR-based stops and 2:1 R/R targets (intraday standard)
function computeTradeZones({ spot, pivots, oiWalls, atr, ydHigh, ydLow, bias }) {
  // Intraday ATR is roughly half the daily ATR (rough rule of thumb)
  const intradayAtr = atr * 0.5;

  // BUY ZONE: pullback to nearest support that's BELOW spot
  // Support candidates: PP, S1, OI Put strike, yesterday's low — pick highest one BELOW spot
  const supportCandidates = [
    { name: 'PP',  level: pivots.pp },
    { name: 'S1',  level: pivots.s1 },
    { name: 'S2',  level: pivots.s2 },
    { name: 'OI Put wall', level: oiWalls?.support?.strike },
    { name: 'Yesterday low', level: ydLow },
  ].filter(s => s.level && s.level < spot);

  // Sort by closeness to spot (closest below first)
  supportCandidates.sort((a, b) => b.level - a.level);
  const primarySupport = supportCandidates[0];

  // Resistance candidates: PP, R1, OI Call strike, yesterday's high — pick lowest one ABOVE spot
  const resistanceCandidates = [
    { name: 'PP',  level: pivots.pp },
    { name: 'R1',  level: pivots.r1 },
    { name: 'R2',  level: pivots.r2 },
    { name: 'OI Call wall', level: oiWalls?.resistance?.strike },
    { name: 'Yesterday high', level: ydHigh },
  ].filter(r => r.level && r.level > spot);
  resistanceCandidates.sort((a, b) => a.level - b.level);
  const primaryResistance = resistanceCandidates[0];

  // BUY ZONE setup
  let buyZone = null;
  if (primarySupport) {
    const entry = primarySupport.level;
    // Stop: 0.6× intraday ATR below entry, OR 0.3% below entry, whichever is wider
    // (keeps stop reasonable on choppy days)
    const stopPct = 0.003;
    const stop = Math.min(entry - intradayAtr * 0.6, entry * (1 - stopPct));
    const risk = entry - stop;
    // Target: nearest resistance, but capped at 2.5× risk (don't extend beyond 2.5R)
    let target;
    if (primaryResistance) {
      const rawTarget = primaryResistance.level;
      target = Math.min(rawTarget, entry + 2.5 * risk);
    } else {
      target = entry + 2 * risk; // fallback 2R
    }
    const reward = target - entry;
    const rrRatio = reward / risk;
    buyZone = {
      entry,
      stop,
      target,
      rrRatio,
      anchor: primarySupport.name,
      targetAnchor: primaryResistance?.name || '2× risk',
      riskPct: ((entry - stop) / entry * 100),
      rewardPct: ((target - entry) / entry * 100),
    };
  }

  // SELL ZONE setup (mirror)
  let sellZone = null;
  if (primaryResistance) {
    const entry = primaryResistance.level;
    const stopPct = 0.003;
    const stop = Math.max(entry + intradayAtr * 0.6, entry * (1 + stopPct));
    const risk = stop - entry;
    let target;
    if (primarySupport) {
      const rawTarget = primarySupport.level;
      target = Math.max(rawTarget, entry - 2.5 * risk);
    } else {
      target = entry - 2 * risk;
    }
    const reward = entry - target;
    const rrRatio = reward / risk;
    sellZone = {
      entry,
      stop,
      target,
      rrRatio,
      anchor: primaryResistance.name,
      targetAnchor: primarySupport?.name || '2× risk',
      riskPct: ((stop - entry) / entry * 100),
      rewardPct: ((entry - target) / entry * 100),
    };
  }

  return { buyZone, sellZone };
}

// Main entry point — build the full intraday playbook
async function buildPlaybook({ symbolKey, spotFetcher, historyFetcher, optionChainFetcher }) {
  // symbolKey: 'BANKNIFTY' or 'NIFTY'
  const indexSymbol = symbolKey === 'BANKNIFTY'
    ? 'NSE:NIFTYBANK-INDEX'
    : 'NSE:NIFTY50-INDEX';

  // Step 1: Get spot and recent quote
  const quote = await spotFetcher(indexSymbol).catch(() => null);
  if (!quote || !quote.lp) {
    return { error: 'No live quote available' };
  }

  // Step 2: Get daily candles for trend + yesterday's HLC + ATR
  const candles = await historyFetcher(indexSymbol, 'D', 250).catch(() => []);
  if (!Array.isArray(candles) || candles.length < 30) {
    return { error: `Insufficient daily history (${candles?.length || 0} candles)` };
  }
  const trendCtx = computeTrendContext(candles);

  // Yesterday's HLC = second-to-last candle (last candle = today, may be partial)
  // BUT if market hasn't opened yet, the last candle IS yesterday
  // Heuristic: if today's date > last candle's date, last candle is yesterday
  const todayDateIST = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
  const lastCandle = candles[candles.length - 1];
  const lastCandleDate = new Date(lastCandle.t * 1000).toISOString().slice(0, 10);
  const yesterdayCandle = lastCandleDate === todayDateIST
    ? candles[candles.length - 2]
    : lastCandle;
  if (!yesterdayCandle) {
    return { error: 'Could not identify yesterday\'s candle' };
  }
  const ydHigh = yesterdayCandle.h;
  const ydLow = yesterdayCandle.l;
  const ydClose = yesterdayCandle.c;

  // Step 3: Compute pivots
  const pivots = computePivots(ydHigh, ydLow, ydClose);

  // Step 4: Get option chain for OI walls + max pain (best-effort, may fail off-hours)
  let oiWalls = null, maxPain = null, pcr = null;
  try {
    const oc = await optionChainFetcher(symbolKey);
    if (oc && !oc.error) {
      oiWalls = oc.oiWalls;
      maxPain = oc.maxPain?.strike;
      pcr = oc.pcr;
    }
  } catch (e) { /* swallow — option chain optional */ }

  // Step 5: Determine bias
  const spot = quote.lp;
  const biasResult = determineBias({
    spot, pivots, oiWalls, maxPain,
    trend: trendCtx.trend,
    ydHigh, ydLow,
  });

  // Step 6: Compute trade zones
  const { buyZone, sellZone } = computeTradeZones({
    spot, pivots, oiWalls, atr: trendCtx.atr, ydHigh, ydLow, bias: biasResult.bias,
  });

  return {
    symbol: symbolKey,
    spot,
    spotChangePct: quote.chp ?? quote.changePct ?? null,
    timestamp: new Date().toISOString(),
    yesterday: { high: ydHigh, low: ydLow, close: ydClose },
    pivots,
    trend: {
      label: trendCtx.trend,
      dma20: trendCtx.dma20,
      dma50: trendCtx.dma50,
      atr: trendCtx.atr,
      rsi: trendCtx.rsi,
    },
    options: {
      oiWalls,
      maxPain,
      pcr,
    },
    bias: biasResult,
    buyZone,
    sellZone,
  };
}

module.exports = { buildPlaybook, computePivots, determineBias, computeTradeZones };
