// fno.js — Futures & Options intelligence for InvestIQ Pro v6
//
// Three capabilities:
//   1. Index Futures: spot vs futures, basis (premium/discount), OI snapshot
//   2. Option Chain: full chain with PCR, Max Pain, OI walls, IV
//   3. Stock F&O Buildup: classify F&O stocks by OI buildup quadrant
//
// All Fyers-driven; caller passes fetcher functions.

// ─── Index futures definitions ─────────────────────────────────
// Indian indices: spot has -INDEX suffix, futures use {INDEX}{YY}{MMM}FUT
// Nifty / Bank Nifty have weekly + monthly; we'll fetch the current-month future.
const INDICES = [
  { id: 'NIFTY',     name: 'Nifty 50',    spot: 'NSE:NIFTY50-INDEX',     futBase: 'NIFTY',      lotSize: 75 },
  { id: 'BANKNIFTY', name: 'Bank Nifty',  spot: 'NSE:NIFTYBANK-INDEX',   futBase: 'BANKNIFTY',  lotSize: 30 },
  { id: 'FINNIFTY',  name: 'Fin Nifty',   spot: 'NSE:FINNIFTY-INDEX',    futBase: 'FINNIFTY',   lotSize: 65 },
  { id: 'MIDCAP',    name: 'Midcap Nifty', spot: 'NSE:MIDCPNIFTY-INDEX', futBase: 'MIDCPNIFTY', lotSize: 120 },
];

const MONTHS_3 = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// Probe upcoming months and return first contract that returns a price.
// Mirrors the commodity resolver but for index futures.
const futCache = new Map();
const futCacheUntil = new Map();

async function resolveIndexFuture(futBase, fetchQuoteFn) {
  const cached = futCache.get(futBase);
  if (cached && Date.now() < (futCacheUntil.get(futBase) || 0)) return cached;
  const now = new Date();
  for (let i = 0; i < 4; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const yy = String(d.getFullYear()).slice(-2);
    const mmm = MONTHS_3[d.getMonth()];
    const sym = `NSE:${futBase}${yy}${mmm}FUT`;
    try {
      const q = await fetchQuoteFn(sym);
      const price = q?.lp ?? q?.ltp;
      if (price && isFinite(price) && price > 0) {
        futCache.set(futBase, sym);
        const eom = new Date(); eom.setMonth(eom.getMonth() + 1, 5);
        futCacheUntil.set(futBase, eom.getTime());
        return sym;
      }
    } catch (_) {}
  }
  return null;
}

// Get index futures snapshot
async function getIndexFutures(fetchQuoteFn) {
  const out = [];
  for (const idx of INDICES) {
    try {
      // Resolve current and next month contracts
      const currMonthSym = await resolveIndexFuture(idx.futBase, fetchQuoteFn);
      const nextMonthSym = await resolveNextMonthFuture(idx.futBase, currMonthSym, fetchQuoteFn);

      // Fetch all in parallel
      const [spotQ, currQ, nextQ] = await Promise.all([
        fetchQuoteFn(idx.spot).catch(() => null),
        currMonthSym ? fetchQuoteFn(currMonthSym).catch(() => null) : null,
        nextMonthSym ? fetchQuoteFn(nextMonthSym).catch(() => null) : null,
      ]);

      const spotPrice = spotQ?.lp ?? spotQ?.ltp;
      const currPrice = currQ?.lp ?? currQ?.ltp;
      const nextPrice = nextQ?.lp ?? nextQ?.ltp;

      // Basis = futures - spot. Positive = contango (premium), negative = backwardation (discount)
      const basis = (spotPrice && currPrice) ? currPrice - spotPrice : null;
      const basisPct = (basis != null && spotPrice) ? (basis / spotPrice) * 100 : null;

      // Rollover: next month volume / (curr + next). High = traders rolling forward.
      const currVol = currQ?.volume ?? currQ?.v ?? 0;
      const nextVol = nextQ?.volume ?? nextQ?.v ?? 0;
      const rollover = (currVol + nextVol > 0) ? (nextVol / (currVol + nextVol)) * 100 : null;

      out.push({
        ...idx,
        currMonthSym,
        nextMonthSym,
        spotPrice,
        spotChangePct: spotQ?.chp ?? null,
        currPrice,
        currChangePct: currQ?.chp ?? null,
        currOI: currQ?.oi ?? null,
        currOIChange: currQ?.oi_change ?? null,
        nextPrice,
        nextChangePct: nextQ?.chp ?? null,
        basis,
        basisPct,
        rollover,
      });
    } catch (err) {
      out.push({ ...idx, error: err.message });
    }
  }
  return out;
}

async function resolveNextMonthFuture(futBase, currSym, fetchQuoteFn) {
  if (!currSym) return null;
  // Parse current symbol's month, advance by 1
  const m = currSym.match(/(\d{2})([A-Z]{3})FUT$/);
  if (!m) return null;
  const yy = parseInt(m[1], 10);
  const mmm = m[2];
  const monthIdx = MONTHS_3.indexOf(mmm);
  if (monthIdx === -1) return null;
  const nextDate = new Date(2000 + yy, monthIdx + 1, 1);
  const nyy = String(nextDate.getFullYear()).slice(-2);
  const nmmm = MONTHS_3[nextDate.getMonth()];
  const nextSym = `NSE:${futBase}${nyy}${nmmm}FUT`;
  try {
    const q = await fetchQuoteFn(nextSym);
    const price = q?.lp ?? q?.ltp;
    if (price && isFinite(price) && price > 0) return nextSym;
  } catch (_) {}
  return null;
}

// ─── Option Chain Analysis ─────────────────────────────────────

// Fetch full option chain via Fyers
// fyers: a fyersModel instance
// symbol: 'NSE:NIFTY50-INDEX' or 'NSE:RELIANCE-EQ' etc.
// strikeCount: number of strikes ABOVE+BELOW spot (Fyers returns 2x this)
async function fetchOptionChain(fyers, symbol, strikeCount = 20) {
  if (typeof fyers.getOptionChain !== 'function') {
    return { error: 'getOptionChain not available in this SDK build' };
  }
  const r = await fyers.getOptionChain({
    symbol,
    strikecount: strikeCount,
    timestamp: '',
  });
  if (r?.s !== 'ok' || !r?.data) {
    return { error: r?.message || 'option chain fetch failed', raw: r };
  }
  return { ok: true, data: r.data };
}

// Compute Max Pain — strike at which option writers lose the LEAST.
// At expiry, total writer loss = sum over strikes where stock < strike (CE writers lose) +
// sum where stock > strike (PE writers lose).
// We compute total writer pain at each strike and find the minimum.
function computeMaxPain(optionsChain) {
  // Group by strike
  const byStrike = {};
  for (const opt of optionsChain) {
    const k = opt.strike_price;
    if (!byStrike[k]) byStrike[k] = { strike: k, ce: null, pe: null };
    if (opt.option_type === 'CE') byStrike[k].ce = opt;
    if (opt.option_type === 'PE') byStrike[k].pe = opt;
  }
  const strikes = Object.values(byStrike).filter((s) => s.ce && s.pe);
  if (strikes.length < 3) return null;

  // For each candidate "expiry price" (each strike), compute total writer pain
  let minPain = Infinity;
  let maxPainStrike = null;
  for (const candidate of strikes) {
    let pain = 0;
    for (const s of strikes) {
      // CE writers lose if expiry > strike; loss per lot = (expiry - strike) * CE_OI
      if (candidate.strike > s.strike) {
        pain += (candidate.strike - s.strike) * (s.ce.oi || 0);
      }
      // PE writers lose if expiry < strike
      if (candidate.strike < s.strike) {
        pain += (s.strike - candidate.strike) * (s.pe.oi || 0);
      }
    }
    if (pain < minPain) { minPain = pain; maxPainStrike = candidate.strike; }
  }
  return { strike: maxPainStrike, totalWriterPain: minPain };
}

// Compute PCR (Put-Call Ratio) — both volume-based and OI-based
function computePCR(optionsChain) {
  let totalCallOI = 0, totalPutOI = 0;
  let totalCallVol = 0, totalPutVol = 0;
  for (const opt of optionsChain) {
    if (opt.option_type === 'CE') {
      totalCallOI += opt.oi || 0;
      totalCallVol += opt.volume || 0;
    } else if (opt.option_type === 'PE') {
      totalPutOI += opt.oi || 0;
      totalPutVol += opt.volume || 0;
    }
  }
  return {
    pcrOI: totalCallOI > 0 ? totalPutOI / totalCallOI : null,
    pcrVolume: totalCallVol > 0 ? totalPutVol / totalCallVol : null,
    totalCallOI,
    totalPutOI,
    totalCallVol,
    totalPutVol,
  };
}

// Identify OI walls: highest CE OI = resistance, highest PE OI = support
function findOIWalls(optionsChain) {
  let topCE = null, topPE = null;
  for (const opt of optionsChain) {
    if (opt.option_type === 'CE' && (!topCE || opt.oi > topCE.oi)) topCE = opt;
    if (opt.option_type === 'PE' && (!topPE || opt.oi > topPE.oi)) topPE = opt;
  }
  return {
    resistance: topCE ? { strike: topCE.strike_price, oi: topCE.oi } : null,
    support:    topPE ? { strike: topPE.strike_price, oi: topPE.oi } : null,
  };
}

// Combine all option chain analytics into one analysis object
function analyzeOptionChain(rawData) {
  const chain = rawData.optionsChain || [];
  if (!chain.length) return { error: 'empty chain' };
  return {
    spot: rawData.optionsChain.find((o) => o.option_type === undefined || o.strike_price == null)?.ltp ?? null,
    callOI: rawData.callOi ?? null,
    putOI: rawData.putOi ?? null,
    indiaVix: rawData.indiavixData?.ltp ?? rawData.indiavixData ?? null,
    expiries: rawData.expiryData || [],
    pcr: computePCR(chain),
    maxPain: computeMaxPain(chain),
    oiWalls: findOIWalls(chain),
    chain, // raw strike data for table rendering
  };
}

// ─── Stock F&O OI Buildup Quadrant ─────────────────────────────
//
// Quadrant logic (the classic 4-way derivatives table):
//   Price ↑ + OI ↑ → LONG BUILDUP    (bullish: new longs being added)
//   Price ↓ + OI ↑ → SHORT BUILDUP   (bearish: new shorts being added)
//   Price ↑ + OI ↓ → SHORT COVERING  (bullish: shorts squaring off)
//   Price ↓ + OI ↓ → LONG UNWINDING  (bearish: longs squaring off)

function classifyBuildup(priceChangePct, oiChangePct) {
  if (priceChangePct == null || oiChangePct == null) return 'N/A';
  // Threshold ±0.1% to avoid noise
  if (Math.abs(priceChangePct) < 0.1 && Math.abs(oiChangePct) < 0.5) return 'NEUTRAL';
  if (priceChangePct > 0 && oiChangePct > 0) return 'LONG BUILDUP';
  if (priceChangePct < 0 && oiChangePct > 0) return 'SHORT BUILDUP';
  if (priceChangePct > 0 && oiChangePct < 0) return 'SHORT COVERING';
  if (priceChangePct < 0 && oiChangePct < 0) return 'LONG UNWINDING';
  return 'NEUTRAL';
}

// F&O stock universe — the most-traded F&O stocks (subset of NSE F&O list)
// Symbols use base name (no -EQ); we need to fetch their current-month future to get OI.
const FNO_STOCKS = [
  'RELIANCE', 'HDFCBANK', 'ICICIBANK', 'INFY', 'TCS', 'BHARTIARTL', 'ITC',
  'AXISBANK', 'KOTAKBANK', 'SBIN', 'LT', 'HINDUNILVR', 'BAJFINANCE', 'M&M',
  'MARUTI', 'TITAN', 'ASIANPAINT', 'WIPRO', 'TATASTEEL', 'JSWSTEEL', 'HCLTECH',
  'TECHM', 'TATAMOTORS', 'POWERGRID', 'NTPC', 'ULTRACEMCO', 'NESTLEIND',
  'SUNPHARMA', 'COALINDIA', 'ONGC', 'ADANIPORTS', 'BAJAJFINSV', 'GRASIM',
  'CIPLA', 'DRREDDY', 'EICHERMOT', 'BAJAJ-AUTO', 'HEROMOTOCO', 'INDUSINDBK',
  'TATACONSUM', 'BPCL', 'IOC', 'GAIL', 'ADANIENT', 'TRENT', 'SHRIRAMFIN',
  'HINDALCO', 'VEDL', 'DLF', 'TVSMOTOR', 'PFC', 'RECLTD', 'CUMMINSIND',
  'LICI', 'SBILIFE', 'HDFCLIFE', 'BEL', 'HAL', 'PIDILITIND', 'DIVISLAB',
];

async function getStockBuildup(fetchQuoteFn) {
  const out = [];
  // Resolve current-month future for each, fetch quote with OI
  const concurrency = 5;
  for (let i = 0; i < FNO_STOCKS.length; i += concurrency) {
    const batch = FNO_STOCKS.slice(i, i + concurrency);
    const results = await Promise.allSettled(batch.map(async (sym) => {
      const futSym = await resolveIndexFuture(sym, fetchQuoteFn); // same convention works for stock futs
      if (!futSym) return null;
      const q = await fetchQuoteFn(futSym).catch(() => null);
      if (!q) return null;
      const priceChangePct = q.chp ?? null;
      const oi = q.oi ?? null;
      const prevOI = q.prev_oi ?? q.previousOpenInterest ?? null;
      const oiChangePct = (oi != null && prevOI != null && prevOI > 0)
        ? ((oi - prevOI) / prevOI) * 100
        : (q.oi_change_perc ?? null); // some Fyers responses include this directly
      return {
        symbol: sym,
        futSymbol: futSym,
        price: q.lp ?? q.ltp ?? null,
        priceChangePct,
        oi,
        oiChangePct,
        volume: q.volume ?? q.v ?? null,
        buildup: classifyBuildup(priceChangePct, oiChangePct),
      };
    }));
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) out.push(r.value);
    }
    if (i + concurrency < FNO_STOCKS.length) {
      await new Promise((res) => setTimeout(res, 250));
    }
  }
  return out;
}

module.exports = {
  INDICES, FNO_STOCKS,
  resolveIndexFuture,
  getIndexFutures,
  fetchOptionChain,
  analyzeOptionChain,
  computeMaxPain, computePCR, findOIWalls,
  classifyBuildup,
  getStockBuildup,
};
