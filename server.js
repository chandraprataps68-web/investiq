const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Live stock data from Yahoo Finance (server-side, no CORS issues) ──
app.get('/api/quote/:symbol', async (req, res) => {
  const symbol = req.params.symbol;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=6mo`;
    const { data } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://finance.yahoo.com',
      },
      timeout: 8000
    });

    const result = data?.chart?.result?.[0];
    if (!result) return res.status(404).json({ error: 'No data' });

    const meta = result.meta;
    const q = result.indicators.quote[0];
    const closes = [], opens = [], highs = [], lows = [], vols = [];
    const timestamps = result.timestamp || [];

    timestamps.forEach((_, i) => {
      if (q.close[i] != null) {
        closes.push(q.close[i]);
        opens.push(q.open[i] || q.close[i]);
        highs.push(q.high[i] || q.close[i]);
        lows.push(q.low[i] || q.close[i]);
        vols.push(q.volume[i] || 0);
      }
    });

    res.json({
      symbol: meta.symbol,
      name: meta.longName || meta.shortName || meta.symbol,
      price: meta.regularMarketPrice,
      prev: meta.previousClose || meta.chartPreviousClose,
      open: meta.regularMarketOpen,
      high: meta.regularMarketDayHigh,
      low: meta.regularMarketDayLow,
      volume: meta.regularMarketVolume,
      marketCap: meta.marketCap,
      currency: meta.currency || 'INR',
      exchange: meta.exchangeName,
      marketState: meta.marketState,
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
      closes, opens, highs, lows, vols,
      dataPoints: closes.length
    });
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({ error: err.message });
  }
});

// ── Global Markets endpoint — fetches all key global indicators ──
app.get('/api/global-markets', async (req, res) => {
  const GLOBAL_SYMBOLS = {
    // US Indices
    'DJI':     { sym: '%5EDJI',    name: 'Dow Jones',       cat: 'US Market' },
    'NASDAQ':  { sym: '%5EIXIC',   name: 'Nasdaq',          cat: 'US Market' },
    'SP500':   { sym: '%5EGSPC',   name: 'S&P 500',         cat: 'US Market' },
    'VIX':     { sym: '%5EVIX',    name: 'CBOE VIX',        cat: 'Fear Index' },
    // Indian Pre-market
    'GIFTNIFTY': { sym: 'NIFTY50.NS', name: 'Nifty 50',    cat: 'India' },
    'BANKNIFTY': { sym: '%5ENSEBANK', name: 'Bank Nifty',   cat: 'India' },
    'INDIAVIX':  { sym: '%5EINDIAVIX',name: 'India VIX',    cat: 'India Fear' },
    // Asian Markets
    'NIKKEI':  { sym: '%5EN225',   name: 'Nikkei 225',      cat: 'Asia' },
    'HANGSENG':{ sym: '%5EHSI',    name: 'Hang Seng',       cat: 'Asia' },
    'SGX':     { sym: '%5ESGX',    name: 'SGX Nifty',       cat: 'Pre-market' },
    // Commodities & Macro
    'CRUDE':   { sym: 'CL=F',      name: 'Crude Oil WTI',   cat: 'Commodity' },
    'GOLD':    { sym: 'GC=F',      name: 'Gold',            cat: 'Commodity' },
    'DXY':     { sym: 'DX=F',      name: 'Dollar Index',    cat: 'Forex/Macro' },
    'USDINR':  { sym: 'USDINR=X',  name: 'USD/INR',         cat: 'Forex' },
    'US10Y':   { sym: '%5ETNX',    name: 'US 10Y Bond Yield', cat: 'Macro' },
  };

  const fetchQuote = async (sym) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d`;
      const { data } = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Referer': 'https://finance.yahoo.com',
        },
        timeout: 6000
      });
      const meta = data?.chart?.result?.[0]?.meta;
      if (!meta) return null;
      const price = meta.regularMarketPrice;
      const prev = meta.previousClose || meta.chartPreviousClose;
      const chg = price - prev;
      const chgPct = ((chg / prev) * 100).toFixed(2);
      return { price, prev, chg, chgPct, marketState: meta.marketState };
    } catch { return null; }
  };

  const results = await Promise.allSettled(
    Object.entries(GLOBAL_SYMBOLS).map(async ([key, info]) => {
      const q = await fetchQuote(info.sym);
      return q ? { key, name: info.name, cat: info.cat, ...q } : null;
    })
  );

  const markets = results
    .map(r => r.status === 'fulfilled' ? r.value : null)
    .filter(Boolean);

  // Build market sentiment summary
  const usMarkets = markets.filter(m => m.cat === 'US Market');
  const avgUSChg = usMarkets.length
    ? (usMarkets.reduce((s, m) => s + parseFloat(m.chgPct), 0) / usMarkets.length).toFixed(2)
    : 0;

  const vix = markets.find(m => m.key === 'VIX');
  const indiaVix = markets.find(m => m.key === 'INDIAVIX');
  const crude = markets.find(m => m.key === 'CRUDE');
  const dxy = markets.find(m => m.key === 'DXY');
  const usdinr = markets.find(m => m.key === 'USDINR');
  const us10y = markets.find(m => m.key === 'US10Y');

  // Generate plain English market mood
  const mood = [];
  if (avgUSChg > 0.5) mood.push(`US markets UP ${avgUSChg}% — positive for Indian markets`);
  else if (avgUSChg < -0.5) mood.push(`US markets DOWN ${Math.abs(avgUSChg)}% — expect selling pressure in India`);
  else mood.push(`US markets flat — neutral for India`);

  if (vix) {
    const v = vix.price;
    if (v > 30) mood.push(`VIX at ${v} — VERY HIGH fear, sell options (premiums expensive), avoid buying options`);
    else if (v > 20) mood.push(`VIX at ${v} — elevated fear, options sellers have edge`);
    else if (v < 15) mood.push(`VIX at ${v} — low fear/complacency, good time to BUY options (cheap premiums)`);
    else mood.push(`VIX at ${v} — normal range`);
  }

  if (indiaVix) {
    const iv = indiaVix.price;
    if (iv > 20) mood.push(`India VIX ${iv} — high, Nifty options premiums elevated, prefer selling strategies`);
    else if (iv < 12) mood.push(`India VIX ${iv} — low, buy straddles/strangles before any event`);
  }

  if (crude) {
    if (parseFloat(crude.chgPct) > 2) mood.push(`Crude oil up ${crude.chgPct}% — bearish for OMCs (BPCL, HPCL, IOC), positive for ONGC`);
    else if (parseFloat(crude.chgPct) < -2) mood.push(`Crude oil down ${crude.chgPct}% — bullish for paint, aviation, OMC margins`);
  }

  if (dxy && parseFloat(dxy.chgPct) > 0.3) mood.push(`Dollar Index rising — FII selling likely, bearish for emerging markets`);

  if (usdinr && usdinr.price > 84) mood.push(`USD/INR at ${usdinr.price} — rupee weak, IT exporters (TCS, Infy) benefit`);

  if (us10y && us10y.price > 4.5) mood.push(`US 10Y yield at ${us10y.price}% — high rates, FII outflows from India likely`);

  const sentiment = parseFloat(avgUSChg) > 0.3 ? 'BULLISH' :
                    parseFloat(avgUSChg) < -0.3 ? 'BEARISH' : 'NEUTRAL';

  res.json({ markets, sentiment, mood, avgUSChg });
});


app.post('/api/quotes', async (req, res) => {
  const { symbols } = req.body;
  if (!symbols || !Array.isArray(symbols)) return res.status(400).json({ error: 'symbols array required' });

  const results = await Promise.allSettled(
    symbols.slice(0, 6).map(s =>
      axios.get(`http://localhost:${PORT}/api/quote/${s}`, { timeout: 8000 })
        .then(r => r.data)
        .catch(() => null)
    )
  );

  const data = results
    .map(r => r.status === 'fulfilled' ? r.value : null)
    .filter(Boolean);

  res.json({ quotes: data });
});

// ── AI proxy (keeps API key server-side) ──
app.post('/api/chat', async (req, res) => {
  const { messages, provider = 'groq' } = req.body;
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'AI_API_KEY not set in environment variables' });

  try {
    if (provider === 'groq') {
      const { data } = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        { model: 'llama-3.3-70b-versatile', messages, max_tokens: 2048, temperature: 0.5 },
        { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 30000 }
      );
      res.json({ text: data.choices?.[0]?.message?.content || '' });
    } else {
      const { data } = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        { contents: messages, generationConfig: { maxOutputTokens: 2048, temperature: 0.5 } },
        { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
      );
      res.json({ text: data.candidates?.[0]?.content?.parts?.[0]?.text || '' });
    }
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ InvestIQ live at http://localhost:${PORT}`));
