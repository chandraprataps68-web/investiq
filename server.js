const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Allow CORS for local dev
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════════
//  YAHOO FINANCE — Lazy init with yahoo-finance2
//  Falls back to direct fetch if package fails
// ═══════════════════════════════════════════════════════════
let yf = null;
let yfReady = false;
let yfError = null;

async function getYF() {
  if (yfReady) return yf;
  if (yfError) return null; // already failed, don't retry
  try {
    const mod = require('yahoo-finance2').default;
    const instance = new mod({ suppressNotices: ['yahooSurvey'] });
    // Test with a quick quote
    await instance.quote('AAPL');
    yf = instance;
    yfReady = true;
    console.log('[YF] ✅ yahoo-finance2 initialized successfully');
    return yf;
  } catch (e) {
    console.log('[YF] ❌ yahoo-finance2 failed:', e.message);
    yfError = e.message;
    return null;
  }
}

// Direct fetch fallback
async function directYahoo(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function getQuotes(symbols) {
  // Strategy 1: yahoo-finance2
  const yahoo = await getYF();
  if (yahoo) {
    const out = [];
    for (const s of symbols) {
      try { out.push(await yahoo.quote(s)); } catch(e) {}
    }
    if (out.length) return out.map(q => ({
      symbol:q.symbol, shortName:q.shortName, longName:q.longName,
      regularMarketPrice:q.regularMarketPrice, regularMarketChange:q.regularMarketChange,
      regularMarketChangePercent:q.regularMarketChangePercent, regularMarketPreviousClose:q.regularMarketPreviousClose,
      regularMarketOpen:q.regularMarketOpen, regularMarketDayHigh:q.regularMarketDayHigh,
      regularMarketDayLow:q.regularMarketDayLow, regularMarketVolume:q.regularMarketVolume,
      marketCap:q.marketCap, currency:q.currency, exchange:q.exchange,
      marketState:q.marketState, fiftyTwoWeekHigh:q.fiftyTwoWeekHigh,
      fiftyTwoWeekLow:q.fiftyTwoWeekLow, fiftyDayAverage:q.fiftyDayAverage,
      twoHundredDayAverage:q.twoHundredDayAverage
    }));
  }

  // Strategy 2: Direct fetch query1
  try {
    const d = await directYahoo(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(','))}`);
    if (d.quoteResponse?.result?.length) return d.quoteResponse.result;
  } catch(e) { console.log('[YF] query1 failed:', e.message); }

  // Strategy 3: Direct fetch query2
  try {
    const d = await directYahoo(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(','))}`);
    if (d.quoteResponse?.result?.length) return d.quoteResponse.result;
  } catch(e) { console.log('[YF] query2 failed:', e.message); }

  return [];
}

async function getChart(symbol, range, interval) {
  const yahoo = await getYF();
  if (yahoo) {
    try {
      const now = new Date();
      const days = {1:'1d','5d':5,'1mo':30,'6mo':180,'1y':365,'5y':1825}[range] || 180;
      const p1 = new Date(now.getTime() - days * 86400000);
      const r = await yahoo.chart(symbol, { period1: p1, period2: now, interval });
      return (r.quotes||[]).filter(q=>q.open!=null).map(q=>({
        time: Math.floor(new Date(q.date).getTime()/1000),
        open:q.open, high:q.high, low:q.low, close:q.close, volume:q.volume
      }));
    } catch(e) {}
  }
  // Fallback
  for (const host of ['query1','query2']) {
    try {
      const d = await directYahoo(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`);
      const res = d.chart?.result?.[0]; if (!res) continue;
      const ts=res.timestamp||[], ohlc=res.indicators?.quote?.[0]||{};
      const candles = ts.map((t,i)=>({time:t,open:ohlc.open?.[i],high:ohlc.high?.[i],low:ohlc.low?.[i],close:ohlc.close?.[i],volume:ohlc.volume?.[i]})).filter(c=>c.open!=null);
      if (candles.length) return candles;
    } catch(e) {}
  }
  return [];
}

// ═══════════════════════════════════════════════════════════
//  API ROUTES (server proxies for browser — avoids CORS)
// ═══════════════════════════════════════════════════════════

app.get('/api/quote/:symbols', async (req, res) => {
  try {
    const syms = req.params.symbols.split(',').map(s=>s.trim()).filter(Boolean);
    res.json({ quotes: await getQuotes(syms) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/history/:symbol', async (req, res) => {
  try {
    const candles = await getChart(req.params.symbol, req.query.range||'6mo', req.query.interval||'1d');
    res.json({ symbol: req.params.symbol, candles });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q; if (!q) return res.json({results:[]});
    const yahoo = await getYF();
    if (yahoo) {
      const d = await yahoo.search(q, {quotesCount:8, newsCount:0});
      return res.json({results:(d.quotes||[]).map(r=>({symbol:r.symbol,name:r.shortname||r.longname||r.symbol,type:r.quoteType,exchange:r.exchange}))});
    }
    // fallback
    const d = await directYahoo(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`);
    res.json({results:(d.quotes||[]).map(r=>({symbol:r.symbol,name:r.shortname||r.longname||r.symbol,type:r.quoteType,exchange:r.exchange}))});
  } catch(e) { res.json({results:[]}); }
});

app.get('/api/markets', async (req,res) => {
  try { res.json({markets: await getQuotes(['^GSPC','^DJI','^IXIC','^NSEI','^BSESN','^NSEBANK','^FTSE','^N225','^HSI'])}); }
  catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/ticker', async (req,res) => {
  try { res.json({tickers: await getQuotes(['^NSEBANK','^DJI','^IXIC','^NSEI','INDIAVIX.NS','CL=F','GC=F','USDINR=X','^GSPC','BTC-USD','^VIX'])}); }
  catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/sectors', async (req,res) => {
  try {
    const qs = await getQuotes(['^CNXIT','^CNXBANKNIFTY','^CNXPHARMA','^CNXENERGY','^CNXFMCG','^CNXAUTO','^CNXMETAL','^CNXREALTY']);
    res.json({sectors: qs.map(q=>({...q, name:(q.shortName||q.symbol||'').replace(/NIFTY\s*/i,'')}))});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Diagnostic endpoint — visit /api/test to see what's working
app.get('/api/test', async (req, res) => {
  const results = { timestamp: new Date().toISOString(), strategies: {} };

  // Test yahoo-finance2
  try {
    const yahoo = await getYF();
    if (yahoo) {
      const q = await yahoo.quote('AAPL');
      results.strategies['yahoo-finance2'] = { status: 'ok', price: q.regularMarketPrice };
    } else {
      results.strategies['yahoo-finance2'] = { status: 'failed', error: yfError };
    }
  } catch(e) { results.strategies['yahoo-finance2'] = { status: 'error', error: e.message }; }

  // Test direct query1
  try {
    const d = await directYahoo('https://query1.finance.yahoo.com/v7/finance/quote?symbols=AAPL');
    const p = d.quoteResponse?.result?.[0]?.regularMarketPrice;
    results.strategies['direct-query1'] = p ? { status: 'ok', price: p } : { status: 'empty' };
  } catch(e) { results.strategies['direct-query1'] = { status: 'error', error: e.message }; }

  // Test direct query2
  try {
    const d = await directYahoo('https://query2.finance.yahoo.com/v7/finance/quote?symbols=AAPL');
    const p = d.quoteResponse?.result?.[0]?.regularMarketPrice;
    results.strategies['direct-query2'] = p ? { status: 'ok', price: p } : { status: 'empty' };
  } catch(e) { results.strategies['direct-query2'] = { status: 'error', error: e.message }; }

  res.json(results);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`InvestIQ Pro v3.0 on port ${PORT}`);
  // Lazy init — don't block startup
  setTimeout(() => getYF(), 2000);
});
