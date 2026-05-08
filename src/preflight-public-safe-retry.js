#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { preflightSite } from './site-preflight.js';

const DATE = new Date().toISOString().split('T')[0];
const DEFAULT_INPUT = resolve(`logs/bulkqrcodegenerator-public-safe-retry-${DATE}.json`);
const SUBMIT_PATHS = [
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
  '/add-url',
  '/add-site',
  '/add-link',
  '/story/new',
  '/new',
];

function parseArgs(args) {
  const opts = {
    input: DEFAULT_INPUT,
    lane: 'bookmark',
    concurrency: 8,
    maxProbePaths: 8,
  };

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--input') opts.input = resolve(args[++i]);
    else if (args[i] === '--lane') opts.lane = args[++i] || opts.lane;
    else if (args[i] === '--concurrency') opts.concurrency = Number(args[++i] || opts.concurrency);
    else if (args[i] === '--max-probe-paths') opts.maxProbePaths = Number(args[++i] || opts.maxProbePaths);
  }

  return opts;
}

function ensureDir(path) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function normalizeUrl(value = '') {
  return String(value)
    .trim()
    .replace(/^http:\/\//i, 'https://')
    .replace(/\/+$/, '');
}

function sameOriginCandidates(rawUrl, maxProbePaths) {
  const seen = new Set();
  const out = [];
  const push = (url) => {
    const key = normalizeUrl(url);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(key);
  };

  push(rawUrl);
  try {
    const parsed = new URL(rawUrl);
    const submitish = /submit|add-?(url|site|link)?|story\/new|\/new\/?$/i.test(parsed.pathname);
    if (!submitish) {
      for (const path of SUBMIT_PATHS.slice(0, maxProbePaths)) {
        push(`${parsed.origin}${path}`);
      }
    }
  } catch {}

  return out;
}

function isRunnablePreflight(preflight) {
  if (!preflight?.ok) return false;
  if (['captcha_detected', 'login_detected', 'guide_page'].includes(preflight.reason)) return false;
  if (String(preflight.reason || '').startsWith('http_')) return false;
  return preflight.directFormLikely;
}

function bestProbe(probes) {
  const runnable = probes.find((probe) => isRunnablePreflight(probe.preflight));
  if (runnable) return { status: 'runnable', ...runnable };

  const notBlocked = probes.find((probe) =>
    probe.preflight?.ok &&
    !['captcha_detected', 'login_detected'].includes(probe.preflight.reason)
  );
  if (notBlocked) return { status: 'weak', ...notBlocked };

  return { status: 'excluded', ...(probes[0] || {}) };
}

async function preflightRow(row, opts) {
  const urls = sameOriginCandidates(row.url || row.site, opts.maxProbePaths);
  const probes = [];

  for (const url of urls) {
    const preflight = await preflightSite(url);
    probes.push({ url, preflight });
    if (isRunnablePreflight(preflight)) break;
    if (['captcha_detected', 'login_detected'].includes(preflight.reason)) break;
  }

  const picked = bestProbe(probes);
  return {
    ...row,
    original_url: row.url || row.site,
    url: picked.url || row.url || row.site,
    preflight_status: picked.status,
    preflight: picked.preflight || null,
    probes,
  };
}

async function runPool(items, concurrency, worker) {
  const results = [];
  let index = 0;

  async function loop() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, loop));
  return results;
}

function compactRow(row) {
  return {
    name: row.name || row.url,
    url: row.url,
    original_url: row.original_url,
    lane: row.lane,
    submit_type: row.submit_type,
    status: row.status,
    reason: row.reason,
    priority: row.priority,
    preflight_status: row.preflight_status,
    preflight_reason: row.preflight?.reason || '',
    preflight_final_url: row.preflight?.finalUrl || '',
    signals: row.preflight?.signals || null,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rows = JSON.parse(readFileSync(opts.input, 'utf-8'))
    .filter((row) => !opts.lane || row.lane === opts.lane);

  console.log(`preflight_input=${rows.length} lane=${opts.lane}`);
  const processed = await runPool(rows, opts.concurrency, async (row, idx) => {
    const result = await preflightRow(row, opts);
    console.log(`[${idx + 1}/${rows.length}] ${result.preflight_status} ${result.preflight?.reason || 'no_reason'} ${result.url}`);
    return result;
  });

  const runnable = processed
    .filter((row) => row.preflight_status === 'runnable')
    .map(compactRow);
  const weak = processed
    .filter((row) => row.preflight_status === 'weak')
    .map(compactRow);
  const excluded = processed
    .filter((row) => row.preflight_status === 'excluded')
    .map(compactRow);

  const base = resolve(`logs/bulkqrcodegenerator-public-safe-preflight-${opts.lane}-${DATE}`);
  ensureDir(`${base}.json`);
  writeFileSync(`${base}.json`, `${JSON.stringify(processed.map(compactRow), null, 2)}\n`, 'utf-8');
  writeFileSync(`${base}-runnable.json`, `${JSON.stringify(runnable, null, 2)}\n`, 'utf-8');
  writeFileSync(`${base}-weak.json`, `${JSON.stringify(weak, null, 2)}\n`, 'utf-8');
  writeFileSync(`${base}-excluded.json`, `${JSON.stringify(excluded, null, 2)}\n`, 'utf-8');

  const lines = [
    `# Public Safe Preflight ${opts.lane}`,
    '',
    `Input: ${rows.length}`,
    `Runnable: ${runnable.length}`,
    `Weak: ${weak.length}`,
    `Excluded: ${excluded.length}`,
    '',
    '| Status | Reason | URL |',
    '|---|---|---|',
  ];
  for (const row of [...runnable, ...weak, ...excluded]) {
    lines.push(`| ${row.preflight_status} | ${row.preflight_reason} | ${row.url} |`);
  }
  writeFileSync(`${base}.md`, `${lines.join('\n')}\n`, 'utf-8');

  console.log(`runnable=${runnable.length} weak=${weak.length} excluded=${excluded.length}`);
  console.log(`${base}-runnable.json`);
  console.log(`${base}.md`);
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
