// 通知通道 / notification channels. Zero dependencies.
import crypto from 'node:crypto';

const recent = new Map();
const tokenCache = new Map();

function dedupe(key, minutes) {
  const now = Date.now();
  const prev = recent.get(key);
  if (prev && now - prev < minutes * 60 * 1000) return false;
  recent.set(key, now);
  if (recent.size > 2000) recent.clear();
  return true;
}

const text = (a) => `${a.title}\n${a.body}${a.url ? '\n' + a.url : ''}`;

/* ---------- DingTalk enterprise app robot (Client ID / Secret) ---------- */
async function dingtalkAccessToken(ch) {
  const hit = tokenCache.get(ch.clientId);
  if (hit && hit.exp > Date.now() + 5 * 60 * 1000) return hit.token;
  const r = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appKey: ch.clientId, appSecret: ch.clientSecret }),
  });
  const j = await r.json();
  if (!j.accessToken) throw new Error('dingtalk token: ' + JSON.stringify(j).slice(0, 200));
  tokenCache.set(ch.clientId, { token: j.accessToken, exp: Date.now() + (j.expireIn || 7200) * 1000 });
  return j.accessToken;
}

export const senders = {
  async console(a) {
    console.log(`[ALERT] ${a.title} :: ${a.body.replace(/\n/g, ' | ')}${a.url ? '  ' + a.url : ''}`);
  },

  /** 钉钉企业内部应用机器人：发群（openConversationId）或发个人（userIds） */
  async 'dingtalk-app'(a, ch) {
    const token = await dingtalkAccessToken(ch);
    const robotCode = ch.robotCode || ch.clientId;
    const msgKey = ch.msgKey || 'sampleMarkdown';
    const msgParam = JSON.stringify({
      title: a.title,
      text: `### ${a.title}\n\n${a.body}${a.url ? `\n\n[打开链接](${a.url})` : ''}`,
    });
    let url, payload;
    if (ch.openConversationId) {
      url = 'https://api.dingtalk.com/v1.0/robot/groupMessages/send';
      payload = { robotCode, openConversationId: ch.openConversationId, msgKey, msgParam };
    } else if (Array.isArray(ch.userIds) && ch.userIds.length) {
      url = 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend';
      payload = { robotCode, userIds: ch.userIds, msgKey, msgParam };
    } else {
      throw new Error('dingtalk-app needs openConversationId or userIds');
    }
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`dingtalk-app ${r.status} ${(await r.text()).slice(0, 240)}`);
  },

  /** 钉钉群「自定义机器人」Webhook（+ 可选加签 secret） */
  async dingtalk(a, ch) {
    let url = ch.webhook;
    if (ch.secret) {
      const ts = Date.now();
      const sign = crypto.createHmac('sha256', ch.secret).update(`${ts}\n${ch.secret}`).digest('base64');
      url += `&timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
    }
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { title: a.title, text: `### ${a.title}\n${a.body}\n${a.url ? `[打开链接](${a.url})` : ''}` },
      }),
    });
    if (!r.ok) throw new Error(`dingtalk ${r.status}`);
  },

  async telegram(a, ch) {
    const r = await fetch(`https://api.telegram.org/bot${ch.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: ch.chatId, text: text(a), disable_web_page_preview: !a.url }),
    });
    if (!r.ok) throw new Error(`telegram ${r.status} ${(await r.text()).slice(0, 160)}`);
  },

  async wecom(a, ch) {
    const r = await fetch(ch.webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { content: `**${a.title}**\n${a.body}\n${a.url ? `[打开](${a.url})` : ''}` },
      }),
    });
    if (!r.ok) throw new Error(`wecom ${r.status}`);
  },

  /** 任意 HTTP 端点，收到 {title, body, url, type, platform, priority} */
  async generic(a, ch) {
    const r = await fetch(ch.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(ch.headers || {}) },
      body: JSON.stringify(a),
    });
    if (!r.ok) throw new Error(`generic ${r.status}`);
  },
};

export function createNotifier(notifyCfg, alertFile, appendLine) {
  const channels = (notifyCfg?.channels || []).filter((c) => c && senders[c.type]);
  const minutes = notifyCfg?.dedupeMinutes ?? 10;

  return async function notify(a) {
    if (!dedupe(a.key || a.title + a.body, minutes)) return false;
    appendLine?.(alertFile, JSON.stringify({ ts: new Date().toISOString(), ...a }));
    for (const ch of channels) {
      try { await senders[ch.type](a, ch); }
      catch (e) { console.error(`[notify:${ch.type}] ${e.message}`); }
    }
    return true;
  };
}

export { dingtalkAccessToken };
