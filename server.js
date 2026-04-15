const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════════
//  Yahoo Finance via yahoo-finance2 package
//  This handles cookie/crumb auth internally and is the
//  most reliable way to access Yahoo Finance data in 2026.
// ═══════════════════════════════════════════════════════════
let yf = null;
async function getYF() {
  if (yf) return yf;
  const mod = require('yahoo-finance2').default;
  yf = new mod({ suppressNotices: ['yahooSurvey'] });
  return yf;
}

// ─── Quote (single or batch) ─────────────────────────────
app.get('/api/quote/:symbols', async (req, res) => {
  try {
    const yahoo = await getYF();
    const syms = req.params.symbols.split(',').map(s => s.trim()).filter(Boolean);
    const results = [];
    // yahoo-finance2 v3 uses quote() for each symbol or quoteCombine
    for (const sym of syms) {
      try {
        const q = await yahoo.quote(sym);
        results.push({
          symbol: q.symbol, name: q.shortName || q.longName || q.symbol,
          price: q.regularMarketPrice, change: q.regularMarketChange,
          changePercent: q.regularMarketChangePercent, previousClose: q.regularMarketPreviousClose,
          open: q.regularMarketOpen, dayHigh: q.regularMarketDayHigh,
          dayLow: q.regularMarketDayLow, volume: q.regularMarketVolume,
          marketCap: q.marketCap, currency: q.currency, exchange: q.exchange,
          marketState: q.marketState, fiftyTwoWeekHigh: q.fiftyTwoWeekHigh,
          fiftyTwoWeekLow: q.fiftyTwoWeekLow, fiftyDayAverage: q.fiftyDayAverage,
          twoHundredDayAverage: q.twoHundredDayAverage
        });
      } catch (e) { console.error(`Quote ${sym}:`, e.message); }
    }
    res.json({ quotes: results });
  } catch (err) {
    console.error('/api/quote error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Historical OHLC (for candlestick charts) ───────────
app.get('/api/history/:symbol', async (req, res) => {
  try {
    const yahoo = await getYF();
    const sym = req.params.symbol;
    const range = req.query.range || '6mo';
    const interval = req.query.interval || '1d';

    // Convert range string to period1/period2 dates
    const now = new Date();
    const rangeMap = { '1d':1, '5d':5, '1mo':30, '3mo':90, '6mo':180, '1y':365, '2y':730, '5y':1825 };
    const days = rangeMap[range] || 180;
    const period1 = new Date(now.getTime() - days * 86400000);

    const result = await yahoo.chart(sym, {
      period1, period2: now, interval
    });

    const quotes = result.quotes || [];
    const candles = quotes
      .filter(q => q.open != null && q.close != null)
      .map(q => ({
        time: Math.floor(new Date(q.date).getTime() / 1000),
        open: q.open, high: q.high, low: q.low,
        close: q.close, volume: q.volume
      }));

    res.json({ symbol: sym, candles });
  } catch (err) {
    console.error('/api/history error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Search ──────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  try {
    const yahoo = await getYF();
    const q = req.query.q;
    if (!q) return res.json({ results: [] });
    const data = await yahoo.search(q, { quotesCount: 8, newsCount: 0 });
    res.json({ results: (data.quotes || []).map(r => ({
      symbol: r.symbol, name: r.shortname || r.longname || r.symbol,
      type: r.quoteType, exchange: r.exchange
    }))});
  } catch (err) {
    console.error('/api/search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Global markets (batch quote for indices) ────────────
app.get('/api/markets', async (req, res) => {
  try {
    const yahoo = await getYF();
    const syms = ['^GSPC','^DJI','^IXIC','^NSEI','^BSESN','^NSEBANK','^FTSE','^N225','^HSI','^GDAXI'];
    const markets = [];
    for (const sym of syms) {
      try {
        const q = await yahoo.quote(sym);
        markets.push({
          symbol: q.symbol, name: q.shortName || q.longName,
          price: q.regularMarketPrice, change: q.regularMarketChange,
          changePercent: q.regularMarketChangePercent, marketState: q.marketState
        });
      } catch (e) { /* skip failed */ }
    }
    res.json({ markets });
  } catch (err) {
    console.error('/api/markets error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Ticker bar ──────────────────────────────────────────
app.get('/api/ticker', async (req, res) => {
  try {
    const yahoo = await getYF();
    const syms = ['^NSEBANK','^DJI','^IXIC','^NSEI','INDIAVIX.NS','CL=F','GC=F','SI=F','USDINR=X','^GSPC','BTC-USD','^VIX'];
    const tickers = [];
    for (const sym of syms) {
      try {
        const q = await yahoo.quote(sym);
        tickers.push({
          symbol: q.symbol, name: q.shortName || q.longName || q.symbol,
          price: q.regularMarketPrice, change: q.regularMarketChange,
          changePercent: q.regularMarketChangePercent
        });
      } catch (e) { /* skip */ }
    }
    res.json({ tickers });
  } catch (err) {
    console.error('/api/ticker error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Sectors ─────────────────────────────────────────────
app.get('/api/sectors', async (req, res) => {
  try {
    const yahoo = await getYF();
    const syms = ['^CNXIT','^CNXBANKNIFTY','^CNXPHARMA','^CNXENERGY','^CNXFMCG','^CNXAUTO','^CNXMETAL','^CNXREALTY','^CNXINFRA','^CNXMEDIA'];
    const sectors = [];
    for (const sym of syms) {
      try {
        const q = await yahoo.quote(sym);
        sectors.push({
          symbol: q.symbol,
          name: (q.shortName || q.longName || q.symbol).replace(/NIFTY\s*/i, ''),
          price: q.regularMarketPrice, change: q.regularMarketChange,
          changePercent: q.regularMarketChangePercent
        });
      } catch (e) { /* skip */ }
    }
    res.json({ sectors });
  } catch (err) {
    console.error('/api/sectors error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Health check ────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    const yahoo = await getYF();
    const q = await yahoo.quote('AAPL');
    res.json({
      status: 'ok',
      test: { symbol: q.symbol, price: q.regularMarketPrice },
      message: 'Yahoo Finance connection working'
    });
  } catch (err) {
    res.json({
      status: 'error',
      message: err.message,
      hint: 'Yahoo Finance may be temporarily blocking this server IP. Try redeploying.'
    });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`InvestIQ Pro v2.1 running on port ${PORT}`));
