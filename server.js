const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════════
//  STOCK DATA PROXY
//  Proxies requests to the Koyeb-hosted Indian Stock Market API
//  This avoids CORS issues when calling from the browser.
//  Source: https://github.com/0xramm/Indian-Stock-Market-API
// ═══════════════════════════════════════════════════════════
const STOCK_API = 'https://military-jobye-haiqstudios-14f59639.koyeb.app';

async function proxyFetch(apiPath) {
  const url = STOCK_API + apiPath;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'InvestIQ-Pro/4.0', 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error(`Upstream ${res.status}`);
  return res.json();
}

// Single stock quote
app.get('/api/stock', async (req, res) => {
  try {
    const sym = req.query.symbol;
    if (!sym) return res.status(400).json({ error: 'symbol required' });
    const data = await proxyFetch(`/stock?symbol=${encodeURIComponent(sym)}&res=num`);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Batch stock quotes
app.get('/api/stocks', async (req, res) => {
  try {
    const syms = req.query.symbols;
    if (!syms) return res.status(400).json({ error: 'symbols required' });
    const data = await proxyFetch(`/stock/list?symbols=${encodeURIComponent(syms)}&res=num`);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Search
app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.json({ results: [] });
    const data = await proxyFetch(`/search?q=${encodeURIComponent(q)}`);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Historical chart data (Yahoo Finance v8 chart — proxied through our server)
app.get('/api/chart/:symbol', async (req, res) => {
  try {
    const sym = req.params.symbol;
    const range = req.query.range || '6mo';
    const interval = req.query.interval || '1d';
    // Try Yahoo v8 chart endpoint directly from server
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
    });
    if (!r.ok) {
      // Try query2
      const r2 = await fetch(url.replace('query1', 'query2'), {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
      });
      if (!r2.ok) return res.json({ candles: [] });
      const d2 = await r2.json();
      return res.json(parseChart(d2));
    }
    const d = await r.json();
    res.json(parseChart(d));
  } catch (e) { res.json({ candles: [] }); }
});

function parseChart(d) {
  const result = d.chart?.result?.[0];
  if (!result) return { candles: [] };
  const ts = result.timestamp || [];
  const ohlc = result.indicators?.quote?.[0] || {};
  const candles = ts.map((t, i) => ({
    time: t, open: ohlc.open?.[i], high: ohlc.high?.[i],
    low: ohlc.low?.[i], close: ohlc.close?.[i], volume: ohlc.volume?.[i]
  })).filter(c => c.open != null && c.close != null);
  return { candles };
}

// Health / diagnostics
app.get('/api/health', async (req, res) => {
  const results = { version: '4.0', timestamp: new Date().toISOString(), sources: {} };
  // Test Koyeb API
  try {
    const d = await proxyFetch('/stock?symbol=RELIANCE&res=num');
    results.sources.koyeb = { status: 'ok', price: d.data?.last_price };
  } catch (e) { results.sources.koyeb = { status: 'error', error: e.message }; }
  // Test Yahoo chart
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/RELIANCE.NS?range=5d&interval=1d', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    results.sources.yahoo_chart = { status: r.ok ? 'ok' : 'blocked', code: r.status };
  } catch (e) { results.sources.yahoo_chart = { status: 'error', error: e.message }; }
  res.json(results);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`InvestIQ Pro v4.0 on port ${PORT}`));
