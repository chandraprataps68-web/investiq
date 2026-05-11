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
const {
  INDICES, FNO_STOCKS,
  getIndexFutures, fetchOptionChain, analyzeOptionChain, getStockBuildup,
} = require('./fno');
const strategy = require('./strategy');
const backtest = require('./backtest');
const optionScanner = require('./optionScanner');
const postmortem = require('./postmortem');
const catalysts = require('./catalysts');
const commodityStitcher = require('./commodityStitcher');
const commodityTA = require('./commodityTA');
const intradayStrategy = require('./intradayStrategy');
const { NIFTY_50, NIFTY_NEXT_50, NIFTY_100, EXTENDED_UNIVERSE, FNO_UNIVERSE, toFyersEquity } = require('./universe');

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
  // Token lifetime: 23 hours, but Fyers can revoke earlier on inactivity
  const TOKEN_TTL_MS = 23 * 3600 * 1000;
  const elapsed = tokenTime ? Date.now() - tokenTime : 0;
  const remainingMs = tokenTime ? Math.max(0, TOKEN_TTL_MS - elapsed) : 0;
  const remainingMin = Math.round(remainingMs / 60000);
  const remainingHours = remainingMs / 3600000;

  // Warn levels:
  //   none     → fresh token, > 4 hours left
  //   info     → 2-4 hours left
  //   warning  → 30 min - 2 hours
  //   critical → < 30 min or expired
  let warnLevel = 'none';
  let warnMessage = null;
  if (!accessToken) {
    warnLevel = 'critical';
    warnMessage = 'Not authenticated. Login required.';
  } else if (remainingMs <= 0) {
    warnLevel = 'critical';
    warnMessage = 'Token has expired. Login again to refresh.';
  } else if (remainingHours < 0.5) {
    warnLevel = 'critical';
    warnMessage = `Token expires in ${remainingMin} min. Login soon to avoid mid-task failures.`;
  } else if (remainingHours < 2) {
    warnLevel = 'warning';
    warnMessage = `Token expires in ~${Math.round(remainingHours * 10) / 10}h. Consider re-login when convenient.`;
  } else if (remainingHours < 4) {
    warnLevel = 'info';
    warnMessage = `Token has ~${Math.round(remainingHours)}h remaining.`;
  }

  res.json({
    authenticated: !!accessToken,
    tokenAge: tokenTime ? Math.round(elapsed / 60000) + ' min' : null,
    remainingMin,
    remainingHours: Math.round(remainingHours * 10) / 10,
    warnLevel,
    warnMessage,
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

  // CRITICAL: Fyers daily history has a 366-day max per request.
  // For longer ranges, we chunk and concatenate. For ≤365 days, single call.
  const MAX_DAYS_PER_REQUEST = resolution === 'D' ? 365 : 30;
  const allCandles = [];
  const nowSec = Math.floor(Date.now() / 1000);
  const totalSec = days * 86400;

  // Build chunked ranges from oldest to newest
  let chunkEnd = nowSec;
  let chunkStart = Math.max(nowSec - totalSec, nowSec - MAX_DAYS_PER_REQUEST * 86400);

  while (chunkEnd > nowSec - totalSec) {
    const r = await fyers.getHistory({
      symbol: fyersSym,
      resolution,
      date_format: 0,
      range_from: String(chunkStart),
      range_to: String(chunkEnd),
      cont_flag: '1',
    });
    if (r?.s !== 'ok') {
      const msg = r?.message || r?.s || 'unknown';
      const code = r?.code;
      console.error(`[fyers history ${fyersSym} chunk] ${msg} (code ${code})`);
      // Only auto-clear token on confirmed auth errors
      if (code === -16 || code === -17 || code === -300 || code === -352) {
        console.error('[fyers] Token invalid, clearing');
        accessToken = '';
        tokenTime = 0;
        try { fs.unlinkSync(TOKEN_FILE); } catch (_) {}
      }
      // Cache empty briefly so we don't hammer Fyers retrying
      cacheSet(ck, [], 5 * 60 * 1000);
      return [];
    }
    const chunk = (r.candles || []).map((c) => ({
      t: c[0], o: c[1], h: c[2], l: c[3], c: c[4], v: c[5],
    }));
    // Prepend (older data goes first)
    allCandles.unshift(...chunk);
    if (chunkStart <= nowSec - totalSec) break;
    chunkEnd = chunkStart - 86400;
    chunkStart = Math.max(nowSec - totalSec, chunkEnd - MAX_DAYS_PER_REQUEST * 86400);
  }

  // De-dupe by timestamp (chunks may overlap by a day at boundaries)
  const seen = new Set();
  const candles = allCandles.filter((c) => {
    if (seen.has(c.t)) return false;
    seen.add(c.t);
    return true;
  });

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
      : universe === 'fno' ? FNO_UNIVERSE
      : NIFTY_100;
    const ck = `scan:${universe || 'nifty100'}`;
    if (!fresh) {
      const cached = cacheGet(ck);
      if (cached) return res.json({ ...cached, fromCache: true });
    } else {
      cache.delete(ck);
    }
    // F&O universe is ~2x size; longer cache + lower concurrency to avoid Fyers rate limits
    const concurrency = universe === 'fno' ? 3 : 4;
    const cacheTtl = universe === 'fno' ? 30 * 60 * 1000 : 15 * 60 * 1000;
    const result = await runScanner(
      (sym) => getHistoryShortKey(sym, 'D', 400),
      { universe: list, concurrency }
    );
    result.universe = universe || 'nifty100';
    result.universeSize = list.length;
    cacheSet(ck, result, cacheTtl);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Pre-market dashboard (uses Fyers if authenticated for India-specific cues)
app.get('/api/premarket', async (req, res) => {
  try {
    const ck = 'premarket';
    const cached = cacheGet(ck);
    if (cached) return res.json({ ...cached, fromCache: true });
    const fyersIndexFetcher = accessToken ? getQuoteOne : null;
    const data = await getPreMarketSnapshot({ fyersIndexFetcher });

    // Detect news catalysts and adjust bias confidence
    if (data.news) {
      const cat = catalysts.detectCatalysts(data.news);
      data.catalysts = cat;
      // If catalysts detected, adjust the bias confidence (not the score itself,
      // but flag that prediction may be unreliable)
      if (data.bias && cat.confidenceImpact < 0) {
        data.bias.catalystWarning = cat.summary;
        data.bias.confidenceImpact = cat.confidenceImpact;
      }
    }
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

// Diagnostic: see what the stitcher returns for one commodity. Use to debug
// why signals fire "insufficient data".
//   GET /api/commodity-debug/GOLD
app.get('/api/commodity-debug/:base', requireAuth, async (req, res) => {
  try {
    const base = req.params.base.toUpperCase();
    const fetcher = (sym, resolution, days) => getHistoryShortKey(sym, resolution || 'D', days || 90);

    // First, probe each candidate contract to see what's available
    const contracts = commodityStitcher.pastContracts(base, 'MCX', 6);
    const perContract = [];
    for (const c of contracts) {
      let count = 0, firstDate = null, lastDate = null, error = null;
      try {
        const candles = await fetcher(c.symbol, 'D', 90);
        count = Array.isArray(candles) ? candles.length : 0;
        if (count > 0) {
          firstDate = new Date(candles[0].t * 1000).toISOString().slice(0, 10);
          lastDate = new Date(candles[count - 1].t * 1000).toISOString().slice(0, 10);
        }
      } catch (e) { error = e.message; }
      perContract.push({ symbol: c.symbol, label: c.label, count, firstDate, lastDate, error });
    }

    // Now get the actual continuous series
    const series = await commodityStitcher.getContinuousSeries(base, 'MCX', fetcher, { days: 365 });
    const activeSymbol = await commodityStitcher.resolveActiveContract(base, 'MCX', fetcher);

    res.json({
      base,
      activeSymbol,
      perContract,
      stitched: {
        candleCount: series.length,
        firstDate: series[0]?.t ? new Date(series[0].t * 1000).toISOString().slice(0, 10) : null,
        lastDate: series[series.length - 1]?.t ? new Date(series[series.length - 1].t * 1000).toISOString().slice(0, 10) : null,
        firstClose: series[0]?.c,
        lastClose: series[series.length - 1]?.c,
      },
      sufficient: series.length >= 220,
      hint: series.length < 220
        ? `Need ≥220 candles for 200-DMA. Got ${series.length}. Either contract is too new or Fyers returned partial history.`
        : 'Series is sufficient for full TA.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Commodity Scanner — TA-based BUY/SELL recommendations (≥75 confidence)
// Uses continuous back-adjusted MCX futures series for robust trend analysis.
// 30-min cache to keep load manageable on free tier.
app.get('/api/commodity-signals', requireAuth, async (req, res) => {
  try {
    const ck = 'commodity-signals';
    if (req.query.fresh !== '1') {
      const cached = cacheGet(ck);
      if (cached) return res.json({ ...cached, fromCache: true });
    }

    // Build list of MCX futures-based commodities (skip equity entries like COALINDIA)
    const { COMMODITIES } = require('./universe');
    const futsList = COMMODITIES.filter(c => c.base && c.exchange === 'MCX');

    // Fetcher returns short-key candles, just like our internal v6 format
    const fetcher = (sym, res, days) => getHistoryShortKey(sym, res || 'D', days || 90);

    const getSeries = async (base, exchange) =>
      commodityStitcher.getContinuousSeries(base, exchange, fetcher, { days: 365 });

    const result = await commodityTA.scanCommodities(futsList, getSeries, {
      confThreshold: 75,
    });

    const out = {
      timestamp: new Date().toISOString(),
      threshold: 75,
      horizon: 'SWING',
      ...result,
    };
    cacheSet(ck, out, 30 * 60 * 1000); // 30-min cache
    res.json(out);
  } catch (e) {
    console.error('[commodity-signals]', e);
    res.status(500).json({ error: e.message });
  }
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

// Intraday playbook for index trading (Bank Nifty / Nifty 50)
//   GET /api/intraday/:symbol  where symbol = BANKNIFTY or NIFTY
// Returns daily setup levels + intraday BUY/SELL zones with target+stop+RR.
// Cached 5 min — refreshes intraday during market hours.
app.get('/api/intraday/:symbol', requireAuth, async (req, res) => {
  try {
    const symbolKey = req.params.symbol.toUpperCase();
    if (symbolKey !== 'BANKNIFTY' && symbolKey !== 'NIFTY') {
      return res.status(400).json({ error: 'symbol must be BANKNIFTY or NIFTY' });
    }
    const ck = `intraday:${symbolKey}`;
    if (req.query.fresh !== '1') {
      const cached = cacheGet(ck);
      if (cached) return res.json({ ...cached, fromCache: true });
    }

    // Wire up data fetchers using existing internals
    const spotFetcher = (sym) => getQuoteOne(sym);
    const historyFetcher = (sym, res, days) => getHistoryShortKey(sym, res || 'D', days || 250);
    const optionChainFetcher = async (key) => {
      const fyersSym = key === 'BANKNIFTY' ? 'NSE:NIFTYBANK-INDEX' : 'NSE:NIFTY50-INDEX';
      const fyers = getFyers();
      const r = await fetchOptionChain(fyers, fyersSym, 20);
      if (r.error) return { error: r.error };
      return analyzeOptionChain(r.data);
    };

    const result = await intradayStrategy.buildPlaybook({
      symbolKey,
      spotFetcher,
      historyFetcher,
      optionChainFetcher,
    });

    if (result.error) {
      return res.status(500).json(result);
    }

    cacheSet(ck, result, 5 * 60 * 1000); // 5 min — refreshes intraday
    res.json(result);
  } catch (e) {
    console.error('[intraday]', e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  F&O ROUTES (Index Futures + Option Chain + Stock Buildup)
// ═══════════════════════════════════════════════════════════

// Index Futures snapshot (Nifty / Bank Nifty / Fin Nifty / Midcap)
app.get('/api/fno/index-futures', requireAuth, async (req, res) => {
  try {
    const ck = 'fno:idx';
    const cached = cacheGet(ck);
    if (cached) return res.json({ ...cached, fromCache: true });
    const data = await getIndexFutures(getQuoteOne);
    const result = { indices: data, timestamp: new Date().toISOString() };
    cacheSet(ck, result, 60 * 1000);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Option chain for given symbol; returns analytics + chain
// query params: symbol (e.g. NSE:NIFTY50-INDEX or NIFTY for shortcut), strikes (default 20), expiry (epoch seconds, optional)
app.get('/api/fno/option-chain', requireAuth, async (req, res) => {
  try {
    let sym = req.query.symbol || 'NSE:NIFTY50-INDEX';
    const strikes = parseInt(req.query.strikes || '20', 10);
    const expiry = req.query.expiry || '';
    // Shortcuts
    const shortcuts = {
      NIFTY: 'NSE:NIFTY50-INDEX',
      BANKNIFTY: 'NSE:NIFTYBANK-INDEX',
      FINNIFTY: 'NSE:FINNIFTY-INDEX',
      MIDCAP: 'NSE:MIDCPNIFTY-INDEX',
    };
    if (shortcuts[sym.toUpperCase()]) sym = shortcuts[sym.toUpperCase()];
    if (!sym.includes(':')) sym = toFyersEquity(sym);
    const ck = `fno:oc:${sym}:${strikes}:${expiry}`;
    const cached = cacheGet(ck);
    if (cached) return res.json({ ...cached, fromCache: true });
    const fyers = getFyers();
    const r = await fetchOptionChain(fyers, sym, strikes, expiry);
    if (r.error) return res.status(500).json({ error: r.error });
    const analyzed = analyzeOptionChain(r.data, expiry);
    const result = { symbol: sym, ...analyzed, timestamp: new Date().toISOString() };
    cacheSet(ck, result, 30 * 1000); // 30s — option chains move fast
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stock F&O OI buildup table
app.get('/api/fno/buildup', requireAuth, async (req, res) => {
  try {
    const ck = 'fno:buildup';
    const cached = cacheGet(ck);
    if (cached) return res.json({ ...cached, fromCache: true });
    const data = await getStockBuildup(getQuoteOne, getFyers());
    // Group counts
    const summary = data.reduce((acc, r) => {
      acc[r.buildup] = (acc[r.buildup] || 0) + 1;
      return acc;
    }, {});
    const result = { stocks: data, summary, timestamp: new Date().toISOString() };
    cacheSet(ck, result, 2 * 60 * 1000);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Legacy alias for the old option-chain stub — kept for compat
app.get('/api/option-chain/:symbol', requireAuth, async (req, res) => {
  try {
    let sym = decodeURIComponent(req.params.symbol);
    if (!sym.includes(':')) sym = toFyersEquity(sym);
    const fyers = getFyers();
    const r = await fetchOptionChain(fyers, sym, 10);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Strategy P&L analyzer — pure math, no auth needed
// POST /api/fno/strategy with body { legs: [...], spot, rangePct? }
app.post('/api/fno/strategy', (req, res) => {
  try {
    const { legs, spot, rangePct } = req.body || {};
    if (!Array.isArray(legs) || legs.length === 0) {
      return res.status(400).json({ error: 'legs array required' });
    }
    if (typeof spot !== 'number' || spot <= 0) {
      return res.status(400).json({ error: 'valid spot required' });
    }
    // Validate each leg
    for (const leg of legs) {
      if (!['CE', 'PE'].includes(leg.type)) return res.status(400).json({ error: 'leg.type must be CE or PE' });
      if (!['BUY', 'SELL'].includes(leg.side)) return res.status(400).json({ error: 'leg.side must be BUY or SELL' });
      if (typeof leg.strike !== 'number' || leg.strike <= 0) return res.status(400).json({ error: 'leg.strike invalid' });
      if (typeof leg.premium !== 'number' || leg.premium < 0) return res.status(400).json({ error: 'leg.premium invalid' });
      if (typeof leg.quantity !== 'number' || leg.quantity <= 0) return res.status(400).json({ error: 'leg.quantity invalid' });
    }
    const result = strategy.analyzeStrategy(legs, spot, rangePct || 0.15);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Strategy preset builder — given preset name + symbol + timeframe,
// fetch live chain at correct expiry, build legs from REAL premiums,
// run recommendation engine against current market context.
app.get('/api/fno/strategy-preset', requireAuth, async (req, res) => {
  try {
    const name = req.query.name;
    const symbol = (req.query.symbol || 'NIFTY').toUpperCase();
    const timeframe = req.query.timeframe === 'monthly' ? 'monthly' : 'weekly';
    if (!strategy.PRESETS[name]) return res.status(400).json({ error: 'unknown preset' });

    // Resolve symbol to Fyers format
    const indexShortcuts = {
      NIFTY: 'NSE:NIFTY50-INDEX',
      BANKNIFTY: 'NSE:NIFTYBANK-INDEX',
      FINNIFTY: 'NSE:FINNIFTY-INDEX',
    };
    const lotSizes = { NIFTY: 75, BANKNIFTY: 30, FINNIFTY: 65 };
    const fyersSym = indexShortcuts[symbol] || symbol;
    const lotSize = lotSizes[symbol] || 75;

    // Fetch chain to find expiries and ATM strike pricing
    const fyers = getFyers();
    const chainResp = await fetchOptionChain(fyers, fyersSym, 30); // 30 strikes for spread coverage
    if (chainResp.error) return res.status(500).json({ error: chainResp.error });

    // Pick expiry based on timeframe:
    //  weekly  → nearest expiry (any flag)
    //  monthly → nearest M-flagged expiry with at least 14 days to expiry
    const expiryData = chainResp.data?.expiryData || [];
    let chosenExpiry = null;
    const nowSec = Math.floor(Date.now() / 1000);
    const FOURTEEN_DAYS = 14 * 86400;
    if (timeframe === 'weekly') {
      const futureExpiries = expiryData.filter(e => parseInt(e.expiry, 10) > nowSec);
      chosenExpiry = futureExpiries[0]?.expiry;
    } else {
      // monthly: find first M-flag with at least 14 days out
      const monthlies = expiryData.filter(e =>
        e.expiry_flag === 'M' && parseInt(e.expiry, 10) > nowSec + FOURTEEN_DAYS
      );
      chosenExpiry = monthlies[0]?.expiry;
      // Fallback to any monthly future expiry if none ≥14d
      if (!chosenExpiry) {
        const anyMonthly = expiryData.find(e =>
          e.expiry_flag === 'M' && parseInt(e.expiry, 10) > nowSec
        );
        chosenExpiry = anyMonthly?.expiry;
      }
    }

    // Re-fetch chain for the specific expiry (chains differ per expiry)
    let chainAtExpiry = chainResp;
    if (chosenExpiry && chosenExpiry !== chainResp.data?.expiryData?.[0]?.expiry) {
      chainAtExpiry = await fetchOptionChain(fyers, fyersSym, 30, chosenExpiry);
    }
    const analyzed = analyzeOptionChain(chainAtExpiry.data, chosenExpiry);

    // Spot from analyzed result
    const spot = analyzed.spot;
    if (!spot || spot <= 0) {
      return res.status(500).json({ error: 'could not determine spot price' });
    }

    // Build a chainAt(strike, type) lookup function over the analyzed chain
    const chainAt = (strike, type) => {
      return (analyzed.chain || []).find(r =>
        r.strike_price === strike && r.option_type === type
      );
    };

    // Generate legs from preset (now with real chain)
    const preset = strategy.PRESETS[name];
    const legs = preset.legs(spot, lotSize, chainAt, timeframe);

    // Build market context for recommendation engine
    let premarketScore = 0;
    try {
      const fyersIndexFetcher = accessToken ? getQuoteOne : null;
      const pm = await getPreMarketSnapshot({ fyersIndexFetcher });
      premarketScore = pm?.bias?.score || 0;
    } catch (_) { /* premarket unavailable, score stays 0 */ }

    const ctx = {
      premarketScore,
      indiaVix: analyzed.indiaVix,
      spot,
      maxPainStrike: analyzed.maxPain?.strike,
      pcrOI: analyzed.pcr?.pcrOI,
    };
    const recommendation = strategy.recommendStrategy(name, timeframe, ctx);

    // Find the chosen expiry's date string for display
    const expiryRow = expiryData.find(e => e.expiry === chosenExpiry);
    const expiryLabel = expiryRow?.date || '—';

    res.json({
      name: preset.name,
      sentiment: preset.sentiment,
      description: preset.description,
      legs,
      timeframe,
      expiryUsed: chosenExpiry,
      expiryLabel,
      spot,
      recommendation,
      marketContext: ctx,
    });
  } catch (e) {
    console.error('[strategy-preset]', e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  OPTION SCANNER (Phase 3 Batch 2)
// ═══════════════════════════════════════════════════════════

// Scan equity STRONG BUY/SELL stocks, recommend best CE/PE per stock
app.get('/api/option-scanner', requireAuth, async (req, res) => {
  try {
    const ck = 'opt-scanner';
    const cached = cacheGet(ck);
    if (cached && req.query.fresh !== '1') {
      return res.json({ ...cached, fromCache: true });
    }

    // Get equity scanner results first
    const scannerCk = 'scanner';
    let scannerData = cacheGet(scannerCk);
    if (!scannerData) {
      const { runScanner } = require('./scanner');
      const { NIFTY_100 } = require('./universe');
      scannerData = await runScanner(
        (sym) => getHistoryShortKey(sym, 'D', 400),
        { universe: NIFTY_100, concurrency: 4 }
      );
      cacheSet(scannerCk, scannerData, 5 * 60 * 1000);
    }

    const fyers = getFyers();
    const scanResult = await optionScanner.scanOptions(scannerData.results || [], fyers);
    const recs = scanResult.recommendations || [];

    const result = {
      recommendations: recs,
      summary: {
        total: recs.length,
        bullish: recs.filter(r => r.optionType === 'CE').length,
        bearish: recs.filter(r => r.optionType === 'PE').length,
        weekly: recs.filter(r => r.timeframe === 'weekly').length,
        monthly: recs.filter(r => r.timeframe === 'monthly').length,
      },
      dataQuality: scanResult.dataQuality, // Phase 8: skip-reason transparency
      timestamp: new Date().toISOString(),
    };
    cacheSet(ck, result, 5 * 60 * 1000); // 5 min cache
    res.json(result);
  } catch (e) {
    console.error('[option-scanner]', e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  BACKTEST (Phase 3 Batch 2)
// ═══════════════════════════════════════════════════════════

// Get aggregated backtest stats
app.get('/api/backtest', (req, res) => {
  try {
    const stats = backtest.getStats();
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Post-mortem analysis: why predictions were right/wrong + recurring patterns
app.get('/api/postmortem', (req, res) => {
  try {
    const state = backtest.load();
    const result = postmortem.runAnalysis(state);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Diagnostic: snapshot system status — why did/didn't a snapshot fire?
app.get('/api/backtest/status', (req, res) => {
  try {
    const state = backtest.load();
    const istHour = backtest.nowISTHour();
    const istDay = new Date(Date.now() + 5.5 * 60 * 60 * 1000).getUTCDay();
    const snapshotShould = backtest.shouldSnapshot(state);
    const verifyShould = backtest.shouldVerify(state);
    res.json({
      currentISTHour: istHour,
      istDayOfWeek: istDay,
      isWeekend: istDay === 0 || istDay === 6,
      authenticated: !!accessToken,
      tokenAgeMin: tokenTime ? Math.round((Date.now() - tokenTime) / 60000) : null,
      shouldSnapshot: snapshotShould,
      shouldVerify: verifyShould,
      todayDate: backtest.todayIST(),
      snapshotsCount: state.snapshots.length,
      lastSnapshot: state.snapshots[state.snapshots.length - 1]?.date || null,
      lastUpdate: state.lastUpdate,
      diagnostic: !accessToken ? 'NOT AUTHENTICATED — snapshot/verify will skip until /auth/login'
        : (istDay === 0 || istDay === 6) ? 'WEEKEND — no snapshots taken'
        : (istHour < 8) ? `BEFORE WINDOW — wait until 8 AM IST (currently ${istHour}:00)`
        : (istHour >= 15 && !verifyShould) ? `AFTER WINDOW — snapshot window closed at 3 PM IST`
        : snapshotShould ? 'SNAPSHOT SHOULD FIRE NOW — hit /api/backtest/snapshot to trigger'
        : verifyShould ? `VERIFY SHOULD FIRE — pending date: ${verifyShould}`
        : 'IN WINDOW — no action needed (already done or no pending work)',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Internal helper: run a snapshot now (called by cron-like check below)
async function runSnapshotIfNeeded() {
  const state = backtest.load();
  if (!backtest.shouldSnapshot(state)) return null;
  if (!accessToken) return null; // need auth to snapshot

  const fyersIndexFetcher = getQuoteOne;

  try {
    return await backtest.takeSnapshot({
      getPremarket: async () => {
        const { getPreMarketSnapshot } = require('./premarket');
        return await getPreMarketSnapshot({ fyersIndexFetcher });
      },
      getScanner: async () => {
        const cached = cacheGet('scanner');
        if (cached) return cached;
        const { runScanner } = require('./scanner');
        const { NIFTY_100 } = require('./universe');
        const data = await runScanner(
          (sym) => getHistoryShortKey(sym, 'D', 400),
          { universe: NIFTY_100, concurrency: 4 }
        );
        cacheSet('scanner', data, 5 * 60 * 1000);
        return data;
      },
      getStrategyVerdicts: async () => {
        // Compute verdicts for all 5 strategies × 2 timeframes for NIFTY
        const fyers = getFyers();
        const chainResp = await fetchOptionChain(fyers, 'NSE:NIFTY50-INDEX', 30);
        if (chainResp?.error) return null;
        const analyzed = analyzeOptionChain(chainResp.data);
        let pmScore = 0;
        try {
          const { getPreMarketSnapshot } = require('./premarket');
          const pm = await getPreMarketSnapshot({ fyersIndexFetcher });
          pmScore = pm?.bias?.score || 0;
        } catch (_) {}
        const ctx = {
          premarketScore: pmScore,
          indiaVix: analyzed.indiaVix,
          spot: analyzed.spot,
          maxPainStrike: analyzed.maxPain?.strike,
          pcrOI: analyzed.pcr?.pcrOI,
        };
        const presets = ['longCall', 'longPut', 'bullCallSpread', 'ironCondor', 'longStraddle'];
        const out = { weekly: {}, monthly: {} };
        for (const tf of ['weekly', 'monthly']) {
          for (const p of presets) {
            out[tf][p] = strategy.recommendStrategy(p, tf, ctx);
          }
        }
        return out;
      },
    });
  } catch (e) {
    console.error('[backtest snapshot]', e);
    return null;
  }
}

// Internal: verify yesterday's snapshot if window has passed
async function runVerifyIfNeeded() {
  const state = backtest.load();
  const dateToVerify = backtest.shouldVerify(state);
  if (!dateToVerify) return null;
  if (!accessToken) return null;

  try {
    return await backtest.verifySnapshot(dateToVerify, {
      fetchClose: async (symbol) => {
        try {
          const q = await getQuoteOne(`NSE:${symbol}-EQ`);
          return q ? { close: q.lp ?? q.ltp } : null;
        } catch (_) { return null; }
      },
      getNiftyMove: async () => {
        try {
          const q = await getQuoteOne('NSE:NIFTY50-INDEX');
          return q?.chp ?? null;
        } catch (_) { return null; }
      },
    });
  } catch (e) {
    console.error('[backtest verify]', e);
    return null;
  }
}

// Manual trigger endpoint (for testing or forced refresh)
app.post('/api/backtest/snapshot', async (req, res) => {
  if (!accessToken) {
    return res.status(401).json({ ok: false, error: 'Not authenticated. Login at /auth/login first.' });
  }
  try {
    const r = await runSnapshotIfNeeded();
    if (!r) {
      const state = backtest.load();
      const today = backtest.todayIST();
      const existing = state.snapshots.find(s => s.date === today);
      if (existing && existing.predictions) {
        return res.json({ ok: true, message: 'Snapshot already exists for today', snapshot: existing.predictions });
      }
      const istHour = backtest.nowISTHour();
      return res.json({ ok: false, message: `Outside snapshot window (current IST hour: ${istHour}, window: 8-15)` });
    }
    res.json({ ok: true, snapshot: r });
  } catch (e) {
    console.error('[snapshot manual]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/backtest/verify', async (req, res) => {
  if (!accessToken) {
    return res.status(401).json({ ok: false, error: 'Not authenticated.' });
  }
  try {
    const r = await runVerifyIfNeeded();
    res.json({ ok: !!r, verification: r });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  HEALTH
// ═══════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
  // Cron-like trigger: check if it's snapshot/verification window
  // (fire-and-forget, doesn't block the response).
  // Logs to server output so we can see WHY a snapshot fired or didn't.
  if (accessToken) {
    Promise.all([runSnapshotIfNeeded(), runVerifyIfNeeded()])
      .then(([s, v]) => {
        if (s) console.log(`[cron] snapshot fired for ${backtest.todayIST()}`);
        if (v) console.log(`[cron] verification fired for ${v.date || 'unknown date'}`);
      })
      .catch((e) => console.error('[cron] error:', e.message));
  }

  res.json({
    version: '6.0',
    authenticated: !!accessToken,
    appId: APP_ID ? 'set' : 'missing',
    secret: SECRET ? 'set' : 'missing',
    tokenAge: tokenTime ? Math.round((Date.now() - tokenTime) / 60000) + ' min' : 'no token',
    cacheSize: cache.size,
    uptime: Math.round(process.uptime()) + 's',
    marketHours: isMarketHours(),
    istHour: backtest.nowISTHour(),
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
