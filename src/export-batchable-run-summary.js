#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { parse as parseYaml } from 'yaml';

const PRODUCT = 'Bulk QR Code Generator for Excel and CSV';
const DATE = new Date().toISOString().split('T')[0];

function ensureDir(path) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function normalizeUrl(value = '') {
  return String(value).trim().replace(/^http:\/\//i, 'https://').replace(/\/+$/, '');
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function latestHistory() {
  const raw = parseYaml(readFileSync('submissions.yaml', 'utf-8')) || { submissions: [] };
  const grouped = new Map();
  for (const row of raw.submissions || []) {
    if (row.product !== PRODUCT) continue;
    const key = normalizeUrl(row.site || row.url || '');
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  const latest = new Map();
  for (const [key, rows] of grouped.entries()) {
    rows.sort((a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime());
    const submitted = rows.find((row) => row.status === 'submitted');
    latest.set(key, submitted || rows.at(-1));
  }
  return latest;
}

function main() {
  const latest = latestHistory();
  const lanes = ['url_field', 'bookmark', 'content'];
  const rows = [];

  for (const lane of lanes) {
    const path = `logs/bulkqrcodegenerator-batchable-${lane}-${DATE}.json`;
    const items = existsSync(path) ? loadJson(path) : [];
    for (const item of items) {
      const key = normalizeUrl(item.url);
      const row = latest.get(key);
      rows.push({
        lane,
        url: item.url,
        site: item.url,
        name: item.name,
        submit_type: item.submit_type,
        status: row?.status || 'unattempted',
        reason: row?.reason || '',
        timestamp: row?.timestamp || '',
      });
    }
  }

  const counts = rows.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});
  const byLane = {};
  for (const row of rows) {
    byLane[row.lane] ||= {};
    byLane[row.lane][row.status] = (byLane[row.lane][row.status] || 0) + 1;
  }

  const blocked = rows.filter((row) => ['captcha_blocked', 'cloudflare_blocked', 'manual_login_needed'].includes(row.status));
  const jsonPath = resolve(`logs/bulkqrcodegenerator-batchable-run-summary-${DATE}.json`);
  const blockedPath = resolve(`logs/bulkqrcodegenerator-batchable-blocked-${DATE}.json`);
  ensureDir(jsonPath);
  writeFileSync(jsonPath, `${JSON.stringify({ total: rows.length, counts, byLane, rows }, null, 2)}\n`, 'utf-8');
  writeFileSync(blockedPath, `${JSON.stringify(blocked, null, 2)}\n`, 'utf-8');

  console.log(JSON.stringify({ total: rows.length, counts, byLane, blocked: blocked.length }, null, 2));
  console.log(jsonPath);
  console.log(blockedPath);
}

main();
