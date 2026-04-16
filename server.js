const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════════
//  Yahoo Finance v8 CHART endpoint — works from Render!
//  We use this for EVERYTHING: current price, OHLCV, history.
//  The v7 quote endpoint is blocked, but v8 chart is not.
// ═══════════════════════════════════════════════════════════
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

async function yahooChart(symbol, range = '1d', interval = '5m') {
  for (const host of ['query1', 'query2']) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!r.ok) continue;
      const d = await r.json();
      const res = d.chart?.result?.[0];
      if (!res) continue;
      const meta = res.meta || {};
      const ts = res.timestamp || [];
      const q = res.indicators?.quote?.[0] || {};
      const candles = ts.map((t, i) => ({
        time: t, open: q.open?.[i], high: q.high?.[i],
        low: q.low?.[i], close: q.close?.[i], volume: q.volume?.[i]
      })).filter(c => c.open != null && c.close != null);
      return {
        meta: {
          symbol: meta.symbol, name: meta.shortName || meta.longName || meta.symbol,
          price: meta.regularMarketPrice, previousClose: meta.previousClose || meta.chartPreviousClose,
          currency: meta.currency, exchange: meta.exchangeName,
          marketState: meta.marketState,
          fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh, fiftyTwoWeekLow: meta.fiftyTwoWeekLow
        },
        candles
      };
    } catch (e) { continue; }
  }
  return { meta: {}, candles: [] };
}

// ─── Quote (uses 1d chart to get current price + meta) ──
app.get('/api/quote/:symbols', async (req, res) => {
  try {
    const syms = req.params.symbols.split(',').map(s => s.trim()).filter(Boolean);
    const quotes = [];
    for (const sym of syms) {
      const ticker = sym.includes('.') ? sym : sym + '.NS';
      const d = await yahooChart(ticker, '5d', '1d');
      if (d.meta.price) {
        const change = d.meta.price - (d.meta.previousClose || d.meta.price);
        const pct = d.meta.previousClose ? (change / d.meta.previousClose * 100) : 0;
        quotes.push({
          symbol: sym, ticker, name: d.meta.name || sym,
          price: d.meta.price, change, changePercent: pct,
          previousClose: d.meta.previousClose,
          fiftyTwoWeekHigh: d.meta.fiftyTwoWeekHigh,
          fiftyTwoWeekLow: d.meta.fiftyTwoWeekLow,
          exchange: d.meta.exchange, currency: d.meta.currency,
          marketState: d.meta.marketState
        });
      }
    }
    res.json({ quotes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Chart (OHLCV for TA computation) ───────────────────
app.get('/api/chart/:symbol', async (req, res) => {
  try {
    const sym = req.params.symbol.includes('.') ? req.params.symbol : req.params.symbol + '.NS';
    const range = req.query.range || '1y';
    const interval = req.query.interval || '1d';
    const d = await yahooChart(sym, range, interval);
    res.json({ symbol: sym, meta: d.meta, candles: d.candles });
  } catch (e) { res.json({ candles: [] }); }
});

// ─── Search (uses Yahoo v1 search — may or may not work) ─
app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q; if (!q) return res.json({ results: [] });
    for (const host of ['query1', 'query2']) {
      try {
        const r = await fetch(`https://${host}.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`, { headers: { 'User-Agent': UA } });
        if (!r.ok) continue;
        const d = await r.json();
        return res.json({ results: (d.quotes || []).map(r => ({ symbol: r.symbol, name: r.shortname || r.longname, exchange: r.exchange })) });
      } catch (e) { continue; }
    }
    res.json({ results: [] });
  } catch (e) { res.json({ results: [] }); }
});

// ─── Health ─────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    const d = await yahooChart('RELIANCE.NS', '5d', '1d');
    res.json({
      status: d.meta.price ? 'ok' : 'no-data',
      version: '4.1',
      test: { symbol: 'RELIANCE.NS', price: d.meta.price, name: d.meta.name },
      candles: d.candles.length
    });
  } catch (e) { res.json({ status: 'error', error: e.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`InvestIQ Pro v4.1 on port ${PORT}`));
