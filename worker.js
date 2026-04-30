// Cloudflare Worker — InvestIQ Pro v6 keep-alive + cache
// Deploy with: npx wrangler deploy

// IMPORTANT: Set RENDER_URL in wrangler.toml or via the dashboard
// e.g. RENDER_URL = "https://investiq-ir5k.onrender.com"

export default {
  async scheduled(event, env, ctx) {
    const now = new Date();
    const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const day = ist.getDay();
    const hr = ist.getHours();
    const isMarketHours = day >= 1 && day <= 5 && hr >= 9 && hr < 16;
    const isPreMarket = day >= 1 && day <= 5 && hr >= 7 && hr < 10;

    // 1. Always ping Render to keep it warm during market hours
    if (isMarketHours || isPreMarket) {
      try {
        const res = await fetch(`${env.RENDER_URL}/api/health`, {
          headers: { 'User-Agent': 'CF-Worker InvestIQ-KeepAlive' },
          cf: { cacheTtl: 0 },
        });
        console.log(`Render health ping: ${res.status}`);
      } catch (e) {
        console.error('Render ping failed:', e.message);
      }

      // 2. Pre-warm pre-market data (free for Render — done in CF Worker)
      if (isPreMarket) {
        ctx.waitUntil(this.warmPremarket(env));
      }
    }
  },

  async warmPremarket(env) {
    try {
      // Fetch pre-market data via Render so the cache is warm for users
      await fetch(`${env.RENDER_URL}/api/premarket`);
    } catch (e) {
      console.error('Pre-market warm failed:', e.message);
    }
  },

  // Optional: fetch handler for direct data routes (CF-hosted, no Render hit)
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/yahoo-cues') {
      // Proxy Yahoo cues from CF edge — no rate limits hitting Render
      const symbols = '^NSEI,^DJI,^IXIC,^N225,^HSI,BZ=F,DX-Y.NYB,INR=X';
      const yres = await fetch(
        `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const data = await yres.json();
      return new Response(JSON.stringify(data), {
        headers: {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
          'cache-control': 'public, max-age=60',
        },
      });
    }
    return new Response('InvestIQ Pro Worker — alive', { status: 200 });
  },
};
