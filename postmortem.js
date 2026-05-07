// postmortem.js — Tier 2 self-learning: analyze why a prediction was right or wrong
//
// Given a verified snapshot (predictions + verification), generate structured
// reasons explaining the outcome. Surfaces patterns over time so the user
// can see WHY the tool missed.
//
// Categories of "why a prediction missed":
//   1. Stale data — input signals weren't fresh
//   2. Missing data — key inputs unavailable (GIFT Nifty blank, etc.)
//   3. News catalyst — overnight news shifted regime after snapshot time
//   4. Signal disagreement — signals were genuinely mixed; model called it
//      wrong but was forced to pick a side
//   5. Regime shift — historical correlation broke (e.g. Hang Seng usually
//      correlates +0.6 with Nifty; today it didn't)
//   6. Magnitude error — direction right but magnitude wildly off
//
// We build the analysis from data we already have, no LLM/external API needed.

function analyzeSnapshot(snapshot) {
  if (!snapshot?.predictions || !snapshot?.verification) return null;
  const p = snapshot.predictions;
  const v = snapshot.verification;
  const reasons = [];
  const evidence = []; // { type, ok, detail } — for surfacing supporting facts

  // ─── 1. Was prediction directionally correct? ───────────────
  const predictedBias = p.premarket?.bias;
  const niftyMove = v.niftyMove;
  let directionCorrect = null;
  if (predictedBias && niftyMove != null) {
    if (predictedBias === 'STRONG BULLISH' || predictedBias === 'BULLISH') {
      directionCorrect = niftyMove > 0;
    } else if (predictedBias === 'STRONG BEARISH' || predictedBias === 'BEARISH') {
      directionCorrect = niftyMove < 0;
    } else {
      // NEUTRAL: correct if move was small (<0.5%)
      directionCorrect = Math.abs(niftyMove) < 0.5;
    }
  }

  // ─── 2. Did we have stale/missing data? ─────────────────────
  if (p.errors && p.errors.length > 0) {
    for (const err of p.errors) {
      reasons.push({
        category: 'missing_data',
        severity: 'high',
        text: `Data fetch failed: ${err}`,
      });
    }
  }

  // Detect if pre-market score was unusually low (likely missing signals)
  const score = p.premarket?.score;
  const sigCount = p.premarket?.signalCount;
  if (sigCount != null && sigCount < 4) {
    reasons.push({
      category: 'missing_data',
      severity: 'medium',
      text: `Only ${sigCount} signals contributed to bias score (expected 6+). Some inputs were unavailable.`,
    });
  }

  // ─── 3. Was there a NEUTRAL prediction with a directional outcome? ──
  // (This is exactly what happened today — NEUTRAL +0 but Nifty +1.24%)
  if (predictedBias === 'NEUTRAL' && Math.abs(niftyMove || 0) > 1.0) {
    reasons.push({
      category: 'underprediction',
      severity: 'high',
      text: `Predicted NEUTRAL but market moved ${niftyMove > 0 ? '+' : ''}${niftyMove?.toFixed(2)}% — likely missed a catalyst (overnight news, earnings, policy).`,
    });
  }

  // ─── 4. Was there a STRONG bias that turned out flat? ───────
  if ((predictedBias === 'STRONG BULLISH' || predictedBias === 'STRONG BEARISH') &&
      Math.abs(niftyMove || 0) < 0.3) {
    reasons.push({
      category: 'overprediction',
      severity: 'medium',
      text: `Predicted ${predictedBias} (score ${score}) but market was essentially flat (${niftyMove?.toFixed(2)}%). Score signals may be auto-correlated.`,
    });
  }

  // ─── 5. Direction-flipped predictions ──────────────────────
  if (directionCorrect === false &&
      (predictedBias === 'STRONG BULLISH' || predictedBias === 'STRONG BEARISH')) {
    reasons.push({
      category: 'direction_flip',
      severity: 'high',
      text: `Predicted ${predictedBias} but market moved opposite direction. Likely cause: news catalyst broke after snapshot, or a signal was directionally wrong.`,
    });
  }

  // ─── 6. Scanner pick analysis ────────────────────────────
  const sb = v.scannerHits?.strongBuy || [];
  const ss = v.scannerHits?.strongSell || [];
  const sbHits = sb.filter(p => p.hit).length;
  const ssHits = ss.filter(p => p.hit).length;
  if (sb.length > 0) {
    const rate = sbHits / sb.length;
    if (rate < 0.4 && niftyMove > 0) {
      reasons.push({
        category: 'scanner_miss',
        severity: 'medium',
        text: `STRONG BUY picks underperformed: ${sbHits}/${sb.length} hit despite Nifty up. Sector mismatch likely (e.g. picked oil names on a day oil fell).`,
      });
    }
    evidence.push({ type: 'scanner_buy_hitrate', value: rate, detail: `${sbHits}/${sb.length}` });
  }
  if (ss.length > 0) {
    const rate = ssHits / ss.length;
    evidence.push({ type: 'scanner_sell_hitrate', value: rate, detail: `${ssHits}/${ss.length}` });
  }

  // ─── 7. Magnitude vs direction ────────────────────────────
  if (directionCorrect === true && Math.abs(niftyMove || 0) > 1.5 &&
      (predictedBias === 'BULLISH' || predictedBias === 'BEARISH')) {
    reasons.push({
      category: 'magnitude_underprediction',
      severity: 'low',
      text: `Direction correct, but called ${predictedBias} for a ${Math.abs(niftyMove).toFixed(2)}% move. Could have been STRONG ${predictedBias.toUpperCase()} if more signals were aligned.`,
    });
  }

  // ─── If no reasons but prediction was wrong, fall back ──────
  if (directionCorrect === false && reasons.length === 0) {
    reasons.push({
      category: 'unexplained',
      severity: 'medium',
      text: `Predicted ${predictedBias}, market moved ${niftyMove?.toFixed(2)}%. No specific signal failure detected — likely an overnight news catalyst.`,
    });
  }

  // ─── Build summary ────────────────────────────────────────
  let verdict;
  if (directionCorrect === true) verdict = 'CORRECT';
  else if (directionCorrect === false) verdict = 'WRONG';
  else verdict = 'UNVERIFIED';

  return {
    date: snapshot.date,
    predictedBias,
    score,
    niftyMove,
    directionCorrect,
    verdict,
    reasons,
    evidence,
  };
}

// Aggregate post-mortem patterns over the last N analyzed days
// to surface RECURRING issues. (E.g. "FII/DII data has been stale 3 of last 5 days.")
function findPatterns(analyses) {
  const patterns = [];
  if (!analyses || analyses.length < 3) {
    return [{ text: 'Need at least 3 verified days to detect patterns.', severity: 'info' }];
  }

  // Count category occurrences
  const catCount = {};
  for (const a of analyses) {
    for (const r of a.reasons || []) {
      catCount[r.category] = (catCount[r.category] || 0) + 1;
    }
  }

  // Pattern: missing data more than 30% of the time
  if (catCount.missing_data && catCount.missing_data >= analyses.length * 0.3) {
    patterns.push({
      text: `Missing data flagged on ${catCount.missing_data}/${analyses.length} days. Pre-market data sources need investigation (FII/DII, GIFT Nifty, Brent).`,
      severity: 'high',
      category: 'data_quality',
    });
  }

  // Pattern: NEUTRAL predictions on volatile days (under-prediction)
  if (catCount.underprediction && catCount.underprediction >= 2) {
    patterns.push({
      text: `Predicted NEUTRAL on ${catCount.underprediction} days where market moved >1%. Bias scoring may be too conservative — consider raising NEUTRAL threshold or adding catalyst detection.`,
      severity: 'medium',
      category: 'model_calibration',
    });
  }

  // Pattern: STRONG predictions that flatten
  if (catCount.overprediction && catCount.overprediction >= 2) {
    patterns.push({
      text: `Predicted STRONG bias on ${catCount.overprediction} days where market was flat. Signals may be over-weighted.`,
      severity: 'medium',
      category: 'model_calibration',
    });
  }

  // Pattern: direction flips
  if (catCount.direction_flip && catCount.direction_flip >= 2) {
    patterns.push({
      text: `Direction flipped on ${catCount.direction_flip} days. Suggest checking news feed during pre-market window.`,
      severity: 'high',
      category: 'news_blindspot',
    });
  }

  if (patterns.length === 0) {
    patterns.push({
      text: 'No recurring issues detected over verified days.',
      severity: 'info',
    });
  }

  return patterns;
}

// Run analysis on all verified snapshots in state
function runAnalysis(state) {
  const verified = (state.snapshots || []).filter(s => s.verification);
  const analyses = verified.map(analyzeSnapshot).filter(Boolean);
  const patterns = findPatterns(analyses);
  return { analyses: analyses.reverse(), patterns }; // most recent first
}

module.exports = { analyzeSnapshot, findPatterns, runAnalysis };
