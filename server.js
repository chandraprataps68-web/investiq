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

// ── Batch quote endpoint ──
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
