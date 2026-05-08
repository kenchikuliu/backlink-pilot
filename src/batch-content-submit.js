#!/usr/bin/env node

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { createSession, delay, humanType } from './browser.js';
import { recordSubmission, hasSuccessfulSubmission } from './tracker.js';
import { hydrateConfigProduct, validateResolvedProduct } from './product.js';
import { loadConfig } from './config.js';

const TIMEOUT_MS = 30000;

function ensureLogsDir() {
  if (!existsSync('logs')) mkdirSync('logs', { recursive: true });
}

function logPath() {
  return `logs/content-submissions-${new Date().toISOString().split('T')[0]}.json`;
}

function loadLog() {
  ensureLogsDir();
  const path = logPath();
  if (!existsSync(path)) return { submissions: [] };
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function saveLog(log) {
  writeFileSync(logPath(), JSON.stringify(log, null, 2), 'utf-8');
}

function alreadyAttempted(productName, url) {
  return hasSuccessfulSubmission(productName, url);
}

async function prepareConfig(productUrl) {
  const config = await loadConfig(undefined, { allowMissingProduct: true });
  const hydrated = await hydrateConfigProduct(config, productUrl);
  validateResolvedProduct(hydrated);
  hydrated._engine = 'playwright';
  hydrated.browser = { ...(hydrated.browser || {}), headless: true, timeout: TIMEOUT_MS };
  return hydrated;
}

function detectState(title, body, html) {
  const text = `${title}\n${body}\n${html}`.toLowerCase();
  if (/just a moment|attention required|enable javascript and cookies to continue|cf_chl_opt|challenges\.cloudflare\.com/.test(text)) return 'cloudflare_blocked';
  if (/captcha|recaptcha|turnstile|verify you are human|i am human|i'm human/.test(text)) return 'captcha_blocked';
  if (/sign in|log in|login|create account|register/.test(text) && !/submit|publish|post|tool|product|link|website|profile/.test(text)) return 'manual_login_needed';
  if (/pricing|checkout|payment|subscribe|\$\d+/.test(text) && !/free/.test(text)) return 'paid_only';
  if (/404|not found|page not found/.test(text)) return 'dead_page';
  return null;
}

async function visible(locator) {
  try {
    return await locator.isVisible();
  } catch {
    return false;
  }
}

async function firstVisible(page, selectors, editable = false) {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const node = locator.nth(i);
      if (!(await visible(node))) continue;
      if (editable) {
        const ok = await node.isEditable().catch(() => false);
        if (!ok) continue;
      }
      return { locator: node, selector: i === 0 ? selector : `${selector} >> nth=${i}` };
    }
  }
  return null;
}

async function processCandidate(page, candidate, product) {
  await page.goto(candidate.url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await delay(1500);

  const title = await page.textContent('title').catch(() => '');
  const body = (await page.textContent('body').catch(() => '')) || '';
  const html = (await page.content().catch(() => '')) || '';
  const state = detectState(title, body.slice(0, 2500), html.slice(0, 5000));
  if (state) return { status: state, reason: state };

  const urlField = await firstVisible(page, [
    'input[type="url"]',
    'input[name*="url" i]',
    'input[name*="website" i]',
    'input[placeholder*="url" i]',
    'input[placeholder*="website" i]',
  ], true);
  const titleField = await firstVisible(page, [
    'input[name*="title" i]',
    'input[name*="name" i]',
    'input[placeholder*="title" i]',
    'input[placeholder*="name" i]',
  ], true);
  const emailField = await firstVisible(page, [
    'input[type="email"]',
    'input[name*="email" i]',
  ], true);
  const textArea = await firstVisible(page, [
    'textarea[name*="description" i]',
    'textarea[name*="content" i]',
    'textarea[name*="message" i]',
    'textarea',
  ], true);
  const submit = await firstVisible(page, [
    'button[type="submit"]',
    'input[type="submit"]',
    'button[class*="submit" i]',
    'button',
    'a[href*="submit" i]',
    'a[href*="publish" i]',
  ]);

  if (!urlField && !titleField && !textArea) {
    return { status: 'failed', reason: 'no_obvious_content_fields', error: 'No obvious content/profile submission fields found.' };
  }

  if (titleField) {
    await titleField.locator.fill('').catch(() => {});
    await humanType(page, titleField.selector, product.name);
    await delay(200);
  }

  if (urlField) {
    await urlField.locator.fill('').catch(() => {});
    await humanType(page, urlField.selector, product.url);
    await delay(200);
  }

  if (emailField) {
    await emailField.locator.fill('').catch(() => {});
    await humanType(page, emailField.selector, product.email);
    await delay(200);
  }

  if (textArea) {
    await textArea.locator.fill('').catch(() => {});
    await humanType(page, textArea.selector, product.description);
    await delay(200);
  }

  if (submit) {
    try {
      await submit.locator.click({ timeout: 10000 });
      await delay(2000);
      return { status: 'submitted', confirmation: 'Content/profile submission attempted — verify manually' };
    } catch (error) {
      return { status: 'failed', reason: 'submit_click_failed', error: String(error?.message || error) };
    }
  }

  return { status: 'failed', reason: 'no_submit_control', error: 'Filled some fields but no submit control found.' };
}

async function main() {
  const args = process.argv.slice(2);
  let productUrl = 'https://www.bulkqrcodegenerator.art';
  let pool = 'logs/bulkqrcodegenerator-content-pool-2026-05-08.json';
  let limit = 76;
  let engine = 'playwright';
  let manualCheckpoint = false;

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--product-url') productUrl = args[++i];
    else if (args[i] === '--pool') pool = args[++i];
    else if (args[i] === '--limit') limit = Number(args[++i] || 76);
    else if (args[i] === '--engine') engine = args[++i] || engine;
    else if (args[i] === '--manual-checkpoint') manualCheckpoint = true;
  }

  const config = await prepareConfig(productUrl);
  if (manualCheckpoint) {
    config.browser = { ...(config.browser || {}), manual_checkpoint: true, headless: false };
  }
  const product = { ...config.product };
  const candidates = JSON.parse(readFileSync(pool, 'utf-8'));
  const pending = candidates.filter((item) => !alreadyAttempted(product.name, item.url));
  const queue = pending.slice(0, limit);
  const log = loadLog();
  const { page, close } = await createSession({
    _engine: engine,
    browser: { headless: !manualCheckpoint, timeout: TIMEOUT_MS, manual_checkpoint: manualCheckpoint },
  });

  console.log(`Pending content/profile sites: ${pending.length}`);
  console.log(`This run queue: ${queue.length}`);

  try {
    for (let i = 0; i < queue.length; i += 1) {
      const candidate = queue[i];
      console.log(`\n[${i + 1}/${queue.length}] ${candidate.url}`);
      let result;
      try {
        result = await processCandidate(page, candidate, product);
      } catch (error) {
        result = { status: 'failed', reason: 'runtime_error', error: String(error?.message || error) };
      }

      log.submissions.push({
        site: candidate.url,
        submit_type: candidate.submit_type,
        product: product.name,
        timestamp: new Date().toISOString(),
        ...result,
      });
      saveLog(log);
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
