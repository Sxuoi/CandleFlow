/**
 * CandleFlow — MT5 CSV parser
 *
 * Handles:
 *   - Tab / comma / semicolon delimiters (auto-detect)
 *   - Angle-bracket headers (<DATE>) and plain headers (Date)
 *   - HH:MM and HH:MM:SS time formats
 *   - Extra MT5 columns (TICKVOL, VOL, SPREAD) — TICKVOL used as volume
 *   - Chronological-order validation
 *   - Malformed-row flagging (never silently dropped)
 *   - Session-start misalignment detection (PRD §4.4)
 *
 * @returns {{ candles: Array, warnings: Array, errors: Array }}
 */

export function parseCSV(text) {
  const warnings = [];
  const errors = [];

  // Normalize line endings
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  // ── Locate header row ──
  let headerLine = '';
  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (/date|time|open|high|low|close/i.test(line) || /<DATE>/i.test(line)) {
      headerLine = line;
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) {
    errors.push({ type: 'NO_HEADER', message: 'Could not find a CSV header row containing Date/Time/Open/High/Low/Close columns.' });
    return { candles: [], warnings, errors };
  }

  // ── Detect delimiter ──
  const delimiter = detectDelimiter(headerLine);

  // ── Parse header — strip angle brackets, normalize to uppercase ──
  const headers = headerLine
    .split(delimiter)
    .map(h => h.trim().replace(/^<|>$/g, '').toUpperCase());

  const colMap = mapColumns(headers);
  if (!colMap) {
    errors.push({
      type: 'BAD_HEADER',
      message: `Required columns missing. Found: [${headers.join(', ')}]. Need at minimum: DATE, TIME, OPEN, HIGH, LOW, CLOSE, and one of VOLUME/TICKVOL.`,
    });
    return { candles: [], warnings, errors };
  }

  // Minimum field count required for a valid row
  const minFields = Math.max(colMap.date, colMap.time, colMap.open, colMap.high, colMap.low, colMap.close, colMap.volume) + 1;

  // ── Parse data rows ──
  const candles = [];
  let prevTimestamp = -Infinity;
  let outOfOrderCount = 0;
  let skippedRows = 0;

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = line.split(delimiter);
    const rowNum = i + 1;   // 1-indexed for human-readable messages

    // Field count check
    if (fields.length < minFields) {
      errors.push({ type: 'SHORT_ROW', row: rowNum, message: `Row ${rowNum}: expected ≥${minFields} fields, got ${fields.length}` });
      skippedRows++;
      continue;
    }

    // Date/time
    const dateStr = fields[colMap.date].trim();
    const timeStr = fields[colMap.time].trim();
    const timestamp = parseDateTime(dateStr, timeStr);

    if (timestamp === null) {
      errors.push({ type: 'BAD_DATETIME', row: rowNum, message: `Row ${rowNum}: invalid date/time "${dateStr} ${timeStr}"` });
      skippedRows++;
      continue;
    }

    // OHLCV
    const open = parseFloat(fields[colMap.open]);
    const high = parseFloat(fields[colMap.high]);
    const low = parseFloat(fields[colMap.low]);
    const close = parseFloat(fields[colMap.close]);
    const volume = parseFloat(fields[colMap.volume]);

    if ([open, high, low, close, volume].some(v => isNaN(v))) {
      errors.push({ type: 'BAD_NUMERIC', row: rowNum, message: `Row ${rowNum}: non-numeric OHLCV value` });
      skippedRows++;
      continue;
    }

    // Sanity: high ≥ low
    if (high < low) {
      warnings.push({ type: 'HIGH_LT_LOW', row: rowNum, message: `Row ${rowNum}: High (${high}) < Low (${low})` });
    }

    // Chronological order
    if (timestamp <= prevTimestamp) {
      outOfOrderCount++;
      if (outOfOrderCount <= 5) {
        errors.push({ type: 'NON_CHRONOLOGICAL', row: rowNum, message: `Row ${rowNum}: timestamp not after previous row (${new Date(timestamp * 1000).toISOString()} ≤ ${new Date(prevTimestamp * 1000).toISOString()})` });
      }
    }
    prevTimestamp = timestamp;

    candles.push({ time: timestamp, open, high, low, close, volume });
  }

  // Summarize out-of-order issues
  if (outOfOrderCount > 5) {
    errors.push({ type: 'NON_CHRONOLOGICAL_SUMMARY', message: `${outOfOrderCount} total non-chronological rows (first 5 shown above).` });
  }

  // If any were out of order, sort + deduplicate so the chart gets clean data
  if (outOfOrderCount > 0 && candles.length > 0) {
    candles.sort((a, b) => a.time - b.time);

    // Deduplicate — keep last occurrence for each timestamp
    let writeIdx = 0;
    for (let i = 0; i < candles.length; i++) {
      // Look ahead: if next candle has same time, skip this one
      if (i < candles.length - 1 && candles[i].time === candles[i + 1].time) continue;
      candles[writeIdx++] = candles[i];
    }
    const removed = candles.length - writeIdx;
    candles.length = writeIdx;
    if (removed > 0) {
      warnings.push({ type: 'DUPLICATES_REMOVED', message: `${removed} duplicate-timestamp candle(s) removed after sorting.` });
    }
  }

  if (skippedRows > 0) {
    warnings.push({ type: 'ROWS_SKIPPED', message: `${skippedRows} malformed row(s) were skipped (see errors above).` });
  }

  // ── Session-start misalignment detection (PRD §4.4) ──
  detectSessionMisalignment(candles, warnings);

  return { candles, warnings, errors };
}


// ── Internal helpers ──

function detectDelimiter(headerLine) {
  // Priority: tab → semicolon → comma
  if (headerLine.includes('\t')) return '\t';
  if (headerLine.includes(';'))  return ';';
  return ',';
}

/**
 * Map header names to column indices.
 * Returns null if any required column is missing.
 */
function mapColumns(headers) {
  const map = {};

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    switch (h) {
      case 'DATE':    map.date = i;    break;
      case 'TIME':    map.time = i;    break;
      case 'OPEN':    map.open = i;    break;
      case 'HIGH':    map.high = i;    break;
      case 'LOW':     map.low = i;     break;
      case 'CLOSE':   map.close = i;   break;
      case 'TICKVOL': if (!('volume' in map)) map.volume = i; break;
      case 'VOLUME':  map.volume = i;  break;   // Overrides TICKVOL if both exist
    }
  }

  const required = ['date', 'time', 'open', 'high', 'low', 'close', 'volume'];
  return required.every(k => k in map) ? map : null;
}

/**
 * Parse MT5 date+time strings into a Unix timestamp (seconds, UTC-treated).
 * Date: YYYY.MM.DD  |  YYYY-MM-DD  |  YYYY/MM/DD
 * Time: HH:MM       |  HH:MM:SS
 *
 * Broker server time is kept as-is (no timezone conversion, per PRD §4.4).
 */
function parseDateTime(dateStr, timeStr) {
  const dm = dateStr.match(/^(\d{4})[.\-/](\d{2})[.\-/](\d{2})$/);
  if (!dm) return null;

  const tm = timeStr.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!tm) return null;

  const dt = new Date(Date.UTC(
    +dm[1], +dm[2] - 1, +dm[3],
    +tm[1], +tm[2], +(tm[3] || 0),
  ));

  return isNaN(dt.getTime()) ? null : Math.floor(dt.getTime() / 1000);
}

/**
 * Detect session-start time misalignment across trading days (PRD §4.4).
 * If the first-candle hour differs between days (e.g. 00:00 some days, 01:00 others),
 * surface a non-blocking warning.
 */
function detectSessionMisalignment(candles, warnings) {
  if (candles.length < 100) return;

  const dayStarts = new Map();
  for (const c of candles) {
    const d = new Date(c.time * 1000);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
    if (!dayStarts.has(key)) {
      dayStarts.set(key, d.getUTCHours());
    }
  }

  const startHours = new Set(dayStarts.values());
  if (startHours.size > 1) {
    const sorted = [...startHours].sort((a, b) => a - b);
    warnings.push({
      type: 'SESSION_MISALIGNMENT',
      message: `Session start times vary across trading days (hours: ${sorted.join(', ')}). This may indicate DST / server-time boundary shifts in your broker data.`,
    });
  }
}
