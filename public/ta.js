// ta.js — Technical Analysis engine for InvestIQ Pro v6
// All indicators computed from OHLCV arrays. No external libs.

// candles = [{ t, o, h, l, c, v }, ...]   sorted oldest -> newest

const sma = (arr, n) => {
  if (arr.length < n) return null;
  const slice = arr.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / n;
};

const ema = (arr, n) => {
  if (arr.length < n) return null;
  const k = 2 / (n + 1);
  let e = arr.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
};

// Full EMA series (for MACD)
const emaSeries = (arr, n) => {
  if (arr.length < n) return [];
  const k = 2 / (n + 1);
  const out = new Array(arr.length).fill(null);
  let e = arr.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = e;
  for (let i = n; i < arr.length; i++) {
    e = arr[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
};

const rsi = (closes, period = 14) => {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgG = gains / period;
  let avgL = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
  }
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
};

const macd = (closes, fast = 12, slow = 26, signal = 9) => {
  if (closes.length < slow + signal) return null;
  const fastE = emaSeries(closes, fast);
  const slowE = emaSeries(closes, slow);
  const macdLine = closes.map((_, i) =>
    fastE[i] != null && slowE[i] != null ? fastE[i] - slowE[i] : null
  );
  const valid = macdLine.filter((v) => v != null);
  const signalE = emaSeries(valid, signal);
  const signalVal = signalE[signalE.length - 1];
  const macdVal = macdLine[macdLine.length - 1];
  return {
    macd: macdVal,
    signal: signalVal,
    histogram: macdVal - signalVal,
    bullish: macdVal > signalVal,
  };
};

const bollinger = (closes, n = 20, k = 2) => {
  if (closes.length < n) return null;
  const slice = closes.slice(-n);
  const mid = slice.reduce((a, b) => a + b, 0) / n;
  const variance = slice.reduce((a, b) => a + (b - mid) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  return { upper: mid + k * sd, middle: mid, lower: mid - k * sd };
};

const atr = (candles, period = 14) => {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
};

// Support/Resistance — pivot-based, last N bars
const findSR = (candles, lookback = 60) => {
  const slice = candles.slice(-lookback);
  const highs = slice.map((c) => c.h).sort((a, b) => b - a);
  const lows = slice.map((c) => c.l).sort((a, b) => a - b);
  return {
    resistance: highs.slice(0, 3),
    support: lows.slice(0, 3),
  };
};

// Volume surge — today's vol vs 20-day average
const volumeSurge = (candles) => {
  if (candles.length < 21) return null;
  const today = candles[candles.length - 1].v;
  const avg20 = candles.slice(-21, -1).reduce((a, c) => a + c.v, 0) / 20;
  return { ratio: today / avg20, today, avg20 };
};

// 52-week high/low metrics
const fiftyTwoWeek = (candles) => {
  // ~252 trading days
  const slice = candles.slice(-252);
  if (slice.length === 0) return null;
  const high = Math.max(...slice.map((c) => c.h));
  const low = Math.min(...slice.map((c) => c.l));
  const last = slice[slice.length - 1].c;
  return {
    high,
    low,
    distFromHighPct: ((high - last) / high) * 100, // 0 = at high
    distFromLowPct: ((last - low) / low) * 100,
    pthRatio: last / high, // George-Hwang Price-To-High
  };
};

// Minervini Trend Template — institutional momentum filter
// Returns { pass: bool, score: 0-8, checks: {...} }
const trendTemplate = (candles) => {
  const closes = candles.map((c) => c.c);
  const last = closes[closes.length - 1];
  const e50 = ema(closes, 50);
  const e150 = ema(closes, 150);
  const e200 = ema(closes, 200);
  const ftw = fiftyTwoWeek(candles);

  if (!e50 || !e150 || !e200 || !ftw) {
    return { pass: false, score: 0, checks: {}, reason: 'insufficient data' };
  }

  // 200 EMA slope: compare to 22 bars ago
  let e200Slope = 0;
  if (candles.length >= 222) {
    const e200Past = ema(closes.slice(0, -22), 200);
    e200Slope = e200Past ? ((e200 - e200Past) / e200Past) * 100 : 0;
  }

  const checks = {
    priceAbove50: last > e50,
    priceAbove150: last > e150,
    priceAbove200: last > e200,
    e50Above150: e50 > e150,
    e150Above200: e150 > e200,
    e200Rising: e200Slope > 0,
    priceWithin25PctOf52WH: ftw.distFromHighPct <= 25,
    priceAbove30PctFrom52WL: ftw.distFromLowPct >= 30,
  };

  const passed = Object.values(checks).filter(Boolean).length;
  return {
    pass: passed === 8,
    score: passed,
    checks,
    metrics: { e50, e150, e200, e200Slope, ...ftw },
  };
};

// Compute everything we need for a stock in one shot
const fullAnalysis = (candles) => {
  if (!candles || candles.length < 30) {
    return { ok: false, reason: 'insufficient candles' };
  }
  const closes = candles.map((c) => c.c);
  const last = candles[candles.length - 1];

  return {
    ok: true,
    price: last.c,
    rsi14: rsi(closes, 14),
    macd: macd(closes),
    bb: bollinger(closes),
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    atr14: atr(candles, 14),
    sr: findSR(candles),
    volume: volumeSurge(candles),
    ftw: fiftyTwoWeek(candles),
    trend: trendTemplate(candles),
  };
};

// Generate signal + target/stop/horizon based on full analysis
// Confidence weighting: trend template 40%, RSI 15%, MACD 15%,
// volume 15%, BB position 15%
const generateSignal = (analysis) => {
  if (!analysis.ok) return { signal: 'NO DATA', confidence: 0 };

  const { price, rsi14, macd: m, bb, atr14, sr, volume, trend, ftw } = analysis;

  // Bullish score 0-100
  let bull = 0;
  let bear = 0;

  // Trend template (40 pts)
  if (trend.pass) bull += 40;
  else if (trend.score >= 6) bull += 25;
  else if (trend.score >= 4) bull += 10;
  else if (trend.score <= 2) bear += 30;

  // RSI (15 pts)
  if (rsi14 != null) {
    if (rsi14 > 50 && rsi14 < 70) bull += 15;
    else if (rsi14 >= 70 && rsi14 < 80) bull += 8; // strong but extended
    else if (rsi14 >= 80) bear += 5; // overbought risk
    else if (rsi14 < 50 && rsi14 > 30) bear += 10;
    else if (rsi14 <= 30) bear += 15;
  }

  // MACD (15 pts)
  if (m) {
    if (m.bullish && m.histogram > 0) bull += 15;
    else if (m.bullish) bull += 8;
    else if (!m.bullish && m.histogram < 0) bear += 15;
    else bear += 8;
  }

  // Volume surge (15 pts) — only credit if price is also up
  if (volume && volume.ratio > 1.5) {
    // need price direction context: up move on high vol = bullish
    bull += 15;
  } else if (volume && volume.ratio < 0.5) {
    bear += 5; // weak conviction
  }

  // Bollinger position (15 pts)
  if (bb) {
    const pct = (price - bb.lower) / (bb.upper - bb.lower);
    if (pct > 0.8) bull += 10; // near upper band, in trend
    else if (pct < 0.2) bear += 10;
    else bull += 5;
  }

  // 52WH proximity bonus
  if (ftw && ftw.distFromHighPct < 5) bull += 5;
  if (ftw && ftw.distFromLowPct < 10) bear += 5;

  const net = bull - bear;
  const confidence = Math.min(100, Math.max(0, Math.abs(net)));

  let signal;
  if (net >= 60) signal = 'STRONG BUY';
  else if (net >= 25) signal = 'BUY';
  else if (net <= -60) signal = 'STRONG SELL';
  else if (net <= -25) signal = 'SELL';
  else signal = 'HOLD';

  // Targets/stops based on ATR + S/R
  // Three horizons: intraday (1d), swing (3-10d), positional (10-60d)
  const targets = {};
  if (atr14 && (signal === 'BUY' || signal === 'STRONG BUY')) {
    targets.intraday = {
      target: +(price + 1.5 * atr14).toFixed(2),
      stop: +(price - 1.0 * atr14).toFixed(2),
      horizon: '1 day',
    };
    targets.swing = {
      target: +(price + 3.0 * atr14).toFixed(2),
      stop: +(price - 1.5 * atr14).toFixed(2),
      horizon: '3-10 days',
    };
    // Positional uses next resistance level if within reach, else 5x ATR
    const nearestR = sr.resistance.find((r) => r > price) || price + 5 * atr14;
    targets.positional = {
      target: +Math.min(nearestR, price + 8 * atr14).toFixed(2),
      stop: +(price - 2.5 * atr14).toFixed(2),
      horizon: '10-60 days',
    };
  } else if (atr14 && (signal === 'SELL' || signal === 'STRONG SELL')) {
    targets.intraday = {
      target: +(price - 1.5 * atr14).toFixed(2),
      stop: +(price + 1.0 * atr14).toFixed(2),
      horizon: '1 day',
    };
    targets.swing = {
      target: +(price - 3.0 * atr14).toFixed(2),
      stop: +(price + 1.5 * atr14).toFixed(2),
      horizon: '3-10 days',
    };
    const nearestS = sr.support.find((s) => s < price) || price - 5 * atr14;
    targets.positional = {
      target: +Math.max(nearestS, price - 8 * atr14).toFixed(2),
      stop: +(price + 2.5 * atr14).toFixed(2),
      horizon: '10-60 days',
    };
  }

  return {
    signal,
    confidence,
    bullScore: bull,
    bearScore: bear,
    netScore: net,
    targets,
    rationale: buildRationale(analysis, signal),
  };
};

const buildRationale = (a, signal) => {
  const reasons = [];
  if (a.trend.pass) reasons.push('All 8 trend-template checks passed');
  else if (a.trend.score >= 5) reasons.push(`Trend template ${a.trend.score}/8`);
  if (a.rsi14 > 70) reasons.push(`RSI ${a.rsi14.toFixed(0)} (strong but extended)`);
  else if (a.rsi14 < 30) reasons.push(`RSI ${a.rsi14.toFixed(0)} (oversold)`);
  if (a.macd && a.macd.bullish) reasons.push('MACD bullish crossover');
  if (a.macd && !a.macd.bullish) reasons.push('MACD bearish');
  if (a.volume && a.volume.ratio > 1.5) reasons.push(`Volume ${a.volume.ratio.toFixed(1)}x avg`);
  if (a.ftw && a.ftw.distFromHighPct < 5) reasons.push('Within 5% of 52W high');
  if (a.ftw && a.ftw.distFromLowPct < 10) reasons.push('Within 10% of 52W low');
  return reasons;
};

module.exports = {
  sma, ema, emaSeries, rsi, macd, bollinger, atr,
  findSR, volumeSurge, fiftyTwoWeek, trendTemplate,
  fullAnalysis, generateSignal,
};
