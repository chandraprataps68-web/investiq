const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Shared Yahoo Finance fetch helper ──
const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://finance.yahoo.com/',
  'Origin': 'https://finance.yahoo.com',
};

async function yahooFetch(symbol, range = '6mo', interval = '1d') {
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`,
  ];
  for (const url of urls) {
    try {
      const { data } = await axios.get(url, { headers: YF_HEADERS, timeout: 8000 });
      if (data?.chart?.result?.[0]) return data;
    } catch (e) { continue; }
  }
  return null;
}

// ── Live stock quote with full OHLCV history ──
app.get('/api/quote/:symbol', async (req, res) => {
  const symbol = decodeURIComponent(req.params.symbol);
  try {
    const data = await yahooFetch(symbol, '6mo');
    if (!data) return res.status(404).json({ error: 'No data for ' + symbol });

    const result = data.chart.result[0];
    const meta = result.meta;
    const q = result.indicators.quote[0];
    const timestamps = result.timestamp || [];
    const closes = [], opens = [], highs = [], lows = [], vols = [];

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
    res.status(500).json({ error: err.message });
  }
});

// ── Global Markets — all key indicators ──
app.get('/api/global-markets', async (req, res) => {
  const SYMBOLS = {
    DJI:       { sym: '%5EDJI',      name: 'Dow Jones',        cat: 'US' },
    NASDAQ:    { sym: '%5EIXIC',     name: 'Nasdaq',           cat: 'US' },
    SP500:     { sym: '%5EGSPC',     name: 'S&P 500',          cat: 'US' },
    VIX:       { sym: '%5EVIX',      name: 'CBOE VIX',         cat: 'Fear' },
    GIFTNIFTY: { sym: '%5ENSEI',     name: 'Nifty 50',         cat: 'India' },
    BANKNIFTY: { sym: '%5ENSEBANK',  name: 'Bank Nifty',       cat: 'India' },
    INDIAVIX:  { sym: '%5EINDIAVIX', name: 'India VIX',        cat: 'India' },
    NIKKEI:    { sym: '%5EN225',     name: 'Nikkei 225',       cat: 'Asia' },
    HANGSENG:  { sym: '%5EHSI',      name: 'Hang Seng',        cat: 'Asia' },
    CRUDE:     { sym: 'CL=F',        name: 'Crude Oil WTI',    cat: 'Commodity' },
    GOLD:      { sym: 'GC=F',        name: 'Gold',             cat: 'Commodity' },
    DXY:       { sym: 'DX-Y.NYB',    name: 'Dollar Index',     cat: 'Macro' },
    USDINR:    { sym: 'USDINR=X',    name: 'USD/INR',          cat: 'Forex' },
    US10Y:     { sym: '%5ETNX',      name: 'US 10Y Yield',     cat: 'Macro' },
  };

  const fetchOne = async (sym) => {
    try {
      const data = await yahooFetch(sym, '5d', '1d');
      if (!data) return null;
      const meta = data.chart.result[0].meta;
      const price = meta.regularMarketPrice;
      const prev = meta.previousClose || meta.chartPreviousClose || price;
      const chg = price - prev;
      const chgPct = prev !== 0 ? ((chg / prev) * 100).toFixed(2) : '0.00';
      return { price, prev, chg, chgPct: parseFloat(chgPct), marketState: meta.marketState };
    } catch { return null; }
  };

  const results = await Promise.allSettled(
    Object.entries(SYMBOLS).map(async ([key, info]) => {
      const q = await fetchOne(info.sym);
      return q ? { key, name: info.name, cat: info.cat, ...q } : null;
    })
  );

  const markets = results.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean);

  // Calculate sentiment
  const usM = markets.filter(m => m.cat === 'US');
  const avgUS = usM.length
    ? (usM.reduce((s, m) => s + m.chgPct, 0) / usM.length).toFixed(2)
    : '0.00';

  const f = k => markets.find(m => m.key === k);
  const vix = f('VIX'), ivix = f('INDIAVIX'), crude = f('CRUDE'), dxy = f('DXY'), usdinr = f('USDINR'), us10y = f('US10Y');

  // Plain English alerts
  const mood = [];
  const avgUSNum = parseFloat(avgUS);
  if (avgUSNum > 0.5) mood.push(`US markets UP ${avgUS}% — positive for Indian markets`);
  else if (avgUSNum < -0.5) mood.push(`US markets DOWN ${Math.abs(avgUS)}% — expect selling pressure in India`);
  else mood.push('US markets flat — neutral for India opening');

  if (vix) {
    if (vix.price > 30) mood.push(`VIX ${vix.price.toFixed(1)} — PANIC level, sell options only, premiums very expensive`);
    else if (vix.price > 20) mood.push(`VIX ${vix.price.toFixed(1)} — elevated fear, options sellers have edge`);
    else if (vix.price < 15) mood.push(`VIX ${vix.price.toFixed(1)} — low fear, good time to BUY options (cheap premiums)`);
    else mood.push(`VIX ${vix.price.toFixed(1)} — normal range`);
  }

  if (ivix) {
    if (ivix.price > 20) mood.push(`India VIX ${ivix.price.toFixed(1)} — high, Nifty premiums elevated, prefer selling strategies`);
    else if (ivix.price < 12) mood.push(`India VIX ${ivix.price.toFixed(1)} — very low, buy straddles before events`);
  }

  if (crude && Math.abs(crude.chgPct) > 1.5) {
    if (crude.chgPct > 0) mood.push(`Crude oil UP ${crude.chgPct.toFixed(1)}% — bearish for BPCL, HPCL, IOC; positive for ONGC`);
    else mood.push(`Crude oil DOWN ${Math.abs(crude.chgPct).toFixed(1)}% — bullish for OMCs, aviation, paints`);
  }

  if (dxy && dxy.chgPct > 0.3) mood.push(`Dollar Index rising — FII selling likely, IT exporters benefit`);
  if (usdinr && usdinr.price > 84) mood.push(`USD/INR ₹${usdinr.price.toFixed(2)} — rupee weak, IT sector outperforms`);
  if (us10y && us10y.price > 4.5) mood.push(`US 10Y yield ${us10y.price.toFixed(2)}% — high rates, FII outflows from India likely`);

  const sentiment = avgUSNum > 0.3 ? 'BULLISH' : avgUSNum < -0.3 ? 'BEARISH' : 'NEUTRAL';

  res.json({ markets, sentiment, mood, avgUSChg: avgUS });
});

// ── AI proxy — keeps API key server-side ──
app.post('/api/chat', async (req, res) => {
  const { messages, provider = 'groq' } = req.body;
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'AI_API_KEY not configured on server' });

  try {
    if (provider === 'groq') {
      const { data } = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        { model: 'llama-3.3-70b-versatile', messages, max_tokens: 2048, temperature: 0.4 },
        { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 30000 }
      );
      res.json({ text: data.choices?.[0]?.message?.content || '' });
    } else {
      const { data } = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        { contents: messages, generationConfig: { maxOutputTokens: 2048, temperature: 0.4 } },
        { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
      );
      res.json({ text: data.candidates?.[0]?.content?.parts?.[0]?.text || '' });
    }
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ error: msg });
  }
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ InvestIQ Pro live at http://localhost:${PORT}`));
