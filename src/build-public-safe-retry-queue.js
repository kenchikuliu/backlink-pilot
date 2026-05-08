#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

const DATE = new Date().toISOString().split('T')[0];
const INPUT = resolve(`logs/bulkqrcodegenerator-batchable-run-summary-${DATE}.json`);

const BLOCKED_STATUSES = new Set([
  'submitted',
  'captcha_blocked',
  'cloudflare_blocked',
  'manual_login_needed',
  'paid_only',
  'dead_page',
]);

function ensureDir(path) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function normalizeUrl(value = '') {
  return String(value).trim().replace(/^http:\/\//i, 'https://').replace(/\/+$/, '');
}

function looksLikePublicSubmit(row) {
  const url = normalizeUrl(row.url || row.site || '').toLowerCase();
  const lane = row.lane || '';
  const submitType = row.submit_type || '';

  if (!url) return false;
  if (/comment-page|\/wp-comments-post\.php|mode=comment|replytocom=/.test(url)) return false;
  if (/\/20\d{2}\/\d{1,2}\//.test(url) && lane !== 'bookmark') return false;
  if (/\/(recipe|travel|news|article|blog|comic)\//.test(url) && lane !== 'bookmark') return false;

  if (lane === 'bookmark') return true;
  if (/submit|add-?(url|site|link|story)?|bookmark|new-story|publish|post-link/.test(url)) return true;
  if (/资料页|URL 字段|链接聚合|书签/.test(submitType)) return true;
  return false;
}

function priority(row) {
  const url = normalizeUrl(row.url || row.site || '').toLowerCase();
  if (/submit|add-?(url|site|link)|new-story|submit-story/.test(url)) return 0;
  if (row.reason === 'submit_click_failed') return 1;
  if (row.status === 'browser_error') return 2;
  if (row.lane === 'bookmark') return 3;
  return 4;
}

function main() {
  const summary = JSON.parse(readFileSync(INPUT, 'utf-8'));
  const rows = (summary.rows || [])
    .filter((row) => !BLOCKED_STATUSES.has(row.status))
    .filter(looksLikePublicSubmit)
    .map((row) => ({
      name: row.name || row.site,
      url: row.url || row.site,
      lane: row.lane,
      submit_type: row.submit_type,
      status: row.status,
      reason: row.reason,
      priority: priority(row),
      timestamp: row.timestamp,
    }))
    .sort((a, b) => a.priority - b.priority || a.lane.localeCompare(b.lane) || a.url.localeCompare(b.url));

  const jsonPath = resolve(`logs/bulkqrcodegenerator-public-safe-retry-${DATE}.json`);
  const mdPath = resolve(`logs/bulkqrcodegenerator-public-safe-retry-${DATE}.md`);
  ensureDir(jsonPath);
  writeFileSync(jsonPath, `${JSON.stringify(rows, null, 2)}\n`, 'utf-8');

  const lines = [
    '# Bulk QR Code Generator Public Safe Retry Queue',
    '',
    `Total: ${rows.length}`,
    '',
    '| Priority | Lane | Status | Reason | URL |',
    '|---:|---|---|---|---|',
  ];
  for (const row of rows) {
    lines.push(`| ${row.priority} | ${row.lane} | ${row.status} | ${row.reason || ''} | ${row.url} |`);
  }
  writeFileSync(mdPath, `${lines.join('\n')}\n`, 'utf-8');

  console.log(`public_safe_retry=${rows.length}`);
  console.log(jsonPath);
  console.log(mdPath);
}

main();
