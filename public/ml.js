// ═══════════════════════════════════════════════════════════
//  InvestIQ Pro — Self-Learning Signal Model
//  Tracks predictions vs outcomes, adjusts indicator weights.
//  Stored in localStorage — learns from YOUR trading history.
// ═══════════════════════════════════════════════════════════

const ML = {
  STORE_KEY: 'iq_ml_signals',
  WEIGHTS_KEY: 'iq_ml_weights',

  // Default indicator weights (equal at start)
  defaultWeights: { RSI: 1.0, MACD: 1.0, EMA: 1.0, BB: 0.8, VOL: 0.6 },

  getWeights() {
    try { return JSON.parse(localStorage.getItem(this.WEIGHTS_KEY)) || { ...this.defaultWeights }; }
    catch { return { ...this.defaultWeights }; }
  },

  saveWeights(w) { localStorage.setItem(this.WEIGHTS_KEY, JSON.stringify(w)); },

  getSignals() {
    try { return JSON.parse(localStorage.getItem(this.STORE_KEY)) || []; }
    catch { return []; }
  },

  saveSignals(s) {
    // Keep last 500 signals max
    if (s.length > 500) s = s.slice(-500);
    localStorage.setItem(this.STORE_KEY, JSON.stringify(s));
  },

  // Record a new prediction
  recordSignal(symbol, price, verdict, confidence, indicators, signals) {
    const sigs = this.getSignals();
    sigs.push({
      id: Date.now(),
      symbol,
      price,
      verdict, // BUY, SELL, HOLD
      confidence,
      indicators: {
        rsi: indicators.rsi,
        macdHist: indicators.macd?.histogram,
        emaAlignment: price > (indicators.ema?.ema20 || 0) ? 'above' : 'below',
        bbPosition: price < (indicators.bollinger?.lower || 0) ? 'below' : price > (indicators.bollinger?.upper || Infinity) ? 'above' : 'middle',
        volumeSignal: indicators.volume?.signal
      },
      signals: signals.map(s => ({ type: s.type, indicator: s.indicator })),
      timestamp: Date.now(),
      outcome: null, // filled later
      outcomePrice: null,
      outcomeDate: null
    });
    this.saveSignals(sigs);
    return sigs.length;
  },

  // Update outcomes — check if predictions were correct
  // Call this with current prices for symbols that have open predictions
  updateOutcomes(symbol, currentPrice) {
    const sigs = this.getSignals();
    let updated = 0;
    const now = Date.now();
    sigs.forEach(s => {
      if (s.symbol !== symbol || s.outcome !== null) return;
      const age = (now - s.timestamp) / 86400000; // days
      // Check after 1 day minimum
      if (age < 1) return;
      const pctChange = ((currentPrice - s.price) / s.price) * 100;
      if (s.verdict === 'BUY' || s.verdict === 'STRONG BUY') {
        s.outcome = pctChange > 0.5 ? 'WIN' : pctChange < -0.5 ? 'LOSS' : 'FLAT';
      } else if (s.verdict === 'SELL' || s.verdict === 'STRONG SELL') {
        s.outcome = pctChange < -0.5 ? 'WIN' : pctChange > 0.5 ? 'LOSS' : 'FLAT';
      } else {
        s.outcome = Math.abs(pctChange) < 1 ? 'WIN' : 'LOSS'; // HOLD is correct if price stayed flat
      }
      s.outcomePrice = currentPrice;
      s.outcomeDate = now;
      updated++;
    });
    if (updated > 0) {
      this.saveSignals(sigs);
      this.recalculateWeights(sigs);
    }
    return updated;
  },

  // Recalculate indicator weights based on historical win rates
  recalculateWeights(sigs) {
    const resolved = sigs.filter(s => s.outcome !== null);
    if (resolved.length < 10) return; // need minimum data

    const indicatorStats = {};
    resolved.forEach(s => {
      (s.signals || []).forEach(sig => {
        if (!indicatorStats[sig.indicator]) indicatorStats[sig.indicator] = { wins: 0, total: 0 };
        indicatorStats[sig.indicator].total++;
        if (s.outcome === 'WIN') indicatorStats[sig.indicator].wins++;
      });
    });

    const weights = this.getWeights();
    Object.keys(indicatorStats).forEach(ind => {
      const stat = indicatorStats[ind];
      if (stat.total >= 5) {
        const winRate = stat.wins / stat.total;
        // Scale weight: 50% winrate = 1.0, 60% = 1.2, 40% = 0.8
        weights[ind] = Math.max(0.2, Math.min(2.0, winRate * 2));
      }
    });
    this.saveWeights(weights);
    return weights;
  },

  // Apply learned weights to TA analysis scores
  applyWeights(analysis) {
    if (!analysis) return analysis;
    const weights = this.getWeights();
    let bullScore = 0, bearScore = 0;

    analysis.signals.forEach(s => {
      const w = weights[s.indicator] || 1.0;
      if (s.type === 'BUY') bullScore += w;
      else if (s.type === 'SELL') bearScore += w;
    });

    // Re-derive verdict with weighted scores
    let verdict, confidence;
    if (bullScore > bearScore + 1.5) { verdict = 'STRONG BUY'; confidence = Math.min(95, 50 + (bullScore - bearScore) * 8); }
    else if (bullScore > bearScore) { verdict = 'BUY'; confidence = Math.min(80, 50 + (bullScore - bearScore) * 6); }
    else if (bearScore > bullScore + 1.5) { verdict = 'STRONG SELL'; confidence = Math.min(95, 50 + (bearScore - bullScore) * 8); }
    else if (bearScore > bullScore) { verdict = 'SELL'; confidence = Math.min(80, 50 + (bearScore - bullScore) * 6); }
    else { verdict = 'HOLD'; confidence = 50; }

    return {
      ...analysis,
      verdict,
      confidence: Math.round(confidence),
      scores: { bull: Math.round(bullScore * 10) / 10, bear: Math.round(bearScore * 10) / 10 },
      mlWeights: weights,
      mlApplied: true
    };
  },

  // Get model stats
  getStats() {
    const sigs = this.getSignals();
    const resolved = sigs.filter(s => s.outcome !== null);
    const wins = resolved.filter(s => s.outcome === 'WIN').length;
    const losses = resolved.filter(s => s.outcome === 'LOSS').length;
    return {
      totalPredictions: sigs.length,
      resolved: resolved.length,
      pending: sigs.length - resolved.length,
      wins,
      losses,
      winRate: resolved.length > 0 ? Math.round((wins / resolved.length) * 100) : 0,
      weights: this.getWeights()
    };
  },

  // Reset model
  reset() {
    localStorage.removeItem(this.STORE_KEY);
    localStorage.removeItem(this.WEIGHTS_KEY);
  }
};

if (typeof module !== 'undefined') module.exports = ML;
