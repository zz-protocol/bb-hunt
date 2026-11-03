/**
 * 五个平台的采集器 / collectors.
 *
 * 统一输出 / normalized shape:
 *   { id, title, url, statusText, enrollOpen, quotaText, quotaLeft, meta }
 *
 * 说明 / notes:
 *  - huoxian / vulbox / butian 完全匿名，不需要任何凭据
 *  - zhongce / bountyteam 需要一段凭据（Cookie / token），由 credentials.json 提供
 *  - 360 的项目 id 每次请求都会变（加密 token），所以用 title 作为稳定键
 */

const pickUA = (cred, cfg) => cred?.userAgent || cfg.userAgent;

export function makeReq(cfg) {
  return async function req(url, { method = 'GET', body, headers = {}, referer, origin, ua, timeoutMs = 20000 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      const h = { 'user-agent': ua || cfg.userAgent, accept: 'application/json, text/plain, */*', ...headers };
      if (origin) h.origin = origin;
      if (referer) h.referer = referer;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(url, { method, body, headers: h, signal: ctrl.signal });
        const t = await r.text();
        if (!r.ok) throw new Error(`HTTP ${r.status} ${url} :: ${t.slice(0, 100)}`);
        try { return JSON.parse(t); } catch { throw new Error(`非 JSON 响应 / not json: ${url} :: ${t.slice(0, 100)}`); }
      } catch (e) {
        lastErr = e;
        if (/HTTP 4\d\d/.test(String(e.message))) break; // 4xx 不重试
        await new Promise((r) => setTimeout(r, 700 + attempt * 900));
      } finally { clearTimeout(timer); }
    }
    throw lastErr;
  };
}

export const num = (s) => { const m = String(s ?? '').match(/(-?\d+)/); return m ? Number(m[1]) : null; };

export const PLATFORMS = {
  /* ---------------- 匿名 / anonymous ---------------- */
  huoxian: {
    label: '火线', needsCred: false,
    async collect({ cfg, req }) {
      const r = await req('https://www.huoxian.cn/fireapi/fireapp/projectList/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ page: 1, page_size: 200 }),
        origin: 'https://www.huoxian.cn', referer: 'https://www.huoxian.cn/community',
      });
      const list = r?.data?.results;
      if (!Array.isArray(list)) throw new Error('火线返回结构异常 / unexpected shape');
      return list.map((p) => ({
        id: String(p.id), title: p.name,
        url: `https://www.huoxian.cn/project/detail?pid=${p.id}`,
        statusText: p.status?.value || '',
        enrollOpen: ['进行中', '即将开始'].includes(p.status?.value),
        quotaText: p.contractNeed ? '需签协议' : '免签协议', quotaLeft: null,
        meta: { type: p.type?.value, rewardLevel: p.reward_level, tags: p.tags },
      }));
    },
  },

  vulbox: {
    label: '漏洞盒子', needsCred: false,
    async collect({ req }) {
      const r = await req('https://vapi.vulbox.com/web/project/flash/projects?search=&page=1&pageSize=50', {
        origin: 'https://www.vulbox.com', referer: 'https://www.vulbox.com/flashFesting/hall',
      });
      const list = r?.data?.data;
      if (!Array.isArray(list)) throw new Error('盒子返回结构异常 / unexpected shape');
      return list.map((p) => ({
        id: String(p.id), title: p.task_title,
        url: 'https://www.vulbox.com/flashFesting/hall',
        statusText: p.status === 3 ? '进行中' : `status=${p.status}`,
        enrollOpen: !!p.join_available,
        quotaText: p.audit_application ? '需审核' : '免审核', quotaLeft: null,
        meta: { is_joined: p.is_joined, rewards: p.rewards, skills: p.task_skill },
      }));
    },
  },

  butian: {
    label: '补天', needsCred: false,
    async collect({ req }) {
      const fd1 = new FormData(); fd1.append('ajax', '1'); fd1.append('name', ''); fd1.append('sort', '1');
      const fd2 = new FormData(); fd2.append('ajax', '1');
      const [corps, com] = await Promise.all([
        req('https://www.butian.net/Reward/corps', { method: 'POST', body: fd1, referer: 'https://www.butian.net/Reward/plan/2' }),
        req('https://www.butian.net/Reward/com', { method: 'POST', body: fd2, referer: 'https://www.butian.net/Reward/plan/2' }),
      ]);
      const rows = [
        ...(corps?.data?.list || []).map((x) => ({ ...x, _kind: '专属SRC' })),
        ...(com?.data?.list || []).map((x) => ({ ...x, _kind: '企业SRC' })),
      ];
      return rows.map((p) => ({
        id: `${p._kind}:${p.company_id}`,
        title: `${p.company_name || p.src_name_en}（${p._kind}）`,
        url: 'https://www.butian.net/Reward/plan/2',
        statusText: p.service_status === '1' ? '开放' : String(p.service_status ?? ''),
        enrollOpen: true,
        quotaText: p.min_reward ? `¥${p.min_reward}-${p.max_reward}` : '', quotaLeft: null,
        meta: { kind: p._kind },
      }));
    },
  },

  /* ---------------- 需要凭据 / credentials required ---------------- */
  zhongce: {
    label: '360众测', needsCred: true,
    credReady: (creds) => !!creds.zhongce?.cookie,
    async verify({ cfg, creds, req }) {
      const r = await req('https://zhongce.360.net/api/hacker/center/certification-info', {
        headers: { cookie: creds.zhongce.cookie },
        referer: 'https://zhongce.360.net/hacker/project/',
        ua: pickUA(creds.zhongce, cfg),
      });
      if (r?.errno !== 0) throw new Error('360 credential invalid: ' + JSON.stringify(r).slice(0, 140));
      return { user: r.data?.username, cert: r.data?.certification_state };
    },
    async collect({ cfg, creds, req }) {
      const r = await req('https://zhongce.360.net/api/hacker/project/list?pn=0&ps=20', {
        headers: { cookie: creds.zhongce.cookie },
        referer: 'https://zhongce.360.net/hacker/project/',
        ua: pickUA(creds.zhongce, cfg),
      });
      if (r?.errno !== 0) throw new Error('360 needs re-login: ' + JSON.stringify(r).slice(0, 140));
      return (r.data?.list || []).map((p) => {
        const btn = p.btn_style?.btn || {};
        const statusText = p.project_status_text || '';
        return {
          // 360 的 id 每次请求随机，用标题做稳定键 / id rotates every request
          id: String(p.title), title: p.title,
          url: 'https://zhongce.360.net/hacker/project/',
          statusText,
          enrollOpen: statusText === '进行中' && btn.type !== 'disable',
          quotaText: btn.text || '', quotaLeft: null,
          meta: {
            sign_up_status: p.sign_up_status, level: p.level, business: p.business_type,
            bonus: p.highest_bonus, skills: p.skill_require, start: p.test_start, end: p.test_end,
          },
        };
      });
    },
  },

  bountyteam: {
    label: '雷神众测', needsCred: true,
    credReady: (creds) => !!creds.bountyteam?.token,
    async verify({ cfg, creds, req }) {
      const r = await req('https://www.bountyteam.com/web/v1/find/userstatus', {
        headers: { Authorization: creds.bountyteam.token },
        origin: 'https://www.bountyteam.com',
        referer: 'https://www.bountyteam.com/hacker-service/bug-bounty-list',
        ua: pickUA(creds.bountyteam, cfg),
      });
      if (r?.errcode !== 0) throw new Error(`bountyteam credential invalid: errcode=${r?.errcode} ${r?.errmsg || ''}`);
      return { user: r.ret?.username, status: r.ret?.status };
    },
    async collect({ cfg, creds, req }) {
      const r = await req('https://www.bountyteam.com/web/v1/project/getProjectList?size=30&page=1&lastPush=1', {
        headers: { Authorization: creds.bountyteam.token },
        origin: 'https://www.bountyteam.com',
        referer: 'https://www.bountyteam.com/hacker-service/bug-bounty-list',
        ua: pickUA(creds.bountyteam, cfg),
      });
      if (r?.errcode !== 0) throw new Error(`bountyteam needs re-login: errcode=${r?.errcode} ${r?.errmsg || ''}`);
      return (r.ret?.data || []).map((p) => {
        const left = num(p.remainderNum);
        return {
          id: String(p.id), title: p.name,
          url: `https://www.bountyteam.com/hacker-service/bugBounty-deatil/${p.id}`,
          statusText: p.states === 'doing' ? '进行中' : p.states === 'enrolling' ? '报名中' : p.states,
          enrollOpen: p.states !== 'stop' && !(left === 0),
          quotaText: p.remainderNum || '', quotaLeft: left,
          meta: {
            states: p.states, reward: `¥${p.lowriskreward}-${p.highriskreward}`,
            start: p.startime, daysLeft: p.surplus, difficulty: p.difficultyFactor,
          },
        };
      });
    },
  },
};

export default PLATFORMS;
