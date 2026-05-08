import { mkdirSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

function slugify(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function isManualCheckpointEnabled(config = {}) {
  return Boolean(config.browser?.manual_checkpoint);
}

export function sessionStatePath(config = {}, site = 'default') {
  const dir = resolve(config.browser?.storage_state_dir || '.sessions');
  return resolve(dir, `${slugify(site || 'default')}.json`);
}

export async function loadSessionState(config = {}, site) {
  const statePath = sessionStatePath(config, site);
  if (existsSync(statePath)) return statePath;
  return undefined;
}

export async function saveSessionState(context, config = {}, site) {
  if (!context || typeof context.storageState !== 'function') return null;
  const statePath = sessionStatePath(config, site);
  mkdirSync(dirname(statePath), { recursive: true });
  await context.storageState({ path: statePath });
  return statePath;
}

export async function runManualCheckpoint({
  context,
  config,
  site,
  reason,
  message,
}) {
  if (!isManualCheckpointEnabled(config)) {
    throw new Error(message);
  }

  console.log(`\n⏸ Manual checkpoint for ${site}`);
  console.log(`   Reason: ${reason}`);
  console.log(`   ${message}`);
  console.log('   Complete the step in the visible browser, then press Enter here to continue.');

  if (config.browser?.headless !== false) {
    console.log('   ⚠️ browser.headless is true. Manual checkpoint works best with headless: false.');
  }

  const rl = readline.createInterface({ input, output });
  try {
    await rl.question('   Press Enter after manual login / captcha / challenge is complete...');
  } finally {
    rl.close();
  }

  const statePath = await saveSessionState(context, config, site);
  if (statePath) {
    console.log(`   💾 Saved session state: ${statePath}`);
  }
}
