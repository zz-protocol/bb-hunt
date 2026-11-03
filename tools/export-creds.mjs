#!/usr/bin/env node
/**
 * 在「你自己电脑」上运行：把 360 的会话 Cookie、雷神的 token 导出成服务器用的 credentials.json
 *
 * 前置：
 *   1. 用同一个浏览器 profile 登录过 360众测 / 雷神众测
 *   2. 浏览器以调试端口启动，例如 Edge：
 *        msedge.exe --user-data-dir="C:\Users\<you>\EdgeAuto" --remote-debugging-port=9222
 *      （Chromium 136+ 不允许对「默认 profile」开调试端口，所以必须用独立 profile）
 *
 * 用法：
 *   node tools/export-creds.mjs              # 写入 data/credentials.json
 *   node tools/export-creds.mjs --print      # 只打印，方便贴到远程服务器
 *   CDP_BASE=http://127.0.0.1:9222 node tools/export-creds.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withOrigin } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data')), 'credentials.json');

const out = {};

try {
  await withOrigin('https://zhongce.360.net', 'https://zhongce.360.net/hacker/project/', async (cdp) => {
    const cookies = (await cdp.send('Network.getAllCookies')).cookies.filter((c) => c.domain.includes('360.net'));
    const auth = cookies.find((c) => c.name === 'homepage-frontend');
    if (!auth) throw new Error('未找到 360 会话 cookie（该浏览器里没登录 360众测？）');
    out.zhongce = {
      cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
      userAgent: await cdp.eval('navigator.userAgent'),
    };
  });
} catch (e) {
  console.error('360 export failed:', e.message);
}

try {
  await withOrigin('https://www.bountyteam.com', 'https://www.bountyteam.com/hacker-service/bug-bounty-list', async (cdp) => {
    const raw = await cdp.eval(`localStorage.getItem('jwtToken')`);
    if (!raw) throw new Error('localStorage 里没有 jwtToken（没登录雷神众测？）');
    let t; try { t = JSON.parse(raw).value; } catch { t = raw; }
    out.bountyteam = {
      token: String(t).replace(/^"|"$/g, ''),
      userAgent: await cdp.eval('navigator.userAgent'),
    };
  });
} catch (e) {
  console.error('bountyteam export failed:', e.message);
}

if (!Object.keys(out).length) {
  console.error('\n没有导出任何凭据。检查浏览器是否已登录、调试端口是否正确。');
  process.exit(1);
}

const json = JSON.stringify(out, null, 2);
if (process.argv.includes('--print')) {
  console.log(json);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, json, 'utf8');
  console.log('written:', OUT);
  console.log('  zhongce.cookie     len =', out.zhongce?.cookie?.length ?? 0);
  console.log('  bountyteam.token       =', out.bountyteam?.token ? out.bountyteam.token.slice(0, 12) + '...' : '(none)');
  console.log('\n然后把该文件内容放到服务器 /app/data/credentials.json（或 docker volume 的 data 目录）。');
}
