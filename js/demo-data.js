/**
 * CandleFlow — Demo data generator
 *
 * Generates realistic-looking XAUUSD M1 candles so the app
 * shows a live chart on first load (no empty state).
 */

/**
 * Generate ~500 M1 candles of synthetic XAUUSD-like price action.
 * Uses a random walk with realistic spread/volatility.
 */
export function generateDemoData() {
  const candles = [];
  const baseTime = Date.UTC(2025, 0, 6, 8, 0, 0) / 1000; // Mon Jan 6 2025 08:00 UTC
  let price = 2635.50; // Realistic XAUUSD level

  // Seed a simple PRNG for reproducible demo data
  let seed = 42;
  function rand() {
    seed = (seed * 16807 + 0) % 2147483647;
    return seed / 2147483647;
  }

  // Generate a trend bias that shifts over time (creates swings)
  const candleCount = 500;

  for (let i = 0; i < candleCount; i++) {
    const time = baseTime + i * 60; // 1-minute intervals

    // Skip weekend gaps (simplified: skip Sat/Sun)
    const day = new Date(time * 1000).getUTCDay();
    if (day === 0 || day === 6) continue;

    // Trend component: slow sine wave for swing structure
    const trendBias = Math.sin(i / 80) * 0.15 + Math.sin(i / 200) * 0.08;

    // Volatility varies
    const vol = 0.3 + rand() * 0.7; // 0.3–1.0 point range per candle

    // Price movement
    const move = (rand() - 0.48 + trendBias) * vol;
    const open = price;

    // Simulate wick and body
    const bodySize = (rand() * 0.6 + 0.1) * vol;
    const isGreen = move >= 0;
    const close = open + (isGreen ? bodySize : -bodySize);

    const wickUp = rand() * vol * 0.5;
    const wickDown = rand() * vol * 0.5;

    const high = Math.max(open, close) + wickUp;
    const low = Math.min(open, close) - wickDown;

    // Volume: higher on bigger moves
    const volume = Math.round(80 + Math.abs(move) * 200 + rand() * 150);

    candles.push({
      time,
      open:   round2(open),
      high:   round2(high),
      low:    round2(low),
      close:  round2(close),
      volume,
    });

    price = close;
  }

  return candles;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Metadata for the demo dataset */
export const DEMO_META = {
  symbol: 'XAUUSD',
  timeframe: 'M1',
  fileName: '(demo)',
  fileSize: 0,
  isDemo: true,
};
