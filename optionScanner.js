// optionScanner.js — Pick best CE/PE per stock with strong equity signal
//
// Logic:
//  - Filter equity scanner to STRONG BUY (CE candidates) + STRONG SELL (PE candidates)
//  - For each stock, pick:
//      * Side: BUY only (selling is risky for retail)
//      * Type: CE if STRONG BUY, PE if STRONG SELL
//      * Expiry: smartly avoid 8-22 DTE death zone (theta accelerates, gamma whipsaw)
//                Prefer 28-50 DTE for swing, weekly only if conf ≥ 85
//      * Strike: ATM if confidence ≥ 85, 1-strike OTM if 70-84
//  - Compute target/stop using delta-scaled stock targets
//  - Compute Probability of Touch (POT) and Probability of Profit (POP)
//  - Liquidity filter: skip if option OI < 100k or volume < 10k
//  - IV sanity filter: skip if IV > 60% (event-driven anomaly)
//  - Re-rank by POT-adjusted score (not just stock confidence)

const { fetchOptionChain, analyzeOptionChain } = require('./fno');
const { probabilityOfTouch, probabilityOfProfit, RISK_FREE_RATE } = require('./greeks');

// Indian stock options use 0.5/1/2.5/5/10/25/50/100 step sizes depending on price.
function strikeStep(price) {
  if (price < 50) return 1;
  if (price < 200) return 2.5;
  if (price < 500) return 5;
  if (price < 1500) return 10;
  if (price < 3000) return 25;
  if (price < 8000) return 50;
  return 100;
}

// Pick expiry from chain.expiries with awareness of theta decay zones.
//
// Theta decay accelerates non-linearly:
//   - 0-7 DTE:   highest theta, gamma whipsaw — good for scalps if conf is very high
//   - 8-22 DTE:  THE DEATH ZONE — theta eats premium fast, not enough time for swing move
//   - 23-50 DTE: SWEET SPOT — moderate theta, time for thesis to play out
//   - 50+ DTE:   too much premium paid for vol, lower delta sensitivity
//
// Strategy: prefer 28-50 DTE. Only use weekly (<=7 DTE) if confidence ≥ 90.
function pickExpiry(expiries, timeframe, confidence) {
  const nowSec = Math.floor(Date.now() / 1000);
  const DAY = 86400;
  if (!Array.isArray(expiries) || expiries.length === 0) return null;

  const future = expiries
    .filter(e => parseInt(e.expiry, 10) > nowSec)
    .map(e => ({
      ...e,
      daysOut: (parseInt(e.expiry, 10) - nowSec) / DAY,
    }))
    .sort((a, b) => a.daysOut - b.daysOut);

  if (future.length === 0) return null;

  // If user asked for weekly AND confidence is very high, allow nearest expiry
  if (timeframe === 'weekly' && confidence >= 90) {
    const weekly = future.find(e => e.daysOut <= 7);
    if (weekly) return { expiry: weekly.expiry, dte: weekly.daysOut, zone: 'WEEKLY_SCALP' };
  }

  // Find expiry in sweet spot (23-50 DTE), preferring monthly
  const sweetSpot = future.find(e =>
    e.expiry_flag === 'M' && e.daysOut >= 23 && e.daysOut <= 50
  );
  if (sweetSpot) {
    return { expiry: sweetSpot.expiry, dte: sweetSpot.daysOut, zone: 'OPTIMAL' };
  }

  // No monthly in sweet spot — relax to any expiry in 23-50 DTE range
  const anyInZone = future.find(e => e.daysOut >= 23 && e.daysOut <= 50);
  if (anyInZone) {
    return { expiry: anyInZone.expiry, dte: anyInZone.daysOut, zone: 'OPTIMAL' };
  }

  // Nothing in sweet spot — find the nearest monthly past 22 DTE (next monthly cycle)
  const nextCycle = future.find(e => e.expiry_flag === 'M' && e.daysOut > 22);
  if (nextCycle) {
    return { expiry: nextCycle.expiry, dte: nextCycle.daysOut, zone: 'OPTIMAL' };
  }

  // FALLBACK: if all available expiries are in death zone or beyond, refuse.
  // Caller should skip this stock (no good expiry available).
  return null;
}

function daysToExpiry(expirySec) {
  const nowSec = Math.floor(Date.now() / 1000);
  return Math.max(0, (parseInt(expirySec, 10) - nowSec) / 86400);
}

// Find closest available strike of given type
function findClosestStrike(chain, targetStrike, optionType) {
  const candidates = chain.filter(r => r.option_type === optionType);
  if (candidates.length === 0) return null;
  let best = null, bestDist = Infinity;
  for (const c of candidates) {
    const d = Math.abs(c.strike_price - targetStrike);
    if (d < bestDist) { bestDist = d; best = c; }
  }
  return best;
}

// Liquidity + sanity filter
function isTradeable(opt) {
  if (!opt) return false;
  if (!opt.ltp || opt.ltp < 0.5) return false; // worthless option
  if (opt.oi == null || opt.oi < 100000) return false; // illiquid
  if (opt.volume != null && opt.volume < 10000) return false;
  if (opt.iv != null && opt.iv > 60) return false; // unreliable IV
  return true;
}

// Generate option recommendation for one stock signal
async function recommendForStock(stockSignal, fyers) {
  if (stockSignal.signal !== 'STRONG BUY' && stockSignal.signal !== 'STRONG SELL') return null;
  if (!stockSignal.price || !stockSignal.targets?.swing) return null;

  const isBullish = stockSignal.signal === 'STRONG BUY';
  const optionType = isBullish ? 'CE' : 'PE';
  const confidence = stockSignal.confidence || 0;
  const timeframe = confidence >= 85 ? 'weekly' : 'monthly';
  const strikeOffset = confidence >= 85 ? 0 : 1;
  const fyersSym = `NSE:${stockSignal.symbol}-EQ`;

  // Initial chain fetch (default expiry)
  let chainResp;
  try {
    chainResp = await fetchOptionChain(fyers, fyersSym, 30);
  } catch (e) {
    return null;
  }
  if (chainResp?.error || !chainResp?.data) return null;

  // Pick expiry with death-zone awareness
  const expiryChoice = pickExpiry(chainResp.data.expiryData || [], timeframe, confidence);
  if (!expiryChoice) return null; // no good expiry available

  // Refetch at chosen expiry if different from default
  let rawData = chainResp.data;
  const defaultExpiry = chainResp.data.expiryData?.[0]?.expiry;
  if (expiryChoice.expiry !== defaultExpiry) {
    try {
      const r = await fetchOptionChain(fyers, fyersSym, 30, expiryChoice.expiry);
      if (r?.data) rawData = r.data;
    } catch (_) { /* fall back */ }
  }

  // Run through analyzeOptionChain to get spot + Greeks-enriched rows
  const analyzed = analyzeOptionChain(rawData, expiryChoice.expiry);
  if (analyzed.error) return null;

  const spot = analyzed.spot || stockSignal.price;
  if (!spot || spot <= 0) return null;

  // Pick strike
  const step = strikeStep(spot);
  const atmStrike = Math.round(spot / step) * step;
  const offsetDirection = isBullish ? 1 : -1;
  const targetStrike = atmStrike + (offsetDirection * strikeOffset * step);

  const opt = findClosestStrike(analyzed.chain || [], targetStrike, optionType);
  if (!opt || !isTradeable(opt)) return null;

  // Compute target/stop on option premium via delta scaling
  const stockTarget = stockSignal.targets.swing.target;
  const stockStop = stockSignal.targets.swing.stop;
  const delta = opt.delta != null ? Math.abs(opt.delta) : 0.5;
  const expectedTargetMove = stockTarget - stockSignal.price;
  const expectedStopMove = stockStop - stockSignal.price;

  const grossMove = Math.abs(expectedTargetMove);
  const grossStopMove = Math.abs(expectedStopMove);
  const finalOptTarget = Math.max(0.5, opt.ltp + delta * grossMove);
  const finalOptStop = Math.max(0.5, opt.ltp - delta * grossStopMove);

  const upside = finalOptTarget - opt.ltp;
  const downside = opt.ltp - finalOptStop;
  const riskReward = downside > 0 ? upside / downside : null;

  // ─── Probability calculations (the big Phase 7 addition) ──────
  // POT = probability spot touches stock-target before option expiry
  // POP = probability option expires ITM by > premium paid
  // These reveal the REAL trade quality regardless of confidence inheritance.
  const T = expiryChoice.dte / 365; // years to expiry
  const sigma = opt.iv != null ? opt.iv / 100 : null;
  let pot = null, pop = null;
  if (sigma && sigma > 0) {
    pot = probabilityOfTouch(
      spot, stockTarget, T, sigma,
      isBullish ? 'above' : 'below'
    );
    pop = probabilityOfProfit(
      spot, opt.strike_price, opt.ltp, T, RISK_FREE_RATE, sigma, optionType
    );
  }

  // Quality score: combine POT with R/R for ranking.
  // Expected value-ish: P(touch) × reward - (1-P) × risk, normalized.
  // We use POT not POP because POT matches how we'd actually exit (at target).
  let qualityScore = null;
  if (pot != null && riskReward != null) {
    const ev = pot * riskReward - (1 - pot); // expected R per 1R risked
    qualityScore = Math.round(ev * 100); // scale to centi-R
  }

  return {
    symbol: stockSignal.symbol,
    side: 'BUY',
    optionType,
    strike: opt.strike_price,
    expiry: expiryChoice.expiry,
    expiryDays: parseFloat(expiryChoice.dte.toFixed(1)),
    expiryZone: expiryChoice.zone, // 'WEEKLY_SCALP' or 'OPTIMAL'
    timeframe,
    spot,
    premium: opt.ltp,
    iv: opt.iv != null ? parseFloat(opt.iv.toFixed(1)) : null,
    delta: opt.delta != null ? parseFloat(opt.delta.toFixed(2)) : null,
    oi: opt.oi,
    volume: opt.volume,
    target: parseFloat(finalOptTarget.toFixed(2)),
    stop: parseFloat(finalOptStop.toFixed(2)),
    riskReward: riskReward != null ? parseFloat(riskReward.toFixed(2)) : null,
    pot: pot != null ? parseFloat((pot * 100).toFixed(1)) : null,    // %
    pop: pop != null ? parseFloat((pop * 100).toFixed(1)) : null,    // %
    qualityScore,                                                     // centi-R EV
    stockSignal: stockSignal.signal,
    stockConfidence: stockSignal.confidence,
    stockConfidenceBreakdown: stockSignal.rationale || null, // pass through bull/bear reasons
    stockPrice: stockSignal.price,
    stockTarget,
    stockStop,
  };
}

// Main scan: takes equity scanner results, produces option recommendations
async function scanOptions(scannerResults, fyers) {
  const filtered = (scannerResults || []).filter(r =>
    (r.signal === 'STRONG BUY' || r.signal === 'STRONG SELL') &&
    r.confidence >= 70
  );
  // Limit to top 30 to keep latency reasonable on free tier
  filtered.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  const top = filtered.slice(0, 30);

  const concurrency = 3;
  const recs = [];
  for (let i = 0; i < top.length; i += concurrency) {
    const batch = top.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(s => recommendForStock(s, fyers))
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) recs.push(r.value);
    }
    if (i + concurrency < top.length) {
      await new Promise(res => setTimeout(res, 300));
    }
  }

  // Sort by qualityScore (EV-based) descending, then by POT, then by stock confidence.
  // This is the BIG Phase 7 change: we rank by expected value, not by upstream
  // confidence which has no calibration. Recommendations without POP/POT
  // (e.g. when IV was missing) fall to the bottom but aren't dropped.
  recs.sort((a, b) => {
    const qa = a.qualityScore ?? -999;
    const qb = b.qualityScore ?? -999;
    if (qa !== qb) return qb - qa;
    const pa = a.pot ?? 0;
    const pb = b.pot ?? 0;
    if (pa !== pb) return pb - pa;
    return (b.stockConfidence || 0) - (a.stockConfidence || 0);
  });
  return recs;
}

module.exports = { scanOptions, recommendForStock };

