// optionScanner.js — Pick best CE/PE per stock with strong equity signal
//
// Logic:
//  - Filter equity scanner to STRONG BUY (CE candidates) + STRONG SELL (PE candidates)
//  - For each stock, pick:
//      * Side: BUY only (selling is risky for retail)
//      * Type: CE if STRONG BUY, PE if STRONG SELL
//      * Expiry: weekly if confidence ≥ 85, monthly if 70-84
//      * Strike: ATM if confidence ≥ 85, 1-strike OTM if 70-84
//  - Compute target/stop using delta-scaled stock targets
//  - Liquidity filter: skip if option OI < 100k or volume < 10k
//  - IV sanity filter: skip if IV > 60% (event-driven anomaly)

const { fetchOptionChain, analyzeOptionChain } = require('./fno');

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

// Pick expiry from chain.expiries based on timeframe choice.
function pickExpiry(expiries, timeframe) {
  const nowSec = Math.floor(Date.now() / 1000);
  if (timeframe === 'weekly') {
    const future = expiries.filter(e => parseInt(e.expiry, 10) > nowSec);
    return future[0]?.expiry || null;
  } else {
    const FOURTEEN_DAYS = 14 * 86400;
    const monthlies = expiries.filter(e =>
      e.expiry_flag === 'M' && parseInt(e.expiry, 10) > nowSec + FOURTEEN_DAYS
    );
    if (monthlies[0]) return monthlies[0].expiry;
    const anyM = expiries.find(e => e.expiry_flag === 'M' && parseInt(e.expiry, 10) > nowSec);
    return anyM?.expiry || null;
  }
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

  // Pick expiry based on timeframe
  const chosenExpiry = pickExpiry(chainResp.data.expiryData || [], timeframe);
  if (!chosenExpiry) return null;

  // Refetch at chosen expiry if different
  let rawData = chainResp.data;
  const defaultExpiry = chainResp.data.expiryData?.[0]?.expiry;
  if (chosenExpiry !== defaultExpiry) {
    try {
      const r = await fetchOptionChain(fyers, fyersSym, 30, chosenExpiry);
      if (r?.data) rawData = r.data;
    } catch (_) { /* fall back */ }
  }

  // Run through analyzeOptionChain to get spot + Greeks-enriched rows
  const analyzed = analyzeOptionChain(rawData, chosenExpiry);
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

  // For PE (bearish), the option gains when stock falls — flip delta sign for math
  const directionMul = isBullish ? 1 : -1;
  const optionTarget = Math.max(0.5, opt.ltp + delta * Math.abs(expectedTargetMove) * directionMul * Math.sign(expectedTargetMove));
  const optionStop = Math.max(0.5, opt.ltp + delta * Math.abs(expectedStopMove) * directionMul * Math.sign(expectedStopMove));

  // Simpler: just use the absolute move scaled by delta, with appropriate sign
  // (For long CE: target above entry, stop below. For long PE: target above entry too — option price rises as stock falls.)
  const grossMove = Math.abs(expectedTargetMove);
  const grossStopMove = Math.abs(expectedStopMove);
  const finalOptTarget = Math.max(0.5, opt.ltp + delta * grossMove);
  const finalOptStop = Math.max(0.5, opt.ltp - delta * grossStopMove);

  const upside = finalOptTarget - opt.ltp;
  const downside = opt.ltp - finalOptStop;
  const riskReward = downside > 0 ? upside / downside : null;

  return {
    symbol: stockSignal.symbol,
    side: 'BUY',
    optionType,
    strike: opt.strike_price,
    expiry: chosenExpiry,
    expiryDays: parseFloat(daysToExpiry(chosenExpiry).toFixed(1)),
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
    stockSignal: stockSignal.signal,
    stockConfidence: stockSignal.confidence,
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

  recs.sort((a, b) => (b.stockConfidence || 0) - (a.stockConfidence || 0));
  return recs;
}

module.exports = { scanOptions, recommendForStock };

