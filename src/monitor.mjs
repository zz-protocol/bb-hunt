#!/usr/bin/env node
/**
 * bb-hunt — 众测/漏洞赏金项目只读监控（服务器版，零浏览器、零第三方依赖）
 *
 * Usage:
 *   node src/monitor.mjs            # daemon (default)
 *   node src/monitor.mjs once       # collect once and print
 *   node src/monitor.mjs probe      # verify credentials only
 *   node src/monitor.mjs status     # show state
 *   node src/monitor.mjs doctor     # environment self-check
 *   node src/monitor.mjs notify-test
 *
 * Env:
 *   DATA_DIR   default ./data      (credentials.json / config.local.json / state / logs)
 *   CONFIG     default ./config.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PLATFORMS, { makeReq } from './collectors.mjs';
import { createNotifier, senders } from './notify.mjs';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SRC_DIR, '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const CONFIG_FILE = path.resolve(process.env.CONFIG || path.join(ROOT, 'config.json'));

fs.mkdirSync(DATA_DIR, { recursive: true });

const STATE_FILE = path.join(DATA_DIR, 'state.json');
const ALERT_FILE = path.join(DATA_DIR, 'alerts.jsonl');
const LOG_FILE = path.join(DATA_DIR, 'monitor.log');
const CRED_FILE = path.join(DATA_DIR, 'credentials.json');

/* ---------------- config ---------------- */

function deepMerge(base, over) {
  if (Array.isArray(over)) return over.slice();
  if (over && typeof over === 'object') {
    const out = { ...(base && typeof base === 'object' ? base : {}) };
    for (const [k, v] of Object.entries(over)) out[k] = deepMerge(out[k], v);
    return out;
  }
  return over;
}

let cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const LOCAL_CFG = path.join(DATA_DIR, 'config.local.json');
if (fs.existsSync(LOCAL_CFG)) {
  try { cfg = deepMerge(cfg, JSON.parse(fs.readFileSync(LOCAL_CFG, 'utf8'))); }
  catch (e) { console.error('config.local.json parse error:', e.message); }
}

let creds = {};
if (fs.existsSync(CRED_FILE)) {
  try { creds = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')); }
  catch (e) { console.error('credentials.json parse error:', e.message); }
}

/* ---------------- infra ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = makeReq(cfg);
const ctx = () => ({ cfg, creds, req });
const nowStr = () => new Date().toLocaleString('sv-SE');

function appendLine(file, line) {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 8 * 1024 * 1024) fs.renameSync(file, file + '.1');
    fs.appendFileSync(file, line + '\n', 'utf8');
  } catch (e) { console.error('appendLine:', e.message); }
}

function log(...a) {
  const line = `[${nowStr()}] ` + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(line);
  appendLine(LOG_FILE, line);
}

const notify = createNotifier(cfg.notify, ALERT_FILE, appendLine);

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { v: 2, platforms: {} }; } }
function saveState(s) {
  try {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 1), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    // 写不进 data/ 时不要崩：告警一次并在日志里说明（通常是容器内权限问题）
    log('WARN cannot write state file:', e.message, '— 检查 data 目录权限 / check data dir ownership');
  }
}

const ICON = { new: '🆕', open: '🔓', quota: '🎯', session: '⚠️', recover: '✅' };

function describe(it) {
  const b = [];
  if (it.statusText) b.push(`状态：${it.statusText}`);
  if (it.quotaText) b.push(`名额：${it.quotaText}`);
  if (it.meta?.bonus) b.push(`最高奖金：¥${it.meta.bonus}`);
  if (it.meta?.business) b.push(`业务：${it.meta.business}`);
  if (it.meta?.reward) b.push(`奖金：${it.meta.reward}`);
  if (it.meta?.type) b.push(`类型：${it.meta.type}`);
  if (it.meta?.skills) {
    const s = Array.isArray(it.meta.skills) ? it.meta.skills.join('/') : it.meta.skills;
    if (s) b.push(`技能：${s}`);
  }
  return b.join('｜');
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '未知';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分`;
}

/* ---------------- cycle ---------------- */

async function cycle(state) {
  const keys = Object.keys(cfg.platforms).filter((k) => cfg.platforms[k] && PLATFORMS[k]);
  for (const key of keys) {
    const p = PLATFORMS[key];
    const prev = state.platforms[key] || {};

    if (p.needsCred && !p.credReady(creds)) {
      if (prev.skipReason !== 'no-cred') log(`${p.label.padEnd(8)} skip (no credentials)`);
      state.platforms[key] = { ...prev, label: p.label, skipReason: 'no-cred', count: prev.count ?? 0 };
      saveState(state);
      continue;
    }

    const t0 = Date.now();
    try {
      const items = await p.collect(ctx());
      const baseline = !prev.projects;
      const cur = {};
      let alerts = 0;
      for (const it of items) {
        cur[it.id] = it;
        if (baseline) continue;
        const old = prev.projects[it.id];
        let kind = null;
        if (!old) kind = 'new';
        else if (!old.enrollOpen && it.enrollOpen) kind = 'open';
        else if (old.quotaLeft === 0 && typeof it.quotaLeft === 'number' && it.quotaLeft > 0) kind = 'quota';
        if (!kind) continue;
        alerts++;
        await notify({
          type: kind, platform: key, key: `${key}:${it.id}:${kind}`,
          title: `${ICON[kind]} [${p.label}] ${it.title}`,
          body: describe(it), url: it.url,
          priority: kind === 'new' ? 'normal' : 'high',
        });
      }
      state.platforms[key] = {
        ...prev, label: p.label, skipReason: undefined,
        checkedAt: Date.now(), count: items.length, lastOk: Date.now(),
        lastError: undefined, login: p.needsCred ? true : prev.login,
        okSince: prev.login === false || !prev.okSince ? Date.now() : prev.okSince,
        projects: cur,
      };
      log(`${p.label.padEnd(8)} ok items=${String(items.length).padStart(3)} alerts=${alerts} ${Date.now() - t0}ms`);
    } catch (e) {
      const msg = String(e.message || e);
      state.platforms[key] = { ...prev, label: p.label, checkedAt: Date.now(), lastError: msg, login: p.needsCred ? false : prev.login };
      log(`${p.label.padEnd(8)} FAIL ${msg.slice(0, 180)}`);
      if (/credential invalid|needs re-login|401|需要登录|凭据/.test(msg)) {
        await notify({
          type: 'session', platform: key, key: `${key}:session:${new Date().toISOString().slice(0, 13)}`,
          title: `${ICON.session} [${p.label}] 凭据失效，采集已停止`,
          body: `已连续有效 ${fmtDuration(Date.now() - (prev.okSince || prev.lastOk || Date.now()))}\n请在电脑上重新导出凭据并更新服务器 credentials.json`,
          priority: 'high',
        });
      }
    }
    await sleep(1000 + Math.floor(Math.random() * 900));
    saveState(state);
  }
}

/* ---------------- health ---------------- */

async function healthCheck(state) {
  for (const key of Object.keys(cfg.platforms).filter((k) => cfg.platforms[k] && PLATFORMS[k]?.verify)) {
    const p = PLATFORMS[key];
    const prev = state.platforms[key] || {};
    if (!p.credReady(creds)) { log(`health ${key.padEnd(11)} ⚪ no credentials`); continue; }
    try {
      const r = await p.verify(ctx());
      const wasDown = prev.login === false;
      state.platforms[key] = {
        ...prev, login: true, loginReason: 'ok', user: r.user,
        loginCheckedAt: Date.now(),
        okSince: wasDown || !prev.okSince ? Date.now() : prev.okSince,
      };
      log(`health ${key.padEnd(11)} ✅ ${r.user || ''} ${r.status || ''}${r.cert !== undefined ? ' cert=' + r.cert : ''}`);
      if (wasDown && cfg.recoverNotify !== false) {
        await notify({
          type: 'recover', platform: key, key: `${key}:recover:${new Date().toISOString().slice(0, 13)}`,
          title: `${ICON.recover} [${p.label}] 凭据已恢复`,
          body: `账号：${r.user || '未知'}，监控继续`,
        });
      }
    } catch (e) {
      const wasUp = prev.login !== false;
      state.platforms[key] = { ...prev, login: false, loginReason: String(e.message).slice(0, 120), loginCheckedAt: Date.now() };
      log(`health ${key.padEnd(11)} ❌ ${e.message}`);
      if (wasUp) {
        await notify({
          type: 'session', platform: key, key: `${key}:session:${new Date().toISOString().slice(0, 13)}`,
          title: `${ICON.session} [${p.label}] 凭据已失效`,
          body: `已连续有效 ${fmtDuration(Date.now() - (prev.okSince || prev.lastOk || Date.now()))}\n请在电脑上重新导出凭据并更新服务器 credentials.json`,
          priority: 'high',
        });
      }
    }
    await sleep(400);
  }
  saveState(state);
}

/* ---------------- commands ---------------- */

async function daemon() {
  const state = loadState();
  saveState(state);
  log('=== bb-hunt daemon started ===');
  log(`data dir: ${DATA_DIR}`);
  log(`platforms: ${Object.keys(cfg.platforms).filter((k) => cfg.platforms[k]).join(', ')}`);
  for (const [k, p] of Object.entries(PLATFORMS)) {
    if (!cfg.platforms[k] || !p.needsCred) continue;
    log(`  ${p.label}: ${p.credReady(creds) ? 'credentials loaded' : '⚪ no credentials (will skip)'}`);
  }
  log(`notify channels: ${(cfg.notify?.channels || []).map((c) => c.type).join(', ') || 'none'}`);

  let stop = false;
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stop = true; log(`got ${sig}, exiting`); process.exit(0); });

  let lastHealth = 0;
  while (!stop) {
    const t0 = Date.now();
    try { await cycle(state); } catch (e) { log('cycle error', String(e.message || e)); }
    if (Date.now() - lastHealth > (cfg.healthIntervalSeconds || 600) * 1000) {
      try { await healthCheck(state); } catch (e) { log('health error', String(e.message || e)); }
      lastHealth = Date.now();
    }
    const jitter = Math.floor(Math.random() * (cfg.jitterSeconds || 0)) * 1000;
    await sleep(Math.max(3000, cfg.intervalSeconds * 1000 + jitter - (Date.now() - t0)));
  }
}

async function once() {
  for (const [k, p] of Object.entries(PLATFORMS)) {
    if (!cfg.platforms[k]) continue;
    if (p.needsCred && !p.credReady(creds)) { log(`${p.label}: ⚪ no credentials, skip`); continue; }
    try {
      const items = await p.collect(ctx());
      log(`${p.label}: ${items.length} items`);
      for (const it of items.filter((x) => x.enrollOpen).slice(0, 5)) {
        log('   ', `${it.title} | ${it.statusText} | ${it.quotaText}`);
      }
    } catch (e) { log(`${p.label}: FAIL ${String(e.message).slice(0, 160)}`); }
    await sleep(500);
  }
}

async function probe() {
  const state = loadState();
  await healthCheck(state);
  const failed = Object.values(state.platforms).filter((p) => p.login === false).length;
  if (failed) console.log(`\n${failed} 个平台凭据不可用，见上。`);
}

async function status() {
  const s = loadState();
  console.log('platform         items  last check          login  note');
  for (const [k, p] of Object.entries(s.platforms)) {
    const t = p.checkedAt ? new Date(p.checkedAt).toLocaleString('sv-SE').slice(5, 16) : '-';
    const login = p.login === true ? '✅' : p.login === false ? '❌' : '⚪';
    console.log(`${(p.label || k).padEnd(14)} ${String(p.count ?? '-').padStart(4)}   ${t.padEnd(18)} ${login}     ${(p.loginReason || p.lastError || p.skipReason || '').slice(0, 46)}`);
  }
  console.log(`\nalerts: ${ALERT_FILE}\nlog:    ${LOG_FILE}\ndata:   ${DATA_DIR}`);
}

async function doctor() {
  const rows = [];
  const ok = (m) => rows.push(['✅', m]);
  const warn = (m) => rows.push(['⚠️', m]);
  const bad = (m) => rows.push(['❌', m]);

  const major = Number(process.version.replace('v', '').split('.')[0]);
  if (major >= 18) ok(`Node ${process.version}`); else bad(`Node ${process.version}（需要 >= 18.17）`);

  ok(`config: ${CONFIG_FILE}${fs.existsSync(LOCAL_CFG) ? ' + data/config.local.json' : ''}`);
  try { fs.accessSync(DATA_DIR, fs.constants.W_OK); ok(`data dir writable: ${DATA_DIR}`); }
  catch { bad(`data dir 不可写: ${DATA_DIR}`); }

  for (const [k, p] of Object.entries(PLATFORMS)) {
    if (!cfg.platforms[k]) { warn(`${p.label}: 已在 config 中关闭`); continue; }
    if (!p.needsCred) { ok(`${p.label}: 匿名，无需凭据`); continue; }
    if (!p.credReady(creds)) { bad(`${p.label}: 缺凭据（data/credentials.json）`); continue; }
    try {
      const r = await p.verify(ctx());
      ok(`${p.label}: 凭据有效（${r.user || '?'}${r.status ? ' / ' + r.status : ''}${r.cert !== undefined ? ' / cert=' + r.cert : ''}）`);
    } catch (e) {
      bad(`${p.label}: 凭据无效 → ${String(e.message).slice(0, 90)}`);
    }
  }

  const chs = (cfg.notify?.channels || []).filter((c) => c && senders[c.type]);
  if (chs.length) ok(`通知通道: ${chs.map((c) => c.type).join(', ')}`);
  else warn('没有配置任何通知通道（只能看日志）');
  for (const c of chs) {
    if (c.type === 'dingtalk-app') {
      if (!c.clientId || !c.clientSecret) bad('dingtalk-app: 缺 clientId/clientSecret');
      else if (!c.openConversationId && !(c.userIds || []).length) bad('dingtalk-app: 缺 openConversationId 或 userIds');
      else if ((c.userIds || []).some((u) => String(u).startsWith('__'))) bad('dingtalk-app: userIds 还是占位符');
      else ok('dingtalk-app: 目标已配置');
    }
  }

  const w = Math.max(...rows.map((r) => r[1].length)) + 2;
  console.log('\nbb-hunt doctor\n' + '─'.repeat(w));
  for (const [icon, m] of rows) console.log(` ${icon}  ${m}`);
  const fail = rows.filter((r) => r[0] === '❌').length;
  console.log('─'.repeat(w));
  console.log(fail ? `\n❌ ${fail} 项需要处理` : '\n✅ 全部通过，可以启动');
  // 不要用 process.exit()：Windows 上会打断 libuv pending handle 导致 assertion。
  process.exitCode = fail ? 1 : 0;
}

/* ---------------- main ---------------- */

const cmd = process.argv[2] || 'daemon';
if (cmd === 'once') await once();
else if (cmd === 'probe') await probe();
else if (cmd === 'status') await status();
else if (cmd === 'doctor') await doctor();
else if (cmd === 'notify-test') {
  const title = process.argv[3] || '🎯 bb-hunt 通知通道测试';
  const sent = await notify({
    type: 'test', platform: 'test', key: 'notify-test:' + Date.now(),
    title, body: '收到这条说明通知通道已打通。', url: 'https://github.com/zz-protocol/bb-hunt',
  });
  console.log(sent ? 'sent (检查上面是否有 [notify:*] 报错)' : 'deduped, skipped');
}
else await daemon();
