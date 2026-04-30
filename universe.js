// universe.js — symbol universes for InvestIQ Pro v6
// All Fyers symbols use the standard format: EXCHANGE:SYMBOL-SEGMENT

// Nifty 50 constituents (as of Wikipedia rebalance, 8 Dec 2025)
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

// Nifty Next 50 (top names by weight; full list maintained semi-annually)
const NIFTY_NEXT_50 = [
  'ADANIPOWER', 'DMART', 'VEDL', 'HAL', 'HINDZINC',
  'IOC', 'ADANIGREEN', 'TVSMOTOR', 'VBL', 'DIVISLAB',
  'ADANIENSOL', 'ABB', 'PFC', 'DLF', 'UNIONBANK',
  'BANKBARODA', 'CUMMINSIND', 'PIDILITIND', 'MUTHOOTFIN', 'TATAPOWER',
  'MOTHERSON', 'IRFC', 'CHOLAFIN', 'BRITANNIA', 'SIEMENS',
  'GODREJCP', 'AMBUJACEM', 'ICICIPRULI', 'BAJAJHLDNG', 'HAVELLS',
  'SBICARD', 'LICI', 'BPCL', 'GAIL', 'TATAELXSI',
  'INDUSINDBK', 'NAUKRI', 'IRCTC', 'PIIND', 'BERGEPAINT',
  'COLPAL', 'MARICO', 'DABUR', 'TORNTPHARM', 'HEROMOTOCO',
  'INDHOTEL', 'POLYCAB', 'ZYDUSLIFE', 'INDUSTOWER', 'PNB',
];

// Combined Nifty 100 universe — main scanner target
const NIFTY_100 = [...NIFTY_50, ...NIFTY_NEXT_50];

// Convert plain symbol to Fyers format
function toFyersEquity(symbol) {
  return `NSE:${symbol}-EQ`;
}

// MCX commodities — Fyers symbol format for current near-month futures
// NOTE: contract month codes (e.g. 25DEC) need updating monthly.
// We'll fetch the active contract dynamically via Fyers in production.
const COMMODITIES = [
  { id: 'GOLD', name: 'Gold', fyers: 'MCX:GOLD25DECFUT', unit: '/10g', icon: '🥇' },
  { id: 'SILVER', name: 'Silver', fyers: 'MCX:SILVER25DECFUT', unit: '/kg', icon: '🥈' },
  { id: 'CRUDEOIL', name: 'Crude Oil', fyers: 'MCX:CRUDEOIL25DECFUT', unit: '/bbl', icon: '🛢️' },
  { id: 'NATURALGAS', name: 'Natural Gas', fyers: 'MCX:NATURALGAS25DECFUT', unit: '/mmBtu', icon: '🔥' },
  { id: 'COPPER', name: 'Copper', fyers: 'MCX:COPPER25DECFUT', unit: '/kg', icon: '🟫' },
  { id: 'COALINDIA_EQ', name: 'Coal India (Eq)', fyers: 'NSE:COALINDIA-EQ', unit: '/sh', icon: '⚫' },
];

// Crypto — via CoinGecko (Fyers does not support crypto)
const CRYPTO = [
  { id: 'bitcoin', name: 'Bitcoin', symbol: 'BTC', icon: '₿' },
  { id: 'ethereum', name: 'Ethereum', symbol: 'ETH', icon: 'Ξ' },
  { id: 'solana', name: 'Solana', symbol: 'SOL', icon: '◎' },
  { id: 'binancecoin', name: 'BNB', symbol: 'BNB', icon: '⬢' },
];

// Global market cues — for pre-market dashboard. These are Yahoo Finance tickers.
const GLOBAL_CUES = [
  { id: 'GIFT_NIFTY', name: 'GIFT Nifty', yahoo: '^NSEI', region: 'india' },
  { id: 'DOW', name: 'Dow Jones', yahoo: '^DJI', region: 'us' },
  { id: 'NASDAQ', name: 'Nasdaq', yahoo: '^IXIC', region: 'us' },
  { id: 'SP500', name: 'S&P 500', yahoo: '^GSPC', region: 'us' },
  { id: 'NIKKEI', name: 'Nikkei 225', yahoo: '^N225', region: 'asia' },
  { id: 'HANGSENG', name: 'Hang Seng', yahoo: '^HSI', region: 'asia' },
  { id: 'FTSE', name: 'FTSE 100', yahoo: '^FTSE', region: 'europe' },
  { id: 'DAX', name: 'DAX', yahoo: '^GDAXI', region: 'europe' },
  { id: 'BRENT', name: 'Brent Crude', yahoo: 'BZ=F', region: 'commodities' },
  { id: 'DXY', name: 'Dollar Index', yahoo: 'DX-Y.NYB', region: 'currency' },
  { id: 'USDINR', name: 'USD/INR', yahoo: 'INR=X', region: 'currency' },
  { id: 'VIX', name: 'VIX', yahoo: '^VIX', region: 'volatility' },
];

// News RSS feeds
const NEWS_FEEDS = [
  { name: 'ET Markets', url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms' },
  { name: 'MoneyControl', url: 'https://www.moneycontrol.com/rss/marketreports.xml' },
  { name: 'BS Markets', url: 'https://www.business-standard.com/rss/markets-106.rss' },
];

module.exports = {
  NIFTY_50, NIFTY_NEXT_50, NIFTY_100,
  COMMODITIES, CRYPTO, GLOBAL_CUES, NEWS_FEEDS,
  toFyersEquity,
};
