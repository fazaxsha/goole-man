import os from 'node:os';
import { detectProfiles, runningProfiles, inspectProfile } from './chrome.js';

export async function scanRoot({ store, root, onProgress }) {
  const profiles = await detectProfiles(root);
  const running = await runningProfiles();
  const concurrency = Math.max(2, Math.min(6, os.cpus().length - 1));
  const queue = profiles.slice();
  let done = 0;
  const errors = [];

  const worker = async () => {
    while (queue.length) {
      const p = queue.shift();
      try {
        const rec = await inspectProfile({ profilePath: p.path, name: p.name, root, running });
        store.saveProfile(rec);
        if (rec.error) errors.push({ name: p.name, error: rec.error });
      } catch (err) {
        errors.push({ name: p.name, error: err?.message ?? String(err) });
      }
      done += 1;
      onProgress?.({ done, total: profiles.length, current: p.name, errors: errors.length });
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return { found: profiles.length, scanned: done, errors };
}
