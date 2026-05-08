#!/usr/bin/env node

import { readFileSync } from 'fs';
import { spawn } from 'child_process';
import { findSubmissionHistory, hasSuccessfulSubmission, recordSubmission } from './tracker.js';

const PRODUCT = 'Bulk QR Code Generator for Excel and CSV';
const PRODUCT_URL = 'https://www.bulkqrcodegenerator.art';

function parseArgs(args) {
  const opts = {
    pool: '',
    lane: 'url_field',
    limit: 25,
    productUrl: PRODUCT_URL,
    timeoutMs: 90000,
    delayMs: 1500,
    skipAttempted: true,
    engine: 'playwright-official',
    manualCheckpoint: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--pool') opts.pool = args[++i];
    else if (arg === '--lane') opts.lane = args[++i];
    else if (arg === '--limit') opts.limit = Number(args[++i] || opts.limit);
    else if (arg === '--product-url') opts.productUrl = args[++i] || PRODUCT_URL;
    else if (arg === '--timeout-ms') opts.timeoutMs = Number(args[++i] || opts.timeoutMs);
    else if (arg === '--delay-ms') opts.delayMs = Number(args[++i] || opts.delayMs);
    else if (arg === '--include-attempted') opts.skipAttempted = false;
    else if (arg === '--engine') opts.engine = args[++i] || opts.engine;
    else if (arg === '--manual-checkpoint') opts.manualCheckpoint = true;
  }

  if (!opts.pool) {
    const date = new Date().toISOString().split('T')[0];
    opts.pool = `logs/bulkqrcodegenerator-batchable-${opts.lane}-${date}.json`;
  }

  return opts;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let activeChildPid = null;

function killProcessGroup(pid, signal) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

function installShutdownHandlers() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      killProcessGroup(activeChildPid, 'SIGTERM');
      setTimeout(() => {
        killProcessGroup(activeChildPid, 'SIGKILL');
        process.exit(signal === 'SIGINT' ? 130 : 143);
      }, 2000).unref();
    });
  }
}

function runOne(candidate, opts) {
  const runner = opts.lane === 'content'
    ? 'src/batch-content-submit.js'
    : 'src/batch-url-field-submit.js';

  const child = spawn('node', [
    runner,
    '--pool',
    opts.singlePool,
    '--limit',
    '1',
    '--product-url',
    opts.productUrl,
    '--engine',
    opts.engine,
    ...(opts.manualCheckpoint ? ['--manual-checkpoint'] : []),
  ], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
    detached: true,
  });
  activeChildPid = child.pid;

  let settled = false;
  function killChild(signal) {
    killProcessGroup(child.pid, signal);
  }

  function settle(resolve, value) {
    if (settled) return;
    settled = true;
    if (activeChildPid === child.pid) activeChildPid = null;
    resolve(value);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      killChild('SIGTERM');
      setTimeout(() => killChild('SIGKILL'), 3000).unref();
      settle(resolve, { code: 124, timedOut: true });
    }, opts.timeoutMs);

    child.on('exit', (code) => {
      clearTimeout(timer);
      settle(resolve, { code: code ?? 1, timedOut: false });
    });
    child.on('error', () => {
      clearTimeout(timer);
      settle(resolve, { code: 1, timedOut: false });
    });
  });
}

async function main() {
  installShutdownHandlers();
  const opts = parseArgs(process.argv.slice(2));
  const candidates = JSON.parse(readFileSync(opts.pool, 'utf-8'));
  const queue = candidates
    .filter((item) => {
      if (hasSuccessfulSubmission(PRODUCT, item.url)) return false;
      if (opts.skipAttempted && findSubmissionHistory(PRODUCT, item.url).length > 0) return false;
      return true;
    })
    .slice(0, opts.limit);

  console.log(`Batchable ${opts.lane} pending: ${queue.length}`);
  for (let i = 0; i < queue.length; i += 1) {
    const candidate = queue[i];
    opts.singlePool = `.sessions/single-${process.pid}-${i}.json`;
    await import('fs').then(({ writeFileSync }) => {
      writeFileSync(opts.singlePool, `${JSON.stringify([candidate], null, 2)}\n`, 'utf-8');
    });

    console.log(`\n[${i + 1}/${queue.length}] ${candidate.url}`);
    const result = await runOne(candidate, opts);
    if (result.timedOut) {
      recordSubmission(candidate.url, 'browser_error', {
        product: PRODUCT,
        reason: 'browser_error',
        error: `Timed out after ${opts.timeoutMs}ms`,
      });
      console.error(`Timed out after ${opts.timeoutMs}ms`);
    }
    if (i < queue.length - 1 && opts.delayMs > 0) await delay(opts.delayMs);
  }
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
