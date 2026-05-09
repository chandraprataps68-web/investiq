// commodityTA.js — Technical analysis engine for MCX commodities
//
// Computes per-commodity swing-horizon signals (3-10 day hold) using
// daily continuous back-adjusted price series.
//
// Signal generation pipeline:
//   1. Trend: EMA20 vs EMA50 vs EMA200 alignment
//   2. Momentum: RSI(14) + MACD histogram
//   3. Volatility regime: ATR(14) vs its 50-day average
//   4. Key levels: recent swing high/low, 200-DMA, ATR-based S/R
//   5. Confidence: weighted aggregate of trend + momentum + vol agreement
//   6. Verdict: STRONG BUY / BUY / HOLD / SELL / STRONG SELL
//   7. Entry zone, target (ATR-based), stop (swing low/high)
//
// Filters at end: only emit BUY / SELL / STRONG variants with conf ≥75.
// HOLD verdicts are dropped.

const TA = require('./ta');

// Compute swing-horizon signal for a continuous candle series.
// Returns null if data insufficient or verdict is HOLD/conf < threshold.
function computeSwingSignal(candles, opts = {}) {
  // Tiered minimums:
  //   ≥220 → full TA with 200-DMA (ideal)
  //   ≥80  → reduced TA without 200-DMA (use EMA50 as longest)
  //   <80  → insufficient
  const HARD_MIN = 80;
  const FULL_MIN = 220;
  const confThreshold = opts.confThreshold ?? 75;
  if (!Array.isArray(candles) || candles.length < HARD_MIN) {
    return { skipped: true, reason: `insufficient data (${candles?.length || 0} candles, need ≥${HARD_MIN})` };
  }
  const fullMode = candles.length >= FULL_MIN;

  const closes = candles.map(c => c.c);
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  const last = candles[candles.length - 1];
  const lastClose = last.c;

  // ─── Trend indicators ─────────────────────────────────
  const ema20 = TA.ema(closes, 20);
  const ema50 = TA.ema(closes, 50);
  const ema200 = fullMode ? TA.ema(closes, 200) : null;

  const e20 = ema20[ema20.length - 1];
  const e50 = ema50[ema50.length - 1];
  const e200 = fullMode ? ema200[ema200.length - 1] : null;

  // Trend score: -3 to +3 in full mode, -2 to +2 in reduced mode
  let trendScore = 0;
  if (e20 > e50) trendScore += 1;
  if (lastClose > e20) trendScore += 1;
  if (e20 < e50) trendScore -= 1;
  if (lastClose < e20) trendScore -= 1;
  if (fullMode) {
    if (e50 > e200) trendScore += 1;
    if (e50 < e200) trendScore -= 1;
  }
  const trendMax = fullMode ? 3 : 2;

  // ─── Momentum: RSI ────────────────────────────────────
  const rsi = TA.rsi(closes, 14);
  const lastRsi = rsi[rsi.length - 1];
  // RSI score: -2 to +2
  // RSI 50-65 = mild bullish (+1)
  // RSI 65-75 = strong bullish but watch for overbought (+2)
  // RSI >75 = overbought (0, can mean reversal)
  // RSI 35-50 = mild bearish (-1)
  // RSI 25-35 = strong bearish (-2)
  // RSI <25 = oversold (0, can mean reversal)
  let rsiScore = 0;
  if (lastRsi > 75) rsiScore = 0;
  else if (lastRsi > 65) rsiScore = 2;
  else if (lastRsi > 55) rsiScore = 1;
  else if (lastRsi > 45) rsiScore = 0;
  else if (lastRsi > 35) rsiScore = -1;
  else if (lastRsi > 25) rsiScore = -2;
  else rsiScore = 0;

  // ─── Momentum: MACD ──────────────────────────────────
  const macdData = TA.macd(closes);
  const lastMacdHist = macdData.histogram[macdData.histogram.length - 1];
  const prevMacdHist = macdData.histogram[macdData.histogram.length - 2];
  // MACD score: -1 to +1
  // Histogram positive AND rising = +1
  // Histogram negative AND falling = -1
  let macdScore = 0;
  if (lastMacdHist > 0 && lastMacdHist > prevMacdHist) macdScore = 1;
  else if (lastMacdHist > 0) macdScore = 0.5;
  else if (lastMacdHist < 0 && lastMacdHist < prevMacdHist) macdScore = -1;
  else if (lastMacdHist < 0) macdScore = -0.5;

  // ─── Volatility regime ───────────────────────────────
  const atr = TA.atr(highs, lows, closes, 14);
  const lastAtr = atr[atr.length - 1];
  // 50-day avg of ATR for regime detection
  const recentAtrs = atr.slice(-50).filter(v => v != null);
  const avgAtr = recentAtrs.reduce((a, b) => a + b, 0) / recentAtrs.length;
  const volRatio = lastAtr / avgAtr;
  // Volatility regime classifier
  let volRegime;
  if (volRatio > 1.4) volRegime = 'EXPANDING';
  else if (volRatio < 0.7) volRegime = 'CONTRACTED';
  else volRegime = 'NORMAL';

  // ─── Aggregate score → confidence ────────────────────
  // Weights: trend 50%, momentum (RSI+MACD) 35%, volatility 15%
  // Each component scaled to -1..+1 then weighted.
  const trendNorm = trendScore / trendMax;
  const momNorm = (rsiScore + macdScore) / 3;
  const volBoost = volRegime === 'EXPANDING' ? 0.15 : volRegime === 'CONTRACTED' ? -0.05 : 0;

  // Combined score -1 to +1
  let combined = trendNorm * 0.5 + momNorm * 0.35
    + Math.sign(trendNorm) * volBoost; // expanding vol amplifies the trend signal

  // Alignment bonus: when trend AND momentum point same direction strongly,
  // boost confidence. Without this, mid-grade signals top out around 0.5
  // even when real-world signals would warrant high confidence.
  if (Math.sign(trendNorm) === Math.sign(momNorm) && Math.abs(trendNorm) >= 0.66 && Math.abs(momNorm) >= 0.5) {
    combined *= 1.35; // 35% boost for clean alignment
  }
  // Clamp to [-1, 1]
  combined = Math.max(-1, Math.min(1, combined));

  // Confidence: how strong is the agreement?
  // |combined| close to 1 → high confidence; close to 0 → low (HOLD)
  const confidence = Math.round(Math.abs(combined) * 100);

  // Verdict
  let verdict;
  if (combined > 0.6) verdict = 'STRONG BUY';
  else if (combined > 0.3) verdict = 'BUY';
  else if (combined < -0.6) verdict = 'STRONG SELL';
  else if (combined < -0.3) verdict = 'SELL';
  else verdict = 'HOLD';

  // ─── Filter: only emit BUY/SELL with conf ≥ threshold ──
  if (verdict === 'HOLD') return { skipped: true, reason: 'HOLD verdict' };
  if (confidence < confThreshold) return { skipped: true, reason: `confidence ${confidence} < ${confThreshold}` };

  // ─── Compute targets and stops based on ATR ─────────
  // Swing horizon: target = 2x ATR, stop = 1.2x ATR (≈1.67 R/R)
  const atrMultTarget = 2.0;
  const atrMultStop = 1.2;
  let target, stop, entryLow, entryHigh;
  if (verdict.includes('BUY')) {
    entryLow = lastClose - lastAtr * 0.3;  // entry zone: -0.3 ATR to +0.1 ATR
    entryHigh = lastClose + lastAtr * 0.1;
    target = lastClose + lastAtr * atrMultTarget;
    stop = lastClose - lastAtr * atrMultStop;
  } else {
    entryLow = lastClose - lastAtr * 0.1;
    entryHigh = lastClose + lastAtr * 0.3;
    target = lastClose - lastAtr * atrMultTarget;
    stop = lastClose + lastAtr * atrMultStop;
  }

  // ─── Build human-readable reasoning ─────────────────
  const reasons = [];
  if (fullMode) {
    if (e20 > e50 && e50 > e200) reasons.push('20/50/200 EMA stacked bullish');
    else if (e20 < e50 && e50 < e200) reasons.push('20/50/200 EMA stacked bearish');
    else if (e20 > e50) reasons.push('Short-term trend bullish (EMA20>EMA50)');
    else if (e20 < e50) reasons.push('Short-term trend bearish (EMA20<EMA50)');
  } else {
    if (e20 > e50) reasons.push('Short-term trend bullish (EMA20>EMA50)');
    else if (e20 < e50) reasons.push('Short-term trend bearish (EMA20<EMA50)');
    reasons.push(`Reduced TA mode (only ${candles.length} candles, no 200-DMA)`);
  }

  if (lastRsi > 65 && lastRsi < 75) reasons.push(`RSI ${lastRsi.toFixed(0)} — momentum strong`);
  else if (lastRsi > 75) reasons.push(`RSI ${lastRsi.toFixed(0)} — overbought, watch reversal`);
  else if (lastRsi < 35 && lastRsi > 25) reasons.push(`RSI ${lastRsi.toFixed(0)} — momentum weak`);
  else if (lastRsi < 25) reasons.push(`RSI ${lastRsi.toFixed(0)} — oversold, watch reversal`);
  else reasons.push(`RSI ${lastRsi.toFixed(0)} — neutral momentum`);

  if (macdScore >= 0.5) reasons.push('MACD histogram positive & expanding');
  else if (macdScore <= -0.5) reasons.push('MACD histogram negative & expanding');

  if (volRegime === 'EXPANDING') reasons.push('Volatility expanding — trend may accelerate');
  else if (volRegime === 'CONTRACTED') reasons.push('Volatility contracted — moves likely small');

  // Risk/reward
  const rrRatio = Math.abs((target - lastClose) / (lastClose - stop));

  return {
    verdict,
    confidence,
    horizon: 'SWING',
    holdDays: '3-10',
    price: lastClose,
    entryLow, entryHigh,
    target, stop,
    rrRatio,
    atr: lastAtr,
    rsi: lastRsi,
    volRegime,
    trendScore,
    reasons,
  };
}

// Run signal computation across multiple commodities. Returns ranked list,
// only including signals that passed the filter (BUY/SELL with conf≥75).
async function scanCommodities(commodityList, getSeriesFn, opts = {}) {
  const results = [];
  for (const c of commodityList) {
    try {
      const series = await getSeriesFn(c.base, c.exchange);
      if (!series || series.length < 80) {
        results.push({ symbol: c.base, name: c.name, skipped: true, reason: `insufficient data (${series?.length || 0} candles)` });
        continue;
      }
      const sig = computeSwingSignal(series, opts);
      if (sig.skipped) {
        results.push({ symbol: c.base, name: c.name, skipped: true, reason: sig.reason });
      } else {
        results.push({ symbol: c.base, name: c.name, ...sig, fullMode: series.length >= 220 });
      }
    } catch (e) {
      console.error(`[commodityTA] ${c.base} failed:`, e.message);
      results.push({ symbol: c.base, name: c.name, skipped: true, reason: e.message });
    }
  }

  // Separate signals from skips
  const signals = results.filter(r => !r.skipped)
    .sort((a, b) => b.confidence - a.confidence);
  const skipped = results.filter(r => r.skipped);

  return { signals, skipped, total: results.length };
}

module.exports = { computeSwingSignal, scanCommodities };
