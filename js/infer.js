/**
 * CandleFlow — Symbol / timeframe inference from filename
 *
 * Common MT5 export patterns:
 *   XAUUSD_M1.csv
 *   XAUUSDu_M1_202512190711_202604060756.csv
 *   EURUSD_H4.csv
 */

const TIMEFRAMES = ['MN1', 'W1', 'D1', 'H4', 'H1', 'M30', 'M15', 'M5', 'M1'];

/**
 * Attempt to extract symbol and timeframe from a filename.
 * @param {string} filename
 * @returns {{ symbol: string|null, timeframe: string|null }}
 */
export function inferFromFilename(filename) {
  // Strip extension
  const name = filename.replace(/\.\w+$/, '');

  let symbol = null;
  let timeframe = null;

  // Try: SYMBOL_TIMEFRAME  or  SYMBOL_TIMEFRAME_anything
  for (const tf of TIMEFRAMES) {
    const re = new RegExp(`^(.+?)_${tf}(?:_|$)`, 'i');
    const m = name.match(re);
    if (m) {
      symbol = m[1];           // Keep original casing (broker suffix etc.)
      timeframe = tf.toUpperCase();
      break;
    }
  }

  // Fallback: look for timeframe token anywhere, derive symbol from preceding text
  if (!timeframe) {
    for (const tf of TIMEFRAMES) {
      const idx = name.toUpperCase().indexOf(tf);
      if (idx >= 0) {
        timeframe = tf;
        if (idx > 0) {
          symbol = name.substring(0, idx).replace(/[_\-]$/, '');
        }
        break;
      }
    }
  }

  return { symbol, timeframe };
}
