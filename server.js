const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { fyersModel } = require('fyers-api-v3');
const app = express();
const PORT = process.env.PORT || 3000;

// ─── Config from environment ──────────────────────────
const APP_ID = process.env.FYERS_APP_ID || '';
const SECRET = process.env.FYERS_SECRET || '';
const REDIRECT = process.env.FYERS_REDIRECT || `https://investiq-ir5k.onrender.com/auth/callback`;

// ─── Token storage (in-memory, refreshed daily via OAuth) ─
let accessToken = '';
let tokenTime = 0;

// ─── Fyers client ─────────────────────────────────────
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
//  AUTH — OAuth2 login flow with Fyers
// ═══════════════════════════════════════════════════════════

// Step 1: Generate login URL and redirect user
app.get('/auth/login', (req, res) => {
  const fyers = getFyers();
  const url = fyers.generateAuthCode();
  console.log('[AUTH] Redirecting to Fyers login:', url);
  res.redirect(url);
});

// Step 2: Callback — exchange auth_code for access_token
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
      auth_code: authCode
    });
    if (response.s === 'ok' && response.access_token) {
      accessToken = response.access_token;
      tokenTime = Date.now();
      console.log('[AUTH] ✅ Access token received');
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

// Auth status check
app.get('/api/auth/status', (req, res) => {
  res.json({
    authenticated: !!accessToken,
    tokenAge: tokenTime ? Math.round((Date.now() - tokenTime) / 60000) + ' min' : null,
    appId: APP_ID ? APP_ID.substring(0, 4) + '...' : 'not set'
  });
});

// Logout
app.get('/auth/logout', (req, res) => {
  accessToken = '';
  tokenTime = 0;
  res.redirect('/');
});

// ─── Auth middleware ──────────────────────────────────
function requireAuth(req, res, next) {
  if (!accessToken) return res.status(401).json({ error: 'Not authenticated. Login at /auth/login' });
  next();
}

// ═══════════════════════════════════════════════════════════
//  DATA APIs — All require Fyers authentication
// ═══════════════════════════════════════════════════════════

// Quotes (live prices for multiple symbols)
app.get('/api/quotes', requireAuth, async (req, res) => {
  try {
    const symbols = req.query.symbols; // comma-separated: NSE:RELIANCE-EQ,NSE:TCS-EQ
    if (!symbols) return res.status(400).json({ error: 'symbols required' });
    const fyers = getFyers();
    const data = await fyers.getQuotes([...symbols.split(',').map(s => s.trim())]);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Market depth
app.get('/api/depth', requireAuth, async (req, res) => {
  try {
    const symbols = req.query.symbols;
    if (!symbols) return res.status(400).json({ error: 'symbols required' });
    const fyers = getFyers();
    const data = await fyers.getMarketDepth({ symbol: symbols.split(',').map(s => s.trim()), ohlcv_flag: 1 });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Historical candles (for TA computation)
app.get('/api/history', requireAuth, async (req, res) => {
  try {
    const { symbol, resolution, from, to } = req.query;
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    const fyers = getFyers();
    const now = Math.floor(Date.now() / 1000);
    const data = await fyers.getHistory({
      symbol: symbol,
      resolution: resolution || 'D', // D=daily, 1=1min, 5=5min, 15, 30, 60, 120, 240
      date_format: 0,
      range_from: from || String(now - 365 * 86400),
      range_to: to || String(now),
      cont_flag: '1'
    });
    // data.candles = [[timestamp, open, high, low, close, volume], ...]
    const candles = (data.candles || []).map(c => ({
      time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5]
    }));
    res.json({ symbol, candles });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Market status
app.get('/api/market-status', requireAuth, async (req, res) => {
  try {
    const fyers = getFyers();
    const data = await fyers.market_status();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Profile
app.get('/api/profile', requireAuth, async (req, res) => {
  try {
    const fyers = getFyers();
    const data = await fyers.get_profile();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Holdings
app.get('/api/holdings', requireAuth, async (req, res) => {
  try {
    const fyers = getFyers();
    const data = await fyers.get_holdings();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Positions
app.get('/api/positions', requireAuth, async (req, res) => {
  try {
    const fyers = getFyers();
    const data = await fyers.get_positions();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Funds
app.get('/api/funds', requireAuth, async (req, res) => {
  try {
    const fyers = getFyers();
    const data = await fyers.get_funds();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Health/diagnostics
app.get('/api/health', async (req, res) => {
  res.json({
    version: '5.0',
    authenticated: !!accessToken,
    appId: APP_ID ? 'set' : 'missing',
    secret: SECRET ? 'set' : 'missing',
    tokenAge: tokenTime ? Math.round((Date.now() - tokenTime) / 60000) + ' min' : 'no token'
  });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`InvestIQ Pro v5.0 on port ${PORT}`);
  console.log(`App ID: ${APP_ID ? APP_ID.substring(0, 6) + '...' : 'NOT SET'}`);
  console.log(`Secret: ${SECRET ? 'SET' : 'NOT SET'}`);
  console.log(`Redirect: ${REDIRECT}`);
  console.log(`Login URL: /auth/login`);
});
