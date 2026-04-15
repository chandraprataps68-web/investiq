const express = require('express');
const path = require('path');
const { NseIndia } = require('stock-nse-india');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════════
//  DATA SOURCES
//  1. NSE India (stock-nse-india) — for Indian stocks/indices
//  2. Yahoo Finance (yahoo-finance2) — for global markets
// ═══════════════════════════════════════════════════════════

const nse = new NseIndia();

// Yahoo — lazy init
let yf = null, yfErr = null;
async function getYF() {
  if (yf) return yf;
  if (yfErr) return null;
  try {
    const mod = require('yahoo-finance2').default;
    const inst = new mod({ suppressNotices: ['yahooSurvey'] });
    await inst.quote('AAPL');
    yf = inst;
    console.log('[YF] ✅ Ready');
    return yf;
  } catch (e) {
    yfErr = e.message;
    console.log('[YF] ❌', e.message);
    return null;
  }
}

// ─── NSE: All indices with live prices ──────────────────
app.get('/api/nse/indices', async (req, res) => {
  try {
    const data = await nse.getAllIndices();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── NSE: Specific index data (NIFTY 50, NIFTY BANK, etc) ─
app.get('/api/nse/index/:name', async (req, res) => {
  try {
    const data = await nse.getEquityStockIndices(req.params.name);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── NSE: Equity details ────────────────────────────────
app.get('/api/nse/equity/:symbol', async (req, res) => {
  try {
    const data = await nse.getEquityDetails(req.params.symbol.toUpperCase());
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── NSE: Historical data ───────────────────────────────
app.get('/api/nse/history/:symbol', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 365;
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400000);
    const data = await nse.getEquityHistoricalData(req.params.symbol.toUpperCase(), { start, end });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── NSE: Market status ─────────────────────────────────
app.get('/api/nse/status', async (req, res) => {
  try {
    const data = await nse.getMarketStatus();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── NSE: Pre-open market data ──────────────────────────
app.get('/api/nse/preopen', async (req, res) => {
  try {
    const data = await nse.getPreOpenMarketData('NIFTY');
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Yahoo: Quote (global symbols) ──────────────────────
app.get('/api/yf/quote/:symbols', async (req, res) => {
  try {
    const yahoo = await getYF();
    if (!yahoo) return res.json({ quotes: [], error: 'Yahoo unavailable' });
    const syms = req.params.symbols.split(',');
    const quotes = [];
    for (const s of syms) {
      try {
        const q = await yahoo.quote(s.trim());
        quotes.push({
          symbol: q.symbol, name: q.shortName || q.longName,
          price: q.regularMarketPrice, change: q.regularMarketChange,
          changePercent: q.regularMarketChangePercent, volume: q.regularMarketVolume,
          marketCap: q.marketCap, dayHigh: q.regularMarketDayHigh,
          dayLow: q.regularMarketDayLow, previousClose: q.regularMarketPreviousClose,
          open: q.regularMarketOpen, fiftyTwoWeekHigh: q.fiftyTwoWeekHigh,
          fiftyTwoWeekLow: q.fiftyTwoWeekLow
        });
      } catch (e) {}
    }
    res.json({ quotes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Yahoo: Chart data ──────────────────────────────────
app.get('/api/yf/chart/:symbol', async (req, res) => {
  try {
    const yahoo = await getYF();
    if (!yahoo) return res.json({ candles: [] });
    const range = req.query.range || '6mo';
    const interval = req.query.interval || '1d';
    const days = { '1d': 1, '5d': 5, '1mo': 30, '6mo': 180, '1y': 365, '5y': 1825 }[range] || 180;
    const now = new Date();
    const r = await yahoo.chart(req.params.symbol, {
      period1: new Date(now.getTime() - days * 86400000), period2: now, interval
    });
    const candles = (r.quotes || []).filter(q => q.open != null).map(q => ({
      time: Math.floor(new Date(q.date).getTime() / 1000),
      open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume
    }));
    res.json({ candles });
  } catch (e) { res.json({ candles: [], error: e.message }); }
});

// ─── Yahoo: Search ──────────────────────────────────────
app.get('/api/yf/search', async (req, res) => {
  try {
    const yahoo = await getYF();
    if (!yahoo) return res.json({ results: [] });
    const d = await yahoo.search(req.query.q || '', { quotesCount: 8, newsCount: 0 });
    res.json({ results: (d.quotes || []).map(r => ({
      symbol: r.symbol, name: r.shortname || r.longname, exchange: r.exchange
    })) });
  } catch (e) { res.json({ results: [] }); }
});

// ─── Diagnostic ─────────────────────────────────────────
app.get('/api/test', async (req, res) => {
  const results = { timestamp: new Date().toISOString(), sources: {} };

  // Test NSE
  try {
    const d = await nse.getMarketStatus();
    results.sources.nse = { status: 'ok', data: d };
  } catch (e) {
    results.sources.nse = { status: 'error', error: e.message };
  }

  // Test Yahoo
  try {
    const yahoo = await getYF();
    if (yahoo) {
      const q = await yahoo.quote('AAPL');
      results.sources.yahoo = { status: 'ok', price: q.regularMarketPrice };
    } else {
      results.sources.yahoo = { status: 'failed', error: yfErr };
    }
  } catch (e) {
    results.sources.yahoo = { status: 'error', error: e.message };
  }

  res.json(results);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`InvestIQ Pro v3.0 on port ${PORT}`);
  // Warm up in background
  setTimeout(() => {
    nse.getMarketStatus().then(() => console.log('[NSE] ✅ Ready')).catch(e => console.log('[NSE] ❌', e.message));
    getYF();
  }, 2000);
});
