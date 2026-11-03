# 给服务器 Agent 的部署 Prompt（复制即用）

把下面整个代码块丢给你的服务器 agent（Claude Code / Cursor / Codex / 任何能执行命令的 agent）。
它分两阶段：**先无凭据跑通 3 家匿名平台**，再由人工投放凭据热加载。这样任何一步出问题都能定位。

---

```text
你的任务：在 /opt 部署开源项目 https://github.com/zz-protocol/bb-hunt （一个只读的众测项目监控服务，Docker 部署）。

## 前置要求
- 服务器有 docker + docker compose
- 有 git、ssh 出网能力
- 建议国内节点（监控的 5 个站点都在国内）

## 硬性约束（违反任何一条都算失败）
1. 不要修改仓库代码、不要改轮询间隔（45s 是刻意保守的，改了会触发平台风控）
2. 不要添加"自动报名/自动提交"相关功能
3. 不要在任何日志、commit、聊天里输出 data/ 下的文件内容（那是账号凭据）
4. 遇到 HTTP 401 / "凭据无效" 不要反复重试（会升级平台风控），把原文贴回来即可
5. 不要提权到平台账号做任何写操作

## 阶段一：无凭据部署 + 报数
1. git clone https://github.com/zz-protocol/bb-hunt.git /opt/bb-hunt
2. cd /opt/bb-hunt && bash install.sh
3. 执行并收集以下输出，原样贴回给我：
   - docker compose -f deploy/docker-compose.yml ps
   - docker compose -f deploy/docker-compose.yml exec bb-hunt node src/monitor.mjs doctor
   - docker compose -f deploy/docker-compose.yml exec bb-hunt node src/monitor.mjs status
   - docker compose -f deploy/docker-compose.yml logs --tail=40 bb-hunt
4. 判定标准：
   - 火线 / 漏洞盒子 / 补天 三家必须有数据（匿名，不需要凭据）
   - 360众测 / 雷神众测 此时应显示「缺凭据」或「跳过」，这是**正常**的，不要当失败
   - 如果三家匿名平台也拿不到数据，先排查出网/DNS，再报告

## 阶段二：投放凭据并热加载（等我提供两步文件）
我会把两份 JSON 内容发给你，你需要：
1. 写入 /opt/bb-hunt/data/credentials.json（平台凭据：360 cookie + 雷神 token）
2. 写入 /opt/bb-hunt/data/config.local.json（通知通道：钉钉应用机器人等）
3. chmod 600 /opt/bb-hunt/data/credentials.json /opt/bb-hunt/data/config.local.json
4. 热加载（不要 restart）：
   docker compose -f deploy/docker-compose.yml kill -s HUP bb-hunt
5. 等 15 秒后执行并贴回：
   - docker compose -f deploy/docker-compose.yml exec bb-hunt node src/monitor.mjs doctor
   - docker compose -f deploy/docker-compose.yml exec bb-hunt node src/monitor.mjs status
   - docker compose -f deploy/docker-compose.yml exec bb-hunt node src/monitor.mjs notify-test
   - docker compose -f deploy/docker-compose.yml logs --tail=30 bb-hunt

## 必须向我确认的 5 件事
1. 三家匿名平台的条数分别是多少（火线应约 100+、漏洞盒子约 10、补天约 38）
2. 360众测在服务器上 doctor 是 ✅ 还是 ❌（如果是 ❌ 但要贴原文 —— 这可能是平台 IP 绑定，需要我决策）
3. 雷神众测同理
4. notify-test 是否成功（我会确认手机/钉钉有没有收到）
5. 日志里有没有 "WARN cannot write state file"（有则说明 data 目录权限有问题，需 chown）

## 排障速查
- 容器反复重启 → 看 logs，多半是 data/credentials.json JSON 语法错
- 通知发不出 → logs 里搜 [notify:，会打印具体 HTTP 错误码
- 只想重置监控基线 → rm data/state.json 然后 kill -s HUP
- 只想要 3 家匿名平台 → 把 data/credentials.json 删掉即可，服务会自动跳过需要凭据的两家
- 更多细节见 /opt/bb-hunt/docs/AGENT.md
```

---

## 阶段二需要你（人类）提供的东西

在你自己电脑上（Node ≥ 22）：

```bash
# 一条命令：检查登录态 → 自动打开登录页 → 你点登录 → 自动导出 → scp 到服务器 → 热加载
node tools/renew-creds.mjs --push root@你的服务器:/opt/bb-hunt/data
```

跑完把 `data/credentials.json` 和 `data/config.local.json` 的内容发给服务器 agent 也行（等价）。
