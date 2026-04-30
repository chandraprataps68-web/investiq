# InvestIQ Pro v6 — Deployment Guide

A complete Indian markets intelligence dashboard.

## What's new in v6

- **5-tab UI**: Pre-Market, Scanner, Stock Search, Commodities, Options
- **Pre-Market Bias**: GIFT Nifty + global cues + FII/DII + news → directional bias card
- **Equity Scanner**: Minervini trend template + RS rank + 52WH proximity across Nifty 100
- **Stock Search**: Search any NSE-100 symbol, get full TA + multi-horizon targets/stops
- **Commodities**: Gold, Silver, Crude, Natural Gas, Copper (Fyers MCX) + BTC/ETH/SOL/BNB (CoinGecko)
- **Cloudflare Worker keep-alive**: free, prevents Render cold starts during market hours

## Architecture

```
[ User browser ]
       │
       ▼
[ Cloudflare Pages ] (frontend, free, fast in India)
       │ /api/* proxied to:
       ▼
[ Render Free ] ─── fyers-api-v3 ───▶ Fyers API
       ▲                              CoinGecko API
       │ /api/health every 10 min     Yahoo Finance
       │
[ Cloudflare Worker cron ] (free, keeps Render warm)
```

## Files

```
investiq/
├── server.js            # Main Express backend
├── ta.js                # Technical analysis engine
├── scanner.js           # Trend-template scanner with RS rank
├── premarket.js         # Global cues + news + FII/DII + bias
├── commodities.js       # MCX + CoinGecko
├── universe.js          # Nifty 50 / Next 50 / commodities / crypto lists
├── public/
│   └── index.html       # Single-page frontend
├── worker/
│   ├── worker.js        # Cloudflare Worker
│   └── wrangler.toml    # Worker config
└── package.json
```

## Step 1: Deploy backend to Render

1. Push this repo to GitHub
2. In Render dashboard:
   - **Service type**: Web Service
   - **Build command**: `npm install`
   - **Start command**: `npm start`
   - **Node version**: 20+
3. Set environment variables:
   - `FYERS_APP_ID` = `WJWQGM6JWM-100`
   - `FYERS_SECRET` = (your secret)
   - `REDIRECT_URI` = `https://YOUR-RENDER-URL.onrender.com/callback`
4. Make sure your Fyers app's redirect URI matches the one above
5. Deploy. Visit `/login` once to authenticate; the token survives ~23 hours.

## Step 2: Deploy frontend to Cloudflare Pages (optional, for speed)

If you want the frontend on Cloudflare's edge (faster in India, no cold starts):

1. Move `public/` contents to a separate `frontend/` repo
2. In every `fetch('/api/...')` call in `index.html`, change to `fetch('https://YOUR-RENDER-URL.onrender.com/api/...')` and add CORS headers in `server.js`:
   ```js
   app.use((req, res, next) => {
     res.setHeader('Access-Control-Allow-Origin', 'https://YOUR-PAGES-URL.pages.dev');
     res.setHeader('Access-Control-Allow-Credentials', 'true');
     next();
   });
   ```
3. Connect Cloudflare Pages to that repo. No build command needed (static).

**OR** keep the simpler path: serve the frontend from Render too (current setup). The Cloudflare Worker still solves the cold-start problem.

## Step 3: Deploy the keep-alive Worker (required for cold-start fix)

1. Install Wrangler: `npm i -g wrangler`
2. Login: `wrangler login`
3. Edit `worker/wrangler.toml`: set `RENDER_URL` to your Render URL
4. Deploy: `cd worker && wrangler deploy`

The Worker pings Render every 10 minutes during pre-market (07:00-10:00 IST) and market hours (09:15-15:30 IST). This keeps Render's free tier from sleeping.

**Cost**: 0. Cloudflare Free tier allows 100K requests/day; we use ~150/day.

## API endpoints exposed by `server.js`

| Method | Path | Purpose |
|---|---|---|
| GET | `/login` | Start Fyers OAuth |
| GET | `/callback` | OAuth return |
| GET | `/api/auth-status` | Check token validity |
| GET | `/api/quote/:symbol` | Single quote |
| POST | `/api/quotes` | Batch quotes (body: `{symbols:[...]}`) |
| GET | `/api/history/:symbol?resolution=D&days=365` | OHLCV candles |
| GET | `/api/analyze/:symbol` | Full TA + signal + targets |
| GET | `/api/universe?q=` | Symbol search |
| GET | `/api/scanner?universe=nifty100` | Run scanner |
| GET | `/api/premarket` | Global cues + news + FII/DII + bias |
| GET | `/api/commodities` | MCX + crypto + signals |
| GET | `/api/crypto-history/:id` | CoinGecko OHLCV |
| GET | `/api/option-chain/:symbol` | Fyers option chain (basic) |
| GET | `/api/health` | Health + cache stats |

## Caveats

- **Commodity contract months** (e.g. `25DEC` in `MCX:GOLD25DECFUT`) need updating monthly. A future version should fetch the active contract dynamically from Fyers.
- **FII/DII scraping** is fragile — Trendlyne markup changes break it. The CF Worker is the right place to harden this with a more reliable source.
- **Yahoo Finance unofficial API** is unstable. If it breaks, swap to `query2.finance.yahoo.com` or a paid alternative (~$10/mo Twelve Data).
- **Coal** has no MCX futures; we surface Coal India equity instead. Hindustan Zinc / NMDC could be added if you want metal exposure.
- **Crypto** uses CoinGecko Free (~30 req/min). Fine for cached data; rate-limit if you increase polling.
- **Options scanner** is staged (Tab 5 stub). Fyers `getOptionChain` exists but the SDK build matters.

## Local development

```bash
cd investiq
npm install
export FYERS_SECRET=your_secret_here
export REDIRECT_URI=http://localhost:10000/callback
npm run dev
# Open http://localhost:10000
```

## License

MIT for your use; data sources have their own ToS — review before commercial use.
