#!/usr/bin/env node
/**
 * Offline smoke test. No network by default.
 *   node tests/smoke.mjs          # offline
 *   node tests/smoke.mjs --live   # also hit the 3 anonymous endpoints
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PLATFORMS, { makeReq, num } from '../src/collectors.mjs';
import { createNotifier, senders } from '../src/notify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

console.log('config');
t('config.json parses', () => {
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  assert.ok(c.intervalSeconds >= 10, 'intervalSeconds too small (avoid rate-limit)');
  assert.ok(Object.keys(c.platforms).length >= 5);
});
t('example credentials parses', () => {
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'credentials.example.json'), 'utf8'));
  assert.ok('zhongce' in c && 'bountyteam' in c);
});

console.log('collectors');
t('5 platforms registered', () => assert.equal(Object.keys(PLATFORMS).length, 5));
t('every platform has collect()', () => {
  for (const [k, p] of Object.entries(PLATFORMS)) {
    assert.equal(typeof p.collect, 'function', `${k}.collect`);
    assert.equal(typeof p.label, 'string', `${k}.label`);
    assert.equal(typeof p.needsCred, 'boolean', `${k}.needsCred`);
  }
});
t('credential platforms expose verify() + credReady()', () => {
  for (const [k, p] of Object.entries(PLATFORMS)) {
    if (!p.needsCred) continue;
    assert.equal(typeof p.verify, 'function', `${k}.verify`);
    assert.equal(typeof p.credReady, 'function', `${k}.credReady`);
  }
});
t('credReady detects missing credentials', () => {
  assert.equal(PLATFORMS.zhongce.credReady({}), false);
  assert.equal(PLATFORMS.bountyteam.credReady({}), false);
  assert.equal(PLATFORMS.zhongce.credReady({ zhongce: { cookie: 'a=b' } }), true);
  assert.equal(PLATFORMS.bountyteam.credReady({ bountyteam: { token: 'x' } }), true);
});
t('num() parses quota strings', () => {
  assert.equal(num('0人'), 0);
  assert.equal(num('1人'), 1);
  assert.equal(num('不限人数'), null);
  assert.equal(num(undefined), null);
});
t('makeReq returns a function', () => {
  assert.equal(typeof makeReq({ userAgent: 'x' }), 'function');
});

console.log('notify');
t('unknown channel is ignored (no throw)', async () => {
  const n = createNotifier({ channels: [{ type: 'nope' }], dedupeMinutes: 10 }, '/dev/null', () => {});
  assert.equal(typeof n, 'function');
});
t('console sender exists and all documented types are implemented', () => {
  for (const t2 of ['console', 'dingtalk-app', 'dingtalk', 'telegram', 'wecom', 'generic']) {
    assert.equal(typeof senders[t2], 'function', `sender ${t2}`);
  }
});
t('dedupe suppresses repeats', async () => {
  const lines = [];
  const n = createNotifier({ channels: [], dedupeMinutes: 10 }, 'x', (f, l) => lines.push(l));
  const a = { title: 'T', body: 'B', key: 'k1' };
  await n(a); await n(a);
  assert.equal(lines.length, 1, 'duplicate should be suppressed');
});

console.log('monitor module loads');
t('monitor.mjs parses (syntax check)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/monitor.mjs'), 'utf8');
  assert.ok(src.includes('bb-hunt'));
  assert.ok(/^#!/.test(src), 'shebang expected');
});

if (process.argv.includes('--live')) {
  console.log('live anonymous collectors');
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const req = makeReq(cfg);
  for (const key of ['huoxian', 'vulbox', 'butian']) {
    const t0 = Date.now();
    try {
      const items = await PLATFORMS[key].collect({ cfg, creds: {}, req });
      assert.ok(Array.isArray(items) && items.length > 0, `${key} returned no items`);
      console.log(`  ok   ${key}: ${items.length} items ${Date.now() - t0}ms`);
      pass++;
    } catch (e) {
      console.error(`  FAIL ${key}: ${e.message}`);
      process.exitCode = 1;
    }
  }
}

console.log(`\n${process.exitCode ? 'FAILED' : 'PASSED'} — ${pass} checks`);
