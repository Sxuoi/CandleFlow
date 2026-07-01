/**
 * CandleFlow — Client-side timeframe aggregation engine (PRD §4.3)
 */

export const TIMEFRAME_MINUTES = {
  'M1': 1,
  'M5': 5,
  'M15': 15,
  'M30': 30,
  'H1': 60,
  'H4': 240,
  'D1': 1440,
  'W1': 10080
};

/**
 * Returns the aligned bucket timestamp for a given timeframe.
 * Using mathematical formulas where possible for high performance.
 */
export function getBucketTimestamp(timestamp, timeframe) {
  if (timeframe === 'W1') {
    // A week has 604800 seconds. Unix epoch (0) was 1970-01-01 (Thursday).
    // We want weekly candles to start on Monday 00:00:00.
    // Monday of the epoch week was 1969-12-29, which is 3 days before epoch.
    // 3 days = 3 * 86400 = 259200 seconds.
    const SECONDS_IN_WEEK = 604800;
    const MON_EPOCH_OFFSET = 3 * 86400;
    
    // Offset, floor to weekly interval, and shift back
    return Math.floor((timestamp - MON_EPOCH_OFFSET) / SECONDS_IN_WEEK) * SECONDS_IN_WEEK + MON_EPOCH_OFFSET;
  }
  
  if (timeframe === 'D1') {
    // 1 day = 86400 seconds. UTC days are exactly 86400 seconds.
    return Math.floor(timestamp / 86400) * 86400;
  }

  const minutes = TIMEFRAME_MINUTES[timeframe];
  if (!minutes) {
    throw new Error(`Unknown timeframe: ${timeframe}`);
  }
  const seconds = minutes * 60;
  return Math.floor(timestamp / seconds) * seconds;
}

/**
 * Aggregate a sorted array of base candles into a target timeframe.
 *
 * @param {Array} baseCandles - Array of OHLCV objects sorted by time ascending.
 * @param {string} targetTf - Timeframe code to aggregate to (e.g. 'M15', 'H4').
 * @returns {Array} Aggregated candles.
 */
export function aggregateCandles(baseCandles, targetTf) {
  if (!baseCandles || baseCandles.length === 0) return [];
  
  const targetMinutes = TIMEFRAME_MINUTES[targetTf];
  if (!targetMinutes) return baseCandles; // default fallback if invalid

  const aggregated = [];
  let currentBucket = null;

  for (let i = 0; i < baseCandles.length; i++) {
    const candle = baseCandles[i];
    const bucketTime = getBucketTimestamp(candle.time, targetTf);

    if (currentBucket === null || currentBucket.time !== bucketTime) {
      if (currentBucket !== null) {
        aggregated.push(currentBucket);
      }
      currentBucket = {
        time: bucketTime,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume
      };
    } else {
      // Aggregate in current bucket
      currentBucket.high = Math.max(currentBucket.high, candle.high);
      currentBucket.low = Math.min(currentBucket.low, candle.low);
      currentBucket.close = candle.close;
      currentBucket.volume += candle.volume;
    }
  }

  // Push final bucket
  if (currentBucket !== null) {
    aggregated.push(currentBucket);
  }

  return aggregated;
}
