// twelvedata.js — Twelve Data API integration for pre-market global cues.
//
// Why: Yahoo Finance proven to rate-limit (HTTP 429) Render's outbound IP pool
// at the daily-quota level. Stooq unreachable from Render. Twelve Data has
// no such IP-based blocking, offers 800 free credits/day, supports batched
// requests (12 symbols in one HTTP call = 1 round-trip).
//
// Free tier limits:
//   - 800 credits/day (1 credit per symbol queried)
//   - 8 credits/minute
//   - Our usage: 12 symbols × ~6 refreshes/day = 72 credits/day (well under)
//
// API docs: https://twelvedata.com/docs#quote
// Sign up: https://twelvedata.com (no payment required for free tier)

const TD_API_BASE = 'https://api.twelvedata.com';
const TD_TIMEOUT_MS = 10_000;

// Map our cue IDs to Twelve Data symbol strings.
// Twelve Data uses different conventions than Yahoo:
//   - US indices: DJI, IXIC, SPX
//   - International indices: NI225, HSI, UKX, GDAXI
//   - Forex: EUR/USD format
//   - Commodities: BRENT (their own ticker)
// Verified at https://twelvedata.com/data/indices and /forex
const TD_SYMBOL_MAP = {
  GIFT_NIFTY: 'NIFTY',     // Twelve Data carries NIFTY index
  DOW: 'DJI',
  NASDAQ: 'IXIC',
  SP500: 'SPX',
  NIKKEI: 'N225',
  HANGSENG: 'HSI',
  FTSE: 'UKX',
  DAX: 'GDAXI',
  BRENT: 'BRENT',          // commodity ticker
  DXY: 'DXY',              // dollar index
  USDINR: 'USD/INR',       // forex pair
  VIX: 'VIX',              // volatility index
};

/**
 * Batch fetch quotes for all configured symbols in a single HTTP call.
 * Returns map of cue_id → { price, change, changePct, prevClose, source } or { error }.
 *
 * Twelve Data batch response shape:
 *   - Single symbol: { symbol: "DJI", close: "45123.45", ... }
 *   - Multiple symbols: { "DJI": { close: "...", ... }, "IXIC": { ... } }
 *   - On error: { code: 429, message: "..." } or per-symbol { code: 400, ... }
 */
async function fetchAllCues(apiKey) {
  if (!apiKey) return { error: 'TWELVEDATA_API_KEY not set' };

  const cueIds = Object.keys(TD_SYMBOL_MAP);
  const symbols = cueIds.map(id => TD_SYMBOL_MAP[id]).join(',');
  const url = `${TD_API_BASE}/quote?symbol=${encodeURIComponent(symbols)}&apikey=${apiKey}`;

  let res, body;
  try {
    res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'InvestIQ/6.0' },
      signal: AbortSignal.timeout(TD_TIMEOUT_MS),
    });
    body = await res.text();
  } catch (e) {
    return { error: `twelvedata fetch failed: ${e.message}` };
  }

  let json;
  try { json = JSON.parse(body); }
  catch (e) { return { error: `twelvedata bad JSON (HTTP ${res.status}): ${body.substring(0, 200)}` }; }

  // Top-level error (e.g., rate limit, bad API key)
  if (json.code && json.code !== 200) {
    return { error: `twelvedata error ${json.code}: ${json.message || 'unknown'}` };
  }

  // Single symbol returned the object directly (when only 1 symbol works); 
  // multi returns an object keyed by symbol. Normalize.
  const isSingleSymbolResponse = json.symbol && json.close;
  const result = {};

  for (const cueId of cueIds) {
    const tdSym = TD_SYMBOL_MAP[cueId];
    const symbolData = isSingleSymbolResponse && json.symbol === tdSym
      ? json
      : json[tdSym];

    if (!symbolData) {
      result[cueId] = { error: 'symbol not in response' };
      continue;
    }
    if (symbolData.code && symbolData.code !== 200) {
      result[cueId] = { error: `td ${symbolData.code}: ${symbolData.message}` };
      continue;
    }

    // Parse numeric fields (Twelve Data returns strings)
    const price = parseFloat(symbolData.close);
    const prevClose = parseFloat(symbolData.previous_close);
    const change = parseFloat(symbolData.change);
    const changePct = parseFloat(symbolData.percent_change);

    if (!Number.isFinite(price)) {
      result[cueId] = { error: 'no valid close price' };
      continue;
    }
    result[cueId] = {
      price,
      prevClose: Number.isFinite(prevClose) ? prevClose : null,
      change: Number.isFinite(change) ? change : null,
      changePct: Number.isFinite(changePct) ? changePct : null,
      source: 'twelvedata',
    };
  }

  return { results: result };
}

/**
 * Single-symbol fetch — used for diagnostic STATUS check.
 * Returns { ok, status, samplePrice, sampleSymbol, error? }.
 */
async function probeOneSymbol(apiKey, symbol = 'DJI') {
  if (!apiKey) return { ok: false, error: 'TWELVEDATA_API_KEY not set' };
  try {
    const url = `${TD_API_BASE}/quote?symbol=${symbol}&apikey=${apiKey}`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(TD_TIMEOUT_MS),
    });
    const body = await res.text();
    let json;
    try { json = JSON.parse(body); }
    catch {
      // Non-JSON usually means auth failure (HTML error page from CDN)
      if (res.status === 401 || res.status === 403) {
        return { ok: false, status: res.status, error: 'API key invalid or expired' };
      }
      return { ok: false, status: res.status, error: `non-JSON response (HTTP ${res.status})` };
    }
    if (json.code && json.code !== 200) {
      return { ok: false, status: json.code, error: json.message };
    }
    return {
      ok: !!json.close,
      status: res.status,
      sampleSymbol: json.symbol,
      samplePrice: json.close,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { fetchAllCues, probeOneSymbol, TD_SYMBOL_MAP };
