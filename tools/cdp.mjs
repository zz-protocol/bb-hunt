// Minimal Chrome/Edge DevTools Protocol client (no dependencies; Node 22+ for global WebSocket).
const BASE = process.env.CDP_BASE || 'http://127.0.0.1:9222';

export async function version() {
  return (await fetch(`${BASE}/json/version`)).json();
}

export async function targets() {
  return (await fetch(`${BASE}/json/list`)).json();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', (e) => rej(new Error('ws error: ' + (e.message || 'unknown'))), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    });
    return this;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(`timeout ${method}`)); }
      }, 30000);
    });
  }
  async eval(expression, { awaitPromise = true } = {}) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, userGesture: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  }
  async goto(url, { timeout = 45000, settle = 1500 } = {}) {
    await this.send('Page.navigate', { url });
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      await sleep(400);
      try { if ((await this.eval('document.readyState')) === 'complete') break; } catch { /* navigating */ }
    }
    await sleep(settle);
  }
  close() { try { this.ws.close(); } catch {} }
}

/** 找到某个 origin 下的标签页，带 #bbmonitor 标记的优先 */
export async function withOrigin(origin, bootUrl, fn) {
  const MARK = '#bbmonitor';
  const boot = bootUrl.includes(MARK) ? bootUrl : bootUrl + MARK;
  let t = (await targets()).find((x) => x.type === 'page' && x.url.startsWith(origin) && x.url.includes(MARK));
  if (!t) {
    const v = await version();
    const b = await new CDP(v.webSocketDebuggerUrl).connect();
    try {
      const { targetId } = await b.send('Target.createTarget', { url: boot, background: true });
      await sleep(2200);
      t = (await targets()).find((x) => x.id === targetId);
    } finally { b.close(); }
    if (!t) throw new Error('cannot create tab for ' + origin);
  }
  const cdp = await new CDP(t.webSocketDebuggerUrl).connect();
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    if ((await cdp.eval('location.origin')) !== origin) await cdp.goto(boot, { settle: 2000 });
    return await fn(cdp);
  } finally { cdp.close(); }
}
