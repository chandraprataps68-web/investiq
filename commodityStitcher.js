// commodityStitcher.js — Get continuous back-adjusted MCX futures series
//
// IMPORTANT INSIGHT: Fyers' history API supports `cont_flag: '1'` which
// returns a NATIVELY CONTINUOUS, ALREADY-STITCHED series for futures
// contracts. The continuous flag handles contract rollovers and back-
// adjustment server-side. We just need to call the CURRENT front-month
// contract symbol with a long enough range, and Fyers gives us the full
// stitched history automatically.
//
// This module's job is now simple:
//   1. Resolve the current active contract for a base (e.g. GOLD → MCX:GOLD26MAYFUT)
//   2. Fetch 365 days of daily history (cont_flag=1 is set inside fetchHistoryFn)
//   3. Return the candles
//
// Previous version tried to manually stitch 6 monthly contracts, which
// failed because Fyers doesn't return data for fully-expired contracts
// older than ~1-2 months.

const MONTHS_3 = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// Cache of resolved active contract symbols
const activeContractCache = new Map();
const ACTIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Cache of stitched series
const seriesCache = new Map();
const SERIES_TTL_MS = 6 * 60 * 60 * 1000; // 6h

// Try to find the active contract by probing the next few months.
// Returns the first symbol whose history call returns ≥10 candles.
async function resolveActiveContract(base, exchange, fetchHistoryFn) {
  const cacheKey = `${exchange}:${base}`;
  const cached = activeContractCache.get(cacheKey);
  if (cached && Date.now() - cached.builtAt < ACTIVE_CACHE_TTL_MS) {
    return cached.symbol;
  }

  // Generate candidates: current and next 5 months, then previous as fallback
  const now = new Date();
  const candidates = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const yy = String(d.getFullYear()).slice(-2);
    const mmm = MONTHS_3[d.getMonth()];
    candidates.push(`${exchange}:${base}${yy}${mmm}FUT`);
  }
  {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const yy = String(d.getFullYear()).slice(-2);
    const mmm = MONTHS_3[d.getMonth()];
    candidates.push(`${exchange}:${base}${yy}${mmm}FUT`);
  }

  for (const sym of candidates) {
    try {
      const candles = await fetchHistoryFn(sym, 'D', 30);
      if (Array.isArray(candles) && candles.length >= 10) {
        console.log(`[stitcher] ${base} active contract → ${sym} (${candles.length} candles in last 30d)`);
        activeContractCache.set(cacheKey, { symbol: sym, builtAt: Date.now() });
        return sym;
      }
    } catch (e) { /* skip */ }
  }
  console.warn(`[stitcher] ${base}: no active contract found`);
  return null;
}

// Get continuous series. fetchHistoryFn signature: (symbol, resolution, daysBack)
// fetchHistoryFn must internally use cont_flag=1 (server.js getHistoryShortKey does)
async function getContinuousSeries(base, exchange, fetchHistoryFn, opts = {}) {
  const days = opts.days || 365;
  const cacheKey = `${exchange}:${base}:${days}`;
  const cached = seriesCache.get(cacheKey);
  if (cached && Date.now() - cached.builtAt < SERIES_TTL_MS) {
    return cached.candles;
  }

  const symbol = await resolveActiveContract(base, exchange, fetchHistoryFn);
  if (!symbol) return [];

  let candles;
  try {
    candles = await fetchHistoryFn(symbol, 'D', days);
  } catch (e) {
    console.warn(`[stitcher] ${base}: history fetch failed: ${e.message}`);
    return [];
  }

  if (!Array.isArray(candles) || candles.length === 0) {
    console.warn(`[stitcher] ${base}: empty candles from ${symbol}`);
    return [];
  }

  const clean = candles.filter(c => c && isFinite(c.c) && c.c > 0);
  console.log(`[stitcher] ${base} → ${symbol}: ${clean.length} continuous candles (${days}d requested)`);

  seriesCache.set(cacheKey, { candles: clean, builtAt: Date.now() });
  return clean;
}

// Diagnostic helper
function describeStitch(base, exchange = 'MCX', days = 365) {
  const cacheKey = `${exchange}:${base}:${days}`;
  const cached = seriesCache.get(cacheKey);
  if (!cached) return null;
  return {
    base,
    candleCount: cached.candles.length,
    firstDate: cached.candles[0]?.t ? new Date(cached.candles[0].t * 1000).toISOString().slice(0, 10) : null,
    lastDate: cached.candles[cached.candles.length - 1]?.t
      ? new Date(cached.candles[cached.candles.length - 1].t * 1000).toISOString().slice(0, 10) : null,
    age: Math.round((Date.now() - cached.builtAt) / 60000) + ' min',
  };
}

// For backward compat with debug endpoint
function pastContracts(base, exchange = 'MCX', months = 6) {
  const now = new Date();
  const contracts = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const yy = String(d.getFullYear()).slice(-2);
    const mmm = MONTHS_3[d.getMonth()];
    contracts.push({
      symbol: `${exchange}:${base}${yy}${mmm}FUT`,
      year: d.getFullYear(),
      month: d.getMonth(),
      label: `${mmm}${yy}`,
    });
  }
  return contracts;
}

module.exports = { getContinuousSeries, describeStitch, pastContracts, resolveActiveContract };
