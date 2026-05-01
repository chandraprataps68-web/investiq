// ═══════════════════════════════════════════════════════════
//  InvestIQ Pro — Technical Analysis Engine (v6)
//  Dual-env: Node module + browser global `TA`
//  Accepts both candle formats:
//    - short keys: { t, o, h, l, c, v }   (v6 internal)
//    - long keys:  { time, open, high, low, close, volume } (v5 legacy)
// ═══════════════════════════════════════════════════════════

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.TA = factory();
})(typeof window !== 'undefined' ? window : this, function () {

  // Normalize to long-key form internally so v5 code keeps working
  const normalize = (candles) => candles.map((c) => ({
    time: c.time ?? c.t,
    open: c.open ?? c.o,
    high: c.high ?? c.h,
    low: c.low ?? c.l,
    close: c.close ?? c.c,
    volume: c.volume ?? c.v,
  }));

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

    // ─── RSI ─────────────────────────────────────────────
    rsi(closes, period = 14) {
      const result = [];
      let avgGain = 0, avgLoss = 0;
      for (let i = 0; i < closes.length; i++) {
        if (i === 0) { result.push(null); continue; }
        const change = closes[i] - closes[i - 1];
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? -change : 0;
        if (i < period) { avgGain += gain; avgLoss += loss; result.push(null); continue; }
        if (i === period) {
          avgGain = (avgGain + gain) / period;
          avgLoss = (avgLoss + loss) / period;
        } else {
          avgGain = (avgGain * (period - 1) + gain) / period;
          avgLoss = (avgLoss * (period - 1) + loss) / period;
        }
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        result.push(100 - 100 / (1 + rs));
      }
      return result;
    },

    // ─── MACD ────────────────────────────────────────────
    macd(closes, fast = 12, slow = 26, signal = 9) {
      const emaFast = this.ema(closes, fast);
      const emaSlow = this.ema(closes, slow);
      const macdLine = closes.map((_, i) =>
        emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
      );
      const validMacd = macdLine.filter((v) => v !== null);
      const sigEma = this.ema(validMacd, signal);
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

    // ─── ATR ─────────────────────────────────────────────
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
    },

    // ─── Support & Resistance ────────────────────────────
    supportResistance(highs, lows, closes, lookback = 20) {
      const len = closes.length;
      if (len < lookback) return { support: [], resistance: [] };
      const recent = closes.slice(-lookback);
      const recentH = highs.slice(-lookback);
      const recentL = lows.slice(-lookback);
      const supports = [], resistances = [];
      for (let i = 1; i < recent.length - 1; i++) {
        if (recentL[i] < recentL[i - 1] && recentL[i] < recentL[i + 1]) supports.push(recentL[i]);
        if (recentH[i] > recentH[i - 1] && recentH[i] > recentH[i + 1]) resistances.push(recentH[i]);
      }
      const cluster = (levels, threshold = 0.02) => {
        const sorted = [...levels].sort((a, b) => a - b);
        const clusters = [];
        for (const level of sorted) {
          const existing = clusters.find((c) => Math.abs(c - level) / c < threshold);
          if (existing) continue;
          clusters.push(level);
        }
        return clusters;
      };
      return {
        support: cluster(supports).slice(-3),
        resistance: cluster(resistances).slice(-3),
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
        signal: avg ? (latest > avg * 1.5 ? 'HIGH' : latest < avg * 0.5 ? 'LOW' : 'NORMAL') : 'NORMAL',
      };
    },

    // ─── 52-week metrics (v6) ────────────────────────────
    fiftyTwoWeek(highs, lows, closes) {
      const slice = closes.slice(-252);
      if (slice.length === 0) return null;
      const sH = highs.slice(-252);
      const sL = lows.slice(-252);
      const high = Math.max(...sH);
      const low = Math.min(...sL);
      const last = slice[slice.length - 1];
      return {
        high, low,
        distFromHighPct: ((high - last) / high) * 100,
        distFromLowPct: ((last - low) / low) * 100,
        pthRatio: last / high,
      };
    },

    // ─── Minervini Trend Template (v6) ───────────────────
    trendTemplate(highs, lows, closes) {
      const last = closes[closes.length - 1];
      const e50 = this.ema(closes, 50).slice(-1)[0];
      const e150 = this.ema(closes, 150).slice(-1)[0];
      const e200 = this.ema(closes, 200).slice(-1)[0];
      const ftw = this.fiftyTwoWeek(highs, lows, closes);
      if (!e50 || !e150 || !e200 || !ftw) {
        return { pass: false, score: 0, checks: {}, reason: 'insufficient data' };
      }
      let e200Slope = 0;
      if (closes.length >= 222) {
        const e200Past = this.ema(closes.slice(0, -22), 200).slice(-1)[0];
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
    },

    // ─── V5 LEGACY: full analyze (kept for browser-side use) ──
    analyze(candles) {
      const c = normalize(candles);
      if (!c || c.length < 30) return null;

      const closes = c.map((x) => x.close);
      const highs = c.map((x) => x.high);
      const lows = c.map((x) => x.low);
      const volumes = c.map((x) => x.volume);
      const latest = closes[closes.length - 1];

      const rsi14 = this.rsi(closes, 14);
      const macdData = this.macd(closes);
      const ema20 = this.ema(closes, 20);
      const ema50 = this.ema(closes, 50);
      const ema200 = this.ema(closes, 200);
      const bb = this.bollinger(closes);
      const sr = this.supportResistance(highs, lows, closes);
      const vol = this.volumeAnalysis(volumes);

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

      const signals = [];
      let bullScore = 0, bearScore = 0;

      if (currentRSI !== null) {
        if (currentRSI < 30) { signals.push({ type: 'BUY', indicator: 'RSI', reason: `RSI ${currentRSI.toFixed(1)} — Oversold` }); bullScore += 2; }
        else if (currentRSI > 70) { signals.push({ type: 'SELL', indicator: 'RSI', reason: `RSI ${currentRSI.toFixed(1)} — Overbought` }); bearScore += 2; }
        else if (currentRSI > 50) bullScore += 1;
        else bearScore += 1;
      }

      if (currentMACD !== null && currentSignal !== null) {
        if (currentHist > 0 && prevHist <= 0) { signals.push({ type: 'BUY', indicator: 'MACD', reason: 'MACD bullish crossover' }); bullScore += 2; }
        else if (currentHist < 0 && prevHist >= 0) { signals.push({ type: 'SELL', indicator: 'MACD', reason: 'MACD bearish crossover' }); bearScore += 2; }
        else if (currentHist > 0) bullScore += 1;
        else bearScore += 1;
      }

      if (currentEMA20 && currentEMA50) {
        if (latest > currentEMA20 && currentEMA20 > currentEMA50) { signals.push({ type: 'BUY', indicator: 'EMA', reason: 'Price > EMA20 > EMA50 — Uptrend' }); bullScore += 2; }
        else if (latest < currentEMA20 && currentEMA20 < currentEMA50) { signals.push({ type: 'SELL', indicator: 'EMA', reason: 'Price < EMA20 < EMA50 — Downtrend' }); bearScore += 2; }
      }
      if (currentEMA200) {
        if (latest > currentEMA200) bullScore += 1; else bearScore += 1;
      }

      if (currentBBLower && currentBBUpper) {
        if (latest <= currentBBLower) { signals.push({ type: 'BUY', indicator: 'BB', reason: 'Price at lower BB — potential bounce' }); bullScore += 1; }
        else if (latest >= currentBBUpper) { signals.push({ type: 'SELL', indicator: 'BB', reason: 'Price at upper BB — potential reversal' }); bearScore += 1; }
      }

      if (vol.signal === 'HIGH') {
        signals.push({ type: 'INFO', indicator: 'VOL', reason: `Volume ${vol.ratio.toFixed(1)}x average — strong conviction` });
      }

      let verdict, confidence;
      if (bullScore > bearScore + 2) { verdict = 'STRONG BUY'; confidence = Math.min(95, 50 + (bullScore - bearScore) * 10); }
      else if (bullScore > bearScore) { verdict = 'BUY'; confidence = Math.min(80, 50 + (bullScore - bearScore) * 8); }
      else if (bearScore > bullScore + 2) { verdict = 'STRONG SELL'; confidence = Math.min(95, 50 + (bearScore - bullScore) * 10); }
      else if (bearScore > bullScore) { verdict = 'SELL'; confidence = Math.min(80, 50 + (bearScore - bullScore) * 8); }
      else { verdict = 'HOLD'; confidence = 50; }

      const atr14 = this.atr(highs, lows, closes, 14);
      const currentATR = atr14[atr14.length - 1] || latest * 0.02;
      const tradeSetup = verdict.includes('BUY') ? {
        entry: latest, target: latest + currentATR * 2, stopLoss: latest - currentATR * 1.5,
        riskReward: (currentATR * 2) / (currentATR * 1.5),
      } : verdict.includes('SELL') ? {
        entry: latest, target: latest - currentATR * 2, stopLoss: latest + currentATR * 1.5,
        riskReward: (currentATR * 2) / (currentATR * 1.5),
      } : null;

      return {
        price: latest,
        indicators: {
          rsi: currentRSI,
          macd: { value: currentMACD, signal: currentSignal, histogram: currentHist },
          ema: { ema20: currentEMA20, ema50: currentEMA50, ema200: currentEMA200 },
          bollinger: { upper: currentBBUpper, middle: currentBBMiddle, lower: currentBBLower },
          volume: vol,
          supportResistance: sr,
        },
        signals,
        verdict,
        confidence,
        tradeSetup,
        scores: { bull: bullScore, bear: bearScore },
      };
    },

    // ─── V6: fullAnalysis (used by scanner + /api/analyze) ──
    // Returns a structure optimized for ranking & multi-horizon targets
    fullAnalysis(candles) {
      const c = normalize(candles);
      if (!c || c.length < 30) return { ok: false, reason: 'insufficient candles' };

      const closes = c.map((x) => x.close);
      const highs = c.map((x) => x.high);
      const lows = c.map((x) => x.low);
      const volumes = c.map((x) => x.volume);
      const last = c[c.length - 1];

      const rsi14arr = this.rsi(closes, 14);
      const macdData = this.macd(closes);
      const bb = this.bollinger(closes);
      const ema20 = this.ema(closes, 20).slice(-1)[0];
      const ema50 = this.ema(closes, 50).slice(-1)[0];
      const ema200 = this.ema(closes, 200).slice(-1)[0];
      const atr14arr = this.atr(highs, lows, closes, 14);
      const sr = this.supportResistance(highs, lows, closes, 60);
      const vol = this.volumeAnalysis(volumes);
      const ftw = this.fiftyTwoWeek(highs, lows, closes);
      const trend = this.trendTemplate(highs, lows, closes);

      const macdLast = macdData.macd[macdData.macd.length - 1];
      const macdSig = macdData.signal[macdData.signal.length - 1];
      const macdHist = macdData.histogram[macdData.histogram.length - 1];

      return {
        ok: true,
        price: last.close,
        rsi14: rsi14arr[rsi14arr.length - 1],
        macd: {
          macd: macdLast, signal: macdSig, histogram: macdHist,
          bullish: macdLast != null && macdSig != null ? macdLast > macdSig : null,
        },
        bb: bb.upper.length ? {
          upper: bb.upper[bb.upper.length - 1],
          middle: bb.middle[bb.middle.length - 1],
          lower: bb.lower[bb.lower.length - 1],
        } : null,
        ema20, ema50, ema200,
        atr14: atr14arr[atr14arr.length - 1],
        sr: { resistance: sr.resistance, support: sr.support },
        volume: { ratio: vol.ratio, today: vol.current, avg20: vol.average },
        ftw,
        trend,
      };
    },

    // ─── V6: generateSignal (with multi-horizon targets) ──
    generateSignal(analysis) {
      if (!analysis || !analysis.ok) return { signal: 'NO DATA', confidence: 0, targets: {}, rationale: [] };
      const { price, rsi14, macd: m, bb, atr14, sr, volume, trend, ftw } = analysis;

      let bull = 0, bear = 0;

      // Trend template (40 pts)
      if (trend.pass) bull += 40;
      else if (trend.score >= 6) bull += 25;
      else if (trend.score >= 4) bull += 10;
      else if (trend.score <= 2) bear += 30;

      // RSI (15 pts)
      if (rsi14 != null) {
        if (rsi14 > 50 && rsi14 < 70) bull += 15;
        else if (rsi14 >= 70 && rsi14 < 80) bull += 8;
        else if (rsi14 >= 80) bear += 5;
        else if (rsi14 < 50 && rsi14 > 30) bear += 10;
        else if (rsi14 <= 30) bear += 15;
      }

      // MACD (15 pts)
      if (m && m.bullish != null) {
        if (m.bullish && m.histogram > 0) bull += 15;
        else if (m.bullish) bull += 8;
        else if (!m.bullish && m.histogram < 0) bear += 15;
        else bear += 8;
      }

      // Volume (15 pts)
      if (volume && volume.ratio > 1.5) bull += 15;
      else if (volume && volume.ratio < 0.5) bear += 5;

      // Bollinger position (15 pts)
      if (bb) {
        const pct = (price - bb.lower) / (bb.upper - bb.lower);
        if (pct > 0.8) bull += 10;
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
        const nearestR = (sr.resistance || []).find((r) => r > price) || price + 5 * atr14;
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
        const nearestS = (sr.support || []).find((s) => s < price) || price - 5 * atr14;
        targets.positional = {
          target: +Math.max(nearestS, price - 8 * atr14).toFixed(2),
          stop: +(price + 2.5 * atr14).toFixed(2),
          horizon: '10-60 days',
        };
      }

      const rationale = [];
      if (trend.pass) rationale.push('All 8 trend-template checks passed');
      else if (trend.score >= 5) rationale.push(`Trend template ${trend.score}/8`);
      if (rsi14 > 70) rationale.push(`RSI ${rsi14.toFixed(0)} (strong but extended)`);
      else if (rsi14 < 30) rationale.push(`RSI ${rsi14.toFixed(0)} (oversold)`);
      if (m && m.bullish === true) rationale.push('MACD bullish');
      if (m && m.bullish === false) rationale.push('MACD bearish');
      if (volume && volume.ratio > 1.5) rationale.push(`Volume ${volume.ratio.toFixed(1)}× avg`);
      if (ftw && ftw.distFromHighPct < 5) rationale.push('Within 5% of 52W high');
      if (ftw && ftw.distFromLowPct < 10) rationale.push('Within 10% of 52W low');

      return {
        signal, confidence,
        bullScore: bull, bearScore: bear, netScore: net,
        targets, rationale,
      };
    },
  };

  return TA;
});
