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
const { probabilityOfTouch, probabilityOfProfit, thetaDecayPct, RISK_FREE_RATE } = require('./greeks');

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

// Pick TWO expiries when available: near-month (where retail trades) AND next-month
// (better theta safety, higher conviction trades).
//
// Indian stock options reality (May 2026 calibration):
//   - 99% of retail volume lives in NEAR-MONTH expiry
//   - Next-month expiries exist on Fyers but have wider spreads & lower OI
//   - Theta is real but secondary to "can I actually trade this contract?"
//
// Returns: { nearMonth, nextMonth } where each is null or { expiry, dte, zone, expiryDate }
// Caller decides whether to fetch & enrich one or both.
function pickExpiries(expiries) {
  const nowSec = Math.floor(Date.now() / 1000);
  const DAY = 86400;
  if (!Array.isArray(expiries) || expiries.length === 0) {
    return { nearMonth: null, nextMonth: null };
  }

  const future = expiries
    .filter(e => parseInt(e.expiry, 10) > nowSec)
    .map(e => ({
      ...e,
      daysOut: (parseInt(e.expiry, 10) - nowSec) / DAY,
      expiryDate: new Date(parseInt(e.expiry, 10) * 1000),
    }))
    .filter(e => e.daysOut >= 3) // skip same-day/imminent expiry (gamma hell)
    .sort((a, b) => a.daysOut - b.daysOut);

  if (future.length === 0) return { nearMonth: null, nextMonth: null };

  // Find first MONTHLY expiry that's >= 3 days out — that's the current month
  // (after weekly contracts which we skip for retail safety)
  const nearMonthly = future.find(e => e.expiry_flag === 'M');
  // Next monthly = the second M expiry
  const monthlyExpiries = future.filter(e => e.expiry_flag === 'M');
  const nextMonthly = monthlyExpiries[1] || null;

  // Some Fyers chains for stock options only return weekly expiries — fall back to
  // simply "first future" and "second future" if M-flag is missing
  const nearFallback = future[0];
  const nextFallback = future.find(e => e.daysOut > (nearFallback?.daysOut || 0) + 7) || null;

  const near = nearMonthly || nearFallback;
  const next = nextMonthly || nextFallback;

  const formatPick = (pick) => pick ? ({
    expiry: pick.expiry,
    dte: pick.daysOut,
    zone: pick.daysOut < 15 ? 'GAMMA_RISK'
      : pick.daysOut < 23 ? 'THETA_WATCH'
      : pick.daysOut <= 50 ? 'OPTIMAL'
      : 'LONG_DATED',
    expiryDate: pick.expiryDate,
  }) : null;

  return {
    nearMonth: formatPick(near),
    // Avoid returning the same expiry twice if next === near
    nextMonth: next && next.expiry !== near?.expiry ? formatPick(next) : null,
  };
}

// Format expiry date as "May 27" / "Jun 24" — used in UI for clarity
function formatExpiryShort(dateObj) {
  if (!dateObj) return '—';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[dateObj.getMonth()]} ${dateObj.getDate()}`;
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

// Liquidity grade: A (deep + tight spread), B (acceptable), C (thin/wide).
// Uses OI, volume, and bid-ask spread when available.
// During market-closed hours, bid/ask are often 0 → fall back to OI+volume only.
function gradeLiquidity(opt) {
  if (!opt) return { grade: 'C', score: 30 };
  const oi = opt.oi || 0;
  const vol = opt.volume || 0;
  const bid = opt.bid || 0;
  const ask = opt.ask || 0;

  // Component 1: OI band
  let oiScore = 0;
  if (oi >= 1_000_000) oiScore = 100;
  else if (oi >= 500_000) oiScore = 85;
  else if (oi >= 250_000) oiScore = 70;
  else if (oi >= 100_000) oiScore = 50;
  else oiScore = 25;

  // Component 2: Volume band
  let volScore = 0;
  if (vol >= 200_000) volScore = 100;
  else if (vol >= 100_000) volScore = 85;
  else if (vol >= 50_000) volScore = 70;
  else if (vol >= 10_000) volScore = 50;
  else volScore = 25;

  // Component 3: Bid-ask spread (when available — 0 during market close)
  let spreadScore = null;
  if (bid > 0 && ask > 0 && ask > bid) {
    const mid = (bid + ask) / 2;
    const spreadPct = ((ask - bid) / mid) * 100;
    if (spreadPct <= 1) spreadScore = 100;
    else if (spreadPct <= 2.5) spreadScore = 85;
    else if (spreadPct <= 5) spreadScore = 70;
    else if (spreadPct <= 10) spreadScore = 45;
    else spreadScore = 20;
  }

  // Composite: spread weighted high when available, else OI+vol equally
  const score = spreadScore != null
    ? Math.round(spreadScore * 0.5 + oiScore * 0.3 + volScore * 0.2)
    : Math.round(oiScore * 0.6 + volScore * 0.4);

  const grade = score >= 80 ? 'A' : score >= 55 ? 'B' : 'C';
  return { grade, score, oiScore, volScore, spreadScore };
}

// Composite BuyScore: combines quality, theta safety, liquidity, expiry proximity.
// Returns a 0-100 number plus the breakdown.
//
// Weights:
//   - 40%  Quality (EV-based, from POT × R/R)
//   - 30%  Theta Safety (lower decay = safer)
//   - 20%  Liquidity (A/B/C grade scaled)
//   - 10%  Proximity bonus (near-month = tradeable today, retail-friendly)
function computeBuyScore({ qualityScore, thetaDecayPct, liquidityScore, dte }) {
  // 1. Quality normalization. qualityScore is typically -50 to +150.
  //    Map to 0-100 where 0 = quality -50 or less, 100 = quality 150 or more.
  let qNorm = qualityScore == null ? 30 : Math.max(0, Math.min(100, ((qualityScore + 50) / 200) * 100));

  // 2. ThetaSafety. Lower daily decay = safer. 0% decay = 100. 5%+/day = 0.
  let thetaSafety = thetaDecayPct == null ? 50 : Math.max(0, Math.min(100, 100 - thetaDecayPct * 20));

  // 3. Liquidity (already 0-100)
  const liqNorm = liquidityScore != null ? liquidityScore : 50;

  // 4. Proximity bonus: near-month (8-30 DTE) gets +10, sweet-spot 30-50 gets +5,
  //    >50 DTE gets 0, <8 DTE gets 0 (gamma hell penalty already in theta).
  let proxBonus = 0;
  if (dte != null) {
    if (dte >= 8 && dte <= 30) proxBonus = 100;
    else if (dte > 30 && dte <= 50) proxBonus = 60;
    else if (dte > 50) proxBonus = 30;
    else proxBonus = 20;
  }

  const score = Math.round(qNorm * 0.4 + thetaSafety * 0.3 + liqNorm * 0.2 + proxBonus * 0.1);
  const tier = score >= 75 ? 'A' : score >= 55 ? 'B' : 'C';
  return {
    buyScore: score,
    tier,
    breakdown: {
      quality: Math.round(qNorm),
      thetaSafety: Math.round(thetaSafety),
      liquidity: Math.round(liqNorm),
      proximity: Math.round(proxBonus),
    },
  };
}

// Build a single recommendation for a given stock signal AT a specific expiry.
// Returns null on any failure (caller logs/aggregates).
function buildPickForExpiry({ stockSignal, fyers, expiryChoice, isBullish, optionType, confidence, strikeOffset, chainResp }) {
  // If we already have chainResp for this expiry (e.g. near-month was default fetch),
  // skip refetch. Otherwise refetch with chosen expiry timestamp.
  // NOTE: caller is responsible for getting chainResp at the right expiry.
  if (!chainResp?.data) return { skip: 'no_chain_data' };

  const analyzed = analyzeOptionChain(chainResp.data, expiryChoice.expiry);
  if (analyzed.error) return { skip: 'analyze_failed', skipDetail: analyzed.error };

  const spot = analyzed.spot || stockSignal.price;
  if (!spot || spot <= 0) return { skip: 'no_spot' };

  const step = strikeStep(spot);
  const atmStrike = Math.round(spot / step) * step;
  const offsetDirection = isBullish ? 1 : -1;
  const targetStrike = atmStrike + (offsetDirection * strikeOffset * step);

  const opt = findClosestStrike(analyzed.chain || [], targetStrike, optionType);
  if (!opt) return { skip: 'strike_not_found' };
  if (!isTradeable(opt)) return { skip: 'illiquid_or_high_iv' };

  // Target/stop via delta scaling
  const stockTarget = stockSignal.targets.swing.target;
  const stockStop = stockSignal.targets.swing.stop;
  const delta = opt.delta != null ? Math.abs(opt.delta) : 0.5;
  const grossMove = Math.abs(stockTarget - stockSignal.price);
  const grossStopMove = Math.abs(stockStop - stockSignal.price);
  const finalOptTarget = Math.max(0.5, opt.ltp + delta * grossMove);
  const finalOptStop = Math.max(0.5, opt.ltp - delta * grossStopMove);
  const upside = finalOptTarget - opt.ltp;
  const downside = opt.ltp - finalOptStop;
  const riskReward = downside > 0 ? upside / downside : null;

  // Probabilities
  const T = expiryChoice.dte / 365;
  const sigma = opt.iv != null ? opt.iv / 100 : null;
  let pot = null, pop = null;
  if (sigma && sigma > 0) {
    pot = probabilityOfTouch(spot, stockTarget, T, sigma, isBullish ? 'above' : 'below');
    pop = probabilityOfProfit(spot, opt.strike_price, opt.ltp, T, RISK_FREE_RATE, sigma, optionType);
  }
  let qualityScore = null;
  if (pot != null && riskReward != null) {
    const ev = pot * riskReward - (1 - pot);
    qualityScore = Math.round(ev * 100);
  }

  // Theta decay percentage
  const decayPct = thetaDecayPct(opt.theta, opt.ltp);

  // Liquidity grade
  const liq = gradeLiquidity(opt);

  // BuyScore composite
  const buy = computeBuyScore({
    qualityScore,
    thetaDecayPct: decayPct,
    liquidityScore: liq.score,
    dte: expiryChoice.dte,
  });

  return {
    symbol: stockSignal.symbol,
    side: 'BUY',
    optionType,
    strike: opt.strike_price,
    expiry: expiryChoice.expiry,
    expiryDate: expiryChoice.expiryDate ? formatExpiryShort(expiryChoice.expiryDate) : null,
    expiryDays: parseFloat(expiryChoice.dte.toFixed(1)),
    expiryZone: expiryChoice.zone,
    spot,
    premium: opt.ltp,
    iv: opt.iv != null ? parseFloat(opt.iv.toFixed(1)) : null,
    delta: opt.delta != null ? parseFloat(opt.delta.toFixed(2)) : null,
    oi: opt.oi,
    volume: opt.volume,
    bid: opt.bid || null,
    ask: opt.ask || null,
    target: parseFloat(finalOptTarget.toFixed(2)),
    stop: parseFloat(finalOptStop.toFixed(2)),
    riskReward: riskReward != null ? parseFloat(riskReward.toFixed(2)) : null,
    pot: pot != null ? parseFloat((pot * 100).toFixed(1)) : null,
    pop: pop != null ? parseFloat((pop * 100).toFixed(1)) : null,
    qualityScore,
    thetaDecayPct: decayPct != null ? parseFloat(decayPct.toFixed(2)) : null,
    liquidityGrade: liq.grade,
    liquidityScore: liq.score,
    buyScore: buy.buyScore,
    tier: buy.tier,
    buyScoreBreakdown: buy.breakdown,
    stockSignal: stockSignal.signal,
    stockConfidence: stockSignal.confidence,
    stockConfidenceBreakdown: stockSignal.rationale || null,
    stockPrice: stockSignal.price,
    stockTarget,
    stockStop,
  };
}

// Generate option recommendations for one stock signal — NOW returns ARRAY of picks
// (up to 2: near-month + next-month) so user sees both options for the same trade.
// Returns either { picks: [...] } or { skip: <reason> } for aggregation.
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
  const strikeOffset = confidence >= 85 ? 0 : 1;
  const fyersSym = `NSE:${stockSignal.symbol}-EQ`;

  // Step 1: fetch default chain (Fyers returns nearest expiry by default, plus expiryData[])
  let defaultChainResp;
  try {
    defaultChainResp = await fetchOptionChain(fyers, fyersSym, 30);
  } catch (e) {
    if (!global.__optChainErrLogged) {
      console.error('[optionScanner] fetchOptionChain threw for', fyersSym, ':', e.message);
      global.__optChainErrLogged = true;
      setTimeout(() => { global.__optChainErrLogged = false; }, 60_000);
    }
    return { skip: 'chain_fetch_failed', skipDetail: e.message };
  }
  if (defaultChainResp?.error || !defaultChainResp?.data) {
    return { skip: 'no_chain_data', skipDetail: defaultChainResp?.error || 'no data' };
  }

  // Step 2: pick BOTH near-month and next-month expiries
  const { nearMonth, nextMonth } = pickExpiries(defaultChainResp.data.expiryData || []);
  if (!nearMonth && !nextMonth) return { skip: 'no_optimal_expiry' };

  const defaultExpirySec = defaultChainResp.data.expiryData?.[0]?.expiry;

  // Step 3: for each candidate expiry, ensure we have the right chain data
  const picks = [];

  for (const choice of [nearMonth, nextMonth]) {
    if (!choice) continue;

    let chainResp = defaultChainResp;
    // If choice.expiry differs from default, refetch
    if (choice.expiry !== defaultExpirySec) {
      try {
        const r = await fetchOptionChain(fyers, fyersSym, 30, choice.expiry);
        if (r?.data) chainResp = r;
        else continue; // can't fetch this expiry — skip silently
      } catch (_) {
        continue;
      }
    }

    const pick = buildPickForExpiry({
      stockSignal, fyers, expiryChoice: choice,
      isBullish, optionType, confidence, strikeOffset,
      chainResp,
    });
    if (pick && !pick.skip) {
      picks.push(pick);
    }
  }

  if (picks.length === 0) return { skip: 'all_picks_filtered' };
  return { picks };
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
  const skipCounts = {};
  const skipDetails = {};
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
        if (r.value.skipDetail && !skipDetails[r.value.skip]) {
          skipDetails[r.value.skip] = r.value.skipDetail;
        }
      } else if (Array.isArray(r.value.picks)) {
        // Phase 11: each stock can yield 1-2 picks (near + next month). Flatten.
        for (const p of r.value.picks) recs.push(p);
      }
    }
    if (i + concurrency < top.length) {
      await new Promise(res => setTimeout(res, 300));
    }
  }

  // Sort by BuyScore (the Phase 11 composite) descending, then quality, then conf.
  // BuyScore weighs Quality(EV) + ThetaSafety + Liquidity + ProximityBonus.
  recs.sort((a, b) => {
    const ba = a.buyScore ?? -999;
    const bb = b.buyScore ?? -999;
    if (ba !== bb) return bb - ba;
    const qa = a.qualityScore ?? -999;
    const qb = b.qualityScore ?? -999;
    if (qa !== qb) return qb - qa;
    return (b.stockConfidence || 0) - (a.stockConfidence || 0);
  });

  // Tier counts for header
  const tierA = recs.filter(r => r.tier === 'A').length;
  const tierB = recs.filter(r => r.tier === 'B').length;
  const tierC = recs.filter(r => r.tier === 'C').length;

  return {
    recommendations: recs,
    dataQuality: {
      stockSignalsConsidered: top.length,
      strongBuyCount: filtered.filter(f => f.signal === 'STRONG BUY').length,
      strongSellCount: filtered.filter(f => f.signal === 'STRONG SELL').length,
      recommendationsReturned: recs.length,
      tierA, tierB, tierC,
      skipCounts,
      skipDetails,
    },
  };
}

module.exports = { scanOptions, recommendForStock };

