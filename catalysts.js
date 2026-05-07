// catalysts.js — Detect high-impact news that may disrupt pre-market predictions
//
// Pre-market predictions assume relatively stable conditions. When major news
// breaks overnight (e.g. Iran ceasefire, Fed surprise, India-Pakistan tension),
// the model's signal mix becomes unreliable.
//
// Approach: scan recent news headlines for keyword matches against a list of
// high-impact event categories. If any match, we surface a warning AND
// reduce the bias score's confidence.
//
// We don't try to predict direction from news (too noisy without LLM). We just
// flag that "the model may be missing something."

const CATALYST_KEYWORDS = [
  // Geopolitical
  { category: 'geopolitical', kw: ['ceasefire', 'truce', 'peace deal', 'peace talks', 'peace memo', 'war ends', 'end war', 'breakthrough'], impact: 'high' },
  { category: 'geopolitical', kw: ['military strike', 'airstrike', 'missile', 'invasion', 'attacks', 'border tension'], impact: 'high' },
  { category: 'geopolitical', kw: ['sanctions', 'sanction'], impact: 'medium' },
  // Energy / oil
  { category: 'energy', kw: ['oil prices', 'crude oil', 'opec', 'strait of hormuz', 'iran oil'], impact: 'high' },
  { category: 'energy', kw: ['oil supply', 'oil cut', 'oil surge', 'oil crash'], impact: 'high' },
  // Central bank / policy
  { category: 'monetary', kw: ['fed cut', 'fed hike', 'rbi cut', 'rbi hike', 'rate cut', 'rate hike'], impact: 'high' },
  { category: 'monetary', kw: ['fomc', 'mpc', 'monetary policy', 'powell speaks'], impact: 'medium' },
  // Trade / tariffs
  { category: 'trade', kw: ['tariff', 'trade war', 'trade deal', 'wto'], impact: 'high' },
  // India-specific
  { category: 'india_macro', kw: ['gst rate', 'budget', 'rbi governor', 'fiscal deficit', 'gdp growth'], impact: 'medium' },
  { category: 'india_political', kw: ['election result', 'no-confidence', 'cabinet reshuffle', 'parliament passes'], impact: 'medium' },
  // Market structure
  { category: 'market_event', kw: ['circuit breaker', 'trading halt', 'flash crash', 'market crash'], impact: 'high' },
  // Company-specific that move indices
  { category: 'index_heavy', kw: ['reliance results', 'tcs results', 'hdfc results', 'infosys results'], impact: 'medium' },
];

// Detect catalysts in a list of news items
// items: [{ title, date, source, ... }]
// Returns: { catalysts: [{category, impact, headline, source}], summary: string }
function detectCatalysts(items, hoursLookback = 12) {
  if (!Array.isArray(items) || items.length === 0) {
    return { catalysts: [], summary: 'No news data available.', confidenceImpact: 0 };
  }

  // Filter to recent items only (last N hours)
  const cutoffMs = Date.now() - hoursLookback * 60 * 60 * 1000;
  const recent = items.filter(it => {
    if (!it.date) return false;
    const t = new Date(it.date).getTime();
    return !isNaN(t) && t >= cutoffMs;
  });

  if (recent.length === 0) {
    // Fall back to all items if dates aren't parseable — better to over-warn than miss
    return _scanItems(items.slice(0, 10));
  }
  return _scanItems(recent);
}

function _scanItems(items) {
  const catalysts = [];
  const seen = new Set(); // dedupe by category — one match per category is enough

  for (const item of items) {
    const title = (item.title || '').toLowerCase();
    if (!title) continue;
    for (const def of CATALYST_KEYWORDS) {
      if (seen.has(def.category)) continue;
      for (const kw of def.kw) {
        if (title.includes(kw)) {
          catalysts.push({
            category: def.category,
            impact: def.impact,
            headline: item.title,
            source: item.source,
            matchedKeyword: kw,
          });
          seen.add(def.category);
          break;
        }
      }
    }
  }

  // Compute confidence impact:
  //   each high-impact catalyst → -2 from confidence
  //   each medium-impact → -1
  let impactScore = 0;
  for (const c of catalysts) {
    if (c.impact === 'high') impactScore -= 2;
    else if (c.impact === 'medium') impactScore -= 1;
  }

  // Build summary
  let summary;
  if (catalysts.length === 0) {
    summary = 'No high-impact catalysts detected in recent news.';
  } else {
    const cats = catalysts.map(c => c.category).join(', ');
    summary = `${catalysts.length} potential catalyst(s) detected: ${cats}. Pre-market signal may be incomplete.`;
  }

  return {
    catalysts,
    summary,
    confidenceImpact: impactScore, // negative number, applied to bias score
  };
}

module.exports = { detectCatalysts, CATALYST_KEYWORDS };
