// browser.js — Dual-engine browser wrapper
// Supports rebrowser-playwright (default) and bb-browser

import { chromium as rebrowserChromium } from 'rebrowser-playwright';
import { existsSync } from 'fs';
import { loadSessionState, saveSessionState } from './manual-checkpoint.js';

let sharedPlaywrightSession = null;

async function resolveChromium(config = {}) {
  const engine = resolveEngine(config);
  if (engine === 'playwright-official' || engine === 'official') {
    const mod = await import('playwright');
    return mod.chromium;
  }
  return rebrowserChromium;
}

function resolveExecutablePath(chromium) {
  try {
    const bundled = typeof chromium.executablePath === 'function' ? chromium.executablePath() : '';
    if (bundled && existsSync(bundled)) return bundled;
  } catch {}

  const chromePaths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];

  return chromePaths.find((path) => existsSync(path));
}

function resolveEngine(config) {
  if (config._engine) return config._engine;
  if (config.browser?.engine) return config.browser.engine;
  return 'playwright';
}

async function connectExistingBrowser(config = {}, chromium = rebrowserChromium) {
  const cdpUrl = config.browser?.cdp_url;
  if (!cdpUrl) return null;

  const browser = await chromium.connectOverCDP(cdpUrl);
  const contexts = browser.contexts();
  const context = contexts[0] || await browser.newContext();
  const pages = context.pages();
  const page = pages[0] || await context.newPage();
  return { browser, context, page, reused: true };
}

export async function launchBrowser(config = {}) {
  const browserOpts = config.browser || {};
  if (browserOpts.shared_session && sharedPlaywrightSession) {
    return { ...sharedPlaywrightSession, reused: true, shared: true };
  }
  const chromium = await resolveChromium(config);
  const reused = await connectExistingBrowser(config, chromium).catch(() => null);
  if (reused) return reused;
  const executablePath = resolveExecutablePath(chromium);
  const storageState = await loadSessionState(
    config,
    config._sessionSite || config._targetUrl || config.product?.url || 'default',
  );

  const browser = await chromium.launch({
    headless: browserOpts.headless !== false,
    executablePath,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  const context = await browser.newContext({
    ...(storageState ? { storageState } : {}),
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  const page = await context.newPage();
  const session = { browser, context, page };
  if (browserOpts.shared_session) {
    sharedPlaywrightSession = session;
  }
  return session;
}

export async function withBrowser(config, fn) {
  const engine = resolveEngine(config);

  if (engine === 'bb') {
    const { BbPage, isBbAvailable } = await import('./bb.js');
    if (!isBbAvailable()) {
      console.warn('⚠️  bb-browser not found, falling back to playwright');
      return withBrowser({ ...config, _engine: 'playwright' }, fn);
    }
    const { maybeUpdateBbSites } = await import('./bb-update.js');
    await maybeUpdateBbSites(config);
    const page = new BbPage(config);
    try {
      return await fn({ browser: null, context: null, page });
    } finally {
      await page.cleanup(); // close all tabs opened during this session
    }
  }

  // Default: rebrowser-playwright
  const { browser, context, page, reused, shared } = await launchBrowser(config);
  try {
    return await fn({ browser, context, page });
  } finally {
    if (!reused && !shared) {
      await saveSessionState(
        context,
        config,
        config._sessionSite || config._targetUrl || config.product?.url || 'default',
      ).catch(() => {});
      await browser.close();
    }
  }
}

/**
 * Create a long-lived browser session (for batch-submit.js)
 * Returns { page, close } — close() cleans up resources
 */
export async function createSession(config = {}) {
  const engine = resolveEngine(config);

  if (engine === 'bb') {
    const { BbPage, isBbAvailable } = await import('./bb.js');
    if (!isBbAvailable()) {
      console.warn('⚠️  bb-browser not found, falling back to playwright');
      return createSession({ ...config, _engine: 'playwright' });
    }
    const { maybeUpdateBbSites } = await import('./bb-update.js');
    await maybeUpdateBbSites(config);
    const page = new BbPage(config);
    return { page, close: async () => page.cleanup() };
  }

  const { browser, page, reused, shared } = await launchBrowser(config);
  return { page, close: async () => { if (!reused && !shared) await browser.close(); } };
}

export async function closeSharedBrowser() {
  if (!sharedPlaywrightSession) return;
  const { browser, context } = sharedPlaywrightSession;
  await saveSessionState(context, {}, 'shared').catch(() => {});
  await browser.close().catch(() => {});
  sharedPlaywrightSession = null;
}

// Human-like delays
export function delay(ms) {
  const jitter = Math.random() * ms * 0.3;
  return new Promise(r => setTimeout(r, ms + jitter));
}

export async function humanType(page, selector, text, opts = {}) {
  // bb-browser uses real Chrome — no need for character-by-character typing
  if (page.constructor.name === 'BbPage') {
    await page.evalFill(selector, text);
    return;
  }

  // Playwright path: type character by character
  await page.click(selector);
  await delay(200);
  await page.fill(selector, '');
  for (const char of text) {
    await page.type(selector, char, { delay: 30 + Math.random() * 70 });
  }
}
