# bb-hunt

**众测 / 漏洞赏金项目的只读监控 + 凭据健康检查 + 多通道告警。零浏览器、零第三方依赖、一个 Docker 容器。**

> Read-only watcher for Chinese bug-bounty / crowd-testing platforms. Zero deps, Docker-ready.
> It never submits anything — it just tells you when a project appears, when enrollment opens, and when your session credential dies.

[![ci](https://github.com/zz-protocol/bb-hunt/actions/workflows/ci.yml/badge.svg)](https://github.com/zz-protocol/bb-hunt/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen.svg)](package.json)

---

## 它解决什么问题

国内众测平台的"抢不到项目"通常不是手速问题，而是三件事：

1. **不知道什么时候上新** —— 项目在半夜/你不在电脑前时上线，名额几小时就满了
2. **登录态悄悄失效** —— 很多平台是会话 Cookie / 短票据，掉了你不知道，等发现时早就错过了
3. **"抢"根本不是机制** —— 有的平台是审核制、邀请制、或长期开放，纯手速没有意义

bb-hunt 只做三件事：**发现变化 → 立刻通知 → 告诉你凭据还活着吗**。

## 特性

- 🔍 **5 个平台**，统一归一化成 `{id,title,status,enrollOpen,quotaLeft,...}` 后做 diff
- 🕐 **45s ± 12s 随机抖动**轮询，串行不并发（刻意保守，避免风控）
- 🔐 **凭据健康检查**：每 10 分钟主动探测一次，失效立刻告警，恢复也告警
- 📊 **告警带"已连续有效 X 小时"**：让你知道这套凭据到底能撑多久
- 📮 **多通道路由**：钉钉（应用机器人 / 群 Webhook）、企业微信、Telegram、任意 HTTP 端点、控制台
- 🧹 **去重**：同一项目同一变化 10 分钟内只推一次
- 🐳 **Docker 一条命令**：`bash install.sh`，幂等可重复
- 🚫 **零依赖**：不用 npm install，只用 Node 内置 API

## 支持平台

| 平台 | 监控内容 | 需要凭据 |
|---|---|---|
| [火线](https://www.huoxian.cn/community#project) | 新项目、状态变化 | 否（匿名） |
| [漏洞盒子](https://www.vulbox.com/flashFesting/hall) | 新闪测期次、接单开放 | 否（匿名） |
| [补天](https://www.butian.net/Reward/plan/2) | 新增专属/企业 SRC | 否（匿名） |
| [360众测](https://zhongce.360.net/hacker/project/) | 新项目、**报名是否开放** | 是（会话 Cookie） |
| [雷神众测](https://www.bountyteam.com/hacker-service/bug-bounty-list) | 新项目、**名额 0→有** | 是（token） |

> 3 家匿名平台**永远无人值守**；2 家需凭据的平台在凭据过期后会告警，续期只需在你电脑上重新导出一次。

## 快速开始（Docker）

```bash
git clone https://github.com/zz-protocol/bb-hunt.git
cd bb-hunt
bash install.sh
```

`install.sh` 会：检查 docker → 建 `data/` → 构建 → 跑 `doctor` 自检 → 启动。

**只需要 3 家匿名平台**（什么都不配就能跑）：

```bash
docker compose -f deploy/docker-compose.yml logs -f bb-hunt
```

**想要 360 / 雷神 的告警**，在你自己电脑上导出凭据（见下），把 JSON 放到服务器的 `data/credentials.json`，重启容器。

## 配置

所有可变数据都在 `data/`，不会进 git：

```
data/
├── credentials.json     # 平台凭据（360 cookie / 雷神 token）
├── config.local.json    # 私密配置：通知密钥（覆盖 config.json）
├── state.json           # 监控基线（删除它会重新建立基线，不告警）
├── alerts.jsonl         # 所有告警历史
└── monitor.log          # 运行日志
```

### 1. 导出平台凭据（在你电脑上）

```powershell
# Edge 必须用独立 profile + 调试端口（Chromium 136+ 不允许默认 profile 开调试）
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --user-data-dir="$env:USERPROFILE\EdgeAuto" --profile-directory=Default `
  --remote-debugging-port=9222 --remote-allow-origins=* --no-first-run `
  --disable-features=msSleepingTabs,msEfficiencyMode

# 在这个窗口里登录 360众测、雷神众测，然后：
node tools/export-creds.mjs --print
```

把输出贴到服务器 `data/credentials.json`。详见 [docs/CREDENTIALS.md](docs/CREDENTIALS.md)。

> 导出工具需要 **Node ≥ 22**（用到全局 `WebSocket`）；服务端容器内自带 Node 20，不受影响。

### 2. 配置通知通道

`data/config.local.json`（可多条并存）：

```json
{
  "notify": {
    "dedupeMinutes": 10,
    "channels": [
      { "type": "dingtalk-app", "clientId": "<AppKey>", "clientSecret": "<AppSecret>",
        "robotCode": "<ClientID>", "userIds": ["<你的钉钉 UserID>"] },
      { "type": "console" }
    ]
  }
}
```

支持的 `type`：

| type | 必填字段 | 说明 |
|---|---|---|
| `dingtalk-app` | `clientId`,`clientSecret`,`userIds` 或 `openConversationId` | 钉钉企业内部应用机器人（发个人 / 发群） |
| `dingtalk` | `webhook`, 可选 `secret` | 钉钉群自定义机器人 |
| `wecom` | `webhook` | 企业微信群机器人 |
| `telegram` | `botToken`,`chatId` | Telegram Bot |
| `generic` | `url`, 可选 `headers` | 任意 HTTP 端点，收到 `{title,body,url,type,platform}` |

测试一条：`docker compose -f deploy/docker-compose.yml exec bb-hunt node src/monitor.mjs notify-test`

## 命令

```bash
DC="docker compose -f deploy/docker-compose.yml"

$DC exec bb-hunt node src/monitor.mjs status       # 各平台条数 / 登录态 / 最后采集时间
$DC exec bb-hunt node src/monitor.mjs probe        # 只做凭据体检
$DC exec bb-hunt node src/monitor.mjs doctor       # 环境自检（Node/配置/凭据/通知通道）
$DC exec bb-hunt node src/monitor.mjs once         # 单次采集并打印
$DC exec bb-hunt node src/monitor.mjs notify-test  # 发一条测试通知
$DC logs -f bb-hunt
```

## 告警长什么样

```json
{"ts":"2026-11-03T12:14:32Z","type":"new","platform":"bountyteam","key":"bountyteam:11590:new",
 "title":"🆕 [雷神众测] 【Vol.2016】某银行网站众测",
 "body":"状态：stop｜名额：0人｜奖金：¥800-15000","url":"https://..."}
```

| type | 含义 |
|---|---|
| `🆕 new` | 新项目出现 |
| `🔓 open` | 报名从关闭 → 开放 |
| `🎯 quota` | 剩余名额 0 → 有 |
| `⚠️ session` | 凭据失效（带"已连续有效 X 小时"） |
| `✅ recover` | 凭据恢复 |

## 工作原理

```
┌────────────── 每 45s ──────────────┐
│ collectors × 5 (纯 HTTP, 串行)      │
│   ├─ 归一化 {id, enrollOpen, quota} │
│   ├─ 与 data/state.json 做 diff     │
│   └─ 有变化 → notifier → 各通道     │
└────────────────────────────────────┘
┌────────── 每 600s 健康检查 ────────┐
│ verify() × 2 → 失效/恢复 → 告警     │
└────────────────────────────────────┘
```

不需要浏览器：凭据是直接重放的 Cookie / Authorization 头（360、雷神实测可用）。详见 [docs/PLATFORMS.md](docs/PLATFORMS.md)。

## 合规与边界（请先读）

本项目**刻意只做只读监控**：

- ✅ 调用的都是各平台**公开列表/详情接口**
- ❌ **不做**自动报名、自动提交漏洞、自动签协议、任何写操作
- ❌ **不做**验证码识别、不做多账号、不做并发压测

原因：

1. 多个平台的报名/接单有**图形验证码**（雷神 `/captcha/generate`、补天极验），绕过即属"绕过技术保护措施"
2. 所有平台用户协议都有兜底条款（"破坏公平交易环境"、"扰乱平台运行"、"账户操作异常"），处罚可到**封号 + 冻结/清空奖金**
3. 账号是**实名 + 可信认证**的长期资产，风险收益严重不对称
4. 更重要的是：**抢到 ≠ 进项目**（多数是审核制/名额制/邀请制），提前 3 秒的边际价值极低

**正确的用法**：把"发现延迟"从几小时压到 45 秒，然后由你本人点最后一下。

## FAQ

<details>
<summary>为什么不用浏览器 / Playwright？</summary>

不需要。3 家平台匿名可读；另外 2 家的凭据（Cookie / Authorization 头）可以直接用 HTTP 重放，实测有效。
浏览器方案还多两个坑：Chromium 136+ 禁止对默认 profile 开调试端口；后台标签页会被休眠导致 CDP 取值超时。
</details>

<details>
<summary>凭据能用多久？</summary>

不知道 —— 这是按平台服务端策略定的，没有公开值，也没有 refresh 接口。所以本项目不猜：它**测量**。
失效时告警里会写「已连续有效 X 小时 Y 分」，第一次收到你就知道实际寿命了。
</details>

<details>
<summary>部署在服务器上，凭据会不会因为 IP 不同失效？</summary>

有可能。所以部署第一步是 `doctor`/`probe`：它会在**服务器 IP** 上真实请求一次。若 360 报 401 而本机正常，说明平台对 IP 敏感，可选「走代理」或「服务器端无头浏览器登录」。
</details>

<details>
<summary>能加平台吗？</summary>

能。在 `src/collectors.mjs` 里加一个对象，实现 `collect({cfg,creds,req})` 返回归一化数组即可；需要登录态的再实现 `verify()` 和 `credReady()`。
</details>

<details>
<summary>会不会把平台打崩 / 被风控？</summary>

默认 45s + 随机抖动 + 平台间串行 + 3 次重试退避，单账号单 IP，负载等同于一个人开着页面偶尔刷新。**不要**把它调到几秒级。
</details>

## 开发

```bash
node tests/smoke.mjs          # 离线测试
node tests/smoke.mjs --live   # 联网测试（会打 3 家匿名接口）
DATA_DIR=./data node src/monitor.mjs doctor
```

CI 覆盖 Node 18 / 20 / 22 + Docker 构建。

## 目录

```
src/monitor.mjs      # 主循环 / diff / 健康检查 / CLI
src/collectors.mjs   # 5 个平台采集器
src/notify.mjs       # 通知通道
tools/export-creds.mjs  # 电脑端导出凭据（需要 Chromium 调试端口）
deploy/              # Dockerfile / compose / systemd
docs/                # PLATFORMS / CREDENTIALS / AGENT
```

## License

[MIT](LICENSE) · 仅限合法授权的安全测试与个人信息获取。使用者自行承担遵守平台协议与当地法律的义务。
