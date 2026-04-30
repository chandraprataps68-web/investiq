// premarket.js — Pre-Market Dashboard data + bias computation
// Fetches: global cues (Yahoo), news (RSS), FII/DII (cached/scraped)
// Outputs: directional bias card with reasons

const { GLOBAL_CUES, NEWS_FEEDS } = require('./universe');

// Yahoo Finance unofficial quote endpoint — free, no key
// Format: https://query1.finance.yahoo.com/v7/finance/quote?symbols=...
async function fetchGlobalCues() {
  const symbols = GLOBAL_CUES.map((g) => g.yahoo).join(',');
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 InvestIQ/6.0',
        Accept: 'application/json',
      },
    });
    if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
    const json = await res.json();
    const quotes = json?.quoteResponse?.result || [];

    return GLOBAL_CUES.map((cue) => {
      const q = quotes.find((x) => x.symbol === cue.yahoo);
      if (!q) return { ...cue, error: 'no data' };
      return {
        ...cue,
        price: q.regularMarketPrice,
        change: q.regularMarketChange,
        changePct: q.regularMarketChangePercent,
        prevClose: q.regularMarketPreviousClose,
        marketState: q.marketState, // PRE / REGULAR / POST / CLOSED
      };
    });
  } catch (err) {
    console.error('Global cues error:', err.message);
    return GLOBAL_CUES.map((c) => ({ ...c, error: err.message }));
  }
}

// Simple RSS parser — RSS feeds have a predictable structure
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
    const date = (dateRegex.exec(block) || [])[1]?.trim();
    const desc = (descRegex.exec(block) || [])[1]?.trim();
    if (title && link) {
      items.push({ title, link, date, desc: desc?.replace(/<[^>]+>/g, '').slice(0, 200) });
    }
  }
  return items;
}

async function fetchNews(maxPerFeed = 5) {
  const all = [];
  for (const feed of NEWS_FEEDS) {
    try {
      const res = await fetch(feed.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 InvestIQ/6.0' },
      });
      if (!res.ok) continue;
      const xml = await res.text();
      const items = parseRSS(xml).slice(0, maxPerFeed);
      items.forEach((it) => all.push({ ...it, source: feed.name }));
    } catch (err) {
      console.error(`News ${feed.name}:`, err.message);
    }
  }
  // Sort by date, newest first
  all.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  return all.slice(0, 15);
}

// FII/DII data — NSE publishes daily but blocks bots. We use an aggregator.
// Fallback: parse from a public mirror. Best practice = scheduled CF Worker.
async function fetchFIIDII() {
  try {
    // Trendlyne has a public JSON endpoint that updates EOD
    const res = await fetch('https://trendlyne.com/macro-data/fii-dii/snapshot/', {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`FII/DII HTTP ${res.status}`);
    const html = await res.text();
    // Light scrape — extract net values
    // Look for "FII" and "DII" with numeric net values
    const fiiMatch = html.match(/FII[^<]*<[^>]*>[^<]*<[^>]*>([\-\+]?[\d,]+\.\d+)/i);
    const diiMatch = html.match(/DII[^<]*<[^>]*>[^<]*<[^>]*>([\-\+]?[\d,]+\.\d+)/i);
    return {
      fii: fiiMatch ? parseFloat(fiiMatch[1].replace(/,/g, '')) : null,
      dii: diiMatch ? parseFloat(diiMatch[1].replace(/,/g, '')) : null,
      source: 'trendlyne',
      note: 'Cash market, T-1 (previous day)',
    };
  } catch (err) {
    return { fii: null, dii: null, error: err.message };
  }
}

// Compute directional bias from inputs
function computeBias({ globalCues, fiiDii, vix }) {
  const reasons = [];
  let score = 0; // -10 (very bearish) to +10 (very bullish)

  // GIFT Nifty as primary indicator
  const gift = globalCues.find((g) => g.id === 'GIFT_NIFTY');
  if (gift && gift.changePct != null) {
    if (gift.changePct > 0.5) { score += 3; reasons.push(`GIFT Nifty +${gift.changePct.toFixed(2)}% (positive cue)`); }
    else if (gift.changePct < -0.5) { score -= 3; reasons.push(`GIFT Nifty ${gift.changePct.toFixed(2)}% (negative cue)`); }
    else reasons.push(`GIFT Nifty flat (${gift.changePct?.toFixed(2)}%)`);
  }

  // US markets close = direct cue for next-day Nifty
  const dow = globalCues.find((g) => g.id === 'DOW');
  const nasdaq = globalCues.find((g) => g.id === 'NASDAQ');
  if (dow && dow.changePct != null) {
    if (dow.changePct > 0.5) { score += 2; reasons.push(`Dow closed +${dow.changePct.toFixed(2)}%`); }
    else if (dow.changePct < -0.5) { score -= 2; reasons.push(`Dow closed ${dow.changePct.toFixed(2)}%`); }
  }
  if (nasdaq && nasdaq.changePct != null) {
    if (nasdaq.changePct > 1) { score += 2; reasons.push(`Nasdaq strong: +${nasdaq.changePct.toFixed(2)}%`); }
    else if (nasdaq.changePct < -1) { score -= 2; reasons.push(`Nasdaq weak: ${nasdaq.changePct.toFixed(2)}%`); }
  }

  // Asian markets
  const nikkei = globalCues.find((g) => g.id === 'NIKKEI');
  const hsi = globalCues.find((g) => g.id === 'HANGSENG');
  if (nikkei && nikkei.changePct != null) {
    if (nikkei.changePct > 0.5) { score += 1; reasons.push(`Nikkei +${nikkei.changePct.toFixed(2)}%`); }
    else if (nikkei.changePct < -0.5) { score -= 1; reasons.push(`Nikkei ${nikkei.changePct.toFixed(2)}%`); }
  }

  // FII/DII
  if (fiiDii && fiiDii.fii != null) {
    if (fiiDii.fii > 1000) { score += 2; reasons.push(`FII bought ₹${fiiDii.fii.toFixed(0)} cr`); }
    else if (fiiDii.fii < -1000) { score -= 2; reasons.push(`FII sold ₹${Math.abs(fiiDii.fii).toFixed(0)} cr`); }
  }
  if (fiiDii && fiiDii.dii != null) {
    if (fiiDii.dii > 1500) { score += 1; reasons.push(`DII bought ₹${fiiDii.dii.toFixed(0)} cr (cushion)`); }
  }

  // Crude oil — inverse for India
  const brent = globalCues.find((g) => g.id === 'BRENT');
  if (brent && brent.changePct != null) {
    if (brent.changePct > 2) { score -= 1; reasons.push(`Brent +${brent.changePct.toFixed(2)}% (negative for India)`); }
    else if (brent.changePct < -2) { score += 1; reasons.push(`Brent ${brent.changePct.toFixed(2)}% (positive for India)`); }
  }

  // Dollar Index — strong dollar generally bad for EM
  const dxy = globalCues.find((g) => g.id === 'DXY');
  if (dxy && dxy.changePct != null) {
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

// Main entry point — call this from the API route
async function getPreMarketSnapshot() {
  const [globalCues, news, fiiDii] = await Promise.all([
    fetchGlobalCues(),
    fetchNews(),
    fetchFIIDII(),
  ]);
  const bias = computeBias({ globalCues, fiiDii });
  return {
    timestamp: new Date().toISOString(),
    globalCues,
    news,
    fiiDii,
    bias,
  };
}

module.exports = { getPreMarketSnapshot, fetchGlobalCues, fetchNews, fetchFIIDII, computeBias };
