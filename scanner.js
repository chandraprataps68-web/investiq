// scanner.js — Equity Trend Scanner for InvestIQ Pro v6
// Pipeline: Universe -> getHistory (cached) -> trendTemplate filter
// -> RS rank vs Nifty -> sort -> generateSignal -> [Phase 15B: gating] -> return ranked list

const TA = require('./ta');
const Zones = require('./zones');
const SignalQuality = require('./signalQuality');
const RangeBehavior = require('./rangeBehavior');
const Gating = require('./gating');
const { NIFTY_100, toFyersEquity } = require('./universe');

// Compute relative strength: stock 6M return vs Nifty 6M return
// Returns RS percentile rank within universe (0-100)
const computeRSRank = (allReturns) => {
  // allReturns = [{ symbol, return6m }, ...]
  const sorted = [...allReturns].sort((a, b) => a.return6m - b.return6m);
  const ranks = {};
  sorted.forEach((s, i) => {
    ranks[s.symbol] = Math.round((i / (sorted.length - 1)) * 100);
  });
  return ranks;
};

const sixMonthReturn = (candles) => {
  // ~126 trading days = 6 months
  if (candles.length < 126) return null;
  const old = candles[candles.length - 126].c;
  const now = candles[candles.length - 1].c;
  return ((now - old) / old) * 100;
};

// Main scan function
// fetchHistoryFn: async (fyersSymbol) => candles[]
// Returns { results: [...], scannedAt, errors }
async function runScanner(fetchHistoryFn, opts = {}) {
  const universe = opts.universe || NIFTY_100;
  const concurrency = opts.concurrency || 5; // Render free is rate-limited
  const errors = [];
  const data = [];

  // Process in batches to avoid hammering Fyers
  for (let i = 0; i < universe.length; i += concurrency) {
    const batch = universe.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(async (sym) => {
        const fyersSym = toFyersEquity(sym);
        const candles = await fetchHistoryFn(fyersSym);
        return { symbol: sym, fyersSym, candles };
      })
    );
    for (const r of batchResults) {
      if (r.status === 'fulfilled' && r.value.candles && r.value.candles.length >= 30) {
        data.push(r.value);
      } else if (r.status === 'rejected') {
        errors.push({ symbol: 'unknown', err: r.reason?.message || String(r.reason) });
      }
    }
    // small delay between batches
    if (i + concurrency < universe.length) {
      await new Promise((res) => setTimeout(res, 300));
    }
  }

  // Compute returns and RS rank
  const returns = data
    .map((d) => ({ symbol: d.symbol, return6m: sixMonthReturn(d.candles) }))
    .filter((r) => r.return6m != null);
  const rsRanks = computeRSRank(returns);

  // Run TA on each, build result rows. Phase 15B: also compute zones, signal
  // quality, range behavior, and gating verdicts per stock. The signal-quality
  // adjustment and gating downgrade are surfaced as extra fields — the original
  // `signal` and `confidence` stay untouched for backward compatibility, the
  // frontend uses `effectiveSignal` to decide what to display.
  const results = data.map((d) => {
    const a = TA.fullAnalysis(d.candles);
    const sig = TA.generateSignal(a);
    const currentPrice = a.ok ? a.price : (d.candles[d.candles.length - 1]?.c ?? null);

    // Phase 15B enrichment — only attempt for stocks that produced a valid
    // analysis. Skipped otherwise so we don't compute zones on insufficient data.
    let zones = null, sq = null, rb = null, gatingStock = null, gatingOption = null;
    let effectiveSignal = sig.signal;
    let downgrade = null;
    if (a.ok && currentPrice && d.candles.length >= 45) {
      try {
        zones = Zones.buildZones(d.candles, currentPrice);
        sq = SignalQuality.enrichSignalQuality({
          candles: d.candles, currentPrice, zones, signal: sig.signal, atr14: a.atr14,
        });
        rb = RangeBehavior.classifyRangeBehavior({ candles: d.candles, currentPrice });
        // Use a synthetic confluence shim for gating — scanner doesn't compute
        // full confluence (that's per-stock detail view). We approximate using
        // the trend score + signal confidence to get a 0-100 figure.
        const approxConfluence = {
          score: Math.min(100, Math.round((a.trend.score / 8) * 60 + sig.confidence * 0.4 + (sq.confluenceAdjustment || 0))),
        };
        gatingStock = Gating.checkCrossEngine({
          signal: sig.signal, confluence: approxConfluence, signalQuality: sq, rangeBehavior: rb,
          zones, currentPrice, isOptionTrade: false,
        });
        gatingOption = Gating.checkCrossEngine({
          signal: sig.signal, confluence: approxConfluence, signalQuality: sq, rangeBehavior: rb,
          zones, currentPrice, isOptionTrade: true,
        });
        // Effective signal reflects gating downgrade
        if (gatingStock.signalDowngrade === 'HOLD') {
          effectiveSignal = 'HOLD';
          downgrade = 'STOCK_BUY_BLOCKED';
        } else if (gatingStock.signalDowngrade === 'BLOCKED') {
          effectiveSignal = 'HOLD';
          downgrade = 'STOCK_HARD_BLOCK';
        }
      } catch (_) { /* enrichment failure → fall back to raw signal */ }
    }

    return {
      symbol: d.symbol,
      fyersSymbol: d.fyersSym,
      price: a.ok ? a.price : null,
      signal: sig.signal,                     // raw scanner signal (unchanged)
      effectiveSignal,                        // after gating
      downgradeReason: downgrade,
      confidence: sig.confidence,
      bullScore: sig.bullScore,
      bearScore: sig.bearScore,
      netScore: sig.netScore,
      rsRank: rsRanks[d.symbol] ?? null,
      return6m: returns.find((r) => r.symbol === d.symbol)?.return6m ?? null,
      trendScore: a.ok ? a.trend.score : 0,
      trendPass: a.ok ? a.trend.pass : false,
      distFromHighPct: a.ok && a.ftw ? a.ftw.distFromHighPct : null,
      volRatio: a.ok && a.volume ? a.volume.ratio : null,
      rsi: a.ok ? a.rsi14 : null,
      targets: sig.targets,
      rationale: sig.rationale,
      atr: a.ok ? a.atr14 : null,
      // Phase 15B exposed fields (UI consumes these to render badges)
      volumeCharacter: sq?.volumeCharacter?.category ?? null,
      resistanceClusterCount: sq?.resistanceCluster?.count ?? null,
      rangeState: rb?.state ?? null,
      adx: rb?.adx ?? null,
      gatingStock: gatingStock ? {
        overall: gatingStock.overall,
        signalDowngrade: gatingStock.signalDowngrade,
        failures: gatingStock.failureReasons,
      } : null,
      gatingOption: gatingOption ? {
        overall: gatingOption.overall,
        signalDowngrade: gatingOption.signalDowngrade,
        failures: gatingOption.failureReasons,
        alternative: gatingOption.suggestedAlternative,
      } : null,
    };
  });

  // Sort: STRONG BUY first by confidence, then BUY by confidence, etc.
  const order = { 'STRONG BUY': 5, BUY: 4, HOLD: 3, SELL: 2, 'STRONG SELL': 1 };
  results.sort((a, b) => {
    const oa = order[a.signal] ?? 0;
    const ob = order[b.signal] ?? 0;
    if (oa !== ob) return ob - oa;
    return b.confidence - a.confidence;
  });

  return {
    scannedAt: new Date().toISOString(),
    universeSize: universe.length,
    fetched: data.length,
    errors,
    results,
    summary: {
      strongBuys: results.filter((r) => r.signal === 'STRONG BUY').length,
      buys: results.filter((r) => r.signal === 'BUY').length,
      holds: results.filter((r) => r.signal === 'HOLD').length,
      sells: results.filter((r) => r.signal === 'SELL').length,
      strongSells: results.filter((r) => r.signal === 'STRONG SELL').length,
      // Phase 15B summary — how many raw BUY signals survive cross-engine gating
      effectiveStrongBuys: results.filter((r) => r.effectiveSignal === 'STRONG BUY').length,
      effectiveBuys: results.filter((r) => r.effectiveSignal === 'BUY').length,
      blockedByGating: results.filter((r) => r.downgradeReason).length,
      gatingOptionPass: results.filter((r) => r.gatingOption?.overall === 'PASS').length,
    },
  };
}

module.exports = { runScanner };
