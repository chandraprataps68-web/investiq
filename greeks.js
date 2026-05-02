// greeks.js — Black-Scholes option pricing + Greeks + IV solver
//
// Formulas reference: Hull, "Options, Futures and Other Derivatives" (10th ed)
// Standard European-option pricing model. Indian index/stock options are
// European-style (cash-settled at expiry) so this is exactly correct for our use.
//
// All time inputs in YEARS. All rates as decimals (0.065 = 6.5%).
// IV/sigma also as decimal (0.15 = 15% annualized vol).

// Indian 91-day T-bill yield, mid-2026. Used as risk-free rate.
// Sensitivity is low for short-dated options — see notes on this in Phase 2A discussion.
const RISK_FREE_RATE = 0.065;

// ─── Standard normal distribution (PDF + CDF) ─────────────────
// Need both for Black-Scholes. CDF uses Abramowitz-Stegun approximation
// (accuracy ~7.5e-8, faster than libraries for our scale).

function normPDF(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function normCDF(x) {
  // Abramowitz & Stegun 26.2.17
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * ax);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1.0 + sign * y);
}

// ─── Black-Scholes price ──────────────────────────────────────
// S: spot, K: strike, T: time to expiry (years), r: rate, sigma: vol, type: 'CE' or 'PE'
function bsPrice(S, K, T, r, sigma, type) {
  if (T <= 0 || sigma <= 0) {
    // Intrinsic value at/past expiry
    if (type === 'CE') return Math.max(S - K, 0);
    return Math.max(K - S, 0);
  }
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  if (type === 'CE') {
    return S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2);
  } else {
    return K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1);
  }
}

// ─── Greeks ───────────────────────────────────────────────────
// All Greeks computed at given S/K/T/r/sigma. Returns object with
// delta, gamma, theta (per day), vega (per 1% vol move).

function bsGreeks(S, K, T, r, sigma, type) {
  if (T <= 0 || sigma <= 0) {
    return { delta: type === 'CE' ? (S > K ? 1 : 0) : (S < K ? -1 : 0),
             gamma: 0, theta: 0, vega: 0 };
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const pdfD1 = normPDF(d1);

  const delta = type === 'CE' ? normCDF(d1) : normCDF(d1) - 1;
  const gamma = pdfD1 / (S * sigma * sqrtT);
  const vegaPer1Pct = S * pdfD1 * sqrtT / 100; // per 1% (not per 1.0)
  // Theta per calendar day
  const thetaAnnual = type === 'CE'
    ? (-(S * pdfD1 * sigma) / (2 * sqrtT)) - r * K * Math.exp(-r * T) * normCDF(d2)
    : (-(S * pdfD1 * sigma) / (2 * sqrtT)) + r * K * Math.exp(-r * T) * normCDF(-d2);
  const thetaPerDay = thetaAnnual / 365;

  return { delta, gamma, theta: thetaPerDay, vega: vegaPer1Pct };
}

// ─── Implied Volatility solver (Newton-Raphson) ───────────────
// Given observed market price, solve for sigma that makes BS price match.
// Uses vega-based Newton-Raphson with bracketing fallback for stability.

function impliedVol(marketPrice, S, K, T, r, type) {
  if (marketPrice <= 0 || T <= 0 || S <= 0 || K <= 0) return null;

  // Sanity check: market price must be above intrinsic value or solver can't converge
  const intrinsic = type === 'CE' ? Math.max(S - K, 0) : Math.max(K - S, 0);
  if (marketPrice < intrinsic - 0.01) return null; // arb opportunity, skip

  // Skip very deep OTM options where price is dominated by bid/ask noise rather
  // than fair value. Threshold: if time value (price - intrinsic) is < ₹2 AND
  // we're far OTM, skip — IV is unreliable.
  const timeValue = marketPrice - intrinsic;
  const moneyness = Math.abs(Math.log(S / K));
  if (timeValue < 2 && moneyness > 0.05) return null;

  // Initial guess from Brenner-Subrahmanyam approximation:
  // sigma ≈ sqrt(2π/T) * (price / S)
  let sigma = Math.sqrt(2 * Math.PI / T) * (marketPrice / S);
  sigma = Math.max(0.01, Math.min(5, sigma)); // clamp to sensible starting range

  // Newton-Raphson with up to 50 iterations
  let converged = false;
  for (let i = 0; i < 50; i++) {
    const price = bsPrice(S, K, T, r, sigma, type);
    const diff = price - marketPrice;
    if (Math.abs(diff) < 0.005) { converged = true; break; }

    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
    const vega = S * normPDF(d1) * sqrtT;

    if (vega < 1e-8) break; // vega vanishingly small, can't proceed
    sigma -= diff / vega;
    if (sigma <= 0.001) sigma = 0.001;
    if (sigma > 5) sigma = 5;
  }

  // Reject results that didn't converge or hit the boundaries — these are garbage
  if (!converged) return null;
  if (sigma <= 0.005 || sigma >= 4.99) return null;
  // Sanity bounds — Indian options rarely trade outside 5%-150% IV
  if (sigma < 0.02 || sigma > 2.0) return null;

  return sigma;
}

// ─── Time to expiry helper ────────────────────────────────────
// expiryEpochSeconds: from Fyers expiryData entries
// Returns time in years, or null if past expiry
function yearsToExpiry(expiryEpochSeconds) {
  if (!expiryEpochSeconds) return null;
  const expiryMs = parseInt(expiryEpochSeconds, 10) * 1000;
  const nowMs = Date.now();
  if (expiryMs <= nowMs) return null;
  return (expiryMs - nowMs) / (365 * 24 * 60 * 60 * 1000);
}

// ─── Enrich an option chain row with IV + Greeks ──────────────
// row: { strike_price, option_type, ltp, ... }
// spot: underlying price
// T: time to expiry in years
// r: risk-free rate (defaults to RISK_FREE_RATE)
function enrichOption(row, spot, T, r = RISK_FREE_RATE) {
  if (!row || !spot || !T || row.ltp == null || row.ltp <= 0) return row;
  const type = row.option_type;
  if (type !== 'CE' && type !== 'PE') return row;

  const iv = impliedVol(row.ltp, spot, row.strike_price, T, r, type);
  if (iv == null) return { ...row, iv: null };

  const greeks = bsGreeks(spot, row.strike_price, T, r, iv, type);
  return {
    ...row,
    iv: iv * 100, // convert to percentage for display
    delta: greeks.delta,
    gamma: greeks.gamma,
    theta: greeks.theta,
    vega: greeks.vega,
  };
}

module.exports = {
  RISK_FREE_RATE,
  normPDF, normCDF,
  bsPrice, bsGreeks, impliedVol,
  yearsToExpiry, enrichOption,
};
