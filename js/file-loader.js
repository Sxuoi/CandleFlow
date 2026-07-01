/**
 * CandleFlow — File loading
 *
 * Two paths per PRD §4.5:
 *   1. File System Access API (showOpenFilePicker) — Chromium, persistent handle
 *   2. Drag-and-drop — universal fallback
 */

import { saveFileHandle, getFileHandle } from './db.js';

/** Feature detection */
export const hasFileSystemAccess = ('showOpenFilePicker' in window);

/**
 * Open a CSV via the File System Access API.
 * @returns {Promise<{ text: string, fileName: string, fileSize: number }|null>}
 */
export async function openFilePicker() {
  if (!hasFileSystemAccess) return null;

  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: 'CSV Files', accept: { 'text/csv': ['.csv'] } }],
      multiple: false,
    });

    // Persist handle for re-use across sessions
    try { await saveFileHandle(handle); } catch (e) { console.warn('Could not save file handle:', e); }

    const file = await handle.getFile();
    const text = await file.text();
    return { text, fileName: file.name, fileSize: file.size };
  } catch (e) {
    if (e.name === 'AbortError') return null; // user cancelled picker
    throw e;
  }
}

/**
 * Try to reopen the last-used file from a stored handle.
 * Only works in Chromium; requires per-session permission re-grant.
 */
export async function reopenLastFile() {
  if (!hasFileSystemAccess) return null;

  try {
    const handle = await getFileHandle();
    if (!handle) return null;

    // Check / request permission
    let perm = await handle.queryPermission({ mode: 'read' });
    if (perm !== 'granted') {
      perm = await handle.requestPermission({ mode: 'read' });
    }
    if (perm !== 'granted') return null;

    const file = await handle.getFile();
    return { text: await file.text(), fileName: file.name, fileSize: file.size };
  } catch {
    return null;
  }
}

/**
 * Wire drag-and-drop on an element.
 * @param {HTMLElement} target     Element that accepts the drop (usually document.body)
 * @param {HTMLElement} dropZone   Overlay element shown during drag
 * @param {function}    onFile     Callback: (fileData, error?) => void
 * @returns {function}  Cleanup function to remove listeners
 */
export function setupDragDrop(target, dropZone, onFile) {
  let dragCounter = 0;

  const onDragEnter = (e) => { e.preventDefault(); dragCounter++; dropZone.classList.remove('hidden'); };
  const onDragOver  = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; };
  const onDragLeave = (e) => { e.preventDefault(); if (--dragCounter <= 0) { dragCounter = 0; dropZone.classList.add('hidden'); } };

  const onDrop = async (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropZone.classList.add('hidden');

    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.csv')) {
      onFile(null, new Error('Please drop a .csv file'));
      return;
    }

    const text = await file.text();
    onFile({ text, fileName: file.name, fileSize: file.size });
  };

  target.addEventListener('dragenter', onDragEnter);
  target.addEventListener('dragover',  onDragOver);
  target.addEventListener('dragleave', onDragLeave);
  target.addEventListener('drop',      onDrop);

  return () => {
    target.removeEventListener('dragenter', onDragEnter);
    target.removeEventListener('dragover',  onDragOver);
    target.removeEventListener('dragleave', onDragLeave);
    target.removeEventListener('drop',      onDrop);
  };
}
