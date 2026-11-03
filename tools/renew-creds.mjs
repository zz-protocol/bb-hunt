#!/usr/bin/env node
/**
 * 凭据续期助手 / credential renewal helper
 *
 * 它做三件事，唯独不替你「输密码」：
 *   1. 确保浏览器（调试端口）在跑；不在就帮你拉起来
 *   2. 自动检测哪些平台的登录态还有效；对失效的那几家，替你打开登录页并**盯着**，
 *      你一登录成功它立刻捕获（不需要你再执行导出命令）
 *   3. 导出 data/credentials.json；可选：scp 推到服务器 + 通知服务热加载（SIGHUP）
 *
 * 用法:
 *   node tools/renew-creds.mjs                       # 检测 + 自动导出（本地）
 *   node tools/renew-creds.mjs --push root@1.2.3.4:/opt/bb-hunt/data
 *   node tools/renew-creds.mjs --watch               # 常驻：一登录成功就自动导出
 *   node tools/renew-creds.mjs --only zhongce        # 只处理 360
 *   node tools/renew-creds.mjs --no-browser          # 不帮你开浏览器
 *
 * 需要: Node >= 22（全局 WebSocket）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { CDP, version, targets, withOrigin } from './cdp.mjs';
import PLATFORMS, { makeReq } from '../src/collectors.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const OUT = path.join(DATA_DIR, 'credentials.json');
const CDP_BASE = process.env.CDP_BASE || 'http://127.0.0.1:9222';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

const PUSH = val('--push', null);                       // user@host:/path/to/data
const RELOAD_CMD = val('--reload-cmd', null);           // 默认按 PUSH 主机推断
const TIMEOUT = Number(val('--timeout', '600')) * 1000; // 等待人工登录的上限
const WATCH = has('--watch');
const NO_BROWSER = has('--no-browser');
const ONLY = val('--only', null);
const PROFILE = process.env.BB_PROFILE || path.join(os.homedir(), 'EdgeAuto');

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const req = makeReq(cfg);

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
const ok = (s) => `${C.g}✅${C.x} ${s}`;
const no = (s) => `${C.r}❌${C.x} ${s}`;
const dim = (s) => `${C.d}${s}${C.x}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 1. 浏览器 ---------------- */

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

async function cdpAlive() {
  try { return !!(await version()).Browser; } catch { return false; }
}

async function ensureBrowser() {
  if (await cdpAlive()) return true;
  if (NO_BROWSER) return false;
  const exe = BROWSERS.find((p) => fs.existsSync(p));
  if (!exe) {
    console.error(no('没找到 Chrome/Edge，请手动启动带调试端口的浏览器（见 docs/CREDENTIALS.md）'));
    return false;
  }
  console.log(dim(`启动浏览器: ${exe}`));
  console.log(dim(`profile: ${PROFILE}`));
  spawn(exe, [
    `--user-data-dir=${PROFILE}`,
    '--profile-directory=Default',
    '--remote-debugging-port=9222',
    '--remote-allow-origins=*',
    '--no-first-run',
    '--disable-features=msSleepingTabs,msEfficiencyMode,CalculateNativeWinOcclusion',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await cdpAlive()) return true;
  }
  return false;
}

/* ---------------- 2. 抓凭据 ---------------- */

const LOGIN_URL = {
  zhongce: 'https://zhongce.360.net/sign-in',
  bountyteam: 'https://www.bountyteam.com/?type=login',
};

async function grab(key) {
  if (key === 'zhongce') {
    return withOrigin('https://zhongce.360.net', 'https://zhongce.360.net/hacker/project/', async (cdp) => {
      const cookies = (await cdp.send('Network.getAllCookies')).cookies.filter((c) => c.domain.includes('360.net'));
      if (!cookies.some((c) => c.name === 'homepage-frontend')) throw new Error('浏览器里没有 360 会话 cookie');
      return { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '), userAgent: await cdp.eval('navigator.userAgent') };
    });
  }
  if (key === 'bountyteam') {
    return withOrigin('https://www.bountyteam.com', 'https://www.bountyteam.com/hacker-service/bug-bounty-list', async (cdp) => {
      const raw = await cdp.eval(`localStorage.getItem('jwtToken')`);
      if (!raw) throw new Error('localStorage 里没有 jwtToken');
      let t; try { t = JSON.parse(raw).value; } catch { t = raw; }
      return { token: String(t).replace(/^"|"$/g, ''), userAgent: await cdp.eval('navigator.userAgent') };
    });
  }
  throw new Error('unknown platform ' + key);
}

/* ---------------- 3. 校验 ---------------- */

async function verify(key, creds) {
  const p = PLATFORMS[key];
  if (!p?.verify) return { ok: false, reason: 'no verifier' };
  try {
    const r = await p.verify({ cfg, creds, req });
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, reason: String(e.message || e).slice(0, 110) };
  }
}

async function openLoginTab(key) {
  try {
    const v = await version();
    const b = await new CDP(v.webSocketDebuggerUrl).connect();
    await b.send('Target.createTarget', { url: LOGIN_URL[key] });
    b.close();
  } catch (e) { /* ignore */ }
}

/* ---------------- 4. 推送 ---------------- */

function run(cmd, args) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    p.on('exit', (code) => res(code));
    p.on('error', () => res(-1));
  });
}

async function pushAndReload() {
  if (!PUSH) return;
  const [target, dir] = PUSH.includes(':') ? PUSH.split(':') : [PUSH, '/opt/bb-hunt/data'];
  console.log(dim(`\nscp → ${target}:${dir}/credentials.json`));
  const rc = await run('scp', [OUT, `${target}:${dir}/credentials.json`]);
  if (rc !== 0) { console.error(no('scp 失败（检查 ssh key / 路径）')); return; }
  console.log(ok('已推送到服务器'));

  const host = target.includes('@') ? target : target;
  const reload = RELOAD_CMD || `docker compose -f ${dir.replace(/\/data$/, '')}/deploy/docker-compose.yml kill -s HUP bb-hunt`;
  console.log(dim(`ssh ${host} "…reload…"`));
  const rc2 = await run('ssh', [host, reload]);
  if (rc2 === 0) console.log(ok('服务已热加载新凭据（SIGHUP）'));
  else console.error(no('reload 失败，可手工: docker compose -f deploy/docker-compose.yml restart bb-hunt'));
}

/* ---------------- 5. 主流程 ---------------- */

const TARGETS = ONLY ? [ONLY] : ['zhongce', 'bountyteam'].filter((k) => cfg.platforms[k]);
let creds = {};

async function tryGrabAll() {
  const got = {};
  for (const k of TARGETS) {
    try { got[k] = await grab(k); } catch { /* not logged in yet */ }
  }
  return got;
}

async function mainOnce({ waiting }) {
  console.log(`\n${C.b}bb-hunt 凭据续期助手${C.x}  ${dim(`browser=${CDP_BASE} profile=${PROFILE}`)}`);
  if (!(await ensureBrowser())) { console.error(no('CDP 不可用，退出')); process.exitCode = 1; return false; }
  console.log(ok('浏览器调试端口已就绪'));

  const grabbed = await tryGrabAll();
  const state = {};
  for (const k of TARGETS) {
    state[k] = grabbed[k] ? await verify(k, { [k]: grabbed[k] }) : { ok: false, reason: '浏览器里没找到凭据' };
    console.log(`  ${state[k].ok ? ok(PLATFORMS[k].label + ' 凭据有效') : no(PLATFORMS[k].label + ' 需要登录')} ${dim(state[k].reason || '')}`);
  }

  const bad = TARGETS.filter((k) => !state[k].ok);
  if (bad.length === 0) {
    creds = grabbed;
    return true;
  }

  for (const k of bad) { console.log(dim(`\n打开登录页: ${LOGIN_URL[k]}`)); await openLoginTab(k); }
  console.log(`\n${C.y}${C.b}请在弹出的浏览器窗口里完成登录${C.x}（账号密码/扫码/短信均可，我不碰你的密码）`);
  console.log(dim(`我会每 3 秒检测一次，登录成功即自动捕获；${TIMEOUT / 1000}s 后放弃。Ctrl+C 取消。\n`));

  const t0 = Date.now();
  let last = TARGETS.map((k) => `${k}:${state[k].ok ? 'ok' : 'wait'}`).join(' ');
  while (Date.now() - t0 < TIMEOUT) {
    await sleep(3000);
    const g = await tryGrabAll();
    for (const k of TARGETS) {
      if (!state[k].ok && g[k]) {
        const v = await verify(k, { [k]: g[k] });
        if (v.ok) { state[k] = v; grabbed[k] = g[k]; console.log(`  ${ok(PLATFORMS[k].label + ' 登录成功，已捕获')} ${dim(v.user || '')}`); }
      }
    }
    const now = TARGETS.map((k) => `${k}:${state[k].ok ? 'ok' : 'wait'}`).join(' ');
    if (now !== last) { last = now; }
    if (TARGETS.every((k) => state[k].ok)) { creds = grabbed; return true; }
  }
  console.error(no(`等待超时（${TIMEOUT / 1000}s）。已完成: ${TARGETS.filter((k) => state[k].ok).join(', ') || '无'}`));
  for (const k of TARGETS) if (grabbed[k]) creds[k] = grabbed[k];
  return Object.keys(creds).length > 0;
}

function writeCreds() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(creds, null, 2), 'utf8');
  try { fs.chmodSync(OUT, 0o600); } catch {}
  console.log(`\n${ok('已写入')} ${OUT}`);
  for (const k of Object.keys(creds)) {
    const v = creds[k].cookie ? `cookie len=${creds[k].cookie.length}` : `token=${String(creds[k].token).slice(0, 12)}…`;
    console.log(`  ${PLATFORMS[k]?.label || k}: ${v}`);
  }
}

const done = await mainOnce({ waiting: true });
if (!done || !Object.keys(creds).length) { process.exitCode = 1; }
else {
  writeCreds();
  await pushAndReload();
}

if (WATCH) {
  console.log(`\n${C.b}watch 模式${C.x}：每分钟检查一次，凭据失效→你重新登录→自动导出推送。Ctrl+C 退出。`);
  setInterval(async () => {
    const g = await tryGrabAll();
    const st = {};
    for (const k of TARGETS) st[k] = g[k] ? await verify(k, { [k]: g[k] }) : { ok: false };
    const alive = TARGETS.filter((k) => st[k].ok);
    console.log(dim(`[${new Date().toLocaleTimeString('sv-SE')}] valid: ${alive.join(',') || 'none'}`));
    if (TARGETS.some((k) => st[k].ok && !(creds[k] && JSON.stringify(creds[k]) === JSON.stringify(g[k])))) {
      const changed = TARGETS.filter((k) => st[k].ok && JSON.stringify(creds[k]) !== JSON.stringify(g[k]));
      if (changed.length) {
        for (const k of changed) creds[k] = g[k];
        writeCreds();
        await pushAndReload();
      }
    }
  }, 60000);
}
