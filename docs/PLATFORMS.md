# 五平台机制与接口（实测记录）

> 采集全部为**只读**：只调列表/详情接口，不调报名、提交、签署类写接口。
> 所有 `id` 字段均为本项目内部归一化后的稳定键，不是平台原始 ID（360 除外说明）。

## 总览

| 平台 | 报警类型 | 需凭据 | 原始接口 |
|---|---|---|---|
| 火线 huoxian.cn | 新项目 / 开放 | 否 | `POST /fireapi/fireapp/projectList/` |
| 漏洞盒子 vulbox.com | 新闪测 / 开放 | 否 | `GET vapi.vulbox.com/web/project/flash/projects` |
| 补天 butian.net | 新增 SRC | 否 | `POST /Reward/corps`、`POST /Reward/com` |
| 360众测 zhongce.360.net | 新项目 / 报名开放 | **是**（Cookie） | `GET /api/hacker/project/list` |
| 雷神众测 bountyteam.com | 新项目 / 放名额 | **是**（token） | `GET /web/v1/project/getProjectList` |

## 火线

- 匿名可读，`{page:1,page_size:200}` 不传 type/status 会返回全量（当前约 103 条）
- 字段：`id / name / status.value（未开始|进行中|暂停中|已结束|即将开始）/ contractNeed / reward_level`
- `enrollOpen` = 状态为「进行中」或「即将开始」
- 加入方式：登录 + 签项目协议（`contractNeed=1`），**没有名额概念**，不是抢单场景
- 当前项目大多是长周期企业 SRC（2020–2027），新项目出现频率低

## 漏洞盒子

- 匿名可读：`/web/project/flash/projects?page=1&pageSize=50`
- 字段：`id / task_title / status / join_available / audit_application / is_joined`
- `enrollOpen` = `join_available`
- 高级项目（`/projects/list`）的接口需要登录 + 额外 `flag` 参数，本项目未覆盖；闪测大厅足够反映上新

## 补天

- 匿名可读（multipart form）：`/Reward/corps`（专属SRC）、`/Reward/com`（企业SRC）
- 字段：`company_id / company_name / min_reward / max_reward / service_status`
- 项目大厅卡片按钮是「提交漏洞」，**不是报名**；真·众测在 `zhongce.butian.net`，需要邀请码（排名前 300 / 近一年专属 SRC 高危 5+ / 其他 SRC 前 3 / 内推，四条满足两条）
- 本采集器监控的是「新增 SRC 计划」

## 360 众测

- 需要登录态。凭据 = `homepage-frontend` + `_csrf-homepage` 等 HttpOnly 会话 Cookie
- 接口：`GET /api/hacker/project/list?pn=0&ps=20`、`GET /api/hacker/center/certification-info`
- 字段：`title / project_status_text / sign_up_status / btn_style.btn.{text,type} / highest_bonus / business_type / skill_require`
- `enrollOpen` = `project_status_text === '进行中'` 且按钮未 disable
  （`sign_up_status === '2'` 表示"报名人数过多，现已暂停报名"）
- ⚠️ **项目 `id` 每次请求都会变**（加密 token），所以用 `title` 当稳定键
- 无 refresh 接口，会话失效只能重新导出

## 雷神众测

- 需要登录态。凭据 = localStorage `jwtToken`，以 `Authorization: <token>` 头发送
- 接口：`GET /web/v1/project/getProjectList?size=30&page=1&lastPush=1`、`GET /web/v1/find/userstatus`
- 字段：`id / name / remainNumber（"0人"/"1人"/"不限人数"）/ states / lowriskreward / highriskreward / surplus`
- `enrollOpen` = `states !== 'stop'` 且 `remainNumber` 不为 0 人
- 报名本身有**图形验证码**（`/captcha/generate`、`/imageCode`）→ 本项目**不做**自动报名
- 无 refresh 端点；前端 localStorage 的 7h 只是本地缓存 TTL，票据真实寿命取决于服务端

## 归一化输出

```js
{
  id: "1612期众测项目",        // 稳定键
  title: "1612期众测项目",
  url: "https://...",          // 打开详情/列表页
  statusText: "进行中",
  enrollOpen: false,
  quotaText: "申请加入",       // 名额/按钮文案
  quotaLeft: null,             // 数值型剩余名额（可比较 0 → >0）
  meta: { bonus: "11000", business: "金融", skills: [...], ... }
}
```

## 已知限制

- 平台改版会导致采集器报 `FAIL`（日志可见），需要更新对应 collector
- 360 列表顺序不固定（随机 id 影响排序），diff 只按 key 比对，不受影响
- 只覆盖「列表级」变化；项目详情页内的条款/资产变更不监控
