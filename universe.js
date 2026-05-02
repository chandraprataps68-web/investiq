// universe.js — symbol universes for InvestIQ Pro v6
// Fyers symbol format: NSE:SYMBOL-EQ for equities, MCX:NAME{MMM}{YY}FUT for futures

// ─── Nifty 50 (verified list, Wikipedia rebalance Dec 2025) ────
const NIFTY_50 = [
  'ADANIENT', 'ADANIPORTS', 'APOLLOHOSP', 'ASIANPAINT', 'AXISBANK',
  'BAJAJ-AUTO', 'BAJFINANCE', 'BAJAJFINSV', 'BEL', 'BHARTIARTL',
  'CIPLA', 'COALINDIA', 'DRREDDY', 'EICHERMOT', 'ETERNAL',
  'GRASIM', 'HCLTECH', 'HDFCBANK', 'HDFCLIFE', 'HINDALCO',
  'HINDUNILVR', 'ICICIBANK', 'INDIGO', 'INFY', 'ITC',
  'JIOFIN', 'JSWSTEEL', 'KOTAKBANK', 'LT', 'M&M',
  'MARUTI', 'MAXHEALTH', 'NESTLEIND', 'NTPC', 'ONGC',
  'POWERGRID', 'RELIANCE', 'SBILIFE', 'SHRIRAMFIN', 'SBIN',
  'SUNPHARMA', 'TCS', 'TATACONSUM', 'TATAMOTORS', 'TATASTEEL',
  'TECHM', 'TITAN', 'TRENT', 'ULTRACEMCO', 'WIPRO',
];

// ─── Nifty Next 50 (50 names, by current weight) ─────────────
const NIFTY_NEXT_50 = [
  'ABB', 'ABCAPITAL', 'ADANIENSOL', 'ADANIGREEN', 'ADANIPOWER',
  'AMBUJACEM', 'BAJAJHLDNG', 'BANKBARODA', 'BERGEPAINT', 'BPCL',
  'BRITANNIA', 'CHOLAFIN', 'COLPAL', 'CUMMINSIND', 'DABUR',
  'DIVISLAB', 'DLF', 'DMART', 'GAIL', 'GODREJCP',
  'HAL', 'HAVELLS', 'HEROMOTOCO', 'HINDZINC', 'ICICIPRULI',
  'INDHOTEL', 'INDUSINDBK', 'IOC', 'IRCTC', 'IRFC',
  'LICI', 'MARICO', 'MOTHERSON', 'MUTHOOTFIN', 'NAUKRI',
  'PFC', 'PIDILITIND', 'PIIND', 'PNB', 'POLYCAB',
  'SBICARD', 'SIEMENS', 'TATAELXSI', 'TATAPOWER', 'TORNTPHARM',
  'TVSMOTOR', 'UNIONBANK', 'VBL', 'VEDL', 'ZYDUSLIFE',
];

// ─── Combined Nifty 100 — primary scanner universe ───────────
const NIFTY_100 = [...NIFTY_50, ...NIFTY_NEXT_50];

// ─── Extended search universe (Nifty 200-ish — common names) ─
// Used by /api/universe?q=… for Stock Search autocomplete only.
// Includes mid-caps, popular F&O stocks, and frequently-searched names
// that aren't in Nifty 100.
const EXTENDED_UNIVERSE = [
  ...NIFTY_100,
  // Mid-caps & popular search targets
  'ABFRL', 'ACC', 'ALKEM', 'APOLLOTYRE', 'ASHOKLEY',
  'ASTRAL', 'AUBANK', 'AUROPHARMA', 'BALKRISIND', 'BANDHANBNK',
  'BHARATFORG', 'BHEL', 'BIOCON', 'BOSCHLTD', 'CANBK',
  'CGPOWER', 'CONCOR', 'COROMANDEL', 'CROMPTON', 'DEEPAKNTR',
  'DIXON', 'ESCORTS', 'EXIDEIND', 'FEDERALBNK', 'GLAXO',
  'GLENMARK', 'GMRINFRA', 'GNFC', 'GODREJPROP', 'GUJGASLTD',
  'HDFCAMC', 'HINDPETRO', 'HUDCO', 'IDEA', 'IDFCFIRSTB',
  'IGL', 'INDIANB', 'INDUSTOWER', 'IPCALAB', 'IRB',
  'JINDALSTEL', 'JUBLFOOD', 'KPITTECH', 'L&TFH', 'LICHSGFIN',
  'LUPIN', 'M&MFIN', 'MANAPPURAM', 'MAZDOCK', 'MCX',
  'MFSL', 'MGL', 'MPHASIS', 'MRF', 'NAM-INDIA',
  'NBCC', 'NHPC', 'NMDC', 'OBEROIRLTY', 'OFSS',
  'OIL', 'PAGEIND', 'PERSISTENT', 'PETRONET', 'PHOENIXLTD',
  'PNBHOUSING', 'POLICYBZR', 'PRESTIGE', 'PVRINOX', 'RAMCOCEM',
  'RECLTD', 'RELAXO', 'SAIL', 'SBI', 'SCHAEFFLER',
  'SHREECEM', 'SOLARINDS', 'SONACOMS', 'SRF', 'STAR',
  'SUNTV', 'SUPREMEIND', 'SUZLON', 'SYNGENE', 'TATACOMM',
  'TIINDIA', 'TORNTPOWER', 'TRIDENT', 'TRITURBINE', 'TTML',
  'UBL', 'UCOBANK', 'UNITDSPR', 'UPL', 'VOLTAS',
  'WHIRLPOOL', 'YESBANK', 'ZEEL', 'ZOMATO',
];

// Convert plain symbol to Fyers format
function toFyersEquity(symbol) {
  return `NSE:${symbol}-EQ`;
}

// ─── MCX Commodities ─────────────────────────────────────────
// Symbols are base names; the resolver in commodities.js tries upcoming
// contract months (e.g. GOLD25APR, GOLD25JUN, GOLD25AUG) and picks the
// first one Fyers responds to — so this list never goes stale.
const COMMODITIES = [
  { id: 'GOLD',       name: 'Gold',           base: 'GOLD',       unit: '/10g',   icon: '🥇', exchange: 'MCX' },
  { id: 'SILVER',     name: 'Silver',         base: 'SILVER',     unit: '/kg',    icon: '🥈', exchange: 'MCX' },
  { id: 'CRUDEOIL',   name: 'Crude Oil',      base: 'CRUDEOIL',   unit: '/bbl',   icon: '🛢️', exchange: 'MCX' },
  { id: 'NATURALGAS', name: 'Natural Gas',    base: 'NATURALGAS', unit: '/mmBtu', icon: '🔥', exchange: 'MCX' },
  { id: 'COPPER',     name: 'Copper',         base: 'COPPER',     unit: '/kg',    icon: '🟫', exchange: 'MCX' },
  // Coal India is an equity, not a future — fixed symbol
  { id: 'COALINDIA',  name: 'Coal India (Eq)', fyers: 'NSE:COALINDIA-EQ', unit: '/sh', icon: '⚫' },
];

// ─── Crypto via CoinGecko ────────────────────────────────────
const CRYPTO = [
  { id: 'bitcoin',     name: 'Bitcoin',  symbol: 'BTC', icon: '₿' },
  { id: 'ethereum',    name: 'Ethereum', symbol: 'ETH', icon: 'Ξ' },
  { id: 'solana',      name: 'Solana',   symbol: 'SOL', icon: '◎' },
  { id: 'binancecoin', name: 'BNB',      symbol: 'BNB', icon: '⬢' },
];

// ─── Global cues — yahoo ticker for fallback / display name ──
const GLOBAL_CUES = [
  { id: 'GIFT_NIFTY', name: 'GIFT Nifty',   yahoo: '^NSEI',     region: 'india' },
  { id: 'DOW',        name: 'Dow Jones',    yahoo: '^DJI',      region: 'us' },
  { id: 'NASDAQ',     name: 'Nasdaq',       yahoo: '^IXIC',     region: 'us' },
  { id: 'SP500',      name: 'S&P 500',      yahoo: '^GSPC',     region: 'us' },
  { id: 'NIKKEI',     name: 'Nikkei 225',   yahoo: '^N225',     region: 'asia' },
  { id: 'HANGSENG',   name: 'Hang Seng',    yahoo: '^HSI',      region: 'asia' },
  { id: 'FTSE',       name: 'FTSE 100',     yahoo: '^FTSE',     region: 'europe' },
  { id: 'DAX',        name: 'DAX',          yahoo: '^GDAXI',    region: 'europe' },
  { id: 'BRENT',      name: 'Brent Crude',  yahoo: 'BZ=F',      region: 'commodities' },
  { id: 'DXY',        name: 'Dollar Index', yahoo: 'DX-Y.NYB',  region: 'currency' },
  { id: 'USDINR',     name: 'USD/INR',      yahoo: 'INR=X',     region: 'currency' },
  { id: 'VIX',        name: 'VIX',          yahoo: '^VIX',      region: 'volatility' },
];

// ─── News RSS feeds ──────────────────────────────────────────
const NEWS_FEEDS = [
  { name: 'ET Markets',   url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms' },
  { name: 'MoneyControl', url: 'https://www.moneycontrol.com/rss/marketreports.xml' },
  { name: 'BS Markets',   url: 'https://www.business-standard.com/rss/markets-106.rss' },
];

module.exports = {
  NIFTY_50, NIFTY_NEXT_50, NIFTY_100, EXTENDED_UNIVERSE,
  COMMODITIES, CRYPTO, GLOBAL_CUES, NEWS_FEEDS,
  toFyersEquity,
};
