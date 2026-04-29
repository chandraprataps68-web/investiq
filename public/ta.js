// ═══════════════════════════════════════════════════════════
//  InvestIQ Pro — Technical Analysis Engine
//  Pure math. No AI. Real indicators from real price data.
// ═══════════════════════════════════════════════════════════

const TA = {
  // ─── Simple Moving Average ───────────────────────────
  sma(data, period) {
    const result = [];
    for (let i = 0; i < data.length; i++) {
      if (i < period - 1) { result.push(null); continue; }
      let sum = 0;
      for (let j = 0; j < period; j++) sum += data[i - j];
      result.push(sum / period);
    }
    return result;
  },

  // ─── Exponential Moving Average ──────────────────────
  ema(data, period) {
    const result = [];
    const k = 2 / (period + 1);
    let prev = null;
    for (let i = 0; i < data.length; i++) {
      if (i < period - 1) { result.push(null); continue; }
      if (prev === null) {
        // First EMA = SMA of first 'period' values
        let sum = 0;
        for (let j = 0; j < period; j++) sum += data[i - j];
        prev = sum / period;
      } else {
        prev = data[i] * k + prev * (1 - k);
      }
      result.push(prev);
    }
    return result;
  },

  // ─── RSI (Relative Strength Index) ──────────────────
  rsi(closes, period = 14) {
    const result = [];
    let avgGain = 0, avgLoss = 0;
    for (let i = 0; i < closes.length; i++) {
      if (i === 0) { result.push(null); continue; }
      const change = closes[i] - closes[i - 1];
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? -change : 0;

      if (i < period) {
        avgGain += gain;
        avgLoss += loss;
        result.push(null);
        continue;
      }
      if (i === period) {
        avgGain = (avgGain + gain) / period;
        avgLoss = (avgLoss + loss) / period;
      } else {
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
      }
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      result.push(100 - (100 / (1 + rs)));
    }
    return result;
  },

  // ─── MACD (Moving Average Convergence Divergence) ────
  macd(closes, fast = 12, slow = 26, signal = 9) {
    const emaFast = this.ema(closes, fast);
    const emaSlow = this.ema(closes, slow);
    const macdLine = closes.map((_, i) =>
      emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
    );
    // Signal line = EMA of MACD line
    const validMacd = macdLine.filter(v => v !== null);
    const sigEma = this.ema(validMacd, signal);
    // Map signal back to full array
    const signalLine = [];
    let si = 0;
    for (let i = 0; i < macdLine.length; i++) {
      if (macdLine[i] === null) { signalLine.push(null); continue; }
      signalLine.push(sigEma[si] || null);
      si++;
    }
    const histogram = macdLine.map((v, i) =>
      v != null && signalLine[i] != null ? v - signalLine[i] : null
    );
    return { macd: macdLine, signal: signalLine, histogram };
  },

  // ─── Bollinger Bands ─────────────────────────────────
  bollinger(closes, period = 20, stdDev = 2) {
    const middle = this.sma(closes, period);
    const upper = [], lower = [];
    for (let i = 0; i < closes.length; i++) {
      if (middle[i] === null) { upper.push(null); lower.push(null); continue; }
      let sumSq = 0;
      for (let j = 0; j < period; j++) {
        const diff = closes[i - j] - middle[i];
        sumSq += diff * diff;
      }
      const std = Math.sqrt(sumSq / period);
      upper.push(middle[i] + stdDev * std);
      lower.push(middle[i] - stdDev * std);
    }
    return { upper, middle, lower };
  },

  // ─── Support & Resistance (pivot points from recent swings) ──
  supportResistance(highs, lows, closes, lookback = 20) {
    const len = closes.length;
    if (len < lookback) return { support: [], resistance: [] };

    const recent = closes.slice(-lookback);
    const recentH = highs.slice(-lookback);
    const recentL = lows.slice(-lookback);

    // Find local mins (support) and maxs (resistance)
    const supports = [], resistances = [];
    for (let i = 1; i < recent.length - 1; i++) {
      if (recentL[i] < recentL[i - 1] && recentL[i] < recentL[i + 1]) {
        supports.push(recentL[i]);
      }
      if (recentH[i] > recentH[i - 1] && recentH[i] > recentH[i + 1]) {
        resistances.push(recentH[i]);
      }
    }

    // Cluster nearby levels
    const cluster = (levels, threshold = 0.02) => {
      const sorted = [...levels].sort((a, b) => a - b);
      const clusters = [];
      for (const level of sorted) {
        const existing = clusters.find(c => Math.abs(c - level) / c < threshold);
        if (existing) continue;
        clusters.push(level);
      }
      return clusters;
    };

    return {
      support: cluster(supports).slice(-3),
      resistance: cluster(resistances).slice(-3)
    };
  },

  // ─── Volume Analysis ─────────────────────────────────
  volumeAnalysis(volumes, period = 20) {
    const avgVol = this.sma(volumes, period);
    const latest = volumes[volumes.length - 1];
    const avg = avgVol[avgVol.length - 1];
    return {
      current: latest,
      average: avg,
      ratio: avg ? latest / avg : 1,
      signal: avg ? (latest > avg * 1.5 ? 'HIGH' : latest < avg * 0.5 ? 'LOW' : 'NORMAL') : 'NORMAL'
    };
  },

  // ─── Generate full analysis from OHLCV data ─────────
  analyze(candles) {
    if (!candles || candles.length < 30) return null;

    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume);
    const latest = closes[closes.length - 1];

    // Compute indicators
    const rsi14 = this.rsi(closes, 14);
    const macdData = this.macd(closes);
    const ema20 = this.ema(closes, 20);
    const ema50 = this.ema(closes, 50);
    const ema200 = this.ema(closes, 200);
    const bb = this.bollinger(closes);
    const sr = this.supportResistance(highs, lows, closes);
    const vol = this.volumeAnalysis(volumes);

    // Latest values
    const currentRSI = rsi14[rsi14.length - 1];
    const currentMACD = macdData.macd[macdData.macd.length - 1];
    const currentSignal = macdData.signal[macdData.signal.length - 1];
    const currentHist = macdData.histogram[macdData.histogram.length - 1];
    const prevHist = macdData.histogram[macdData.histogram.length - 2];
    const currentEMA20 = ema20[ema20.length - 1];
    const currentEMA50 = ema50[ema50.length - 1];
    const currentEMA200 = ema200[ema200.length - 1];
    const currentBBUpper = bb.upper[bb.upper.length - 1];
    const currentBBLower = bb.lower[bb.lower.length - 1];
    const currentBBMiddle = bb.middle[bb.middle.length - 1];

    // ─── Generate Signals ────────────────────────────
    const signals = [];
    let bullScore = 0, bearScore = 0;

    // RSI signals
    if (currentRSI !== null) {
      if (currentRSI < 30) { signals.push({ type: 'BUY', indicator: 'RSI', reason: `RSI ${currentRSI.toFixed(1)} — Oversold` }); bullScore += 2; }
      else if (currentRSI > 70) { signals.push({ type: 'SELL', indicator: 'RSI', reason: `RSI ${currentRSI.toFixed(1)} — Overbought` }); bearScore += 2; }
      else if (currentRSI > 50) { bullScore += 1; }
      else { bearScore += 1; }
    }

    // MACD signals
    if (currentMACD !== null && currentSignal !== null) {
      if (currentHist > 0 && prevHist <= 0) { signals.push({ type: 'BUY', indicator: 'MACD', reason: 'MACD bullish crossover' }); bullScore += 2; }
      else if (currentHist < 0 && prevHist >= 0) { signals.push({ type: 'SELL', indicator: 'MACD', reason: 'MACD bearish crossover' }); bearScore += 2; }
      else if (currentHist > 0) { bullScore += 1; }
      else { bearScore += 1; }
    }

    // EMA trend
    if (currentEMA20 && currentEMA50) {
      if (latest > currentEMA20 && currentEMA20 > currentEMA50) { signals.push({ type: 'BUY', indicator: 'EMA', reason: 'Price above EMA20 > EMA50 — Uptrend' }); bullScore += 2; }
      else if (latest < currentEMA20 && currentEMA20 < currentEMA50) { signals.push({ type: 'SELL', indicator: 'EMA', reason: 'Price below EMA20 < EMA50 — Downtrend' }); bearScore += 2; }
    }
    if (currentEMA200) {
      if (latest > currentEMA200) bullScore += 1;
      else bearScore += 1;
    }

    // Bollinger Band signals
    if (currentBBLower && currentBBUpper) {
      if (latest <= currentBBLower) { signals.push({ type: 'BUY', indicator: 'BB', reason: 'Price at lower Bollinger Band — potential bounce' }); bullScore += 1; }
      else if (latest >= currentBBUpper) { signals.push({ type: 'SELL', indicator: 'BB', reason: 'Price at upper Bollinger Band — potential reversal' }); bearScore += 1; }
    }

    // Volume confirmation
    if (vol.signal === 'HIGH') {
      signals.push({ type: 'INFO', indicator: 'VOL', reason: `Volume ${vol.ratio.toFixed(1)}x above average — Strong conviction` });
    }

    // Overall verdict
    const totalScore = bullScore + bearScore;
    let verdict, confidence;
    if (bullScore > bearScore + 2) { verdict = 'STRONG BUY'; confidence = Math.min(95, 50 + (bullScore - bearScore) * 10); }
    else if (bullScore > bearScore) { verdict = 'BUY'; confidence = Math.min(80, 50 + (bullScore - bearScore) * 8); }
    else if (bearScore > bullScore + 2) { verdict = 'STRONG SELL'; confidence = Math.min(95, 50 + (bearScore - bullScore) * 10); }
    else if (bearScore > bullScore) { verdict = 'SELL'; confidence = Math.min(80, 50 + (bearScore - bullScore) * 8); }
    else { verdict = 'HOLD'; confidence = 50; }

    // Trade setup
    const atr14 = this.atr(highs, lows, closes, 14);
    const currentATR = atr14[atr14.length - 1] || (latest * 0.02);
    const tradeSetup = verdict.includes('BUY') ? {
      entry: latest,
      target: latest + currentATR * 2,
      stopLoss: latest - currentATR * 1.5,
      riskReward: (currentATR * 2) / (currentATR * 1.5)
    } : verdict.includes('SELL') ? {
      entry: latest,
      target: latest - currentATR * 2,
      stopLoss: latest + currentATR * 1.5,
      riskReward: (currentATR * 2) / (currentATR * 1.5)
    } : null;

    return {
      price: latest,
      indicators: {
        rsi: currentRSI,
        macd: { value: currentMACD, signal: currentSignal, histogram: currentHist },
        ema: { ema20: currentEMA20, ema50: currentEMA50, ema200: currentEMA200 },
        bollinger: { upper: currentBBUpper, middle: currentBBMiddle, lower: currentBBLower },
        volume: vol,
        supportResistance: sr
      },
      signals,
      verdict,
      confidence,
      tradeSetup,
      scores: { bull: bullScore, bear: bearScore }
    };
  },

  // ─── Average True Range ──────────────────────────────
  atr(highs, lows, closes, period = 14) {
    const tr = [];
    for (let i = 0; i < closes.length; i++) {
      if (i === 0) { tr.push(highs[i] - lows[i]); continue; }
      tr.push(Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      ));
    }
    return this.ema(tr, period);
  }
};

// Export for both Node.js and browser
if (typeof module !== 'undefined') module.exports = TA;
