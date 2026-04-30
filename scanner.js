// scanner.js — Equity Trend Scanner for InvestIQ Pro v6
// Pipeline: Universe -> getHistory (cached) -> trendTemplate filter
// -> RS rank vs Nifty -> sort -> generateSignal -> return ranked list

const { fullAnalysis, generateSignal } = require('./ta');
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

  // Run TA on each, build result rows
  const results = data.map((d) => {
    const a = fullAnalysis(d.candles);
    const sig = generateSignal(a);
    return {
      symbol: d.symbol,
      fyersSymbol: d.fyersSym,
      price: a.ok ? a.price : null,
      signal: sig.signal,
      confidence: sig.confidence,
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
    },
  };
}

module.exports = { runScanner };
