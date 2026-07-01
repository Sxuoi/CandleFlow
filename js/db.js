/**
 * CandleFlow — IndexedDB persistence layer
 *
 * Stores:
 *   - datasets: base-timeframe OHLCV arrays keyed by dataset signature
 *   - fileHandles: remembered File System Access API handles
 *
 * Dataset signature = SHA-256(symbol|timeframe|fileSize|firstTimestamp|lastTimestamp)
 */

const DB_NAME = 'CandleFlow';
const DB_VERSION = 1;
const STORE_DATASETS = 'datasets';
const STORE_HANDLES = 'fileHandles';

/** @type {Promise<IDBDatabase>|null} */
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_DATASETS)) {
        db.createObjectStore(STORE_DATASETS, { keyPath: 'signature' });
      }
      if (!db.objectStoreNames.contains(STORE_HANDLES)) {
        db.createObjectStore(STORE_HANDLES, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/**
 * Generate a dataset signature from metadata.
 * @param {{ symbol: string, timeframe: string, fileSize: number, firstTimestamp: number, lastTimestamp: number }} meta
 * @returns {Promise<string>} hex-encoded SHA-256 hash
 */
export async function generateSignature({ symbol, timeframe, fileSize, firstTimestamp, lastTimestamp }) {
  const raw = `${symbol}|${timeframe}|${fileSize}|${firstTimestamp}|${lastTimestamp}`;
  const buf = new TextEncoder().encode(raw);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Save a parsed dataset to IndexedDB.
 */
export async function saveDataset(signature, meta, candles) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DATASETS, 'readwrite');
    tx.objectStore(STORE_DATASETS).put({ signature, meta, candles });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Load a dataset by signature. Returns null if not found.
 */
export async function loadDataset(signature) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DATASETS, 'readonly');
    const req = tx.objectStore(STORE_DATASETS).get(signature);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/**
 * List all stored dataset metadata (without candle arrays, for perf).
 */
export async function listDatasets() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DATASETS, 'readonly');
    const req = tx.objectStore(STORE_DATASETS).getAll();
    req.onsuccess = () => {
      // Return meta only — candle arrays are huge
      resolve(req.result.map(d => ({ signature: d.signature, meta: d.meta })));
    };
    req.onerror = () => reject(req.error);
  });
}

// ── File handle persistence (Chromium File System Access API) ──

export async function saveFileHandle(handle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HANDLES, 'readwrite');
    tx.objectStore(STORE_HANDLES).put({ id: 'lastFile', handle });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getFileHandle() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HANDLES, 'readonly');
    const req = tx.objectStore(STORE_HANDLES).get('lastFile');
    req.onsuccess = () => resolve(req.result?.handle || null);
    req.onerror = () => reject(req.error);
  });
}
