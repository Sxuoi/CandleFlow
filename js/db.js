/**
 * CandleFlow — IndexedDB persistence layer (PRD §5 Phase 6)
 *
 * Stores:
 *   - candles: base-timeframe OHLCV arrays keyed by dataset signature (read once on load)
 *   - datasets: metadata, drawings, indicators, replay state (updated frequently, lightweight)
 *   - appState: global states like lastActiveSignature
 *   - fileHandles: remembered File System Access API handles
 */

const DB_NAME = 'CandleFlow';
const DB_VERSION = 2; // Upgraded to v2 to separate candles and metadata
const STORE_DATASETS = 'datasets';
const STORE_CANDLES = 'candles';
const STORE_STATE = 'appState';
const STORE_HANDLES = 'fileHandles';

/** @type {Promise<IDBDatabase>|null} */
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const oldVersion = e.oldVersion;

      // Reset old v1 stores to cleanly upgrade schema
      if (oldVersion < 2) {
        if (db.objectStoreNames.contains('datasets')) {
          db.deleteObjectStore('datasets');
        }
        if (db.objectStoreNames.contains('fileHandles')) {
          db.deleteObjectStore('fileHandles');
        }
      }

      if (!db.objectStoreNames.contains(STORE_DATASETS)) {
        db.createObjectStore(STORE_DATASETS, { keyPath: 'signature' });
      }
      if (!db.objectStoreNames.contains(STORE_CANDLES)) {
        db.createObjectStore(STORE_CANDLES, { keyPath: 'signature' });
      }
      if (!db.objectStoreNames.contains(STORE_STATE)) {
        db.createObjectStore(STORE_STATE, { keyPath: 'key' });
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
    const tx = db.transaction([STORE_DATASETS, STORE_CANDLES], 'readwrite');
    
    // Put meta + state skeleton
    tx.objectStore(STORE_DATASETS).put({
      signature,
      meta,
      drawings: [],
      indicators: [],
      replayState: null,
      lastActiveTime: Date.now()
    });

    // Put large candles array in separate store
    tx.objectStore(STORE_CANDLES).put({
      signature,
      candles
    });

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
    const tx = db.transaction([STORE_DATASETS, STORE_CANDLES], 'readwrite');
    const datasetReq = tx.objectStore(STORE_DATASETS).get(signature);
    const candlesReq = tx.objectStore(STORE_CANDLES).get(signature);

    // Update last active timestamp
    datasetReq.onsuccess = () => {
      const data = datasetReq.result;
      if (data) {
        data.lastActiveTime = Date.now();
        tx.objectStore(STORE_DATASETS).put(data);
      }
    };

    tx.oncomplete = () => {
      const dataset = datasetReq.result;
      const candlesData = candlesReq.result;
      if (dataset && candlesData) {
        resolve({
          signature: dataset.signature,
          meta: dataset.meta,
          drawings: dataset.drawings || [],
          indicators: dataset.indicators || [],
          replayState: dataset.replayState || null,
          candles: candlesData.candles
        });
      } else {
        resolve(null);
      }
    };

    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Delete a dataset from IndexedDB.
 */
export async function deleteDataset(signature) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_DATASETS, STORE_CANDLES], 'readwrite');
    tx.objectStore(STORE_DATASETS).delete(signature);
    tx.objectStore(STORE_CANDLES).delete(signature);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Save lightweight user modifications (drawings, indicators, replay)
 * without rewriting the large candles database.
 */
export async function saveUserState(signature, state) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DATASETS, 'readwrite');
    const store = tx.objectStore(STORE_DATASETS);
    const req = store.get(signature);

    req.onsuccess = () => {
      const dataset = req.result;
      if (dataset) {
        if ('drawings' in state) dataset.drawings = state.drawings;
        if ('indicators' in state) dataset.indicators = state.indicators;
        if ('replayState' in state) dataset.replayState = state.replayState;
        if ('meta' in state) dataset.meta = state.meta;
        dataset.lastActiveTime = Date.now();
        store.put(dataset);
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * List all stored dataset metadata (sorted by lastActiveTime descending).
 */
export async function listDatasets() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DATASETS, 'readonly');
    const req = tx.objectStore(STORE_DATASETS).getAll();
    req.onsuccess = () => {
      const sorted = req.result.sort((a, b) => (b.lastActiveTime || 0) - (a.lastActiveTime || 0));
      resolve(sorted.map(d => ({
        signature: d.signature,
        meta: d.meta,
        lastActiveTime: d.lastActiveTime || 0,
        drawingsCount: d.drawings?.length || 0,
        indicatorsCount: d.indicators?.length || 0
      })));
    };
    req.onerror = () => reject(req.error);
  });
}

// ── App State (for auto-load last session) ──

export async function setLastActiveSignature(signature) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_STATE, 'readwrite');
    tx.objectStore(STORE_STATE).put({ key: 'lastActiveSignature', value: signature });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getLastActiveSignature() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_STATE, 'readonly');
    const req = tx.objectStore(STORE_STATE).get('lastActiveSignature');
    req.onsuccess = () => resolve(req.result?.value || null);
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
