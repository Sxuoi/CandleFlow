/**
 * CandleFlow — Indicator Calculation Engine (Phase 3)
 *
 * Pure functions — no DOM or chart dependencies.
 * Each function takes candles[] + config and returns data arrays
 * suitable for Lightweight Charts series.
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Get the source value from a candle. */
function getSource(candle, source = 'close') {
  switch (source) {
    case 'open':  return candle.open;
    case 'high':  return candle.high;
    case 'low':   return candle.low;
    case 'close': return candle.close;
    case 'hl2':   return (candle.high + candle.low) / 2;
    case 'hlc3':  return (candle.high + candle.low + candle.close) / 3;
    case 'ohlc4': return (candle.open + candle.high + candle.low + candle.close) / 4;
    default:      return candle.close;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SMA — Simple Moving Average
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * @param {Array} candles  OHLCV candle array
 * @param {number} period  Lookback period
 * @param {string} source  Price source field
 * @returns {Array<{time: number, value: number}>}
 */
export function calcSMA(candles, period = 20, source = 'close') {
  if (candles.length < period) return [];
  const result = [];
  let sum = 0;

  for (let i = 0; i < candles.length; i++) {
    sum += getSource(candles[i], source);
    if (i >= period) {
      sum -= getSource(candles[i - period], source);
    }
    if (i >= period - 1) {
      result.push({ time: candles[i].time, value: sum / period });
    }
  }
  return result;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  EMA — Exponential Moving Average
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * @param {Array} candles
 * @param {number} period
 * @param {string} source
 * @returns {Array<{time: number, value: number}>}
 */
export function calcEMA(candles, period = 9, source = 'close') {
  if (candles.length < period) return [];
  const k = 2 / (period + 1);
  const result = [];

  // Seed with SMA of first `period` values
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += getSource(candles[i], source);
  }
  let ema = sum / period;
  result.push({ time: candles[period - 1].time, value: ema });

  for (let i = period; i < candles.length; i++) {
    ema = getSource(candles[i], source) * k + ema * (1 - k);
    result.push({ time: candles[i].time, value: ema });
  }
  return result;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  RSI — Relative Strength Index
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Uses Wilder's smoothing (identical to TradingView's RSI).
 * @param {Array} candles
 * @param {number} period
 * @returns {Array<{time: number, value: number}>}
 */
export function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return [];

  const result = [];
  let avgGain = 0;
  let avgLoss = 0;

  // Initial average gain/loss over first `period` changes
  for (let i = 1; i <= period; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  const rsi0 = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  result.push({ time: candles[period].time, value: rsi0 });

  // Wilder's smoothing for subsequent values
  for (let i = period + 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    const rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    result.push({ time: candles[i].time, value: rsi });
  }
  return result;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  MACD — Moving Average Convergence Divergence
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * @param {Array} candles
 * @param {number} fastPeriod   Default 12
 * @param {number} slowPeriod   Default 26
 * @param {number} signalPeriod Default 9
 * @returns {{ macd: Array, signal: Array, histogram: Array }}
 */
export function calcMACD(candles, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const fastEMA = calcEMA(candles, fastPeriod);
  const slowEMA = calcEMA(candles, slowPeriod);

  if (slowEMA.length === 0) return { macd: [], signal: [], histogram: [] };

  // Build time-indexed lookup for fast EMA
  const fastMap = new Map(fastEMA.map(d => [d.time, d.value]));

  // MACD line = fastEMA - slowEMA (aligned by time)
  const macdLine = [];
  for (const s of slowEMA) {
    const f = fastMap.get(s.time);
    if (f !== undefined) {
      macdLine.push({ time: s.time, value: f - s.value });
    }
  }

  if (macdLine.length < signalPeriod) {
    return { macd: macdLine, signal: [], histogram: [] };
  }

  // Signal line = EMA of MACD line
  const signalK = 2 / (signalPeriod + 1);
  let signalSum = 0;
  for (let i = 0; i < signalPeriod; i++) {
    signalSum += macdLine[i].value;
  }
  let signalEma = signalSum / signalPeriod;

  const signalLine = [];
  const histogram = [];

  signalLine.push({ time: macdLine[signalPeriod - 1].time, value: signalEma });
  histogram.push({
    time: macdLine[signalPeriod - 1].time,
    value: macdLine[signalPeriod - 1].value - signalEma,
    color: macdLine[signalPeriod - 1].value - signalEma >= 0
      ? 'rgba(38,166,154,0.7)' : 'rgba(239,83,80,0.7)',
  });

  for (let i = signalPeriod; i < macdLine.length; i++) {
    signalEma = macdLine[i].value * signalK + signalEma * (1 - signalK);
    signalLine.push({ time: macdLine[i].time, value: signalEma });
    const histVal = macdLine[i].value - signalEma;
    histogram.push({
      time: macdLine[i].time,
      value: histVal,
      color: histVal >= 0 ? 'rgba(38,166,154,0.7)' : 'rgba(239,83,80,0.7)',
    });
  }

  return { macd: macdLine, signal: signalLine, histogram };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Bollinger Bands
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * @param {Array} candles
 * @param {number} period     Default 20
 * @param {number} stddev     Multiplier (default 2)
 * @param {string} source
 * @returns {{ upper: Array, middle: Array, lower: Array }}
 */
export function calcBollingerBands(candles, period = 20, stddev = 2, source = 'close') {
  if (candles.length < period) return { upper: [], middle: [], lower: [] };

  const upper = [];
  const middle = [];
  const lower = [];

  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += getSource(candles[j], source);
    }
    const mean = sum / period;

    let sqDiffSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = getSource(candles[j], source) - mean;
      sqDiffSum += diff * diff;
    }
    const sd = Math.sqrt(sqDiffSum / period);

    const t = candles[i].time;
    upper.push({ time: t, value: mean + stddev * sd });
    middle.push({ time: t, value: mean });
    lower.push({ time: t, value: mean - stddev * sd });
  }

  return { upper, middle, lower };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  VWAP — Volume Weighted Average Price
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Session-based VWAP. Resets at each day boundary.
 * @param {Array} candles
 * @returns {Array<{time: number, value: number}>}
 */
export function calcVWAP(candles) {
  if (candles.length === 0) return [];
  const result = [];
  let cumTPV = 0;  // cumulative (typical price × volume)
  let cumVol = 0;
  let lastDay = -1;

  for (const c of candles) {
    // Detect day boundary (UTC)
    const day = Math.floor(c.time / 86400);
    if (day !== lastDay) {
      cumTPV = 0;
      cumVol = 0;
      lastDay = day;
    }

    const tp = (c.high + c.low + c.close) / 3;
    const vol = c.volume || 1; // avoid div-by-zero for tick volume = 0
    cumTPV += tp * vol;
    cumVol += vol;

    result.push({ time: c.time, value: cumTPV / cumVol });
  }
  return result;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Time Separators
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Returns timestamps where separators should be placed.
 * Adaptive: day boundaries for intraday TFs, month for daily, year for weekly.
 * @param {Array} candles
 * @param {string} timeframe  Current timeframe string (M1, M5, H1, D1, etc.)
 * @returns {Array<{time: number}>}
 */
export function calcTimeSeparators(candles, timeframe = 'M1') {
  if (candles.length === 0) return [];

  // Determine boundary type based on timeframe
  const isIntraday = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4'].includes(timeframe);
  const isDaily = timeframe === 'D1';
  // W1 → year boundaries

  const result = [];
  let lastBoundary = -1;

  for (const c of candles) {
    const date = new Date(c.time * 1000);
    let boundary;

    if (isIntraday) {
      // Day boundary
      boundary = Math.floor(c.time / 86400);
    } else if (isDaily) {
      // Month boundary
      boundary = date.getUTCFullYear() * 100 + date.getUTCMonth();
    } else {
      // Year boundary (weekly)
      boundary = date.getUTCFullYear();
    }

    if (boundary !== lastBoundary && lastBoundary !== -1) {
      result.push({ time: c.time });
    }
    lastBoundary = boundary;
  }
  return result;
}
