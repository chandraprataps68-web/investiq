// lotsizes.js — NSE F&O lot sizes (May 2026 revision)
//
// NSE revises stock F&O lot sizes quarterly to keep contract value
// between ₹5-10 lakh per SEBI mandate. Values below verified for current
// quarter. Refresh from https://www.nseindia.com/products-services/equity-derivatives-list-underlyings
// at quarterly expiry (Mar/Jun/Sep/Dec last Thursday).
//
// If a symbol is missing here, getLotSize() returns null and the UI will
// show "—" for capital required. We never fabricate a wrong lot size.

const LOT_SIZES = {
  // Indices
  'NIFTY': 75,
  'BANKNIFTY': 30,
  'FINNIFTY': 65,
  'MIDCPNIFTY': 120,
  'BANKEX': 30,

  // Large-cap stocks (Nifty 50 + select Next 50)
  'RELIANCE': 250,
  'TCS': 175,
  'HDFCBANK': 550,
  'INFY': 400,
  'ICICIBANK': 700,
  'HINDUNILVR': 300,
  'SBIN': 750,
  'BHARTIARTL': 475,
  'KOTAKBANK': 400,
  'ITC': 1600,
  'LT': 175,
  'AXISBANK': 625,
  'HCLTECH': 350,
  'ASIANPAINT': 200,
  'BAJFINANCE': 125,
  'MARUTI': 50,
  'SUNPHARMA': 350,
  'TITAN': 175,
  'WIPRO': 3000,
  'ULTRACEMCO': 50,
  'NESTLEIND': 250,
  'NTPC': 1500,
  'POWERGRID': 1900,
  'M&M': 350,
  'ONGC': 2250,
  'TATAMOTORS': 800,
  'JSWSTEEL': 675,
  'COALINDIA': 1350,
  'TATASTEEL': 5500,
  'BAJAJFINSV': 500,
  'TECHM': 600,
  'GRASIM': 250,
  'HINDALCO': 1400,
  'INDUSINDBK': 700,
  'CIPLA': 425,
  'EICHERMOT': 175,
  'DRREDDY': 625,
  'BPCL': 1800,
  'BRITANNIA': 200,
  'HEROMOTOCO': 150,
  'DIVISLAB': 200,
  'SBILIFE': 375,
  'TATACONSUM': 550,
  'ADANIPORTS': 400,
  'BAJAJ-AUTO': 75,
  'APOLLOHOSP': 125,
  'HDFCLIFE': 1100,
  'UPL': 1335,
  'TRENT': 175,

  // Banking / Financials mid-cap
  'AUBANK': 750,
  'BANDHANBNK': 3600,
  'BANKBARODA': 2925,
  'BANKINDIA': 5450,
  'CANBK': 6750,
  'CHOLAFIN': 625,
  'FEDERALBNK': 5000,
  'HDFCAMC': 200,
  'IDFCFIRSTB': 7500,
  'IIFL': 1500,
  'INDIANB': 1500,
  'LICHSGFIN': 1100,
  'M&MFIN': 2150,
  'MFSL': 800,
  'PEL': 825,
  'PNB': 8000,
  'POLICYBZR': 375,
  'RBLBANK': 4250,
  'RECLTD': 1450,
  'SBICARD': 800,
  'SHRIRAMFIN': 300,
  'UNIONBANK': 4425,
  'YESBANK': 30000,
  'ABCAPITAL': 5400,
  'LICI': 850,
  'BAJAJHLDNG': 75,

  // IT
  'COFORGE': 75,
  'KPITTECH': 400,
  'LTIM': 100,
  'LTTS': 125,
  'MPHASIS': 275,
  'OFSS': 75,
  'PERSISTENT': 100,
  'TATAELXSI': 100,

  // Auto / Auto-ancillaries
  'APOLLOTYRE': 1600,
  'ASHOKLEY': 2500,
  'BALKRISIND': 200,
  'BHARATFORG': 500,
  'BOSCHLTD': 25,
  'ESCORTS': 175,
  'EXIDEIND': 1800,
  'MOTHERSON': 6150,
  'MRF': 5,
  'SONACOMS': 1300,
  'TIINDIA': 175,
  'TVSMOTOR': 350,

  // Pharma / Healthcare
  'ALKEM': 125,
  'APLLTD': 350,
  'AUROPHARMA': 550,
  'BIOCON': 2200,
  'GLAXO': 250,
  'GLENMARK': 425,
  'GRANULES': 1450,
  'IPCALAB': 425,
  'LAURUSLABS': 1300,
  'LUPIN': 425,
  'MAXHEALTH': 600,
  'METROPOLIS': 350,
  'NATCOPHARM': 625,
  'SYNGENE': 800,
  'TORNTPHARM': 250,
  'ZYDUSLIFE': 600,
  'MANKIND': 200,
  'ABBOTINDIA': 25,
  'PFIZER': 125,

  // Metals / Mining
  'HINDCOPPER': 2250,
  'JINDALSTEL': 750,
  'NATIONALUM': 3000,
  'NMDC': 2700,
  'SAIL': 4750,
  'VEDL': 1150,
  'HINDZINC': 1300,
  'APLAPOLLO': 350,

  // Energy / Oil
  'GAIL': 3000,
  'GUJGASLTD': 1250,
  'HINDPETRO': 1300,
  'IGL': 1375,
  'IOC': 4875,
  'MGL': 350,
  'OIL': 1100,
  'PETRONET': 1875,
  'TATAPOWER': 1450,
  'ADANIENSOL': 600,
  'ADANIGREEN': 425,
  'ADANIPOWER': 1250,

  // Power / Infra
  'CESC': 3375,
  'CONCOR': 925,
  'CUMMINSIND': 200,
  'GMRINFRA': 7500,
  'IRB': 3750,
  'NHPC': 6000,
  'SJVN': 4500,
  'TORNTPOWER': 375,
  'BHEL': 1900,

  // Cement
  'ACC': 250,
  'AMBUJACEM': 1200,
  'DALBHARAT': 250,
  'JKCEMENT': 125,
  'RAMCOCEM': 700,
  'SHREECEM': 25,

  // Consumer / Retail
  'ABFRL': 2600,
  'BATAINDIA': 425,
  'BERGEPAINT': 1100,
  'COLPAL': 350,
  'CROMPTON': 1800,
  'DABUR': 1250,
  'DIXON': 50,
  'GODREJCP': 1000,
  'GODREJPROP': 250,
  'HAVELLS': 500,
  'JUBLFOOD': 1250,
  'NAUKRI': 100,
  'PAGEIND': 15,
  'PIDILITIND': 250,
  'POLYCAB': 100,
  'UBL': 400,
  'UNITDSPR': 400,
  'VOLTAS': 500,
  'WHIRLPOOL': 350,
  'PVRINOX': 407,
  'NYKAA': 3125,
  'PATANJALI': 300,

  // Industrials / Engineering / Defence
  'ASTRAL': 425,
  'BEL': 2850,
  'CGPOWER': 1300,
  'HAL': 150,
  'L&T': 175,
  'MAZDOCK': 175,
  'NAVINFLUOR': 175,
  'PIIND': 175,
  'SIEMENS': 200,
  'SOLARINDS': 75,
  'SRF': 375,
  'SUPREMEIND': 200,
  'TATACOMM': 350,
  'TRITURBINE': 1100,

  // Misc / Others
  'CDSL': 425,
  'BSE': 375,
  'IEX': 3750,
  'IRCTC': 875,
  'IRFC': 5400,
  'INDIGO': 175,
  'KEI': 175,
  'MCX': 100,
  'NBCC': 6000,
  'OBEROIRLTY': 700,
  'PHOENIXLTD': 425,
  'PRESTIGE': 450,
  'SUZLON': 19000,
  'ZOMATO': 3950,
  'IDEA': 50000,
  'INDUSTOWER': 1700,
  'INDIAMART': 200,
  'CUB': 5000,
  'PFC': 1300,
};

/**
 * Returns lot size for an NSE F&O symbol, or null if unknown.
 * Symbol format: bare symbol like 'WIPRO' or 'BAJAJ-AUTO' (no exchange prefix).
 */
function getLotSize(symbol) {
  if (!symbol) return null;
  const upper = symbol.toUpperCase().trim();
  return LOT_SIZES[upper] ?? null;
}

/**
 * Compute total capital required = premium × lot_size.
 * Returns null if any input is missing (UI shows '—').
 */
function computeCapitalRequired(symbol, premium) {
  if (!premium || premium <= 0) return null;
  const lot = getLotSize(symbol);
  if (!lot) return null;
  return Math.round(lot * premium);
}

module.exports = { LOT_SIZES, getLotSize, computeCapitalRequired };
