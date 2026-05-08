#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

const DATE = new Date().toISOString().split('T')[0];
const INPUT = resolve(`logs/bulkqrcodegenerator-batchable-blocked-${DATE}.json`);

function ensureDir(path) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function main() {
  const rows = JSON.parse(readFileSync(INPUT, 'utf-8'));
  const groups = new Map();
  for (const row of rows) {
    const key = row.status;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      name: row.name || row.site,
      url: row.site,
      lane: row.lane,
      submit_type: row.submit_type,
      status: row.status,
      reason: row.reason,
      timestamp: row.timestamp,
    });
  }

  for (const [status, items] of groups.entries()) {
    const path = resolve(`logs/bulkqrcodegenerator-blocked-${status}-${DATE}.json`);
    ensureDir(path);
    writeFileSync(path, `${JSON.stringify(items, null, 2)}\n`, 'utf-8');
    console.log(`${status}=${items.length} ${path}`);
  }
}

main();
