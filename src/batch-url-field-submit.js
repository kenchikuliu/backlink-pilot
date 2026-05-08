#!/usr/bin/env node

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { createSession, delay, humanType } from './browser.js';
import { recordSubmission, hasSuccessfulSubmission, findSubmissionHistory } from './tracker.js';
import { hydrateConfigProduct, validateResolvedProduct } from './product.js';
import { loadConfig } from './config.js';

const TIMEOUT_MS = 30000;
const SUBMIT_ENTRY_RE = /submit|add\s*(url|site|link|bookmark|story)?|new\s*(story|link|post)|publish|post\s*(story|link)?|create/i;

const COMMENT_TEMPLATES = [
  'Useful resource. Sharing this here in case it helps others.',
  'Thanks for the write-up. Adding a related tool link for reference.',
  'Helpful post. This tool may also be relevant to readers here.',
  'Interesting page. Dropping a related resource that solves a similar workflow.',
  'Useful context. This might be a helpful companion tool for this topic.',
];

function todayLogPath() {
  return `logs/url-field-submissions-${new Date().toISOString().split('T')[0]}.json`;
}

function ensureLogsDir() {
  if (!existsSync('logs')) mkdirSync('logs', { recursive: true });
}

function loadDailyLog() {
  ensureLogsDir();
  const path = todayLogPath();
  if (!existsSync(path)) return { submissions: [] };
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function saveDailyLog(log) {
  writeFileSync(todayLogPath(), JSON.stringify(log, null, 2), 'utf-8');
}

function alreadyAttempted(productName, url) {
  return hasSuccessfulSubmission(productName, url);
}

function hasAnyHistory(productName, url) {
  return findSubmissionHistory(productName, url).length > 0;
}

async function prepareConfig(productUrl) {
  const config = await loadConfig(undefined, { allowMissingProduct: true });
  const hydrated = await hydrateConfigProduct(config, productUrl);
  validateResolvedProduct(hydrated);
  hydrated._engine = 'playwright';
  hydrated.browser = { ...(hydrated.browser || {}), headless: true, timeout: TIMEOUT_MS };
  return hydrated;
}

async function visible(locator) {
  try {
    return await locator.isVisible();
  } catch {
    return false;
  }
}

async function firstVisible(page, selectors, { editable = false } = {}) {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const node = locator.nth(index);
      if (!(await visible(node))) continue;
      if (await isLikelyTrapField(node)) continue;
      if (editable) {
        const ok = await node.isEditable().catch(() => false);
        if (!ok) continue;
      }
      const resolvedSelector = index === 0 ? selector : `${selector} >> nth=${index}`;
      return { selector: resolvedSelector, index, locator: node };
    }
  }
  return null;
}

async function dismissObstructions(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => {
    const selectors = [
      '[id^="google_ads_iframe"]',
      '[id*="interstitial" i]',
      '[id*="overlay" i]',
      '[id*="popup" i]',
      '[class*="interstitial" i]',
      '[class*="overlay" i]',
      '[class*="popup" i]',
      '[class*="modal" i]',
      '.adsbygoogle',
      'ins.adsbygoogle',
    ];

    for (const selector of selectors) {
      for (const node of Array.from(document.querySelectorAll(selector))) {
        const rect = node.getBoundingClientRect?.();
        const style = window.getComputedStyle(node);
        const coversScreen = rect &&
          rect.width > window.innerWidth * 0.35 &&
          rect.height > window.innerHeight * 0.2 &&
          (style.position === 'fixed' || style.position === 'absolute' || Number(style.zIndex || 0) > 100);
        const adish = /google|ad|popup|overlay|interstitial|modal/i.test([
          node.id,
          node.className,
          node.getAttribute('aria-label'),
        ].join(' '));
        if (coversScreen || adish) node.remove();
      }
    }

    for (const node of Array.from(document.body.querySelectorAll('div, a, iframe'))) {
      const rect = node.getBoundingClientRect?.();
      if (!rect) continue;
      const style = window.getComputedStyle(node);
      const highLayer = style.position === 'fixed' || Number(style.zIndex || 0) > 999;
      const large = rect.width > window.innerWidth * 0.5 && rect.height > window.innerHeight * 0.25;
      const emptyOrAd = !String(node.textContent || '').trim() ||
        /ad|ads|banner|popup|overlay|interstitial/i.test([node.id, node.className, node.getAttribute('href')].join(' '));
      if (highLayer && large && emptyOrAd) node.remove();
    }
  }).catch(() => {});
  await delay(200);
}

async function isLikelyTrapField(locator) {
  return locator.evaluate((node) => {
    const value = (attr) => String(node.getAttribute(attr) || '').toLowerCase();
    const tagName = String(node.tagName || '').toLowerCase();
    const type = value('type');
    const combined = [
      value('name'),
      value('id'),
      value('class'),
      value('aria-label'),
      value('placeholder'),
      value('autocomplete'),
    ].join(' ');

    if (node.disabled || node.readOnly) return true;
    if (node.getAttribute('aria-hidden') === 'true') return true;
    if (node.getAttribute('tabindex') === '-1') return true;
    if (type === 'hidden') return true;
    if (/honeypot|anti.?spam|trap|do.?not.?fill|hp-|hidden/.test(combined)) return true;
    if (tagName === 'input' && ['submit', 'button', 'image', 'checkbox', 'radio', 'file'].includes(type)) return true;
    return false;
  }).catch(() => false);
}

async function formIndexFor(locator) {
  return locator.evaluate((node) => {
    const form = node.closest('form');
    if (!form) return -1;
    return Array.from(document.forms || []).indexOf(form);
  }).catch(() => -1);
}

async function buttonScore(locator) {
  return locator.evaluate((node) => {
    const attr = (name) => String(node.getAttribute(name) || '').toLowerCase();
    const text = String(node.textContent || '').toLowerCase();
    const value = 'value' in node ? String(node.value || '').toLowerCase() : '';
    const combined = [
      text,
      value,
      attr('aria-label'),
      attr('title'),
      attr('class'),
      attr('id'),
      attr('name'),
      attr('href'),
    ].join(' ').replace(/\s+/g, ' ').trim();

    if (!combined) return 0;
    if (/search|newsletter|subscribe|filter|login|sign.?in|register/.test(combined)) return -50;

    let score = 0;
    if (/post\s+comment|submit\s+comment|leave\s+comment/.test(combined)) score += 20;
    if (/submit|send|post|publish|save|add|share/.test(combined)) score += 10;
    if (/comment|reply|url|website|link|bookmark|story/.test(combined)) score += 5;
    if (node.matches?.('button[type="submit"], input[type="submit"]')) score += 3;
    return score;
  }).catch(() => 0);
}

async function firstGoodSubmitIn(scope) {
  const selectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button[class*="submit" i]',
    'input[class*="submit" i]',
    'button',
    '[role="button"]',
    'a[class*="submit" i]',
  ];
  let best = null;

  for (const selector of selectors) {
    const locator = scope.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (!(await visible(candidate))) continue;
      const score = await buttonScore(candidate);
      if (score <= 0) continue;
      if (!best || score > best.score) {
        best = { locator: candidate, score };
      }
    }
  }

  return best;
}

async function findBestSubmit(page, fields) {
  const formIndexes = [];
  for (const field of [fields.comment, fields.url, fields.email, fields.name]) {
    if (!field?.locator) continue;
    const index = await formIndexFor(field.locator);
    if (index >= 0 && !formIndexes.includes(index)) formIndexes.push(index);
  }

  for (const formIndex of formIndexes) {
    const form = page.locator('form').nth(formIndex);
    const match = await firstGoodSubmitIn(form);
    if (match) return { selector: `form >> nth=${formIndex}`, locator: match.locator };
  }

  const globalMatch = await firstGoodSubmitIn(page);
  if (globalMatch) return { selector: '', locator: globalMatch.locator };
  return null;
}

async function findFields(page) {
  const fields = {
    url: await firstVisible(page, [
      'input[type="url"]',
      'input[name="url"]',
      'input[name*="website" i]',
      'input[name*="url" i]',
      'input[id*="website" i]',
      'input[id*="url" i]',
      'input[placeholder*="website" i]',
      'input[placeholder*="url" i]',
    ], { editable: true }),
    name: await firstVisible(page, [
      'input[name="author"]',
      'input[name*="name" i]',
      'input[id*="name" i]',
      'input[placeholder*="name" i]',
    ], { editable: true }),
    email: await firstVisible(page, [
      'input[type="email"]',
      'input[name*="email" i]',
      'input[id*="email" i]',
      'input[placeholder*="email" i]',
    ], { editable: true }),
    comment: await firstVisible(page, [
      'textarea[name*="comment" i]',
      'textarea[name*="message" i]',
      'textarea[name*="description" i]',
      'textarea',
      'input[name*="comment" i]',
      'input[name*="message" i]',
    ], { editable: true }),
  };
  fields.submit = await findBestSubmit(page, fields);
  return fields;
}

async function fillField(page, field, value) {
  if (!field?.locator) return;
  await dismissObstructions(page);
  await field.locator.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await field.locator.fill('');
    await humanType(page, field.selector, value);
    return;
  } catch {}

  await field.locator.evaluate((node, nextValue) => {
    node.focus?.();
    node.value = '';
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.value = nextValue;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

function detectBlockers(title, body, html) {
  const text = `${title}\n${body}\n${html}`.toLowerCase();
  if (/just a moment|attention required|enable javascript and cookies to continue|cf_chl_opt|challenges\.cloudflare\.com/.test(text)) {
    return 'cloudflare_blocked';
  }
  if (/captcha|recaptcha|turnstile|verify you are human|i am human|i'm human/.test(text)) {
    return 'captcha_blocked';
  }
  if (/\/(login|signin|sign-in|register|signup|sign-up)(\.php)?\/?$/i.test(text.split('\n')[0] || '')) {
    return 'manual_login_needed';
  }
  if (/sign in|log in|login|create account|register/.test(text) && !/comment|website|url|message|submit/.test(text)) {
    return 'manual_login_needed';
  }
  if (/pricing|checkout|payment|subscribe|\$\d+/.test(text) && !/free/.test(text)) {
    return 'paid_only';
  }
  return null;
}

async function followSubmitEntry(page) {
  const current = new URL(page.url());
  const entries = await page.evaluate((patternSource) => {
    const pattern = new RegExp(patternSource, 'i');
    const items = [];
    for (const el of Array.from(document.querySelectorAll('a[href], button'))) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const href = el.getAttribute('href') || '';
      const label = [text, href, el.getAttribute('aria-label') || '', el.getAttribute('title') || ''].join(' ');
      if (!pattern.test(label)) continue;
      items.push({ text, href });
    }
    return items;
  }, SUBMIT_ENTRY_RE.source).catch(() => []);

  const ranked = entries
    .map((item) => {
      let score = 0;
      const label = `${item.text} ${item.href}`.toLowerCase();
      if (/submit/.test(label)) score += 5;
      if (/add/.test(label)) score += 4;
      if (/url|site|link|bookmark|story/.test(label)) score += 3;
      if (/login|sign.?in|register|signup/.test(label)) score -= 6;
      return { ...item, score };
    })
    .sort((a, b) => b.score - a.score);

  for (const item of ranked) {
    if (!item.href || item.href === '#') continue;
    const next = new URL(item.href, page.url());
    if (next.hostname.replace(/^www\./, '') !== current.hostname.replace(/^www\./, '')) continue;
    await page.goto(next.toString(), { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS }).catch(() => null);
    await delay(1200);
    return true;
  }

  return false;
}

async function tryKnownSubmitPaths(page) {
  const base = new URL(page.url());
  const origin = base.origin;
  const paths = [
    '/submit',
    '/submit/',
    '/submit.php',
    '/submit-story',
    '/submit-story/',
    '/submit-link',
    '/add',
    '/add/',
    '/addurl',
    '/addurl/',
    '/add-site',
    '/add-site/',
    '/add-link',
    '/add-link/',
    '/story/new',
    '/new',
  ];

  for (const path of paths) {
    const target = `${origin}${path}`;
    const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => null);
    const status = response?.status?.() || 0;
    if (status && status >= 400) continue;
    await delay(1000);
    const fields = await findFields(page);
    if (fields.url || fields.comment || fields.name) return { followed: true, fields };
    const body = ((await page.textContent('body').catch(() => '')) || '').toLowerCase();
    if (/login|sign.?in|register|create.?account/.test(body)) return { followed: true, fields };
  }

  return { followed: false, fields: null };
}

async function processOne(page, candidate, product) {
  await page.goto(candidate.url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await delay(1500);
  await dismissObstructions(page);

  const title = await page.textContent('title').catch(() => '');
  const body = (await page.textContent('body').catch(() => '')) || '';
  const html = (await page.content().catch(() => '')) || '';
  const blocker = detectBlockers(`${page.url()}\n${title}`, body.slice(0, 2000), html.slice(0, 4000));
  if (blocker) {
    return { status: blocker, reason: blocker };
  }

  let fields = await findFields(page);
  if (!fields.url) {
    const followed = await followSubmitEntry(page);
    if (followed) {
      const nextTitle = await page.textContent('title').catch(() => '');
      const nextBody = (await page.textContent('body').catch(() => '')) || '';
      const nextHtml = (await page.content().catch(() => '')) || '';
      const nextBlocker = detectBlockers(nextTitle, nextBody.slice(0, 2000), nextHtml.slice(0, 4000));
      if (nextBlocker) return { status: nextBlocker, reason: nextBlocker };
      fields = await findFields(page);
    }
  }
  if (!fields.url) {
    const attempted = await tryKnownSubmitPaths(page);
    if (attempted.fields) fields = attempted.fields;
  }
  if (!fields.url) {
    return { status: 'failed', reason: 'no_url_field', error: 'No usable URL field found.' };
  }

  const targetUrl = product.utm_url || product.url;
  await fillField(page, fields.url, targetUrl);
  await delay(300);

  if (fields.name) {
    await fillField(page, fields.name, product.name);
    await delay(250);
  }

  if (fields.email) {
    await fillField(page, fields.email, product.email);
    await delay(250);
  }

  if (fields.comment) {
    const comment = COMMENT_TEMPLATES[Math.floor(Math.random() * COMMENT_TEMPLATES.length)];
    await fillField(page, fields.comment, comment);
    await delay(250);
  }

  if (!fields.submit) {
    return { status: 'failed', reason: 'no_submit', error: 'No visible submit control found.' };
  }

  try {
    await dismissObstructions(page);
    await fields.submit.locator.scrollIntoViewIfNeeded().catch(() => {});
    await fields.submit.locator.click({ timeout: 10000 });
    await delay(2500);
    return { status: 'submitted', confirmation: 'URL field submission completed — verify manually' };
  } catch (error) {
    try {
      await fields.submit.locator.evaluate((node) => {
        if (node instanceof HTMLElement) node.click();
      });
      await delay(2500);
      return { status: 'submitted', confirmation: 'URL field submission completed via DOM click — verify manually' };
    } catch {
      return { status: 'failed', reason: 'submit_click_failed', error: String(error?.message || error) };
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  let productUrl = 'https://www.bulkqrcodegenerator.art';
  let pool = 'logs/bulkqrcodegenerator-url-field-pool-2026-05-08.json';
  let limit = 10;
  let skipAttempted = false;
  let engine = 'playwright';
  let manualCheckpoint = false;

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--product-url') productUrl = args[++i];
    else if (args[i] === '--pool') pool = args[++i];
    else if (args[i] === '--limit') limit = Number(args[++i] || 10);
    else if (args[i] === '--skip-attempted') skipAttempted = true;
    else if (args[i] === '--engine') engine = args[++i] || engine;
    else if (args[i] === '--manual-checkpoint') manualCheckpoint = true;
  }

  const config = await prepareConfig(productUrl);
  if (manualCheckpoint) {
    config.browser = { ...(config.browser || {}), manual_checkpoint: true, headless: false };
  }
  const product = {
    ...config.product,
    utm_url: productUrl,
  };

  const candidates = JSON.parse(readFileSync(pool, 'utf-8'));
  const pending = candidates.filter((item) =>
    !alreadyAttempted(product.name, item.url) &&
    (!skipAttempted || !hasAnyHistory(product.name, item.url))
  );
  const queue = pending.slice(0, limit);

  console.log(`Pending URL-field sites: ${pending.length}`);
  console.log(`This run queue: ${queue.length}`);

  const dailyLog = loadDailyLog();
  const { page, close } = await createSession({
    _engine: engine,
    browser: { headless: !manualCheckpoint, timeout: TIMEOUT_MS, manual_checkpoint: manualCheckpoint },
  });

  try {
    for (let i = 0; i < queue.length; i += 1) {
      const candidate = queue[i];
      console.log(`\n[${i + 1}/${queue.length}] ${candidate.url}`);
      let result;
      try {
        result = await processOne(page, candidate, product);
      } catch (error) {
        result = { status: 'failed', reason: 'runtime_error', error: String(error?.message || error) };
      }

      dailyLog.submissions.push({
        site: candidate.url,
        product: product.name,
        timestamp: new Date().toISOString(),
        ...result,
      });
      saveDailyLog(dailyLog);
      recordSubmission(candidate.url, result.status, {
        product: product.name,
        reason: result.reason,
        error: result.error,
        confirmation: result.confirmation,
      });
      console.log(`  → ${result.status}`);
      await delay(1000);
    }
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
