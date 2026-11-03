# Changelog

## 1.1.1 — 2026-11-03

### 文档
- 新增 `docs/DEPLOY-PROMPT.md`：可直接复制给服务器 agent 的两阶段部署 Prompt
  （先无凭据跑通 3 家匿名平台 → 再投放凭据热加载），含硬性约束与必须回报项
- `docs/AGENT.md`：配置/凭据一律用 `kill -s HUP` 热加载（不再 restart），补「凭据续期不在服务器上做」
- `install.sh`：下一步提示改为热加载

## 1.1.0 — 2026-11-03

### 新增
- `tools/renew-creds.mjs` 凭据续期助手：
  - 自动拉起带调试端口的浏览器（独立 profile、禁用后台标签页休眠）
  - 逐家校验现有凭据，对失效平台自动打开登录页并**盯登录**，成功即捕获
  - 写出 `data/credentials.json`（chmod 600）
  - `--push user@host:/path` 自动 scp + 远端 SIGHUP 热加载
  - `--watch` 常驻模式：登录态恢复即自动重新导出推送
- 服务端 **SIGHUP 热加载**：`docker compose kill -s HUP bb-hunt` 即可重载 `credentials.json` /
  `config.local.json` 并立刻重跑体检，无需重启容器

## 1.0.0 — 2026-11-03

首个版本。

### 新增
- 五个平台的只读监控：火线、漏洞盒子、补天（匿名）+ 360众测、雷神众测（凭据重放）
- 统一归一化 `{id,title,statusText,enrollOpen,quotaText,quotaLeft,meta}` + 状态 diff
- 告警类型：`new` / `open` / `quota` / `session` / `recover`
- 凭据健康检查：周期性 `verify()`，失效与恢复均推送，含"已连续有效时长"
- 通知通道：钉钉企业内部应用机器人、钉钉群 Webhook、企业微信、Telegram、任意 HTTP、控制台
- 去重（同 key 10 分钟）、日志轮转、状态原子写入
- CLI：`daemon` / `once` / `probe` / `status` / `doctor` / `notify-test`
- `tools/export-creds.mjs`：从 Chromium（Edge/Chrome）调试端口导出凭据
- Docker + docker-compose + systemd unit + 幂等 `install.sh`
- 离线 smoke 测试 + GitHub Actions CI（Node 18/20/22 + Docker build）

### 已知限制
- 360 / 雷神 的凭据无 refresh 接口，过期需人工重新导出
- 高级项目（漏洞盒子 `/projects/list`）需要登录 + 额外参数，未覆盖
- 只监控列表级变化，不监控项目详情内的条款/资产变更
- 平台改版会导致对应采集器失败（日志可见，需更新 collector）
