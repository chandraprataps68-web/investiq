// commodityStitcher.js — Build continuous back-adjusted MCX futures series
//
// Problem: each MCX commodity futures contract expires monthly. Raw price
// history of any single contract only covers ~1-2 months. To do TA on
// trends/EMAs/RSI we need a long continuous price series.
//
// Naive solution: concatenate consecutive contracts. Bad — there's typically
// a 0.5-2% price gap between contracts (contango/backwardation), which breaks
// every moving average and creates phantom signals on rollover days.
//
// Standard solution: BACK-ADJUSTED CONTINUOUS series.
// Walk forward through contracts in order. When you switch from contract A
// to contract B, compute the gap (B's first-day close - A's last-day close)
// and SUBTRACT that gap from ALL of A's historical prices. This makes the
// series smooth without distorting recent prices (which are what matters
// for current trading decisions).
//
// We fetch ~6 months of daily candles spanning multiple contracts, then
// stitch. Cached for 24h since older data doesn't change.

const MONTHS_3 = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// Cache: key=base symbol, value={ candles: [...], builtAt: Date }
const stitchCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Generate sequence of contract symbols for the last N months including current.
// Goes BACKWARD from current month to give us historical sequence.
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

// Fetch daily candles for a contract via Fyers history endpoint.
// Returns array of { t, o, h, l, c, v } or empty array on failure.
async function fetchContractHistory(symbol, fetchHistoryFn, daysBack = 60) {
  try {
    const candles = await fetchHistoryFn(symbol, '1D', daysBack);
    if (!Array.isArray(candles) || candles.length === 0) return [];
    // Defensive: filter out any rows with bad data
    return candles.filter(c => c && isFinite(c.c) && c.c > 0);
  } catch (e) {
    console.warn(`[stitcher] ${symbol} history failed: ${e.message}`);
    return [];
  }
}

// Detect rollover dates by finding where two consecutive contracts overlap
// in time. The "active period" of a contract is when it's the front-month —
// roughly from the previous contract's expiry until its own expiry.
//
// Simple heuristic: for each contract, use its data ONLY for dates after
// the prior contract's last meaningful candle (based on volume).
// We pick the boundary as: the last date of contract A where its volume was
// reasonable, then everything after that comes from contract B.
function findRolloverBoundaries(contractsData) {
  // contractsData: [{ contract, candles }, ...]  in chronological order
  const boundaries = []; // [{ rolloverDate, fromContract, toContract, gap }, ...]

  for (let i = 0; i < contractsData.length - 1; i++) {
    const cur = contractsData[i];
    const next = contractsData[i + 1];
    if (!cur.candles.length || !next.candles.length) continue;

    // Find the last date in cur where volume was at least 30% of its peak.
    // After that point, the contract is dying and we should switch to next.
    const peakVol = Math.max(...cur.candles.map(c => c.v || 0));
    const volThreshold = peakVol * 0.3;

    let lastActiveIdx = cur.candles.length - 1;
    for (let j = cur.candles.length - 1; j >= 0; j--) {
      if ((cur.candles[j].v || 0) >= volThreshold) {
        lastActiveIdx = j;
        break;
      }
    }
    const lastActiveCandle = cur.candles[lastActiveIdx];
    const rolloverTime = lastActiveCandle.t;

    // Find next contract's candle on or after rollover date
    const nextStartCandle = next.candles.find(c => c.t >= rolloverTime);
    if (!nextStartCandle) continue;

    // Gap = (next contract close) - (current contract close) on overlapping date.
    // We want SAME date if possible.
    const sameDayInNext = next.candles.find(c =>
      Math.abs(c.t - lastActiveCandle.t) < 12 * 3600); // within 12 hours
    const gap = sameDayInNext
      ? sameDayInNext.c - lastActiveCandle.c
      : nextStartCandle.c - lastActiveCandle.c;

    boundaries.push({
      rolloverTime,
      fromContract: cur.contract.label,
      toContract: next.contract.label,
      gap,
    });
  }

  return boundaries;
}

// Build the continuous back-adjusted series.
// Algorithm:
//   1. For each contract, keep candles only during its "active period"
//   2. Walk backward through boundaries, applying cumulative gap adjustment
//      to all PRIOR data. The most recent contract's data stays unchanged.
function buildContinuousSeries(contractsData) {
  if (contractsData.length === 0) return [];
  if (contractsData.length === 1) return contractsData[0].candles;

  const boundaries = findRolloverBoundaries(contractsData);

  // Step 1: Slice each contract to only its active period.
  // For each contract, active = from start until its rollover boundary
  // (or end of data if it's the last contract).
  const activeSlices = contractsData.map((cd, i) => {
    if (i === contractsData.length - 1) {
      // Last (current) contract — use everything from its starting boundary onward
      const startBoundary = boundaries[i - 1]?.rolloverTime ?? 0;
      return cd.candles.filter(c => c.t > startBoundary);
    }
    const startBoundary = boundaries[i - 1]?.rolloverTime ?? 0;
    const endBoundary = boundaries[i]?.rolloverTime ?? Infinity;
    return cd.candles.filter(c => c.t > startBoundary && c.t <= endBoundary);
  });

  // Step 2: Apply cumulative back-adjustment.
  // Walk from last contract backward. For contract i, the adjustment is the
  // sum of all gaps from boundary i to the most recent boundary.
  // (Adjustments shift OLDER prices to align with newer ones.)
  const adjustments = new Array(contractsData.length).fill(0);
  for (let i = contractsData.length - 2; i >= 0; i--) {
    const gap = boundaries[i]?.gap ?? 0;
    adjustments[i] = adjustments[i + 1] + gap;
  }

  // Step 3: Apply adjustments to each slice.
  const adjusted = [];
  for (let i = 0; i < activeSlices.length; i++) {
    const adj = adjustments[i];
    for (const c of activeSlices[i]) {
      adjusted.push({
        t: c.t,
        o: c.o + adj,
        h: c.h + adj,
        l: c.l + adj,
        c: c.c + adj,
        v: c.v, // volume isn't price-adjusted
      });
    }
  }

  // Step 4: Sort by time and dedupe (just in case)
  adjusted.sort((a, b) => a.t - b.t);
  const deduped = [];
  let lastT = -1;
  for (const c of adjusted) {
    if (c.t !== lastT) {
      deduped.push(c);
      lastT = c.t;
    }
  }
  return deduped;
}

// Main entry point: get continuous series for a commodity.
// fetchHistoryFn signature: (symbol, resolution, daysBack) => candles
async function getContinuousSeries(base, exchange, fetchHistoryFn, opts = {}) {
  const months = opts.months || 6;
  const cacheKey = `${exchange}:${base}:${months}`;
  const cached = stitchCache.get(cacheKey);
  if (cached && Date.now() - cached.builtAt < CACHE_TTL_MS) {
    return cached.candles;
  }

  const contracts = pastContracts(base, exchange, months);
  // Fetch each contract's history in parallel
  const contractsData = await Promise.all(
    contracts.map(async (contract) => ({
      contract,
      candles: await fetchContractHistory(contract.symbol, fetchHistoryFn, 90),
    }))
  );

  // Filter out contracts that returned no data (e.g. far-future contracts)
  const valid = contractsData.filter(cd => cd.candles.length > 0);
  if (valid.length === 0) {
    console.warn(`[stitcher] ${base}: no contract data`);
    return [];
  }

  const continuous = buildContinuousSeries(valid);
  console.log(`[stitcher] ${base}: stitched ${valid.length} contracts → ${continuous.length} candles`);

  stitchCache.set(cacheKey, { candles: continuous, builtAt: Date.now() });
  return continuous;
}

// Diagnostic: show what got stitched, useful for debugging
function describeStitch(base, exchange = 'MCX') {
  const cacheKey = `${exchange}:${base}:6`;
  const cached = stitchCache.get(cacheKey);
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

module.exports = { getContinuousSeries, describeStitch, pastContracts };
