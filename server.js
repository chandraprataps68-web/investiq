// server.js — InvestIQ Pro v6 backend
// Express + fyers-api-v3 + scanner + premarket + commodities

const express = require('express');
const path = require('path');
const { fyersModel } = require('fyers-api-v3');

const { runScanner } = require('./scanner');
const { getPreMarketSnapshot } = require('./premarket');
const { fetchCrypto, fetchCryptoHistory, fetchCommodities } = require('./commodities');
const { NIFTY_50, NIFTY_NEXT_50, NIFTY_100, toFyersEquity } = require('./universe');
const { fullAnalysis, generateSignal } = require('./ta');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Config ----------
const APP_ID = process.env.FYERS_APP_ID || 'WJWQGM6JWM-100';
const APP_SECRET = process.env.FYERS_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://investiq-ir5k.onrender.com/callback';
const PORT = process.env.PORT || 10000;

if (!APP_SECRET) {
  console.warn('⚠ FYERS_SECRET not set — Fyers calls will fail');
}

// In-memory token store (single-user app; fine for personal use)
let accessToken = null;
let tokenExpiry = 0;

const fyers = new fyersModel({ path: '/tmp', enableLogging: false });
fyers.setAppId(APP_ID);
fyers.setRedirectUrl(REDIRECT_URI);

function ensureAuth(req, res, next) {
  if (!accessToken || Date.now() > tokenExpiry) {
    return res.status(401).json({ error: 'not_authenticated', loginUrl: '/login' });
  }
  next();
}

// ---------- In-memory cache ----------
const cache = new Map(); // key -> { ts, ttl, data }
const cacheGet = (k) => {
  const v = cache.get(k);
  if (!v) return null;
  if (Date.now() > v.ts + v.ttl) { cache.delete(k); return null; }
  return v.data;
};
const cacheSet = (k, data, ttlMs) => cache.set(k, { ts: Date.now(), ttl: ttlMs, data });

// ---------- OAuth flow ----------
app.get('/login', (req, res) => {
  const url = fyers.generateAuthCode();
  res.redirect(url);
});

app.get('/callback', async (req, res) => {
  const { auth_code, s } = req.query;
  if (!auth_code) return res.status(400).send('No auth_code received');
  try {
    const result = await fyers.generate_access_token({
      secret_key: APP_SECRET,
      auth_code,
    });
    if (result.s === 'ok') {
      accessToken = result.access_token;
      tokenExpiry = Date.now() + 23 * 3600 * 1000; // ~23h
      fyers.setAccessToken(accessToken);
      res.redirect('/');
    } else {
      res.status(500).json({ error: result });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth-status', (req, res) => {
  res.json({
    authenticated: !!accessToken && Date.now() < tokenExpiry,
    expiresIn: accessToken ? Math.max(0, tokenExpiry - Date.now()) : 0,
  });
});

// ---------- Fyers helpers ----------
async function getQuote(fyersSym) {
  const ck = `q:${fyersSym}`;
  const cached = cacheGet(ck);
  if (cached) return cached;
  const r = await fyers.getQuotes([fyersSym]);
  const data = r?.d?.[0]?.v || null;
  if (data) cacheSet(ck, data, 30 * 1000); // 30s
  return data;
}

async function getQuotes(symArr) {
  // Fyers limit: ~50 symbols per call
  const out = {};
  for (let i = 0; i < symArr.length; i += 50) {
    const batch = symArr.slice(i, i + 50);
    const r = await fyers.getQuotes(batch);
    if (r?.d) {
      r.d.forEach((q) => { if (q.n) out[q.n] = q.v; });
    }
  }
  return out;
}

async function getHistory(fyersSym, resolution = 'D', days = 365) {
  const ck = `h:${fyersSym}:${resolution}:${days}`;
  const cached = cacheGet(ck);
  if (cached) return cached;
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 86400;
  const r = await fyers.getHistory({
    symbol: fyersSym,
    resolution,
    date_format: '0',
    range_from: String(from),
    range_to: String(to),
    cont_flag: '1',
  });
  const candles = (r?.candles || []).map((c) => ({
    t: c[0], o: c[1], h: c[2], l: c[3], c: c[4], v: c[5],
  }));
  // Cache for 10 min during market hours, 60 min outside
  const isMarketHours = (() => {
    const d = new Date();
    const ist = new Date(d.getTime() + (5.5 * 3600 * 1000) - (d.getTimezoneOffset() * 60000));
    const day = ist.getUTCDay();
    const hr = ist.getUTCHours();
    return day >= 1 && day <= 5 && hr >= 9 && hr < 16;
  })();
  cacheSet(ck, candles, isMarketHours ? 10 * 60 * 1000 : 60 * 60 * 1000);
  return candles;
}

// ---------- API routes ----------

// Live quote(s)
app.get('/api/quote/:symbol', ensureAuth, async (req, res) => {
  try {
    const sym = decodeURIComponent(req.params.symbol);
    const q = await getQuote(sym);
    res.json(q);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/quotes', ensureAuth, async (req, res) => {
  try {
    const { symbols } = req.body;
    if (!Array.isArray(symbols)) return res.status(400).json({ error: 'symbols array required' });
    const data = await getQuotes(symbols);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Historical candles
app.get('/api/history/:symbol', ensureAuth, async (req, res) => {
  try {
    const sym = decodeURIComponent(req.params.symbol);
    const resolution = req.query.resolution || 'D';
    const days = parseInt(req.query.days || '365', 10);
    const candles = await getHistory(sym, resolution, days);
    res.json({ candles });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Stock search — full analysis for any NSE equity
app.get('/api/analyze/:symbol', ensureAuth, async (req, res) => {
  try {
    let sym = decodeURIComponent(req.params.symbol).toUpperCase();
    // Accept either plain symbol or full Fyers format
    if (!sym.includes(':')) sym = toFyersEquity(sym);
    const candles = await getHistory(sym, 'D', 400);
    if (!candles || candles.length < 30) {
      return res.json({ ok: false, reason: 'insufficient data', symbol: sym });
    }
    const a = fullAnalysis(candles);
    const sig = generateSignal(a);
    const quote = await getQuote(sym).catch(() => null);
    res.json({
      ok: true,
      symbol: sym,
      quote,
      analysis: a,
      signal: sig,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Universe search (autocomplete)
app.get('/api/universe', (req, res) => {
  const q = (req.query.q || '').toUpperCase();
  const all = NIFTY_100.map((s) => ({ symbol: s, fyers: toFyersEquity(s) }));
  if (!q) return res.json(all.slice(0, 50));
  res.json(all.filter((x) => x.symbol.includes(q)).slice(0, 20));
});

// Market scanner (cached 15 min)
app.get('/api/scanner', ensureAuth, async (req, res) => {
  try {
    const universe = req.query.universe; // 'nifty50' | 'next50' | 'nifty100'
    const list = universe === 'nifty50' ? NIFTY_50 : universe === 'next50' ? NIFTY_NEXT_50 : NIFTY_100;
    const ck = `scan:${universe || 'nifty100'}`;
    const cached = cacheGet(ck);
    if (cached) return res.json({ ...cached, fromCache: true });
    const result = await runScanner(
      (sym) => getHistory(sym, 'D', 400),
      { universe: list, concurrency: 4 }
    );
    cacheSet(ck, result, 15 * 60 * 1000);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Pre-market dashboard (cached 5 min)
app.get('/api/premarket', async (req, res) => {
  try {
    const ck = 'premarket';
    const cached = cacheGet(ck);
    if (cached) return res.json({ ...cached, fromCache: true });
    const data = await getPreMarketSnapshot();
    cacheSet(ck, data, 5 * 60 * 1000);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Commodities (Fyers MCX) + Crypto (CoinGecko)
app.get('/api/commodities', ensureAuth, async (req, res) => {
  try {
    const ck = 'commodities';
    const cached = cacheGet(ck);
    if (cached) return res.json({ ...cached, fromCache: true });
    const [commodities, crypto] = await Promise.all([
      fetchCommodities(getQuote, (s) => getHistory(s, 'D', 200)),
      fetchCrypto(),
    ]);
    const data = { commodities, crypto, timestamp: new Date().toISOString() };
    cacheSet(ck, data, 60 * 1000); // 1 min
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/crypto-history/:id', async (req, res) => {
  try {
    const candles = await fetchCryptoHistory(req.params.id, parseInt(req.query.days || '90', 10));
    res.json({ candles });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Option chain (basic; fuller features later)
app.get('/api/option-chain/:symbol', ensureAuth, async (req, res) => {
  try {
    let sym = decodeURIComponent(req.params.symbol);
    if (!sym.includes(':')) sym = toFyersEquity(sym);
    // fyers.getOptionChain may not be in all SDK versions; guard it
    if (typeof fyers.getOptionChain !== 'function') {
      return res.status(501).json({ error: 'option chain not available in this SDK build' });
    }
    const r = await fyers.getOptionChain({ symbol: sym, strikecount: 10 });
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Health + warm endpoint (Cloudflare Worker pings this every 10 min during market hrs)
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    authenticated: !!accessToken && Date.now() < tokenExpiry,
    cacheSize: cache.size,
    uptime: process.uptime(),
    ts: new Date().toISOString(),
  });
});

// ---------- Static fallback ----------
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`InvestIQ Pro v6 listening on :${PORT}`);
});
