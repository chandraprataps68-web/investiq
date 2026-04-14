const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Yahoo Finance helpers ───────────────────────────────────────────
async function fetchYahoo(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });
  if (!res.ok) throw new Error(`Yahoo fetch failed: ${res.status}`);
  return res.json();
}

// ─── Quote endpoint (single or multiple tickers) ────────────────────
app.get('/api/quote/:symbols', async (req, res) => {
  try {
    const symbols = req.params.symbols;
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}`;
    const data = await fetchYahoo(url);
    const quotes = (data.quoteResponse?.result || []).map(q => ({
      symbol: q.symbol,
      name: q.shortName || q.longName || q.symbol,
      price: q.regularMarketPrice,
      change: q.regularMarketChange,
      changePercent: q.regularMarketChangePercent,
      previousClose: q.regularMarketPreviousClose,
      open: q.regularMarketOpen,
      dayHigh: q.regularMarketDayHigh,
      dayLow: q.regularMarketDayLow,
      volume: q.regularMarketVolume,
      marketCap: q.marketCap,
      currency: q.currency,
      exchange: q.exchange,
      marketState: q.marketState
    }));
    res.json({ quotes });
  } catch (err) {
    console.error('Quote error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Historical data for candlestick charts ─────────────────────────
app.get('/api/history/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const range = req.query.range || '6mo';
    const interval = req.query.interval || '1d';
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
    const data = await fetchYahoo(url);
    const result = data.chart?.result?.[0];
    if (!result) return res.status(404).json({ error: 'No data found' });

    const timestamps = result.timestamp || [];
    const ohlc = result.indicators?.quote?.[0] || {};
    const candles = timestamps.map((t, i) => ({
      time: t,
      open: ohlc.open?.[i],
      high: ohlc.high?.[i],
      low: ohlc.low?.[i],
      close: ohlc.close?.[i],
      volume: ohlc.volume?.[i]
    })).filter(c => c.open != null && c.close != null);

    res.json({
      symbol,
      currency: result.meta?.currency,
      candles
    });
  } catch (err) {
    console.error('History error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Search / autocomplete ──────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.json({ results: [] });
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`;
    const data = await fetchYahoo(url);
    const results = (data.quotes || []).map(q => ({
      symbol: q.symbol,
      name: q.shortname || q.longname || q.symbol,
      type: q.quoteType,
      exchange: q.exchange
    }));
    res.json({ results });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Global market indices ──────────────────────────────────────────
app.get('/api/markets', async (req, res) => {
  try {
    const indices = '^GSPC,^DJI,^IXIC,^NSEI,^BSESN,^FTSE,^N225,^HSI,^GDAXI';
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${indices}`;
    const data = await fetchYahoo(url);
    const markets = (data.quoteResponse?.result || []).map(q => ({
      symbol: q.symbol,
      name: q.shortName || q.longName,
      price: q.regularMarketPrice,
      change: q.regularMarketChange,
      changePercent: q.regularMarketChangePercent,
      marketState: q.marketState
    }));
    res.json({ markets });
  } catch (err) {
    console.error('Markets error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Trending tickers ───────────────────────────────────────────────
app.get('/api/trending', async (req, res) => {
  try {
    const url = 'https://query1.finance.yahoo.com/v1/finance/trending/IN?count=10';
    const data = await fetchYahoo(url);
    const symbols = (data.finance?.result?.[0]?.quotes || []).map(q => q.symbol);
    if (symbols.length === 0) return res.json({ trending: [] });

    const quoteUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols.join(',')}`;
    const quoteData = await fetchYahoo(quoteUrl);
    const trending = (quoteData.quoteResponse?.result || []).map(q => ({
      symbol: q.symbol,
      name: q.shortName || q.longName,
      price: q.regularMarketPrice,
      change: q.regularMarketChange,
      changePercent: q.regularMarketChangePercent
    }));
    res.json({ trending });
  } catch (err) {
    console.error('Trending error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Catch-all for SPA ──────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`InvestIQ Pro running on port ${PORT}`);
});
