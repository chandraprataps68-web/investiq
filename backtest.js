// backtest.js — Daily prediction logging + next-day verification
//
// Storage: ephemeral JSON at /tmp/backtest.json (survives ~23h on Render).
// Format: { snapshots: [{ date, type, data }], verifications: {...} }
//
// Snapshot windows (IST):
//   Pre-market: 08:00 - 09:10 (after pre-market data is ready, before open)
//   Verification: 15:45 - 23:59 (after market close)
//
// Each "snapshot" captures:
//   - premarket: { bias, score, signals }
//   - scanner: { strongBuys: [{symbol, price, target, stop, confidence}], strongSells: [...] }
//   - strategy: { weekly: {longCall: verdict, ...}, monthly: {...} }
//
// Each "verification" (next trading day, 3:45 PM IST) records:
//   - niftyMove: actual % move
//   - biasCorrect: did predicted bias match actual?
//   - scannerHits: { strongBuy: [{symbol, predicted, actual, hit: bool}], strongSell: [...] }
//   - strategyVerdicts: which ENTER calls would've been profitable

const fs = require('fs');
const path = require('path');

const STORE_PATH = '/tmp/backtest.json';

function load() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('[backtest] load failed:', e.message);
  }
  return { snapshots: [], lastUpdate: null };
}

function save(state) {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2));
    return true;
  } catch (e) {
    console.error('[backtest] save failed:', e.message);
    return false;
  }
}

// Get IST date in YYYY-MM-DD format (IST = UTC+5:30)
function todayIST() {
  const now = new Date();
  const istMs = now.getTime() + (5.5 * 60 * 60 * 1000);
  return new Date(istMs).toISOString().slice(0, 10);
}

// Get current IST hour (0-23)
function nowISTHour() {
  const now = new Date();
  const istMs = now.getTime() + (5.5 * 60 * 60 * 1000);
  return new Date(istMs).getUTCHours();
}

// Find snapshot for a given date
function findSnapshot(state, date) {
  return state.snapshots.find(s => s.date === date);
}

// Determine if we should snapshot now (8:00-9:10 IST, weekday, not done yet)
function shouldSnapshot(state) {
  const date = todayIST();
  const dayOfWeek = new Date().getUTCDay(); // 0=Sun, 6=Sat
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  const hour = nowISTHour();
  if (hour < 8 || hour >= 10) return false; // 8 AM - 10 AM window
  const existing = findSnapshot(state, date);
  if (existing && existing.predictions) return false;
  return true;
}

// Determine if we should verify yesterday's snapshot (after 15:45 IST, weekday)
function shouldVerify(state) {
  const dayOfWeek = new Date().getUTCDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  const hour = nowISTHour();
  if (hour < 15) return false;
  // Find most recent snapshot that's not yet verified
  for (let i = state.snapshots.length - 1; i >= 0; i--) {
    const s = state.snapshots[i];
    if (s.predictions && !s.verification) return s.date;
  }
  return false;
}

// Take a prediction snapshot — gather pre-market, scanner, strategy data
async function takeSnapshot({ getPremarket, getScanner, getStrategyVerdicts }) {
  const state = load();
  const date = todayIST();

  let premarket, scanner, strategy;
  try { premarket = await getPremarket(); } catch (e) { console.error('[backtest] premarket fail:', e.message); }
  try { scanner = await getScanner(); } catch (e) { console.error('[backtest] scanner fail:', e.message); }
  try { strategy = await getStrategyVerdicts(); } catch (e) { console.error('[backtest] strategy fail:', e.message); }

  // Distill predictions to compact form (we don't need every detail, just the
  // bits we'll verify tomorrow).
  const predictions = {
    premarket: premarket ? {
      bias: premarket.bias?.label,
      score: premarket.bias?.score,
      signalCount: premarket.bias?.signals?.length || 0,
    } : null,
    scanner: scanner ? {
      strongBuys: (scanner.results || [])
        .filter(r => r.signal === 'STRONG BUY')
        .slice(0, 5)
        .map(r => ({ symbol: r.symbol, price: r.price, target: r.targets?.swing?.target, stop: r.targets?.swing?.stop, confidence: r.confidence })),
      strongSells: (scanner.results || [])
        .filter(r => r.signal === 'STRONG SELL')
        .slice(0, 5)
        .map(r => ({ symbol: r.symbol, price: r.price, target: r.targets?.swing?.target, stop: r.targets?.swing?.stop, confidence: r.confidence })),
    } : null,
    strategy: strategy ? {
      weekly: strategy.weekly,
      monthly: strategy.monthly,
    } : null,
    timestamp: new Date().toISOString(),
  };

  // Insert or update snapshot
  const existing = findSnapshot(state, date);
  if (existing) {
    existing.predictions = predictions;
  } else {
    state.snapshots.push({ date, predictions });
  }
  state.lastUpdate = new Date().toISOString();
  save(state);
  return predictions;
}

// Verify a snapshot from `date` against today's actuals
// fetchClose: function(symbol) → close price, percentage move
async function verifySnapshot(date, { fetchClose, getNiftyMove }) {
  const state = load();
  const snap = findSnapshot(state, date);
  if (!snap || !snap.predictions) return null;

  const niftyMove = await getNiftyMove().catch(() => null); // % change today

  const v = {
    niftyMove,
    biasCorrect: null,
    scannerHits: { strongBuy: [], strongSell: [] },
    strategyHits: { weekly: {}, monthly: {} },
  };

  // 1) Was the directional bias correct?
  if (snap.predictions.premarket && niftyMove != null) {
    const bias = snap.predictions.premarket.bias;
    if (bias === 'STRONG BULLISH' || bias === 'BULLISH') {
      v.biasCorrect = niftyMove > 0;
    } else if (bias === 'STRONG BEARISH' || bias === 'BEARISH') {
      v.biasCorrect = niftyMove < 0;
    } else {
      v.biasCorrect = Math.abs(niftyMove) < 0.5; // neutral = small move
    }
  }

  // 2) Scanner picks: did STRONG BUYs gain? Did STRONG SELLs fall?
  if (snap.predictions.scanner) {
    for (const pick of snap.predictions.scanner.strongBuys || []) {
      try {
        const r = await fetchClose(pick.symbol);
        if (r) {
          const move = ((r.close - pick.price) / pick.price) * 100;
          v.scannerHits.strongBuy.push({
            symbol: pick.symbol,
            predicted: pick.price,
            actual: r.close,
            move: parseFloat(move.toFixed(2)),
            hit: move > 0,
          });
        }
      } catch (_) {}
    }
    for (const pick of snap.predictions.scanner.strongSells || []) {
      try {
        const r = await fetchClose(pick.symbol);
        if (r) {
          const move = ((r.close - pick.price) / pick.price) * 100;
          v.scannerHits.strongSell.push({
            symbol: pick.symbol,
            predicted: pick.price,
            actual: r.close,
            move: parseFloat(move.toFixed(2)),
            hit: move < 0,
          });
        }
      } catch (_) {}
    }
  }

  // 3) Strategy verdicts: ENTER calls — did they directionally pay off?
  // (Approximate: ENTER on Long Call → would've paid if Nifty went up >0.3%)
  if (snap.predictions.strategy && niftyMove != null) {
    const checkVerdict = (verdict, name) => {
      if (verdict !== 'ENTER') return null; // only audit ENTER calls
      // Map strategy → expected outcome
      if (name === 'longCall') return niftyMove > 0.3; // need rally
      if (name === 'longPut') return niftyMove < -0.3; // need fall
      if (name === 'bullCallSpread') return niftyMove > 0.2;
      if (name === 'ironCondor') return Math.abs(niftyMove) < 0.5; // need flat
      if (name === 'longStraddle') return Math.abs(niftyMove) > 0.7; // need big move
      return null;
    };
    for (const tf of ['weekly', 'monthly']) {
      const tfData = snap.predictions.strategy[tf] || {};
      for (const name of Object.keys(tfData)) {
        const verdict = tfData[name]?.verdict;
        const hit = checkVerdict(verdict, name);
        if (hit !== null) {
          v.strategyHits[tf][name] = { verdict, hit };
        }
      }
    }
  }

  snap.verification = v;
  state.lastUpdate = new Date().toISOString();
  save(state);
  return v;
}

// Aggregate stats over all verified snapshots
function getStats() {
  const state = load();
  const verified = state.snapshots.filter(s => s.verification);

  const stats = {
    totalDays: state.snapshots.length,
    verifiedDays: verified.length,
    bias: { correct: 0, total: 0, hitRate: 0 },
    scanner: {
      strongBuy: { correct: 0, total: 0, hitRate: 0, avgMove: 0 },
      strongSell: { correct: 0, total: 0, hitRate: 0, avgMove: 0 },
    },
    strategy: { weekly: {}, monthly: {} },
    recentSnapshots: state.snapshots.slice(-10).reverse(),
  };

  for (const s of verified) {
    const v = s.verification;
    if (v.biasCorrect != null) {
      stats.bias.total += 1;
      if (v.biasCorrect) stats.bias.correct += 1;
    }
    for (const pick of v.scannerHits.strongBuy || []) {
      stats.scanner.strongBuy.total += 1;
      stats.scanner.strongBuy.avgMove += pick.move;
      if (pick.hit) stats.scanner.strongBuy.correct += 1;
    }
    for (const pick of v.scannerHits.strongSell || []) {
      stats.scanner.strongSell.total += 1;
      stats.scanner.strongSell.avgMove += pick.move;
      if (pick.hit) stats.scanner.strongSell.correct += 1;
    }
    for (const tf of ['weekly', 'monthly']) {
      const sh = v.strategyHits[tf] || {};
      for (const name of Object.keys(sh)) {
        if (!stats.strategy[tf][name]) {
          stats.strategy[tf][name] = { correct: 0, total: 0, hitRate: 0 };
        }
        stats.strategy[tf][name].total += 1;
        if (sh[name].hit) stats.strategy[tf][name].correct += 1;
      }
    }
  }

  // Compute hit rates
  if (stats.bias.total > 0) stats.bias.hitRate = stats.bias.correct / stats.bias.total;
  if (stats.scanner.strongBuy.total > 0) {
    stats.scanner.strongBuy.hitRate = stats.scanner.strongBuy.correct / stats.scanner.strongBuy.total;
    stats.scanner.strongBuy.avgMove = stats.scanner.strongBuy.avgMove / stats.scanner.strongBuy.total;
  }
  if (stats.scanner.strongSell.total > 0) {
    stats.scanner.strongSell.hitRate = stats.scanner.strongSell.correct / stats.scanner.strongSell.total;
    stats.scanner.strongSell.avgMove = stats.scanner.strongSell.avgMove / stats.scanner.strongSell.total;
  }
  for (const tf of ['weekly', 'monthly']) {
    for (const name of Object.keys(stats.strategy[tf])) {
      const x = stats.strategy[tf][name];
      x.hitRate = x.total > 0 ? x.correct / x.total : 0;
    }
  }

  return stats;
}

module.exports = {
  load, save, todayIST, nowISTHour,
  shouldSnapshot, shouldVerify,
  takeSnapshot, verifySnapshot,
  getStats,
};
