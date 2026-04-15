const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════════
//  Yahoo Finance — Cookie + Crumb Authentication
//  Yahoo now requires a session cookie + crumb token for all
//  API requests. We fetch these once and cache them.
// ═══════════════════════════════════════════════════════════

let yfCookie = '';
let yfCrumb = '';
let yfAuthTime = 0;
const YF_AUTH_TTL = 3600000; // re-auth every 1 hour

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function ensureYahooAuth() {
  if (yfCookie && yfCrumb && (Date.now() - yfAuthTime < YF_AUTH_TTL)) {
    return; // cached auth still valid
  }
  console.log('[YF] Refreshing cookie + crumb...');
  try {
    // Step 1: Get cookie by hitting fc.yahoo.com (which sets session cookies)
    const cookieResp = await fetch('https://fc.yahoo.com', {
      redirect: 'manual',
      headers: YF_HEADERS
    });
    const setCookies = cookieResp.headers.getSetCookie?.() || [];
    yfCookie = setCookies.map(c => c.split(';')[0]).join('; ');

    // Fallback: if no cookies from fc.yahoo.com, try finance.yahoo.com
    if (!yfCookie) {
      const fallbackResp = await fetch('https://finance.yahoo.com/', {
        redirect: 'manual',
        headers: YF_HEADERS
      });
      const fallbackCookies = fallbackResp.headers.getSetCookie?.() || [];
      yfCookie = fallbackCookies.map(c => c.split(';')[0]).join('; ');
    }

    if (!yfCookie) {
      console.log('[YF] Warning: No cookies received. Trying without auth...');
    }

    // Step 2: Get crumb using the cookie
    const crumbResp = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { ...YF_HEADERS, 'Cookie': yfCookie }
    });
    if (crumbResp.ok) {
      yfCrumb = await crumbResp.text();
      yfAuthTime = Date.now();
      console.log('[YF] Auth success. Crumb:', yfCrumb.substring(0, 6) + '...');
    } else {
      console.log('[YF] Crumb request failed:', crumbResp.status);
      // Try without crumb (some endpoints may work without it)
      yfCrumb = '';
      yfAuthTime = Date.now();
    }
  } catch (err) {
    console.error('[YF] Auth error:', err.message);
    yfCrumb = '';
    yfAuthTime = Date.now(); // Don't retry immediately
  }
}

async function fetchYahoo(baseUrl) {
  await ensureYahooAuth();

  // Append crumb to URL if we have one
  const separator = baseUrl.includes('?') ? '&' : '?';
  const url = yfCrumb ? `${baseUrl}${separator}crumb=${encodeURIComponent(yfCrumb)}` : baseUrl;

  const res = await fetch(url, {
    headers: { ...YF_HEADERS, 'Cookie': yfCookie }
  });

  if (res.status === 401 || res.status === 403) {
    // Cookie/crumb expired — force re-auth and retry once
    console.log('[YF] Got', res.status, '- re-authenticating...');
    yfAuthTime = 0; // force refresh
    await ensureYahooAuth();
    const retryUrl = yfCrumb ? `${baseUrl}${separator}crumb=${encodeURIComponent(yfCrumb)}` : baseUrl;
    const retry = await fetch(retryUrl, {
      headers: { ...YF_HEADERS, 'Cookie': yfCookie }
    });
    if (!retry.ok) throw new Error(`Yahoo retry failed: ${retry.status}`);
    return retry.json();
  }

  if (!res.ok) throw new Error(`Yahoo fetch failed: ${res.status}`);
  return res.json();
}

// ─── Initialize auth on startup ──────────────────────────
ensureYahooAuth().then(() => console.log('[YF] Initial auth complete'));

// ═══════════════════════════════════════════════════════════
//  API ROUTES
// ═══════════════════════════════════════════════════════════

// Quote (single or batch)
app.get('/api/quote/:symbols', async (req, res) => {
  try {
    const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(req.params.symbols)}`;
    const data = await fetchYahoo(url);
    const quotes = (data.quoteResponse?.result || []).map(q => ({
      symbol: q.symbol, name: q.shortName || q.longName || q.symbol,
      price: q.regularMarketPrice, change: q.regularMarketChange,
      changePercent: q.regularMarketChangePercent, previousClose: q.regularMarketPreviousClose,
      open: q.regularMarketOpen, dayHigh: q.regularMarketDayHigh,
      dayLow: q.regularMarketDayLow, volume: q.regularMarketVolume,
      marketCap: q.marketCap, currency: q.currency, exchange: q.exchange,
      marketState: q.marketState, fiftyTwoWeekHigh: q.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: q.fiftyTwoWeekLow, fiftyDayAverage: q.fiftyDayAverage,
      twoHundredDayAverage: q.twoHundredDayAverage
    }));
    res.json({ quotes });
  } catch (err) {
    console.error('[API] /quote error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Historical OHLC
app.get('/api/history/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const range = req.query.range || '6mo';
    const interval = req.query.interval || '1d';
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
    const data = await fetchYahoo(url);
    const result = data.chart?.result?.[0];
    if (!result) return res.status(404).json({ error: 'No data' });
    const ts = result.timestamp || [];
    const ohlc = result.indicators?.quote?.[0] || {};
    const candles = ts.map((t, i) => ({
      time: t, open: ohlc.open?.[i], high: ohlc.high?.[i],
      low: ohlc.low?.[i], close: ohlc.close?.[i], volume: ohlc.volume?.[i]
    })).filter(c => c.open != null);
    res.json({ symbol, currency: result.meta?.currency, candles });
  } catch (err) {
    console.error('[API] /history error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Search
app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.json({ results: [] });
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`;
    const data = await fetchYahoo(url);
    res.json({ results: (data.quotes || []).map(q => ({
      symbol: q.symbol, name: q.shortname || q.longname || q.symbol,
      type: q.quoteType, exchange: q.exchange
    }))});
  } catch (err) {
    console.error('[API] /search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Global indices
app.get('/api/markets', async (req, res) => {
  try {
    const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent('^GSPC,^DJI,^IXIC,^NSEI,^BSESN,^NSEBANK,^FTSE,^N225,^HSI,^GDAXI')}`;
    const data = await fetchYahoo(url);
    res.json({ markets: (data.quoteResponse?.result || []).map(q => ({
      symbol: q.symbol, name: q.shortName || q.longName,
      price: q.regularMarketPrice, change: q.regularMarketChange,
      changePercent: q.regularMarketChangePercent, marketState: q.marketState
    }))});
  } catch (err) {
    console.error('[API] /markets error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Ticker bar (indices + commodities + forex + crypto)
app.get('/api/ticker', async (req, res) => {
  try {
    const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent('^NSEBANK,^DJI,^IXIC,^NSEI,INDIAVIX.NS,CL=F,GC=F,SI=F,USDINR=X,^GSPC,BTC-USD,^VIX')}`;
    const data = await fetchYahoo(url);
    res.json({ tickers: (data.quoteResponse?.result || []).map(q => ({
      symbol: q.symbol, name: q.shortName || q.longName || q.symbol,
      price: q.regularMarketPrice, change: q.regularMarketChange,
      changePercent: q.regularMarketChangePercent
    }))});
  } catch (err) {
    console.error('[API] /ticker error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Sectors
app.get('/api/sectors', async (req, res) => {
  try {
    const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent('^CNXIT,^CNXBANKNIFTY,^CNXPHARMA,^CNXENERGY,^CNXFMCG,^CNXAUTO,^CNXMETAL,^CNXREALTY,^CNXINFRA,^CNXMEDIA')}`;
    const data = await fetchYahoo(url);
    res.json({ sectors: (data.quoteResponse?.result || []).map(q => ({
      symbol: q.symbol,
      name: (q.shortName || q.longName || q.symbol).replace(/NIFTY\s*/i, ''),
      price: q.regularMarketPrice, change: q.regularMarketChange,
      changePercent: q.regularMarketChangePercent
    }))});
  } catch (err) {
    console.error('[API] /sectors error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check / debug
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    yahooAuth: {
      hasCookie: !!yfCookie,
      hasCrumb: !!yfCrumb,
      cookieAge: yfAuthTime ? Math.round((Date.now() - yfAuthTime) / 1000) + 's ago' : 'never'
    }
  });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`InvestIQ Pro running on port ${PORT}`));
