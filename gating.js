// gating.js — Phase 15B Module 9: Cross-Engine Gating
//
// The meta-rule: no signal is published to the user without passing checks
// from ALL relevant engines. This prevents the "scanner says BUY but volume
// shows distribution" type of inconsistency that bit the TATASTEEL trade.
//
// Three signal classes with different bars:
//
//   OPTION_BUY  — highest bar. Theta works against the buyer, so every
//                 quality check must pass. Confluence ≥ 75 required.
//   STOCK_BUY   — medium bar. Confluence ≥ 65, plus volume/range checks.
//   STOCK_HOLD  — low bar. Confluence ≥ 55, no conflicting strong bearish.
//
// Stock SELL/STRONG SELL have their own checks (mirror of BUY).
// HOLD always passes (no action implied).
//
// The gating function never silently changes a signal — it returns a verdict
// + reasoning + suggested alternative. The CALLER decides what to do with it
// (downgrade signal, show warning, filter out of scanner results, etc.).

// Required thresholds per signal class
const THRESHOLDS = {
  OPTION_BUY: {
    minConfluence: 75,
    forbidsRangeBound: true,
    forbidsDistribution: true,
    maxResistanceCluster: 2,
  },
  STOCK_BUY: {
    minConfluence: 65,
    forbidsRangeBound: true,  // upper-third only
    forbidsDistribution: true,
    maxResistanceCluster: 3,
  },
  STOCK_HOLD: {
    minConfluence: 55,
    forbidsRangeBound: false,
    forbidsDistribution: false,
    maxResistanceCluster: 99,
  },
  // Mirror for shorts (stock SELL / option PUT BUY)
  OPTION_PUT_BUY: {
    minConfluence: 75,
    forbidsRangeBound: true,
    forbidsAccumulation: true,
    maxSupportCluster: 2,
  },
  STOCK_SELL: {
    minConfluence: 65,
    forbidsRangeBound: true,
    forbidsAccumulation: true,
    maxSupportCluster: 3,
  },
};

// Map raw signal to gating class
function classifySignal(signal, isOptionTrade = false) {
  if (!signal) return null;
  const isBuy = signal === 'STRONG BUY' || signal === 'BUY';
  const isSell = signal === 'STRONG SELL' || signal === 'SELL';
  if (isBuy && isOptionTrade) return 'OPTION_BUY';
  if (isBuy) return 'STOCK_BUY';
  if (isSell && isOptionTrade) return 'OPTION_PUT_BUY';
  if (isSell) return 'STOCK_SELL';
  return 'STOCK_HOLD';
}

// ─── Count support cluster (mirror of resistance cluster) ──
function countSupportCluster(zones, currentPrice) {
  if (!Array.isArray(zones?.zones) || !currentPrice) return 0;
  const floor = currentPrice * 0.97;
  return zones.zones.filter(z =>
    z.type === 'support' && z.price < currentPrice && z.price >= floor
  ).length;
}

// ─── Main gating function ──
function checkCrossEngine({ signal, confluence, signalQuality, rangeBehavior, zones, currentPrice, isOptionTrade = false }) {
  const signalClass = classifySignal(signal, isOptionTrade);
  if (!signalClass || signalClass === 'STOCK_HOLD') {
    // HOLD always passes; no action implied
    return {
      overall: 'PASS',
      signalClass,
      passes: { confluence: true, range: true, volume: true, resistance: true, scanner: true },
      failureReasons: [],
      suggestedAlternative: null,
      signalDowngrade: null,
    };
  }

  const t = THRESHOLDS[signalClass];
  const isBuySide = signalClass.includes('BUY');
  const isSellSide = signalClass.includes('SELL') || signalClass === 'OPTION_PUT_BUY';

  const passes = {};
  const failures = [];

  // 1. Confluence threshold
  const score = confluence?.score ?? 0;
  passes.confluence = score >= t.minConfluence;
  if (!passes.confluence) {
    failures.push(`Confluence ${score} < required ${t.minConfluence} for ${signalClass}`);
  }

  // 2. Range behavior
  const rangeState = rangeBehavior?.state;
  passes.range = true;
  if (t.forbidsRangeBound && rangeState === 'RANGE_BOUND') {
    const pos = rangeBehavior?.currentPosition;
    if (isBuySide && pos === 'upper_third') {
      passes.range = false;
      failures.push('Range-bound at upper third — directional BUY likely to fail at range high');
    } else if (isSellSide && pos === 'lower_third') {
      passes.range = false;
      failures.push('Range-bound at lower third — directional SELL likely to fail at range low');
    } else if (pos === 'mid') {
      // Mid-range: no edge for directional either way
      passes.range = false;
      failures.push('Range-bound mid-range — no directional edge available');
    }
  }

  // 3. Volume character
  const volCat = signalQuality?.volumeCharacter?.category;
  passes.volume = true;
  if (isBuySide && t.forbidsDistribution) {
    if (volCat === 'DISTRIBUTION' || volCat === 'ABSORPTION') {
      passes.volume = false;
      failures.push(`Volume character: ${volCat} — supply pressure overwhelms demand`);
    }
  }
  if (isSellSide && t.forbidsAccumulation) {
    if (volCat === 'ACCUMULATION' || volCat === 'STEALTH_BUILDUP') {
      passes.volume = false;
      failures.push(`Volume character: ${volCat} — demand pressure overwhelms supply, fighting the buyers`);
    }
  }

  // 4. Resistance/support cluster
  passes.resistance = true;
  if (isBuySide) {
    const clusterCount = signalQuality?.resistanceCluster?.count ?? 0;
    if (clusterCount > t.maxResistanceCluster) {
      passes.resistance = false;
      failures.push(`${clusterCount} resistance levels within 3% above — likely rejection at supply zone`);
    }
  } else if (isSellSide) {
    const supportCount = countSupportCluster(zones, currentPrice);
    if (supportCount > (t.maxSupportCluster || 2)) {
      passes.resistance = false;
      failures.push(`${supportCount} support levels within 3% below — likely bounce from demand zone`);
    }
  }

  // 5. Scanner sanity: if signal is BUY/SELL but signalQuality.blockBuySignal
  // is set (the hard-block from Phase 15A), respect it.
  passes.scanner = true;
  if (isBuySide && signalQuality?.blockBuySignal) {
    passes.scanner = false;
    failures.push(`Signal quality hard-block: ${signalQuality.blockReason}`);
  }

  // ─── Overall verdict ──
  const failedChecks = Object.values(passes).filter(p => !p).length;
  const overall = failedChecks === 0 ? 'PASS' : 'FAIL';

  // ─── Suggested alternative when blocked ──
  let suggestedAlternative = null;
  let signalDowngrade = null;
  if (overall === 'FAIL') {
    if (signalClass === 'OPTION_BUY' || signalClass === 'OPTION_PUT_BUY') {
      // Block option BUY; suggest spread or skip
      signalDowngrade = 'BLOCKED';
      if (rangeState === 'RANGE_BOUND') {
        const pos = rangeBehavior?.currentPosition;
        if (pos === 'upper_third' && isBuySide) {
          suggestedAlternative = `Bear Call Spread near ₹${rangeBehavior.rangeHigh} (sell the upper edge)`;
        } else if (pos === 'lower_third' && isSellSide) {
          suggestedAlternative = `Bull Put Spread near ₹${rangeBehavior.rangeLow} (sell the lower edge)`;
        } else {
          suggestedAlternative = 'Iron Condor between range boundaries OR skip';
        }
      } else if (signalQuality?.resistanceCluster?.count >= 3 && isBuySide) {
        suggestedAlternative = 'Bear Call Spread above resistance shelf OR wait for cluster clearance';
      } else if (volCat === 'DISTRIBUTION' || volCat === 'ABSORPTION') {
        suggestedAlternative = 'Wait for accumulation confirmation OR consider PUT side';
      } else {
        suggestedAlternative = 'Wait for cleaner setup — current conditions unfavorable for directional option BUY';
      }
    } else {
      // Stock BUY/SELL: downgrade to HOLD-with-warning
      signalDowngrade = 'HOLD';
      suggestedAlternative = isBuySide
        ? 'Hold off on buying — quality checks failed. Wait for setup to clear.'
        : 'Hold off on shorting — quality checks failed. Wait for setup to clear.';
    }
  }

  return {
    overall,
    signalClass,
    passes,
    failureReasons: failures,
    suggestedAlternative,
    signalDowngrade,
    thresholds: t,
  };
}

module.exports = { checkCrossEngine, classifySignal, THRESHOLDS };
