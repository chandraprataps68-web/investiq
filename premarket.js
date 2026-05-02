// premarket.js — Pre-Market Dashboard data + bias computation
// Multi-source strategy (Render IPs are often blocked by Yahoo):
//   1. Stooq — free, no auth, no IP block, returns CSV. Primary source.
//   2. Yahoo chart endpoint — different from quote endpoint, no crumb required.
//   3. FII/DII via Moneycontrol mirror.

const { GLOBAL_CUES, NEWS_FEEDS } = require('./universe');

// ─── Symbol mapping for Stooq ──────────────────────────
// Stooq uses different ticker conventions. Mapping based on stooq.com
const STOOQ_MAP = {
  '^NSEI': '^nsei',         // GIFT/Nifty 50
  '^DJI': '^dji',           // Dow Jones
  '^IXIC': '^ixic',         // Nasdaq
  '^GSPC': '^spx',          // S&P 500 (stooq uses ^spx)
  '^N225': '^nkx',          // Nikkei (stooq: ^nkx)
  '^HSI': '^hsi',           // Hang Seng
  '^FTSE': '^ftm',          // FTSE 100 (stooq: ^ftm)
  '^GDAXI': '^dax',         // DAX
  'BZ=F': 'cb.f',           // Brent crude futures (stooq cb.f)
  'DX-Y.NYB': 'dx.f',       // Dollar index futures
  'INR=X': 'usdinr',        // USD/INR
  '^VIX': '^vix',           // VIX
};

// ─── Fetch from Stooq (primary) ────────────────────────
// Stooq returns lightweight CSV: Symbol,Date,Time,Open,High,Low,Close,Volume
async function fetchStooqQuote(stooqSym) {
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(stooqSym)}&f=sd2t2ohlcv&h&e=csv`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'InvestIQ/6.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`stooq HTTP ${res.status}`);
    const text = await res.text();
    const lines = text.trim().split('\n');
    if (lines.length < 2) throw new Error('empty CSV');
    const headers = lines[0].split(',');
    const values = lines[1].split(',');
    const row = {};
    headers.forEach((h, i) => { row[h.trim()] = values[i]?.trim(); });
    if (row.Close === 'N/D' || !row.Close) throw new Error('no close price');
    const close = parseFloat(row.Close);
    const open = parseFloat(row.Open);
    if (!isFinite(close)) throw new Error('invalid close');
    return {
      price: close,
      open,
      high: parseFloat(row.High),
      low: parseFloat(row.Low),
      // Stooq doesn't give prev close in the lite endpoint;
      // approximate change vs open as a fallback indicator
      change: close - open,
      changePct: open > 0 ? ((close - open) / open) * 100 : 0,
      source: 'stooq',
    };
  } catch (err) {
    return { error: err.message, source: 'stooq' };
  }
}

// ─── Yahoo chart endpoint fallback (no crumb required) ─
async function fetchYahooChart(yahooSym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=1d&range=5d`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`yahoo HTTP ${res.status}`);
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error('no chart data');
    const meta = result.meta;
    return {
      price: meta.regularMarketPrice,
      prevClose: meta.chartPreviousClose,
      change: meta.regularMarketPrice - meta.chartPreviousClose,
      changePct: ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100,
      source: 'yahoo-chart',
    };
  } catch (err) {
    return { error: err.message, source: 'yahoo-chart' };
  }
}

// ─── Combined fetch: try Stooq, fall back to Yahoo ─────
async function fetchGlobalCues() {
  const results = await Promise.all(
    GLOBAL_CUES.map(async (cue) => {
      const stooqSym = STOOQ_MAP[cue.yahoo];
      let data = stooqSym ? await fetchStooqQuote(stooqSym) : { error: 'no stooq mapping' };
      if (data.error) {
        // Fall back to Yahoo chart endpoint
        const yh = await fetchYahooChart(cue.yahoo);
        if (!yh.error) data = yh;
      }
      return { ...cue, ...data };
    })
  );
  return results;
}

// ─── RSS parser ────────────────────────────────────────
function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/g;
  const titleRegex = /<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/;
  const linkRegex = /<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/;
  const dateRegex = /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/;
  const descRegex = /<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/;

  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const title = (titleRegex.exec(block) || [])[1]?.trim();
    const link = (linkRegex.exec(block) || [])[1]?.trim();
    const dateRaw = (dateRegex.exec(block) || [])[1]?.trim();
    const desc = (descRegex.exec(block) || [])[1]?.trim();
    // Robust date parse: RSS uses RFC822 format (e.g., "Thu, 01 May 2026 12:34:56 GMT")
    let dateISO = null;
    if (dateRaw) {
      const d = new Date(dateRaw);
      if (!isNaN(d.getTime())) dateISO = d.toISOString();
    }
    if (title && link) {
      items.push({
        title: title.replace(/\s+/g, ' '),
        link,
        date: dateISO,
        desc: desc?.replace(/<[^>]+>/g, '').slice(0, 200),
      });
    }
  }
  return items;
}

async function fetchNews(maxPerFeed = 8) {
  const all = [];
  await Promise.all(NEWS_FEEDS.map(async (feed) => {
    try {
      const res = await fetch(feed.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 InvestIQ/6.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return;
      const xml = await res.text();
      const items = parseRSS(xml).slice(0, maxPerFeed);
      items.forEach((it) => all.push({ ...it, source: feed.name }));
    } catch (err) {
      console.error(`News ${feed.name}:`, err.message);
    }
  }));
  // Sort newest first; items with no date go last
  all.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return new Date(b.date) - new Date(a.date);
  });
  return all.slice(0, 20);
}

// ─── FII/DII via MrChartist's daily-refreshed JSON on GitHub ──
// Free, public, CDN-cached, no auth, no IP block.
async function fetchFIIDII() {
  const url = 'https://raw.githubusercontent.com/MrChartist/fii-dii-data/main/data/history.json';
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'InvestIQ/6.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    // history.json is an array of daily entries, newest last (or first — depends).
    // Each entry: { date, fii_buy, fii_sell, fii_net, dii_buy, dii_sell, dii_net } (or similar)
    const arr = Array.isArray(json) ? json : (json.history || json.data || []);
    if (!arr.length) throw new Error('empty array');
    // Find latest entry by date
    const sorted = [...arr].sort((a, b) =>
      new Date(b.date || b.tradingDate || 0) - new Date(a.date || a.tradingDate || 0)
    );
    const latest = sorted[0];
    // Try common field name variations
    const fiiNet = latest.fii_net ?? latest.fiiNet ?? latest.FII_Net ?? latest.fii?.net ?? null;
    const diiNet = latest.dii_net ?? latest.diiNet ?? latest.DII_Net ?? latest.dii?.net ?? null;
    const date = latest.date || latest.tradingDate || latest.Date;
    return {
      fii: typeof fiiNet === 'number' ? fiiNet : parseFloat(fiiNet) || null,
      dii: typeof diiNet === 'number' ? diiNet : parseFloat(diiNet) || null,
      date,
      source: 'github/MrChartist',
      note: 'Cash market, T-1',
    };
  } catch (err) {
    return { fii: null, dii: null, error: err.message };
  }
}

// ─── Compute directional bias ──────────────────────────
function computeBias({ globalCues, fiiDii }) {
  const reasons = [];
  let score = 0;

  const gift = globalCues.find((g) => g.id === 'GIFT_NIFTY');
  if (gift && gift.changePct != null && !gift.error) {
    if (gift.changePct > 0.5) { score += 3; reasons.push(`GIFT/Nifty +${gift.changePct.toFixed(2)}% (positive cue)`); }
    else if (gift.changePct < -0.5) { score -= 3; reasons.push(`GIFT/Nifty ${gift.changePct.toFixed(2)}% (negative cue)`); }
    else reasons.push(`Nifty flat (${gift.changePct.toFixed(2)}%)`);
  }

  const dow = globalCues.find((g) => g.id === 'DOW');
  if (dow && dow.changePct != null && !dow.error) {
    if (dow.changePct > 0.5) { score += 2; reasons.push(`Dow closed +${dow.changePct.toFixed(2)}%`); }
    else if (dow.changePct < -0.5) { score -= 2; reasons.push(`Dow closed ${dow.changePct.toFixed(2)}%`); }
  }

  const nasdaq = globalCues.find((g) => g.id === 'NASDAQ');
  if (nasdaq && nasdaq.changePct != null && !nasdaq.error) {
    if (nasdaq.changePct > 1) { score += 2; reasons.push(`Nasdaq strong: +${nasdaq.changePct.toFixed(2)}%`); }
    else if (nasdaq.changePct < -1) { score -= 2; reasons.push(`Nasdaq weak: ${nasdaq.changePct.toFixed(2)}%`); }
  }

  const nikkei = globalCues.find((g) => g.id === 'NIKKEI');
  if (nikkei && nikkei.changePct != null && !nikkei.error) {
    if (nikkei.changePct > 0.5) { score += 1; reasons.push(`Nikkei +${nikkei.changePct.toFixed(2)}%`); }
    else if (nikkei.changePct < -0.5) { score -= 1; reasons.push(`Nikkei ${nikkei.changePct.toFixed(2)}%`); }
  }

  const hsi = globalCues.find((g) => g.id === 'HANGSENG');
  if (hsi && hsi.changePct != null && !hsi.error) {
    if (hsi.changePct > 0.5) { score += 1; reasons.push(`Hang Seng +${hsi.changePct.toFixed(2)}%`); }
    else if (hsi.changePct < -0.5) { score -= 1; reasons.push(`Hang Seng ${hsi.changePct.toFixed(2)}%`); }
  }

  if (fiiDii?.fii != null) {
    if (fiiDii.fii > 1000) { score += 2; reasons.push(`FII bought ₹${fiiDii.fii.toFixed(0)} cr`); }
    else if (fiiDii.fii < -1000) { score -= 2; reasons.push(`FII sold ₹${Math.abs(fiiDii.fii).toFixed(0)} cr`); }
  }
  if (fiiDii?.dii != null) {
    if (fiiDii.dii > 1500) { score += 1; reasons.push(`DII bought ₹${fiiDii.dii.toFixed(0)} cr (cushion)`); }
  }

  const brent = globalCues.find((g) => g.id === 'BRENT');
  if (brent && brent.changePct != null && !brent.error) {
    if (brent.changePct > 2) { score -= 1; reasons.push(`Brent +${brent.changePct.toFixed(2)}% (negative for India)`); }
    else if (brent.changePct < -2) { score += 1; reasons.push(`Brent ${brent.changePct.toFixed(2)}% (positive for India)`); }
  }

  const dxy = globalCues.find((g) => g.id === 'DXY');
  if (dxy && dxy.changePct != null && !dxy.error) {
    if (dxy.changePct > 0.5) { score -= 1; reasons.push(`Dollar strong (DXY +${dxy.changePct.toFixed(2)}%)`); }
  }

  let bias;
  if (score >= 5) bias = 'STRONG BULLISH';
  else if (score >= 2) bias = 'BULLISH';
  else if (score <= -5) bias = 'STRONG BEARISH';
  else if (score <= -2) bias = 'BEARISH';
  else bias = 'NEUTRAL';

  return { bias, score, reasons };
}

async function getPreMarketSnapshot(opts = {}) {
  const fyersIndexFetcher = opts.fyersIndexFetcher; // optional: async (fyersSym) => {lp, ch, chp}

  const [globalCues, news, fiiDii] = await Promise.all([
    fetchGlobalCues(),
    fetchNews(),
    fetchFIIDII(),
  ]);

  // If Fyers is available, fill in India-specific cues that Stooq/Yahoo struggle with
  if (fyersIndexFetcher) {
    const indexMap = {
      'GIFT_NIFTY': 'NSE:NIFTY50-INDEX',
      'VIX': 'NSE:INDIAVIX-INDEX', // Note: shows India VIX, not US VIX
    };
    await Promise.all(Object.entries(indexMap).map(async ([cueId, fyersSym]) => {
      const cue = globalCues.find((c) => c.id === cueId);
      if (!cue || !cue.error) return; // already have data
      try {
        const q = await fyersIndexFetcher(fyersSym);
        if (q && (q.lp != null || q.ltp != null)) {
          const price = q.lp ?? q.ltp;
          const change = q.ch;
          const changePct = q.chp;
          Object.assign(cue, {
            price, change, changePct,
            error: undefined,
            source: 'fyers',
          });
          if (cueId === 'VIX') cue.name = 'India VIX'; // be honest about what we're showing
        }
      } catch (err) {
        // keep cue.error as-is
      }
    }));
  }

  const bias = computeBias({ globalCues, fiiDii });
  return {
    timestamp: new Date().toISOString(),
    globalCues,
    news,
    fiiDii,
    bias,
  };
}

module.exports = {
  getPreMarketSnapshot,
  fetchGlobalCues,
  fetchNews,
  fetchFIIDII,
  computeBias,
};
