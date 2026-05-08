#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

const DATE = new Date().toISOString().split('T')[0];
const INPUT = resolve(`logs/bulkqrcodegenerator-batchable-blocked-${DATE}.json`);

function ensureDir(path) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function priority(row) {
  if (row.status === 'manual_login_needed') return 0;
  if (row.status === 'captcha_blocked' && row.lane === 'url_field') return 1;
  if (row.status === 'captcha_blocked') return 2;
  if (row.status === 'cloudflare_blocked' && row.lane === 'url_field') return 3;
  return 4;
}

function main() {
  const rows = JSON.parse(readFileSync(INPUT, 'utf-8'));
  const sorted = rows
    .map((row) => ({
      priority: priority(row),
      lane: row.lane,
      status: row.status,
      url: row.url || row.site,
      site: row.site,
      name: row.name,
      submit_type: row.submit_type,
      reason: row.reason,
      timestamp: row.timestamp,
    }))
    .sort((a, b) => a.priority - b.priority || a.lane.localeCompare(b.lane) || a.site.localeCompare(b.site));

  const jsonPath = resolve(`logs/bulkqrcodegenerator-semi-manual-queue-${DATE}.json`);
  const mdPath = resolve(`logs/bulkqrcodegenerator-semi-manual-queue-${DATE}.md`);
  ensureDir(jsonPath);
  writeFileSync(jsonPath, `${JSON.stringify(sorted, null, 2)}\n`, 'utf-8');

  const lines = [
    '# Bulk QR Code Generator Semi Manual Queue',
    '',
    `Total: ${sorted.length}`,
    '',
    '| Priority | Status | Lane | Site | Submit Type |',
    '|---:|---|---|---|---|',
  ];
  for (const row of sorted) {
    lines.push(`| ${row.priority} | ${row.status} | ${row.lane} | ${row.site} | ${row.submit_type || ''} |`);
  }
  writeFileSync(mdPath, `${lines.join('\n')}\n`, 'utf-8');

  console.log(`semi_manual_queue=${sorted.length}`);
  console.log(jsonPath);
  console.log(mdPath);
}

main();
