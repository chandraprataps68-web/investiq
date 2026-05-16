// confluence.js — Per-stock Confluence Score (0-100)
//
// Combines five independently-meaningful signals into a single auditable score:
//
//   30%  CHART STRUCTURE    — trend template, S/R proximity, multi-TF alignment
//   25%  BIAS ALIGNMENT     — does this stock's signal match today's pre-market bias
//   15%  NEWS CATALYST      — do today's catalysts favor/oppose the trade direction
//   20%  TECHNICAL SIGNALS  — RSI, MACD, volume confirmation
//   10%  LIQUIDITY          — volume × 20d avg, range position
//
// Each component returns 0-100. Final = weighted average.
// We always expose the breakdown — never just the number — so the score is
// auditable and tunable from feedback rather than a black box.

// Sector mapping: which NSE stocks are affected by which news catalyst categories.
// Used by the catalyst scorer. Not exhaustive — covers major Nifty/F&O names.
const STOCK_SECTOR = {
  // Energy / Oil
  RELIANCE: 'energy',     ONGC: 'energy',    BPCL: 'energy',     IOC: 'energy',
  HINDPETRO: 'energy',    GAIL: 'energy',    OIL: 'energy',      PETRONET: 'energy',
  IGL: 'energy',          MGL: 'energy',     GUJGASLTD: 'energy',
  ADANIGREEN: 'energy',   TATAPOWER: 'energy', NTPC: 'energy',   POWERGRID: 'energy',
  // Banks / Financials (interest rate sensitive)
  HDFCBANK: 'banking',    ICICIBANK: 'banking', SBIN: 'banking', AXISBANK: 'banking',
  KOTAKBANK: 'banking',   INDUSINDBK: 'banking', BANKBARODA: 'banking',
  PNB: 'banking',         FEDERALBNK: 'banking', AUBANK: 'banking',
  BAJFINANCE: 'financial', BAJAJFINSV: 'financial', SBICARD: 'financial',
  CHOLAFIN: 'financial',  SHRIRAMFIN: 'financial', HDFCAMC: 'financial',
  LICI: 'financial',      LICHSGFIN: 'financial',
  // IT (rupee/dollar sensitive, US economy sensitive)
  TCS: 'it',              INFY: 'it',         WIPRO: 'it',        HCLTECH: 'it',
  TECHM: 'it',            LTIM: 'it',         LTTS: 'it',         MPHASIS: 'it',
  PERSISTENT: 'it',       COFORGE: 'it',      KPITTECH: 'it',     OFSS: 'it',
  // Metals (commodity / China demand)
  TATASTEEL: 'metals',    JSWSTEEL: 'metals', HINDALCO: 'metals', VEDL: 'metals',
  COALINDIA: 'metals',    NMDC: 'metals',     SAIL: 'metals',     JINDALSTEL: 'metals',
  HINDZINC: 'metals',     NATIONALUM: 'metals', HINDCOPPER: 'metals',
  // Auto
  MARUTI: 'auto',         TATAMOTORS: 'auto', M_M: 'auto',        'M&M': 'auto',
  BAJAJ_AUTO: 'auto',     'BAJAJ-AUTO': 'auto', HEROMOTOCO: 'auto', EICHERMOT: 'auto',
  TVSMOTOR: 'auto',       ASHOKLEY: 'auto',   MOTHERSON: 'auto',  BOSCHLTD: 'auto',
  // Pharma
  SUNPHARMA: 'pharma',    CIPLA: 'pharma',    DRREDDY: 'pharma',  DIVISLAB: 'pharma',
  LUPIN: 'pharma',        AUROPHARMA: 'pharma', TORNTPHARM: 'pharma',
  BIOCON: 'pharma',       ALKEM: 'pharma',    ZYDUSLIFE: 'pharma',
  // FMCG
  HINDUNILVR: 'fmcg',     ITC: 'fmcg',        NESTLEIND: 'fmcg',  BRITANNIA: 'fmcg',
  DABUR: 'fmcg',          GODREJCP: 'fmcg',   TATACONSUM: 'fmcg', COLPAL: 'fmcg',
  // Cement
  ULTRACEMCO: 'cement',   SHREECEM: 'cement', AMBUJACEM: 'cement', ACC: 'cement',
  DALBHARAT: 'cement',    RAMCOCEM: 'cement', JKCEMENT: 'cement',
  // Consumer durables / retail
  TITAN: 'consumer',      ASIANPAINT: 'consumer', BERGEPAINT: 'consumer',
  TRENT: 'retail',        DMART: 'retail',    POLYCAB: 'consumer', HAVELLS: 'consumer',
  CROMPTON: 'consumer',   VOLTAS: 'consumer', DIXON: 'consumer',
  // Telecom
  BHARTIARTL: 'telecom',  IDEA: 'telecom',    INDUSTOWER: 'telecom',
};

// Map catalyst category → which sectors are most affected
const CATALYST_SECTOR_IMPACT = {
  energy:        { energy: 'high', auto: 'medium', metals: 'low', fmcg: 'low' },
  geopolitical:  { energy: 'high', metals: 'medium', banking: 'low' },
  monetary:      { banking: 'high', financial: 'high', auto: 'medium', consumer: 'medium' },
  trade:         { it: 'high', pharma: 'medium', metals: 'medium', auto: 'medium' },
  india_macro:   { banking: 'medium', auto: 'medium', consumer: 'medium', fmcg: 'low' },
  market_event:  { banking: 'high', financial: 'high', it: 'medium' }, // broad markets
  index_heavy:   {}, // not sector-specific
};

// ─── Component 1: Chart Structure (30%) ─────────
//
// Three sub-signals averaged:
//   a) trend template score (0-8 → 0-100)
//   b) S/R zone proximity — closer to a strong zone = more actionable
//   c) trend direction strength based on EMAs
function scoreChartStructure({ analysis, zones }) {
  const subs = {};

  // a) Trend template (already scored 0-8)
  const trendScore = analysis?.trend?.score ?? 0;
  subs.trendTemplate = Math.round((trendScore / 8) * 100);

  // b) Proximity to nearest strong zone — closer = more actionable.
  // The closest zone within 5% = 100 score, decays linearly to 0% at 15%.
  // No zones found = 50 (neutral).
  if (zones?.zones?.length > 0) {
    const nearest = zones.zones[0]; // zones array is pre-sorted by distance
    const dist = nearest.distancePct ?? 999;
    if (dist <= 1) subs.zoneProximity = 100;
    else if (dist <= 5) subs.zoneProximity = Math.round(100 - (dist - 1) * 10);
    else if (dist <= 15) subs.zoneProximity = Math.round(60 - (dist - 5) * 6);
    else subs.zoneProximity = 0;
  } else {
    subs.zoneProximity = 50;
  }

  // c) Multi-timeframe trend alignment.
  // Approximated via EMA ladder: price > 20EMA > 50EMA > 200EMA = strong uptrend (100)
  // Price > 20EMA > 50EMA, but 50<200 = mixed (50)
  // All inverted = strong downtrend (100 for bearish trade)
  const price = analysis?.price;
  const e20 = analysis?.ema20?.slice(-1)?.[0];
  const e50 = analysis?.ema50?.slice(-1)?.[0];
  const e200 = analysis?.ema200?.slice(-1)?.[0];
  if (price && e20 && e50 && e200) {
    const stronglyUp = price > e20 && e20 > e50 && e50 > e200;
    const stronglyDown = price < e20 && e20 < e50 && e50 < e200;
    const partialUp = price > e20 && e20 > e50;
    const partialDown = price < e20 && e20 < e50;
    if (stronglyUp || stronglyDown) subs.mtfAlignment = 100;
    else if (partialUp || partialDown) subs.mtfAlignment = 65;
    else subs.mtfAlignment = 35;
  } else {
    subs.mtfAlignment = 50;
  }

  const composite = Math.round((subs.trendTemplate + subs.zoneProximity + subs.mtfAlignment) / 3);
  return { score: composite, breakdown: subs };
}

// ─── Component 2: Bias Alignment (25%) ─────────
//
// Stock direction × Market bias direction.
// Strong alignment → 100. Opposed → 0. Either neutral → 50.
function scoreBiasAlignment({ signal, biasObj }) {
  // Stock direction: +2 strong buy, +1 buy, 0 hold, -1 sell, -2 strong sell
  const stockMap = { 'STRONG BUY': 2, 'BUY': 1, 'HOLD': 0, 'SELL': -1, 'STRONG SELL': -2 };
  const stockDir = stockMap[signal?.signal] ?? 0;

  // Bias direction: from bias object {bias: 'BULLISH'/'BEARISH'/'NEUTRAL'/'INSUFFICIENT_DATA', score: N}
  const biasStr = biasObj?.bias;
  let biasDir = 0;
  if (biasStr === 'BULLISH') biasDir = 1;
  else if (biasStr === 'BEARISH') biasDir = -1;
  else if (biasStr === 'NEUTRAL') biasDir = 0;
  else biasDir = null; // INSUFFICIENT_DATA — can't score alignment

  if (biasDir === null) {
    return { score: 50, breakdown: { reason: 'no bias available' } };
  }

  // Perfect alignment: same sign, both strong → 100
  // Opposite signs → 0 (fighting the market)
  // Neutral bias → 50 (no helpful info)
  let score;
  if (biasDir === 0) {
    // Neutral market, slight credit if stock has strong direction (own conviction)
    score = 50 + Math.abs(stockDir) * 5;
  } else {
    // Sign match → multiply, normalize
    const product = biasDir * stockDir; // -4 to +4
    score = 50 + product * 12.5; // -50 to +50 → 0 to 100
  }
  score = Math.max(0, Math.min(100, score));

  return {
    score: Math.round(score),
    breakdown: {
      stockSignal: signal?.signal || 'unknown',
      stockDir,
      marketBias: biasStr || 'unknown',
      biasDir,
    },
  };
}

// ─── Component 3: News Catalyst Impact (15%) ─────────
//
// Are today's catalysts in sectors that affect this stock?
// And do they favor or oppose our trade direction?
function scoreCatalysts({ symbol, catalysts, signal }) {
  if (!catalysts?.catalysts || catalysts.catalysts.length === 0) {
    return { score: 50, breakdown: { reason: 'no catalysts detected' } };
  }

  const sector = STOCK_SECTOR[symbol?.toUpperCase()];
  if (!sector) {
    // We don't know this stock's sector — assume catalysts are neutral
    return { score: 50, breakdown: { reason: `sector unknown for ${symbol}` } };
  }

  // Find catalysts affecting this sector
  const affecting = [];
  for (const cat of catalysts.catalysts) {
    const impactMap = CATALYST_SECTOR_IMPACT[cat.category] || {};
    const impactLevel = impactMap[sector]; // 'high' / 'medium' / 'low' / undefined
    if (impactLevel) {
      affecting.push({ ...cat, sectorImpact: impactLevel });
    }
  }

  if (affecting.length === 0) {
    return { score: 60, breakdown: { sector, reason: 'no relevant catalysts' } };
  }

  // We have catalysts affecting our sector. We can't determine direction with
  // certainty (would need LLM or sophisticated NLP). Conservative approach:
  // affecting catalysts INCREASE uncertainty, which lowers score.
  // Higher impact = more uncertainty.
  let uncertainty = 0;
  for (const c of affecting) {
    if (c.sectorImpact === 'high') uncertainty += 25;
    else if (c.sectorImpact === 'medium') uncertainty += 15;
    else uncertainty += 8;
  }
  const score = Math.max(20, Math.min(80, 70 - uncertainty));

  return {
    score: Math.round(score),
    breakdown: {
      sector,
      affectingCatalysts: affecting.map(c => `${c.category}(${c.sectorImpact})`).join(', '),
    },
  };
}

// ─── Component 4: Technical Signals (20%) ─────────
//
// RSI position + MACD state + volume × confirmation.
function scoreTechnicals({ analysis, signal }) {
  const subs = {};

  // RSI: 30-70 is healthy range. Extremes warrant caution (could be reversal point).
  // For a BUY signal: RSI 50-70 is ideal (momentum but room to run).
  // For a SELL signal: RSI 30-50 ideal.
  const rsi = analysis?.rsi14;
  const isBullishTrade = signal?.signal === 'STRONG BUY' || signal?.signal === 'BUY';
  const isBearishTrade = signal?.signal === 'STRONG SELL' || signal?.signal === 'SELL';
  if (rsi == null) {
    subs.rsi = 50;
  } else if (isBullishTrade) {
    if (rsi >= 55 && rsi <= 70) subs.rsi = 100;        // sweet spot
    else if (rsi >= 50 && rsi < 55) subs.rsi = 80;      // building momentum
    else if (rsi > 70 && rsi <= 80) subs.rsi = 60;      // momentum strong but extended
    else if (rsi > 80) subs.rsi = 30;                    // overbought, reversal risk
    else if (rsi >= 45 && rsi < 50) subs.rsi = 60;      // neutral
    else if (rsi >= 35 && rsi < 45) subs.rsi = 40;      // weakening
    else subs.rsi = 20;                                  // oversold but bullish trade is fighting tape
  } else if (isBearishTrade) {
    if (rsi >= 30 && rsi <= 45) subs.rsi = 100;
    else if (rsi >= 45 && rsi < 50) subs.rsi = 80;
    else if (rsi >= 20 && rsi < 30) subs.rsi = 60;
    else if (rsi < 20) subs.rsi = 30;
    else if (rsi >= 50 && rsi < 55) subs.rsi = 60;
    else if (rsi >= 55 && rsi < 65) subs.rsi = 40;
    else subs.rsi = 20;
  } else {
    subs.rsi = 50;
  }

  // MACD: bullish crossover = good for buys, bearish = good for sells.
  const macdBullish = analysis?.macd?.bullish;
  if (macdBullish == null) {
    subs.macd = 50;
  } else if (isBullishTrade && macdBullish) subs.macd = 90;
  else if (isBullishTrade && !macdBullish) subs.macd = 30;
  else if (isBearishTrade && !macdBullish) subs.macd = 90;
  else if (isBearishTrade && macdBullish) subs.macd = 30;
  else subs.macd = 50;

  // Volume confirmation: high relative volume = participation behind the move
  const volRatio = analysis?.volume?.ratio;
  if (volRatio == null) {
    subs.volume = 50;
  } else if (volRatio >= 2) subs.volume = 100;   // 2× avg or more = strong participation
  else if (volRatio >= 1.5) subs.volume = 85;
  else if (volRatio >= 1.0) subs.volume = 65;
  else if (volRatio >= 0.7) subs.volume = 45;
  else subs.volume = 25;                          // very low volume = unconvincing

  const composite = Math.round((subs.rsi + subs.macd + subs.volume) / 3);
  return { score: composite, breakdown: subs };
}

// ─── Component 5: Liquidity (10%) ─────────
//
// Two checks:
//   a) Recent volume vs 20d average (already used in technical, but here we care
//      about absolute liquidity for execution, not signal confirmation)
//   b) 52W position — extreme positions (near 52WH or 52WL) without confirmation
//      mean wider spreads and more slippage
function scoreLiquidity({ analysis }) {
  const subs = {};

  // Volume × 20d avg — basic liquidity gate
  const volRatio = analysis?.volume?.ratio;
  if (volRatio == null) subs.volume = 50;
  else if (volRatio >= 0.8) subs.volume = 100;   // normal+ volume = good liquidity
  else if (volRatio >= 0.5) subs.volume = 70;
  else if (volRatio >= 0.3) subs.volume = 40;
  else subs.volume = 20;                          // very thin

  // 52W position — mid-range = best execution
  const distHigh = analysis?.ftw?.distFromHighPct;
  const distLow = analysis?.ftw?.distFromLowPct;
  if (distHigh == null || distLow == null) {
    subs.rangePosition = 50;
  } else {
    // Avoid extreme positions (< 3% from 52W high or low)
    if (distHigh < 3 || distLow < 3) subs.rangePosition = 50; // wider spreads near extremes
    else if (distHigh < 10 || distLow < 10) subs.rangePosition = 75;
    else subs.rangePosition = 90;
  }

  const composite = Math.round((subs.volume + subs.rangePosition) / 2);
  return { score: composite, breakdown: subs };
}

// ─── Main: compute full Confluence ─────────
function computeConfluence({ symbol, analysis, signal, zones, biasObj, catalysts }) {
  const chart = scoreChartStructure({ analysis, zones });
  const bias = scoreBiasAlignment({ signal, biasObj });
  const cat = scoreCatalysts({ symbol, catalysts, signal });
  const tech = scoreTechnicals({ analysis, signal });
  const liq = scoreLiquidity({ analysis });

  const score = Math.round(
    chart.score * 0.30 +
    bias.score  * 0.25 +
    cat.score   * 0.15 +
    tech.score  * 0.20 +
    liq.score   * 0.10
  );

  const tier =
    score >= 85 ? 'S' :
    score >= 70 ? 'A' :
    score >= 55 ? 'B' :
    score >= 40 ? 'C' : 'D';

  return {
    score,
    tier,
    components: {
      chartStructure: { score: chart.score, weight: 30, breakdown: chart.breakdown },
      biasAlignment:  { score: bias.score,  weight: 25, breakdown: bias.breakdown },
      catalystImpact: { score: cat.score,   weight: 15, breakdown: cat.breakdown },
      technicals:     { score: tech.score,  weight: 20, breakdown: tech.breakdown },
      liquidity:      { score: liq.score,   weight: 10, breakdown: liq.breakdown },
    },
  };
}

module.exports = { computeConfluence, STOCK_SECTOR, CATALYST_SECTOR_IMPACT };
