// commodities.js — Commodities + Crypto for InvestIQ Pro v6
// Sources: Fyers (MCX futures), CoinGecko (crypto, free, no key)
//
// MCX contracts expire monthly. Instead of hardcoding contract months
// (e.g. GOLD25DECFUT) which go stale, we probe the next few months and
// use whichever returns valid data. Resolved symbols are cached so we
// don't probe on every request.

const { COMMODITIES, CRYPTO } = require('./universe');
const TA = require('./ta');

const MONTHS_3 = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// In-memory cache: { GOLD: 'MCX:GOLD26MAYFUT', SILVER: ... }
const contractCache = new Map();
// Cached entries last until end of month so we re-resolve on rollover.
const cacheUntil = new Map();

// Generate the list of plausible active contracts for a base symbol.
// Indian commodity futures conventions:
//  - Bullion (GOLD, SILVER): expire on 5th of even months (Feb, Apr, Jun, Aug, Oct, Dec)
//    BUT mini variants (GOLDM, SILVERM) trade monthly. We'll just try sequentially.
//  - Energy (CRUDEOIL, NATURALGAS): monthly expiry, on 19th-ish.
//  - Base metals (COPPER, ZINC, etc.): monthly expiry.
// To avoid hardcoding all this, we try the next 6 months in order.
function plausibleContracts(base, exchange = 'MCX') {
  const now = new Date();
  const candidates = [];
  // Try current month first, then next 5
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const yy = String(d.getFullYear()).slice(-2);
    const mmm = MONTHS_3[d.getMonth()];
    candidates.push(`${exchange}:${base}${yy}${mmm}FUT`);
  }
  return candidates;
}

// Resolve active contract for a base symbol. Tries plausible contracts,
// returns the first one that fetchQuoteFn returns a valid price for.
async function resolveContract(base, exchange, fetchQuoteFn) {
  const cacheKey = `${exchange}:${base}`;
  // Check cache (valid until end of current month)
  const cachedSym = contractCache.get(cacheKey);
  const cachedTtl = cacheUntil.get(cacheKey) || 0;
  if (cachedSym && Date.now() < cachedTtl) return cachedSym;

  const candidates = plausibleContracts(base, exchange);
  for (const sym of candidates) {
    try {
      const q = await fetchQuoteFn(sym);
      const price = q?.lp ?? q?.ltp;
      if (price != null && isFinite(price) && price > 0) {
        contractCache.set(cacheKey, sym);
        // Cache until end of current month + 5 days buffer
        const eom = new Date();
        eom.setMonth(eom.getMonth() + 1, 5);
        cacheUntil.set(cacheKey, eom.getTime());
        console.log(`[commodity resolver] ${base} → ${sym}`);
        return sym;
      }
    } catch (e) {
      // try next candidate
    }
  }
  console.warn(`[commodity resolver] No active contract found for ${base}`);
  return null;
}

// Fetch crypto prices in INR via CoinGecko, with Binance USD fallback
async function fetchCrypto() {
  const ids = CRYPTO.map((c) => c.id).join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=inr,usd&include_24hr_change=true&include_24hr_vol=true`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const data = await res.json();
    // Sanity-check: at least one coin should have a price
    const hasData = CRYPTO.some((c) => data[c.id]?.inr || data[c.id]?.usd);
    if (!hasData) throw new Error('CoinGecko returned no usable data');
    return CRYPTO.map((c) => {
      const d = data[c.id];
      if (!d) return { ...c, error: 'no data' };
      return {
        ...c,
        priceInr: d.inr,
        priceUsd: d.usd,
        change24h: d.inr_24h_change,
        volume24h: d.inr_24h_vol,
        source: 'coingecko',
      };
    });
  } catch (err) {
    console.warn('[crypto] CoinGecko failed, trying CoinCap fallback:', err.message);
    return fetchCryptoCoinCapFallback();
  }
}

// CoinCap fallback — no API key, no IP blocks, simpler than Binance.
// Returns USD prices; we convert to INR using a hardcoded approximate rate.
async function fetchCryptoCoinCapFallback() {
  const map = {
    bitcoin: 'bitcoin',
    ethereum: 'ethereum',
    solana: 'solana',
    binancecoin: 'binance-coin',
  };
  const USD_INR = 84.5;
  try {
    // Fetch all in parallel; CoinCap doesn't have a batch endpoint
    const results = await Promise.all(CRYPTO.map(async (c) => {
      const cid = map[c.id];
      if (!cid) return { ...c, error: 'no mapping' };
      try {
        const url = `https://api.coincap.io/v2/assets/${cid}`;
        const res = await fetch(url, {
          headers: { 'User-Agent': 'InvestIQ/6.0' },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`CoinCap HTTP ${res.status}`);
        const json = await res.json();
        const d = json.data;
        if (!d) throw new Error('no data field');
        const usd = parseFloat(d.priceUsd);
        const change24h = parseFloat(d.changePercent24Hr);
        const volumeUsd = parseFloat(d.volumeUsd24Hr);
        return {
          ...c,
          priceInr: usd * USD_INR,
          priceUsd: usd,
          change24h: change24h,
          volume24h: (volumeUsd || 0) * USD_INR,
          source: 'coincap',
        };
      } catch (err) {
        return { ...c, error: err.message };
      }
    }));
    return results;
  } catch (err) {
    return CRYPTO.map((c) => ({ ...c, error: err.message }));
  }
}

// Fetch crypto historical (for chart) — CoinGecko free tier
async function fetchCryptoHistory(coinId, days = 90) {
  const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=inr&days=${days}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const prices = data.prices || [];
    const volumes = data.total_volumes || [];
    const daily = {};
    prices.forEach(([ts, price], i) => {
      const day = new Date(ts).toISOString().slice(0, 10);
      if (!daily[day]) {
        daily[day] = { t: ts / 1000, o: price, h: price, l: price, c: price, v: 0 };
      } else {
        daily[day].h = Math.max(daily[day].h, price);
        daily[day].l = Math.min(daily[day].l, price);
        daily[day].c = price;
      }
      if (volumes[i]) daily[day].v += volumes[i][1];
    });
    return Object.values(daily);
  } catch (err) {
    console.error('Crypto history error:', err.message);
    return [];
  }
}

// Fetch commodity quote + history via Fyers, with active-contract resolution.
// fetchQuoteFn: async (fyersSym) => { lp, ch, chp, ... }
// fetchHistoryFn: async (fyersSym) => candles[]
async function fetchCommodities(fetchQuoteFn, fetchHistoryFn) {
  const out = [];
  for (const c of COMMODITIES) {
    try {
      // Resolve symbol: equity has fixed `fyers`; futures use `base`+exchange
      let fyersSym = c.fyers;
      if (!fyersSym && c.base) {
        fyersSym = await resolveContract(c.base, c.exchange || 'MCX', fetchQuoteFn);
      }
      if (!fyersSym) {
        out.push({ ...c, error: 'no active contract found', signal: 'NO DATA' });
        continue;
      }

      const [quote, candles] = await Promise.all([
        fetchQuoteFn(fyersSym).catch(() => null),
        fetchHistoryFn(fyersSym).catch(() => []),
      ]);
      const a = candles && candles.length > 30 ? TA.fullAnalysis(candles) : null;
      const sig = a ? TA.generateSignal(a) : null;
      out.push({
        ...c,
        fyers: fyersSym, // expose resolved symbol so frontend can deep-link
        price: quote?.lp ?? quote?.ltp ?? a?.price ?? null,
        change: quote?.ch ?? null,
        changePct: quote?.chp ?? null,
        signal: sig?.signal ?? 'NO DATA',
        confidence: sig?.confidence ?? 0,
        targets: sig?.targets ?? null,
        rationale: sig?.rationale ?? [],
        rsi: a?.rsi14 ?? null,
        ftw: a?.ftw ?? null,
        sparkline: (candles || []).slice(-30).map((cd) => cd.c),
      });
    } catch (err) {
      out.push({ ...c, error: err.message, signal: 'NO DATA' });
    }
  }
  return out;
}

module.exports = { fetchCrypto, fetchCryptoHistory, fetchCommodities, resolveContract };
