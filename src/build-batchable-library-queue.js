#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { parse as parseYaml } from 'yaml';

const PRODUCT = 'Bulk QR Code Generator for Excel and CSV';
const LIBRARY = resolve('assets/backlink-library/backlink-library.csv');
const TRACKER = resolve('submissions.yaml');
const DATE = new Date().toISOString().split('T')[0];

function ensureDir(path) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function parseCsvLine(line) {
  const out = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        value += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      out.push(value);
      value = '';
    } else {
      value += char;
    }
  }
  out.push(value);
  return out;
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  const header = parseCsvLine(lines.shift() || '');
  return lines.map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(header.map((key, index) => [key, values[index] || '']));
  });
}

function normalizeUrl(value = '') {
  return String(value)
    .trim()
    .replace(/^http:\/\//i, 'https://')
    .replace(/\/+$/, '');
}

function loadSubmittedSites() {
  if (!existsSync(TRACKER)) return new Set();
  const raw = parseYaml(readFileSync(TRACKER, 'utf-8')) || { submissions: [] };
  const submitted = new Set();
  for (const row of raw.submissions || []) {
    if (row.product !== PRODUCT || row.status !== 'submitted') continue;
    const key = normalizeUrl(row.site || row.url || '');
    if (key) submitted.add(key);
  }
  return submitted;
}

function classifyLane(row) {
  const method = row['提交方式判断'] || '';
  if (/资料页|URL 字段|链接聚合|个人资料|主页/.test(method)) return 'url_field';
  if (/书签/.test(method)) return 'bookmark';
  return 'content';
}

function main() {
  const rows = parseCsv(readFileSync(LIBRARY, 'utf-8'));
  const submitted = loadSubmittedSites();
  const batchable = rows.filter((row) => row['是否适合批量做'] === '是' && row['网址']);
  const pending = batchable
    .filter((row) => !submitted.has(normalizeUrl(row['网址'])))
    .map((row) => ({
      name: row['平台名称'] || row['标准域名'] || row['网址'],
      url: row['网址'],
      domain: row['标准域名'],
      lane: classifyLane(row),
      submit_type: row['提交方式判断'],
      source: row['来源'],
      source_sheet: row['来源Sheet'],
      link_strategy: row['Link Strategy'],
      link_format: row['Link Format'],
      notes: row['执行建议'],
    }));

  const allPath = resolve(`logs/bulkqrcodegenerator-batchable-pending-${DATE}.json`);
  ensureDir(allPath);
  writeFileSync(allPath, `${JSON.stringify(pending, null, 2)}\n`, 'utf-8');

  const lanes = new Map();
  for (const item of pending) {
    if (!lanes.has(item.lane)) lanes.set(item.lane, []);
    lanes.get(item.lane).push(item);
  }

  for (const [lane, items] of lanes.entries()) {
    const path = resolve(`logs/bulkqrcodegenerator-batchable-${lane}-${DATE}.json`);
    writeFileSync(path, `${JSON.stringify(items, null, 2)}\n`, 'utf-8');
    console.log(`${lane}=${items.length} ${path}`);
  }

  console.log(`batchable_total=${batchable.length}`);
  console.log(`pending_total=${pending.length}`);
  console.log(allPath);
}

main();
