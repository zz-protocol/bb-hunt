# Agent 部署指引（给服务器上的自动化 agent）

本文档假设：一台 Linux 服务器，有 docker + docker compose，仓库已克隆到 `/opt/bb-hunt`。
目标：把服务跑起来，并让人类确认"凭据在此服务器 IP 上可用"。

## 0. 前置检查

```bash
docker info >/dev/null && echo docker-ok
docker compose version
node --version        # 可选，仅用于本地调试；容器内自带 node 20
```

## 1. 克隆与部署

```bash
git clone https://github.com/zz-protocol/bb-hunt.git /opt/bb-hunt
cd /opt/bb-hunt
bash install.sh
```

`install.sh` 是**幂等**的，重复执行安全。它会：
1. 检查 docker / compose
2. `mkdir data` 并在缺失时从 example 复制 `credentials.json`、`config.local.json`
3. 构建镜像
4. 跑 `doctor` 自检（**关键**：这一步会验证凭据在**本服务器 IP** 上是否可用）
5. `up -d` 启动

## 2. 读 doctor 输出并如实上报

- 全部 ✅ → 正常，进入第 4 步
- `360众测: 凭据无效 → HTTP 401` 且人类那台机器上是好的 → **大概率 IP 绑定**，这是必须让人知道的信息，不要自己反复重试
- `雷神众测: 缺凭据` → 人还没提供，先跑 3 家匿名的（服务会自动 skip）
- `通知通道: 只有 console` → 提醒人类配置 `data/config.local.json`，否则告警只在日志里

## 3. 配置（人类提供的素材）

两份文件，**只写在 `data/` 下**：

`data/credentials.json`（平台凭据，来自人类电脑的 `node tools/export-creds.mjs --print`）
```json
{ "zhongce": { "cookie": "...", "userAgent": "..." },
  "bountyteam": { "token": "...", "userAgent": "..." } }
```

`data/config.local.json`（通知通道，覆盖 `config.json`）
```json
{ "notify": { "channels": [
  { "type": "dingtalk-app", "clientId": "...", "clientSecret": "...", "userIds": ["..."] },
  { "type": "console" } ] } }
```

```bash
chmod 600 data/credentials.json data/config.local.json
docker compose -f deploy/docker-compose.yml restart bb-hunt
```

## 4. 验收（必须全部做）

```bash
DC="docker compose -f deploy/docker-compose.yml"

$DC exec bb-hunt node src/monitor.mjs status        # 5 家都有 items、login 状态符合预期
$DC exec bb-hunt node src/monitor.mjs notify-test   # 人类应该在钉钉/手机收到一条
$DC logs --tail=30 bb-hunt                          # 无反复 FAIL / 无 crash loop
```

期望日志形如：

```
=== bb-hunt daemon started ===
火线      ok items=103 alerts=0 1441ms
雷神众测   ok items= 30 alerts=0  294ms
health zhongce     ✅ kingzzp cert=1
health bountyteam  ✅ xianggudahundun credible
```

## 5. 交给人类的验收清单

- [ ] `docker ps` 显示 bb-hunt 为 running
- [ ] `status` 里 5 家平台都有条目（匿名的 3 家不需要凭据）
- [ ] `notify-test` 的消息已到达手机
- [ ] doctor 输出里 360/雷神 是 ✅（否则说明 IP 有问题，需人类决策）
- [ ] `alerts.jsonl` 里没有 `"type":"session"`

## 6. 绝对不要做的事

- ❌ 不要把 `credentials.json` / `config.local.json` 提交进 git、贴进聊天、写进日志
- ❌ 不要调高轮询频率"抢"项目：默认 45s 是刻意保守的；调到几秒会触发平台风控
- ❌ 不要在本项目基础上加"自动报名/自动提交"：请求会被平台判定为异常操作（详见 README 的合规说明）
- ❌ 不要在没有人类确认的情况下反复重试失效凭据（会让风控升级）

## 7. 排障

| 现象 | 处理 |
|---|---|
| 容器反复重启 | `docker logs bb-hunt` 看是否有 JSON 解析错误（多半是 `data/credentials.json` 写坏了） |
| 微信/钉钉收不到 | `monitor.log` 里搜 `[notify:`，会打印具体 HTTP 错误 |
| `HTTP 401` 只对 360 | IP 绑定，上报人类，不要重试 |
| 某平台一直 FAIL | 平台可能改版，看 `docs/PLATFORMS.md` 更新 collector，或先 `platforms.<name>: false` 关掉 |
| state 想重置 | `rm data/state.json && restart`（会重新建立基线，不告警） |
