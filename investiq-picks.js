/* =====================================================================
   InvestIQ Pro v6 — Pick Enrichment Module
   Adds: (1) investment/capital buckets, (2) HONEST confidence colours,
         (3) auto-log selection for the tracker.

   IMPORTANT HONESTY NOTE (read before using the colours):
   BuyScore/Tier measure trade HYGIENE (liquidity, theta safety, proximity,
   quality) — NOT the probability the trade profits. Your own 75-row tracker
   study showed Tier A and Tier B do NOT separate on forward return. So the
   colours below are labelled as SETUP CLEANLINESS, never as "will profit".
   Green = cleanest setup that passed all gates. It is not a buy promise.
   ===================================================================== */

// ---- (1) INVESTMENT BUCKETS -----------------------------------------
// Tags each pick with the capital band it falls into (its own cost),
// AND gives an "affordable within budget B" filter for the "I have ₹X,
// what can I trade?" question.

function capitalBucket(capital) {
  if (capital == null || isNaN(capital)) return { key: 'na', label: 'Capital N/A' };
  if (capital <= 5000)  return { key: '5k',   label: '≤ ₹5K' };
  if (capital <= 10000) return { key: '10k',  label: '₹5K–₹10K' };
  if (capital <= 15000) return { key: '15k',  label: '₹10K–₹15K' };
  if (capital <= 20000) return { key: '20k',  label: '₹15K–₹20K' };
  return { key: '20k+', label: '₹20K+' };
}

// budget in rupees (5000/10000/15000/20000) or 'all' for 20k+
function affordableWithin(pick, budget) {
  if (budget === 'all' || budget == null) return true;
  if (pick.capital == null || isNaN(pick.capital)) return false;
  return pick.capital <= budget;
}

// ---- (2) HONEST CONFIDENCE COLOURS ----------------------------------
// Maps to YOUR existing Tier/BuyScore + gate pass. Labels are about
// setup cleanliness, not profit odds.

function confidence(pick) {
  const gatesOk = pick.gatesPassed != null && pick.gatesTotal != null
                  && pick.gatesPassed === pick.gatesTotal;
  const bs = pick.buyScore;
  if (gatesOk && bs >= 75) return {
    css: 'iq-conf-high', dot: '🟢', label: 'Cleanest setup',
    note: 'Passed all gates + top hygiene score. This is NOT a profit prediction.'
  };
  if (gatesOk && bs >= 55) return {
    css: 'iq-conf-mid', dot: '🟡', label: 'Solid setup',
    note: 'Passed all gates, moderate hygiene. Directional edge unproven.'
  };
  return {
    css: 'iq-conf-low', dot: '⚪', label: 'Speculative',
    note: 'Below 55 hygiene or a gate flag. Lowest-confidence setup.'
  };
}

// ---- (3) AUTO-LOG SELECTION -----------------------------------------
// Picks ONE pick per scan to auto-write to the tracker, so the tool
// builds an unbiased outcome record without you remembering to click.
// Selection: highest confidence class, then highest BuyScore, then best R/R.

function chooseAutoLog(picks) {
  const rank = { 'iq-conf-high': 3, 'iq-conf-mid': 2, 'iq-conf-low': 1 };
  const scored = picks
    .filter(p => p._conf) // must be enriched first
    .slice()
    .sort((a, b) => {
      const r = rank[b._conf.css] - rank[a._conf.css];
      if (r) return r;
      const s = (b.buyScore || 0) - (a.buyScore || 0);
      if (s) return s;
      return (b.rr || 0) - (a.rr || 0);
    });
  return scored[0] || null;
}

// ---- ENRICH: run all three over a picks array -----------------------
function enrichPicks(picks) {
  picks.forEach(p => {
    p._bucket = capitalBucket(p.capital);
    p._conf   = confidence(p);
  });
  const autoLog = chooseAutoLog(picks);
  if (autoLog) autoLog._autoLog = true;
  return { picks, autoLog };
}

module.exports = { capitalBucket, affordableWithin, confidence, chooseAutoLog, enrichPicks };
