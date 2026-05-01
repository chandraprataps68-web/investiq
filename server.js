// ═══════════════════════════════════════════════════════════
//  InvestIQ Pro v6 — backend
//  Preserves all v5 routes + adds scanner, premarket, commodities, search
// ═══════════════════════════════════════════════════════════

const express = require('express');
const path = require('path');
const { fyersModel } = require('fyers-api-v3');

const TA = require('./ta');
const { runScanner } = require('./scanner');
const { getPreMarketSnapshot } = require('./premarket');
const { fetchCrypto, fetchCryptoHistory, fetchCommodities } = require('./commodities');
const { NIFTY_50, NIFTY_NEXT_50, NIFTY_100, EXTENDED_UNIVERSE, toFyersEquity } = require('./universe');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Config (matches v5 env var names) ──────────────────
const APP_ID = process.env.FYERS_APP_ID || '';
const SECRET = process.env.FYERS_SECRET || '';
const REDIRECT = process.env.FYERS_REDIRECT || 'https://investiq-ir5k.onrender.com/auth/callback';

// ─── Token (persisted to disk to survive Render spin-down) ────
const fs = require('fs');
const TOKEN_FILE = '/tmp/fyers-token.json';

let accessToken = '';
let tokenTime = 0;

function saveToken() {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ accessToken, tokenTime }));
  } catch (e) { console.error('[token save]', e.message); }
}

function loadToken() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return;
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
    // Fyers tokens valid ~24 hours; treat as expired after 23h to be safe
    if (data.tokenTime && Date.now() - data.tokenTime < 23 * 3600 * 1000) {
      accessToken = data.accessToken;
      tokenTime = data.tokenTime;
      const ageMin = Math.round((Date.now() - tokenTime) / 60000);
      console.log(`[token] Restored from disk (age ${ageMin} min)`);
    } else {
      console.log('[token] Disk token expired, ignoring');
      try { fs.unlinkSync(TOKEN_FILE); } catch (_) {}
    }
  } catch (e) { console.error('[token load]', e.message); }
}

// Restore on boot
loadToken();

function getFyers() {
  const fyers = new fyersModel({ path: '/tmp', enableLogging: false });
  fyers.setAppId(APP_ID);
  fyers.setRedirectUrl(REDIRECT);
  if (accessToken) fyers.setAccessToken(accessToken);
  return fyers;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════════
//  AUTH (v5 paths preserved exactly)
// ═══════════════════════════════════════════════════════════

app.get('/auth/login', (req, res) => {
  const fyers = getFyers();
  const url = fyers.generateAuthCode();
  console.log('[AUTH] Redirecting to Fyers login:', url);
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const authCode = req.query.auth_code;
  const error = req.query.error;
  if (error || !authCode) {
    console.log('[AUTH] Error:', error || 'No auth_code');
    return res.redirect('/?auth=error');
  }
  try {
    const fyers = getFyers();
    const response = await fyers.generate_access_token({
      client_id: APP_ID,
      secret_key: SECRET,
      auth_code: authCode,
    });
    if (response.s === 'ok' && response.access_token) {
      accessToken = response.access_token;
      tokenTime = Date.now();
      saveToken();
      console.log('[AUTH] ✅ Access token received and persisted');
      res.redirect('/?auth=success');
    } else {
      console.log('[AUTH] ❌ Token error:', response);
      res.redirect('/?auth=error&msg=' + encodeURIComponent(response.message || 'Unknown error'));
    }
  } catch (e) {
    console.log('[AUTH] ❌ Exception:', e.message);
    res.redirect('/?auth=error&msg=' + encodeURIComponent(e.message));
  }
});

app.get('/api/auth/status', (req, res) => {
  res.json({
    authenticated: !!accessToken,
    tokenAge: tokenTime ? Math.round((Date.now() - tokenTime) / 60000) + ' min' : null,
    appId: APP_ID ? APP_ID.substring(0, 4) + '...' : 'not set',
  });
});

app.get('/auth/logout', (req, res) => {
  accessToken = '';
  tokenTime = 0;
  try { fs.unlinkSync(TOKEN_FILE); } catch (_) {}
  res.redirect('/');
});

function requireAuth(req, res, next) {
  if (!accessToken) {
    return res.status(401).json({
      error: 'auth_required',
      message: 'Fyers session expired. Please reconnect.',
      loginUrl: '/auth/login',
    });
  }
  next();
}

// ═══════════════════════════════════════════════════════════
//  CACHE
// ═══════════════════════════════════════════════════════════

const cache = new Map();
const cacheGet = (k) => {
  const v = cache.get(k);
  if (!v) return null;
  if (Date.now() > v.ts + v.ttl) { cache.delete(k); return null; }
  return v.data;
};
const cacheSet = (k, data, ttlMs) => cache.set(k, { ts: Date.now(), ttl: ttlMs, data });

const isMarketHours = () => {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return day >= 1 && day <= 5 && mins >= 9 * 60 + 15 && mins < 15 * 60 + 30;
};

// ═══════════════════════════════════════════════════════════
//  FYERS HELPERS (cached, used by scanner/commodities)
// ═══════════════════════════════════════════════════════════

async function getQuoteOne(fyersSym) {
  const ck = `q:${fyersSym}`;
  const cached = cacheGet(ck);
  if (cached) return cached;
  const fyers = getFyers();
  const r = await fyers.getQuotes([fyersSym]);
  const data = r?.d?.[0]?.v || null;
  if (data) cacheSet(ck, data, 30 * 1000);
  return data;
}

async function getQuotesBatch(symArr) {
  const out = {};
  const fyers = getFyers();
  for (let i = 0; i < symArr.length; i += 50) {
    const batch = symArr.slice(i, i + 50);
    const r = await fyers.getQuotes(batch);
    if (r?.d) r.d.forEach((q) => { if (q.n) out[q.n] = q.v; });
  }
  return out;
}

async function getHistoryShortKey(fyersSym, resolution = 'D', days = 365) {
  const ck = `h:${fyersSym}:${resolution}:${days}`;
  const cached = cacheGet(ck);
  if (cached) return cached;
  const fyers = getFyers();
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 86400;
  const r = await fyers.getHistory({
    symbol: fyersSym,
    resolution,
    date_format: 0,
    range_from: String(from),
    range_to: String(to),
    cont_flag: '1',
  });
  // Fyers returns { s: 'ok', candles: [...] } on success
  // and { s: 'error', message: '...', code: -... } on failure.
  // Don't silently swallow errors — they cause the scanner to return 0 results.
  if (r?.s !== 'ok') {
    const msg = r?.message || r?.s || 'unknown';
    const code = r?.code;
    console.error(`[fyers history ${fyersSym}] ${msg} (code ${code})`);
    // Auth errors: codes -16 (token expired), -17 (invalid token), -300/-352 (auth)
    // Clear token so /api/auth/status reflects reality
    if (code === -16 || code === -17 || code === -300 || code === -352 ||
        /token|auth|expired|unauthor/i.test(String(msg))) {
      console.error('[fyers] Token appears invalid, clearing');
      accessToken = '';
      tokenTime = 0;
      try { fs.unlinkSync(TOKEN_FILE); } catch (_) {}
    }
    // Cache empty result briefly so we don't hammer Fyers retrying bad symbols
    cacheSet(ck, [], 5 * 60 * 1000);
    return [];
  }
  // Internal canonical: short keys (t,o,h,l,c,v) — used by ta.js & scanner.js
  const candles = (r.candles || []).map((c) => ({
    t: c[0], o: c[1], h: c[2], l: c[3], c: c[4], v: c[5],
  }));
  cacheSet(ck, candles, isMarketHours() ? 10 * 60 * 1000 : 60 * 60 * 1000);
  return candles;
}

// Long-key form (legacy v5 + chart libs)
const toLongKeyCandles = (candles) =>
  candles.map((c) => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v }));

// ═══════════════════════════════════════════════════════════
//  V5 LEGACY ROUTES (preserved exactly — your old UI keeps working)
// ═══════════════════════════════════════════════════════════

// Old /api/quotes?symbols=NSE:RELIANCE-EQ,NSE:TCS-EQ
app.get('/api/quotes', requireAuth, async (req, res) => {
  try {
    const symbols = req.query.symbols;
    if (!symbols) return res.status(400).json({ error: 'symbols required' });
    const fyers = getFyers();
    const data = await fyers.getQuotes([...symbols.split(',').map((s) => s.trim())]);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/depth', requireAuth, async (req, res) => {
  try {
    const symbols = req.query.symbols;
    if (!symbols) return res.status(400).json({ error: 'symbols required' });
    const fyers = getFyers();
    const data = await fyers.getMarketDepth({
      symbol: symbols.split(',').map((s) => s.trim()),
      ohlcv_flag: 1,
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Old /api/history?symbol=NSE:RELIANCE-EQ&resolution=D
app.get('/api/history', requireAuth, async (req, res) => {
  try {
    const { symbol, resolution, from, to } = req.query;
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    const fyers = getFyers();
    const now = Math.floor(Date.now() / 1000);
    const data = await fyers.getHistory({
      symbol,
      resolution: resolution || 'D',
      date_format: 0,
      range_from: from || String(now - 365 * 86400),
      range_to: to || String(now),
      cont_flag: '1',
    });
    const candles = (data.candles || []).map((c) => ({
      time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5],
    }));
    res.json({ symbol, candles });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/market-status', requireAuth, async (req, res) => {
  try {
    const fyers = getFyers();
    const data = await fyers.market_status();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/profile', requireAuth, async (req, res) => {
  try { res.json(await getFyers().get_profile()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/holdings', requireAuth, async (req, res) => {
  try { res.json(await getFyers().get_holdings()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/positions', requireAuth, async (req, res) => {
  try { res.json(await getFyers().get_positions()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/funds', requireAuth, async (req, res) => {
  try { res.json(await getFyers().get_funds()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
//  V6 NEW ROUTES
// ═══════════════════════════════════════════════════════════

// Path-style single quote — used by new UI
app.get('/api/quote/:symbol', requireAuth, async (req, res) => {
  try {
    const sym = decodeURIComponent(req.params.symbol);
    res.json(await getQuoteOne(sym));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Path-style history (auto-prefixes plain symbols to NSE:...-EQ)
app.get('/api/history/:symbol', requireAuth, async (req, res) => {
  try {
    let sym = decodeURIComponent(req.params.symbol).toUpperCase();
    if (!sym.includes(':')) sym = toFyersEquity(sym);
    const resolution = req.query.resolution || 'D';
    const days = parseInt(req.query.days || '365', 10);
    const candles = await getHistoryShortKey(sym, resolution, days);
    res.json({ symbol: sym, candles: toLongKeyCandles(candles) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Full single-stock analysis with TA + signal + targets
app.get('/api/analyze/:symbol', requireAuth, async (req, res) => {
  try {
    let sym = decodeURIComponent(req.params.symbol).toUpperCase();
    if (!sym.includes(':')) sym = toFyersEquity(sym);
    const candles = await getHistoryShortKey(sym, 'D', 400);
    if (!candles || candles.length < 30) {
      return res.json({
        ok: false,
        symbol: sym,
        reason: candles?.length === 0
          ? `No data from Fyers for ${sym}. Symbol may be delisted, suspended, or use a different series (try -BE or -SM).`
          : `Only ${candles?.length || 0} candles available — need 30+ for analysis.`,
      });
    }
    const a = TA.fullAnalysis(candles);
    const sig = TA.generateSignal(a);
    const quote = await getQuoteOne(sym).catch(() => null);
    res.json({ ok: true, symbol: sym, quote, analysis: a, signal: sig });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Universe search (autocomplete) — uses extended ~200 symbol list
app.get('/api/universe', (req, res) => {
  const q = (req.query.q || '').toUpperCase();
  const all = EXTENDED_UNIVERSE.map((s) => ({ symbol: s, fyers: toFyersEquity(s) }));
  if (!q) return res.json(all.slice(0, 50));
  // Match anywhere in the symbol; prefix matches first
  const starts = all.filter((x) => x.symbol.startsWith(q));
  const contains = all.filter((x) => !x.symbol.startsWith(q) && x.symbol.includes(q));
  res.json([...starts, ...contains].slice(0, 20));
});

// Market scanner — supports ?fresh=1 to bypass cache
app.get('/api/scanner', requireAuth, async (req, res) => {
  try {
    const universe = req.query.universe;
    const fresh = req.query.fresh === '1';
    const list = universe === 'nifty50' ? NIFTY_50
      : universe === 'next50' ? NIFTY_NEXT_50
      : NIFTY_100;
    const ck = `scan:${universe || 'nifty100'}`;
    if (!fresh) {
      const cached = cacheGet(ck);
      if (cached) return res.json({ ...cached, fromCache: true });
    } else {
      cache.delete(ck);
    }
    const result = await runScanner(
      (sym) => getHistoryShortKey(sym, 'D', 400),
      { universe: list, concurrency: 4 }
    );
    cacheSet(ck, result, 15 * 60 * 1000);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Pre-market dashboard
app.get('/api/premarket', async (req, res) => {
  try {
    const ck = 'premarket';
    const cached = cacheGet(ck);
    if (cached) return res.json({ ...cached, fromCache: true });
    const data = await getPreMarketSnapshot();
    cacheSet(ck, data, 5 * 60 * 1000);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Commodities + crypto
app.get('/api/commodities', requireAuth, async (req, res) => {
  try {
    const ck = 'commodities';
    const cached = cacheGet(ck);
    if (cached) return res.json({ ...cached, fromCache: true });
    const [commodities, crypto] = await Promise.all([
      fetchCommodities(getQuoteOne, (s) => getHistoryShortKey(s, 'D', 200)),
      fetchCrypto(),
    ]);
    const data = { commodities, crypto, timestamp: new Date().toISOString() };
    cacheSet(ck, data, 60 * 1000);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/crypto-history/:id', async (req, res) => {
  try {
    const candles = await fetchCryptoHistory(
      req.params.id,
      parseInt(req.query.days || '90', 10)
    );
    res.json({ candles });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Option chain (Fyers — guarded since SDK builds vary)
app.get('/api/option-chain/:symbol', requireAuth, async (req, res) => {
  try {
    let sym = decodeURIComponent(req.params.symbol);
    if (!sym.includes(':')) sym = toFyersEquity(sym);
    const fyers = getFyers();
    if (typeof fyers.getOptionChain !== 'function') {
      return res.status(501).json({ error: 'option chain not available in this SDK build' });
    }
    const r = await fyers.getOptionChain({ symbol: sym, strikecount: 10 });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
//  HEALTH
// ═══════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
  res.json({
    version: '6.0',
    authenticated: !!accessToken,
    appId: APP_ID ? 'set' : 'missing',
    secret: SECRET ? 'set' : 'missing',
    tokenAge: tokenTime ? Math.round((Date.now() - tokenTime) / 60000) + ' min' : 'no token',
    cacheSize: cache.size,
    uptime: Math.round(process.uptime()) + 's',
    marketHours: isMarketHours(),
  });
});

// ═══════════════════════════════════════════════════════════
//  SPA fallback
// ═══════════════════════════════════════════════════════════

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`InvestIQ Pro v6 listening on :${PORT}`);
  console.log(`App ID: ${APP_ID ? APP_ID.substring(0, 6) + '...' : 'NOT SET'}`);
  console.log(`Secret: ${SECRET ? 'SET' : 'NOT SET'}`);
  console.log(`Redirect: ${REDIRECT}`);
  console.log(`Login: /auth/login`);
});
