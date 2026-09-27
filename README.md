# 多账号群组消息管理平台

面向《全栈开发工程师笔试题（2026-09-26）》的完整实现：Node.js + TypeScript + PostgreSQL 后端，React 18 控制台，并自带可注入故障的**消息网关**与 **Agent** 模拟服务，便于本地演示与自动化验收。

## 给评审的快速路径

| 用时                       | 建议操作                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **约 2 分钟**              | 对照下文「需求完成度」表；扫一眼「设计要点」是否与题目 A/B 组一致。                                                                     |
| **约 10 分钟**             | `pnpm install && make up`，浏览器打开 Web 控制台，用 `admin/admin` 登录体验账号、建群、时间线与 Agent。                                 |
| **约 15 分钟（可脚本化）** | 服务已启动的前提下，依次跑「自动化验收」中与题目 **S1–S8** 对应的命令（见下表映射）。                                                   |
| **读代码**                 | 从 `apps/api` 的网关 SSE 消费、出站 outbox、Agent 编排与 `packages/contracts` 的 Zod 契约入手；可靠性提纲见「网关不可靠时的处理思路」。 |

**题目典型场景与仓库脚本**

| 题目场景                        | 验收命令                        |
| ------------------------------- | ------------------------------- |
| S1 受理与发出                   | `pnpm scenario smoke`           |
| S2 事件重复                     | `pnpm scenario s2`              |
| S3 己方消息回流                 | `pnpm scenario s3`              |
| S4 限流                         | `pnpm scenario s4`              |
| S5 Agent 同 key 重试 / 504 对账 | `pnpm scenario s5`              |
| S6 Agent 坏响应                 | `pnpm scenario s6`              |
| S7 序列并发互斥                 | `pnpm sequence:verify`（含 S7） |
| S8 占位符预检                   | `pnpm sequence:verify`（含 S8） |

另有：`pnpm scenario agent`（Agent 端到端）、`pnpm auth:verify`（B3 会话）、`pnpm group-lifecycle:verify`（B2）、`pnpm lab:verify`（控制台可靠性实验）、`pnpm account-concurrency:verify`（账号并发）。

## 技术栈与仓库结构

与题干一致：**后端** Fastify + PostgreSQL；**前端** React 18 + Vite + TypeScript。对外 REST、WebSocket；对接题干中的消息网关（HTTP + SSE）与 Agent（Anthropic tool use 形状），开发和演示由本仓库内的 Mock 服务承担。

```text
apps/
  api/             平台 API、持久化、Worker（网关 SSE / 出站 / Agent / 序列）
  web/             运营管理控制台（题目第 4 节页面 1–5）
  mock-gateway/    可配置故障的消息网关模拟
  mock-agent/      Agent 协议与异常行为模拟
packages/
  contracts/       Zod Schema + 共享 TypeScript 类型（API / WS / 协议）
scripts/           场景与全栈验收脚本
```

本仓库为 **pnpm monorepo**：各 app 可独立 `build` 与部署；`packages/contracts` 与 API、前端、Mock 在同一次 PR 内一起改，避免契约与实现脱节。根目录一份 `pnpm-lock.yaml` 统一依赖版本。

## 本地启动

**环境**：Node.js 22+、pnpm 10+、Docker（仅 PostgreSQL）。

```bash
pnpm install
make up
```

`make up` 等价于：

```bash
pnpm infra:up      # PostgreSQL → localhost:55432
pnpm db:migrate    # 可重复执行的数据库迁移
pnpm dev           # API、Web、Mock 网关、Mock Agent 并行开发模式
```

分步执行：`make infra-up`、`make db-migrate`、`make dev`。

| 服务          | 地址                            |
| ------------- | ------------------------------- |
| Web 控制台    | http://localhost:5173           |
| API / Swagger | http://localhost:3000/docs      |
| OpenAPI JSON  | http://localhost:3000/docs/json |
| Mock 消息网关 | http://localhost:4001           |
| Mock Agent    | http://localhost:4002           |

**演示登录**

- `admin / admin`：读写
- `viewer / viewer`：只读（界面隐藏写操作；直接调写接口返回 `403`）

预置服务账号「小红助手 / 小明助手 / 小张助手」；管理员还可在控制台新建账号。新账号为 `idle`，需先连接网关后才可参与建群与发消息（与题干 2.1 一致）。

**环境变量**：见 `.env.example`（`PORT`、`DATABASE_URL`、`GATEWAY_URL`、`AGENT_URL`、`JWT_SECRET`、`WEB_ORIGIN`、`DEMO_MODE` 等）。非演示环境建议 `DEMO_MODE=false`，关闭 Mock 网关上的故障注入开关。

**数据库迁移**：部署时显式执行 `pnpm db:migrate`。若库表版本落后于代码内置 migration，**API 拒绝启动**并提示先迁移，避免运行中才因缺表报错。

## 设计要点（与题目对照）

以下是对题干 A/B 组的实现取向摘要，细节以代码与 OpenAPI 为准。

- **账号（A1）**：有限状态机 + 操作员手动转移（CAS）；终态时清成员、取消排队发送、推 `account_terminal`。
- **网关边界（A2）**：出站先落库再调网关（outbox），崩溃可续发；入站按 `(groupId, msgId)` 去重；504 → `unknown` 后对账，确认未发出时最多重试一次；写库失败不丢事件，推 `inconsistency`。
- **建群（A3 / B2）**：异步 Job（建群 → 邀请 → join → 等事件 → promote）；邀请未就绪/过期重试；`leave-all` 非群主先退、群主最后退。
- **时间线与实时（A4 / B4）**：消息 keyset 分页；WebSocket 单调 `seq`，断线 `sinceSeq` 补发。
- **Agent（A5）**：非己方消息触发；单群单 run；审计门控；run 内 `idempotency_key` 幂等；步数/时长/协议错误上限；重启可恢复。
- **定时序列（B1）**：占位符预检（S8）；单群单 running（S7）；与出站管道共用发送与限流逻辑。
- **会话（B3）**：Refresh HttpOnly Cookie、轮换与重放作废；Logout 立即使 access token 失效。
- **契约与文档**：路由校验、TS 类型与 Swagger 来自同一套 Zod 定义（`packages/contracts` + API 注册）。

**选做 C1–C3**（媒体落盘、真实 LLM Agent、Playwright E2E）：未实现，时间集中在 A/B 主线与可重复验收。

## 网关不可靠时的处理思路

题干 2.1 规定 SSE 为 **至少一次（at-least-once）** 投递：可能重复、短暂乱序、随时断连。平台在网关之上用 PostgreSQL 与后台 Worker，把边界外的不可靠收敛为**可持久化、可恢复、可对账**的内部状态。读代码时可按下面 checklist 对照。

### 入站（SSE → 库 → 控制台）

| 关注点      | 做法                                                        |
| ----------- | ----------------------------------------------------------- |
| 重复        | 同一 `msgId` / 事件只生效一次（验收：`pnpm scenario s2`）   |
| 乱序        | 展示与分页按 `sentAt` 与 keyset，不按到达顺序               |
| 断连        | 持久化 `since` 游标，重启后续传                             |
| 己方回流    | 合并到原 outbound，`isOwn=true`，不触发 Agent（`s3`）       |
| 账号 / 成员 | `account_status`、成员进出与建群 Job 对齐                   |
| 持久化失败  | 不中断消费、不静默丢事件；推 `inconsistency`，留 inbox 重试 |

去重键是网关分配的 **`msgId`**，不是正文：不同 `msgId` 内容相同也占两行。

### 出站（API / Worker → 网关）

| 关注点   | 做法                                                              |
| -------- | ----------------------------------------------------------------- |
| 可靠性   | 先写 outbox 再请求网关（`smoke`）                                 |
| 状态     | `queued → accepted → sent` / `failed` / `unknown` / `cancelled`   |
| 限流     | `429` → `rate_limited`，排队消息保留并按序再发（`s4`）            |
| 504      | `unknown` → `by-client-id` 对账；确认未发出时最多重试一次（`s5`） |
| 异步命令 | 建群、进退群等走 Job 与重试（A3、B2）                             |

### 同一管道上的能力

Agent 触发与工具执行、定时序列排期、WebSocket 推送，均复用上述入站 / 出站与账号状态逻辑。

## 自动化验收

需先 `make up`（或等价地启动 API 与 Mock）。脚本会通过公开 API 准备数据、向 Mock 注入题干行为，并断言可观察结果；**不会**直接改库伪造成功。

```bash
pnpm scenario smoke   # S1：queued → accepted → sent
pnpm scenario s2      # S2
pnpm scenario s3      # S3
pnpm scenario s4      # S4
pnpm scenario s5      # S5
pnpm scenario s6      # S6
pnpm scenario agent   # Agent 读群、审计、发送、结束
pnpm sequence:verify  # S7 + S8 + 序列运行
pnpm auth:verify      # B3 Refresh / 重放 / Logout
pnpm group-lifecycle:verify
pnpm account-concurrency:verify
pnpm lab:verify       # 控制台五项可靠性实验
```

## 需求完成度

| 需求                                  | 状态   | 证据（实现或验收）                                 |
| ------------------------------------- | ------ | -------------------------------------------------- |
| A0 可重复 Migration 与结构版本保护    | 已完成 | `pnpm db:migrate`；启动时版本校验                  |
| A0 admin/viewer 权限                  | 已完成 | 前端可见性 + API 鉴权                              |
| A1 账号状态机与 CAS                   | 已完成 | 条件更新、终态清理；`account-concurrency:verify`   |
| A2 出站生命周期与 outbox              | 已完成 | `outbox-compensation.test.ts`；`smoke`、`s4`、`s5` |
| A2 入站去重与己方合并                 | 已完成 | 唯一约束；`s2`、`s3`                               |
| A2 SSE 游标与缺口补洞                 | 已完成 | 持久化水位，连续推进                               |
| A3 异步建群                           | 已完成 | Job 模型 + 前端任务状态                            |
| A4 时间线 keyset + WS                 | 已完成 | `(sent_at, id)` 游标；`ws_events` 补发             |
| A5 Agent 单群单 run、审计、幂等、恢复 | 已完成 | 部分唯一索引；`agent`、`s6`；步骤 API              |
| A6 页面 1–3                           | 已完成 | 登录、账号、群详情与时间线、Agent 列表             |
| B1 定时序列                           | 已完成 | Worker + 预检；`sequence:verify`；页面 5           |
| B2 邀请与 leave-all                   | 已完成 | `group-lifecycle:verify`                           |
| B3 Refresh 轮换                       | 已完成 | `auth:verify`                                      |
| B4 断线补齐与 Agent 详情              | 已完成 | `sinceSeq`；运行详情页 / 抽屉                      |
| C1–C3                                 | 未做   | 选做项                                             |

## 开发与质量

```bash
pnpm build       # 生产构建（含 contracts）
pnpm lint        # ESLint + 各包 tsc + Prettier
pnpm test        # 单元 / 集成测试
pnpm format      # Prettier 写回
pnpm db:migrate  # 迁移
```

- **pre-commit**：`lint-staged`（ESLint fix + Prettier）。
- **pre-push**：`pnpm lint && pnpm test`。
