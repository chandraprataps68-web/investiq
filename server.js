const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function fetchYahoo(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  if (!res.ok) throw new Error(`Yahoo fetch failed: ${res.status}`);
  return res.json();
}

// Quote (single or batch)
app.get('/api/quote/:symbols', async (req, res) => {
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(req.params.symbols)}`;
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Historical OHLC
app.get('/api/history/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const range = req.query.range || '6mo';
    const interval = req.query.interval || '1d';
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Search
app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.json({ results: [] });
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`;
    const data = await fetchYahoo(url);
    res.json({ results: (data.quotes || []).map(q => ({
      symbol: q.symbol, name: q.shortname || q.longname || q.symbol,
      type: q.quoteType, exchange: q.exchange
    }))});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Global indices
app.get('/api/markets', async (req, res) => {
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=^GSPC,^DJI,^IXIC,^NSEI,^BSESN,^NSEBANK,^FTSE,^N225,^HSI,^GDAXI`;
    const data = await fetchYahoo(url);
    res.json({ markets: (data.quoteResponse?.result || []).map(q => ({
      symbol: q.symbol, name: q.shortName || q.longName,
      price: q.regularMarketPrice, change: q.regularMarketChange,
      changePercent: q.regularMarketChangePercent, marketState: q.marketState
    }))});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Ticker bar (indices + commodities + forex + crypto)
app.get('/api/ticker', async (req, res) => {
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent('^NSEBANK,^DJI,^IXIC,^NSEI,INDIAVIX.NS,CL=F,GC=F,SI=F,USDINR=X,^GSPC,BTC-USD,^VIX')}`;
    const data = await fetchYahoo(url);
    res.json({ tickers: (data.quoteResponse?.result || []).map(q => ({
      symbol: q.symbol, name: q.shortName || q.longName || q.symbol,
      price: q.regularMarketPrice, change: q.regularMarketChange,
      changePercent: q.regularMarketChangePercent
    }))});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Sectors
app.get('/api/sectors', async (req, res) => {
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent('^CNXIT,^CNXBANKNIFTY,^CNXPHARMA,^CNXENERGY,^CNXFMCG,^CNXAUTO,^CNXMETAL,^CNXREALTY,^CNXINFRA,^CNXMEDIA')}`;
    const data = await fetchYahoo(url);
    res.json({ sectors: (data.quoteResponse?.result || []).map(q => ({
      symbol: q.symbol,
      name: (q.shortName || q.longName || q.symbol).replace(/NIFTY\s*/i, ''),
      price: q.regularMarketPrice, change: q.regularMarketChange,
      changePercent: q.regularMarketChangePercent
    }))});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`InvestIQ Pro running on port ${PORT}`));
