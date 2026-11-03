# 凭据与生命周期

## 谁需要凭据

| 平台 | 需要？ | 凭据形态 | 从哪来 |
|---|---|---|---|
| 火线 | ❌ | — | 匿名 |
| 漏洞盒子 | ❌ | — | 匿名 |
| 补天 | ❌ | — | 匿名 |
| 360众测 | ✅ | `Cookie: Qs_* ; homepage-frontend=... ; _csrf-homepage=...` | 浏览器登录后导出 |
| 雷神众测 | ✅ | `Authorization: <uuid>`（localStorage `jwtToken`） | 浏览器登录后导出 |

**没有凭据也能跑 3 家**。缺凭据时对应平台会 `skip`，不会报错、不会阻塞其他平台。

## 导出步骤（在你自己电脑上）

1. 用**独立 profile** 启动 Chromium 内核浏览器并开调试端口（Chromium 136+ 不允许默认 profile）：

   ```powershell
   # Windows / Edge
   & "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
     --user-data-dir="$env:USERPROFILE\EdgeAuto" `
     --profile-directory=Default `
     --remote-debugging-port=9222 `
     --remote-allow-origins=* `
     --no-first-run `
     --disable-features=msSleepingTabs,msEfficiencyMode
   ```

   > `--disable-features=msSleepingTabs,...` 很重要：否则后台标签页会被浏览器休眠，CDP 取值超时。

2. 在这个窗口里登录 360众测、雷神众测。

3. 导出：

   ```bash
   node tools/export-creds.mjs --print   # 打印 JSON，方便贴到服务器
   node tools/export-creds.mjs           # 或直接写 data/credentials.json
   ```

   > 导出工具依赖全局 `WebSocket`，需要 **Node ≥ 22**（服务端本体只需 ≥ 18.17）。
   > Node 20 可加 `--experimental-websocket` 运行。

4. 把 JSON 放到服务器 `data/credentials.json`，重启容器。

## 有效期与失效

| 平台 | 是否有 refresh | 失效后怎么办 |
|---|---|---|
| 360众测 | ❌ 无 | 重新导出（浏览器里还登着）或重新登录后再导出 |
| 雷神众测 | ❌ 无 | 同上 |

- 系统默认每 `healthIntervalSeconds`（默认 600s）做一次**主动体检**，并在每次采集失败时立即判定
- 失效会立刻推送 `⚠️ [平台] 凭据已失效`，**告警里带「已连续有效 X 小时 Y 分」**——第一次收到就能知道这套凭据实际能撑多久
- 恢复后会推 `✅ [平台] 凭据已恢复`（`recoverNotify: false` 可关）
- 同一平台 10 分钟内不重复推（`notify.dedupeMinutes`）

## 两个真实风险

### 1. IP 绑定 / 风控

凭据在 A 地签发、在 B 地（服务器）使用，平台可能：
- 直接判会话无效（401）→ `probe` / `doctor` 会报出来
- 或记为异地登录（最坏情况影响账号信誉）

**部署第一步必须跑 `doctor`**（`install.sh` 会自动跑）。如果 360 报 401 而本机可用，说明它对 IP 敏感，可选：
- 服务器请求走你日常出口 IP 的代理
- 或在服务器上跑无头浏览器登录（本项目未包含，属于另一套方案）

### 2. 凭据会被平台主动失效

改密码、平台安全策略调整、长时间不活跃、风控命中，都会让会话失效。所以**不可能"部署完永久不用管"**：
- 3 家匿名平台：永久无人值守
- 2 家需凭据平台：靠告警驱动人工续期，正常一两个月一次的量级（实际间隔由告警里的"连续有效时长"告诉你）

## 安全

- `data/credentials.json`、`data/config.local.json` 等同于账号登录态与机器人密钥
- 仓库 `.gitignore` 已忽略 `data/`；`chmod 600`；不要贴到 issue / 聊天 / 公开仓库
- 建议单独建 `bb-hunt` 系统用户跑容器，别用 root
- 凭据泄露的处置：去平台退出该设备会话 / 改密码，然后重新导出
