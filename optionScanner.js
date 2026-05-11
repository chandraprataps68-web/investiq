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
// Theta decay zones (calibrated for Indian F&O stock options):
//   - 0-7 DTE:    DANGER — extreme gamma whipsaw, never for swing
//   - 8-14 DTE:   AVOID — theta accelerates hard, not enough time for thesis
//   - 15-22 DTE:  THETA RISK — acceptable when nothing else available (typical
//                 NSE stock options reality: June monthly not yet listed in early May)
//   - 23-50 DTE:  OPTIMAL — moderate theta, time for thesis to play out
//   - 51+ DTE:    HEAVY VEGA — too much premium paid for vol, lower delta sensitivity
//
// Strategy:
//   1. If timeframe='weekly' AND confidence >= 90, allow 0-7 DTE for scalps
//   2. Strongly prefer OPTIMAL zone (23-50 DTE)
//   3. If OPTIMAL is empty, accept 15-22 DTE with a THETA_RISK tag (caller surfaces this)
//   4. Refuse if only 0-14 DTE or 50+ DTE available
//
// This avoids the previous "0 recommendations" failure when next monthly cycle
// isn't yet listed in Fyers' expiryData for stock options.
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

  // 1. Weekly scalp (very high conf only)
  if (timeframe === 'weekly' && confidence >= 90) {
    const weekly = future.find(e => e.daysOut <= 7);
    if (weekly) return { expiry: weekly.expiry, dte: weekly.daysOut, zone: 'WEEKLY_SCALP' };
  }

  // 2. OPTIMAL zone (23-50 DTE), prefer monthly
  const sweetMonthly = future.find(e =>
    e.expiry_flag === 'M' && e.daysOut >= 23 && e.daysOut <= 50
  );
  if (sweetMonthly) {
    return { expiry: sweetMonthly.expiry, dte: sweetMonthly.daysOut, zone: 'OPTIMAL' };
  }
  const sweetAny = future.find(e => e.daysOut >= 23 && e.daysOut <= 50);
  if (sweetAny) {
    return { expiry: sweetAny.expiry, dte: sweetAny.daysOut, zone: 'OPTIMAL' };
  }

  // 3. THETA RISK zone (15-22 DTE) — acceptable last resort
  // Common in early/mid month when next monthly isn't yet listed by NSE/Fyers
  // for stock options. Caller should display warning prominently.
  const thetaRiskMonthly = future.find(e =>
    e.expiry_flag === 'M' && e.daysOut >= 15 && e.daysOut < 23
  );
  if (thetaRiskMonthly) {
    return { expiry: thetaRiskMonthly.expiry, dte: thetaRiskMonthly.daysOut, zone: 'THETA_RISK' };
  }
  const thetaRiskAny = future.find(e => e.daysOut >= 15 && e.daysOut < 23);
  if (thetaRiskAny) {
    return { expiry: thetaRiskAny.expiry, dte: thetaRiskAny.daysOut, zone: 'THETA_RISK' };
  }

  // 4. Refuse — only 0-14 DTE (too risky) or 51+ DTE (too heavy in vega)
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

// Generate option recommendation for one stock signal.
// Returns either a recommendation object, OR { skip: <reason> } so the caller
// can aggregate WHY stocks were filtered out (data quality transparency).
async function recommendForStock(stockSignal, fyers) {
  if (stockSignal.signal !== 'STRONG BUY' && stockSignal.signal !== 'STRONG SELL') {
    return { skip: 'not_strong_signal' };
  }
  if (!stockSignal.price || !stockSignal.targets?.swing) {
    return { skip: 'missing_targets' };
  }

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
    return { skip: 'chain_fetch_failed' };
  }
  if (chainResp?.error || !chainResp?.data) return { skip: 'no_chain_data' };

  // Pick expiry with death-zone awareness
  const expiryChoice = pickExpiry(chainResp.data.expiryData || [], timeframe, confidence);
  if (!expiryChoice) return { skip: 'no_optimal_expiry' };

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
  if (analyzed.error) return { skip: 'analyze_failed' };

  const spot = analyzed.spot || stockSignal.price;
  if (!spot || spot <= 0) return { skip: 'no_spot' };

  // Pick strike
  const step = strikeStep(spot);
  const atmStrike = Math.round(spot / step) * step;
  const offsetDirection = isBullish ? 1 : -1;
  const targetStrike = atmStrike + (offsetDirection * strikeOffset * step);

  const opt = findClosestStrike(analyzed.chain || [], targetStrike, optionType);
  if (!opt) return { skip: 'strike_not_found' };
  if (!isTradeable(opt)) return { skip: 'illiquid_or_high_iv' };

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

  // Probability calculations (Phase 7)
  const T = expiryChoice.dte / 365;
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

  let qualityScore = null;
  if (pot != null && riskReward != null) {
    const ev = pot * riskReward - (1 - pot);
    qualityScore = Math.round(ev * 100);
  }

  return {
    symbol: stockSignal.symbol,
    side: 'BUY',
    optionType,
    strike: opt.strike_price,
    expiry: expiryChoice.expiry,
    expiryDays: parseFloat(expiryChoice.dte.toFixed(1)),
    expiryZone: expiryChoice.zone,
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
    pot: pot != null ? parseFloat((pot * 100).toFixed(1)) : null,
    pop: pop != null ? parseFloat((pop * 100).toFixed(1)) : null,
    qualityScore,
    stockSignal: stockSignal.signal,
    stockConfidence: stockSignal.confidence,
    stockConfidenceBreakdown: stockSignal.rationale || null,
    stockPrice: stockSignal.price,
    stockTarget,
    stockStop,
  };
}

// Main scan: takes equity scanner results, produces option recommendations.
// Returns { recommendations, dataQuality } where dataQuality tells the UI
// HOW MANY stocks were considered, returned, and WHY others were skipped.
async function scanOptions(scannerResults, fyers) {
  const filtered = (scannerResults || []).filter(r =>
    (r.signal === 'STRONG BUY' || r.signal === 'STRONG SELL') &&
    r.confidence >= 70
  );
  filtered.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  const top = filtered.slice(0, 30);

  const concurrency = 3;
  const recs = [];
  const skipCounts = {}; // reason → count
  for (let i = 0; i < top.length; i += concurrency) {
    const batch = top.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(s => recommendForStock(s, fyers))
    );
    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value) {
        skipCounts['error'] = (skipCounts['error'] || 0) + 1;
        continue;
      }
      if (r.value.skip) {
        skipCounts[r.value.skip] = (skipCounts[r.value.skip] || 0) + 1;
      } else {
        recs.push(r.value);
      }
    }
    if (i + concurrency < top.length) {
      await new Promise(res => setTimeout(res, 300));
    }
  }

  // Sort by qualityScore (EV-based)
  recs.sort((a, b) => {
    const qa = a.qualityScore ?? -999;
    const qb = b.qualityScore ?? -999;
    if (qa !== qb) return qb - qa;
    const pa = a.pot ?? 0;
    const pb = b.pot ?? 0;
    if (pa !== pb) return pb - pa;
    return (b.stockConfidence || 0) - (a.stockConfidence || 0);
  });

  return {
    recommendations: recs,
    dataQuality: {
      stockSignalsConsidered: top.length,
      strongBuyCount: filtered.filter(f => f.signal === 'STRONG BUY').length,
      strongSellCount: filtered.filter(f => f.signal === 'STRONG SELL').length,
      recommendationsReturned: recs.length,
      skipCounts,
    },
  };
}

module.exports = { scanOptions, recommendForStock };

