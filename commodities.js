// commodities.js — Commodities + Crypto for InvestIQ Pro v6
// Sources: Fyers (MCX futures), CoinGecko (crypto, free, no key)

const { COMMODITIES, CRYPTO } = require('./universe');
const TA = require('./ta');

// Fetch crypto prices in INR via CoinGecko
async function fetchCrypto() {
  const ids = CRYPTO.map((c) => c.id).join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=inr,usd&include_24hr_change=true&include_24hr_vol=true`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const data = await res.json();
    return CRYPTO.map((c) => {
      const d = data[c.id];
      if (!d) return { ...c, error: 'no data' };
      return {
        ...c,
        priceInr: d.inr,
        priceUsd: d.usd,
        change24h: d.inr_24h_change,
        volume24h: d.inr_24h_vol,
      };
    });
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
    // Convert prices array [[ts, price], ...] to OHLCV-ish daily candles
    const prices = data.prices || [];
    const volumes = data.total_volumes || [];
    // Group by day
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

// Fetch commodity quote + history via Fyers (caller passes fyers fns)
// fetchQuoteFn: async (fyersSym) => { lp, ch, chp, ... }
// fetchHistoryFn: async (fyersSym) => candles[]
async function fetchCommodities(fetchQuoteFn, fetchHistoryFn) {
  const out = [];
  for (const c of COMMODITIES) {
    try {
      const [quote, candles] = await Promise.all([
        fetchQuoteFn(c.fyers).catch(() => null),
        fetchHistoryFn(c.fyers).catch(() => []),
      ]);
      const a = candles && candles.length > 30 ? TA.fullAnalysis(candles) : null;
      const sig = a ? TA.generateSignal(a) : null;
      out.push({
        ...c,
        price: quote?.lp ?? quote?.ltp ?? a?.price ?? null,
        change: quote?.ch ?? null,
        changePct: quote?.chp ?? null,
        signal: sig?.signal ?? 'NO DATA',
        confidence: sig?.confidence ?? 0,
        targets: sig?.targets ?? null,
        rationale: sig?.rationale ?? [],
        rsi: a?.rsi14 ?? null,
        ftw: a?.ftw ?? null,
        sparkline: candles.slice(-30).map((c) => c.c),
      });
    } catch (err) {
      out.push({ ...c, error: err.message });
    }
  }
  return out;
}

module.exports = { fetchCrypto, fetchCryptoHistory, fetchCommodities };
