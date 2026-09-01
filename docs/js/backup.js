// Export and restore everything personal.
//
// There is no true auto-backup on an iPhone: the API that lets a page rewrite the same
// file without asking (showSaveFilePicker) does not exist in Safari. So this is one tap
// plus a nudge when it goes stale, which is the strongest thing actually available.

import * as store from './store.js';

const STALE_DAYS = 14;

const stamp = () => new Date().toISOString().slice(0, 10);

export const filename = () => `umd-nutrition-${stamp()}.json`;

export function payload() {
  return JSON.stringify(store.snapshot(), null, 2);
}

// What a restore would bring back, so it can be shown before anything is overwritten.
export function describe(data) {
  const n = (o) => Object.keys(o || {}).length;
  return [
    `${n(data.overrides)} corrected items`,
    `${n(data.targets)} custom targets`,
    `${(data.plate || []).length} items on the saved plate`,
    `${(data.avoid || []).length} allergens avoided`,
  ];
}

export async function save() {
  const file = new File([payload()], filename(), { type: 'application/json' });

  // The share sheet is the good path on iOS: Save to Files lets you overwrite the same
  // file instead of piling up backup(3).json.
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'UMD Nutrition backup' });
      store.set('lastBackup', new Date().toISOString());
      return 'shared';
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
    }
  }

  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename();
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  store.set('lastBackup', new Date().toISOString());
  return 'downloaded';
}

export function read(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(JSON.parse(reader.result));
      } catch {
        reject(new Error('That file is not valid JSON.'));
      }
    };
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsText(file);
  });
}

export function restore(data) {
  store.replaceAll(data);
}

export function backupAge() {
  const last = store.get('lastBackup');
  if (!last) return { days: null, stale: true };
  const days = Math.floor((Date.now() - new Date(last)) / 86400000);
  return { days, stale: days >= STALE_DAYS };
}
