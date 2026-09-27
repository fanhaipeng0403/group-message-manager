## 仓库结构

```text
apps/
  api/             Fastify API、PostgreSQL 持久化与可靠性 Worker
  web/             React 18 运营管理控制台
  mock-gateway/    支持故障注入的 HTTP + SSE 消息网关
  mock-agent/      工具调用 Agent 协议模拟器
packages/
  contracts/       Zod 运行时 Schema 与 TypeScript 通信类型
docs/              架构说明、可靠性约束与设计决策记录
scripts/           可执行的可靠性验收场景
```

每个应用都有独立的 `package.json`，可以分别构建和部署。仓库使用 pnpm workspace，让接口契约和调用方可以在同一次变更中原子更新，并共享一份锁文件；当前规模不需要额外引入 Nx 或 Turborepo。

## 快速启动

环境要求：Node.js 22+、pnpm 10+、Docker。

```bash
pnpm install
make up
```

`make up` 按顺序执行：

```bash
pnpm infra:up      # 启动 PostgreSQL（localhost:55432）
pnpm db:migrate    # 执行数据库迁移
pnpm dev           # 同时启动 API、Web、Mock 网关、Mock Agent
```

需要单独跑某一步时，用 `make infra-up`、`make db-migrate` 或 `make dev`。

启动后可访问：

| 服务          | 地址                       |
| ------------- | -------------------------- |
| Web 控制台    | http://localhost:5173      |
| API / Swagger | http://localhost:3000/docs |
| Mock 消息网关 | http://localhost:4001      |
| Mock Agent    | http://localhost:4002      |

机器可读的 OpenAPI JSON：<http://localhost:3000/docs/json>

使用以下演示账号登录 Web 控制台：

- `admin / admin`：管理员，可读写
- `viewer / viewer`：观察员，只读；页面隐藏写操作，直接调用写接口也会返回 `403`

接口参数校验、TypeScript 类型推导和 API 文档来自同一份 Zod 路由 Schema，避免代码与文档逐渐不一致。

可配置环境变量包括 `PORT`、`DATABASE_URL`、`GATEWAY_URL`、`AGENT_URL`、`JWT_SECRET`、`WEB_ORIGIN` 和 `DEMO_MODE`，具体示例见 `.env.example`。在笔试演示环境之外应设置 `DEMO_MODE=false`，关闭故障注入接口。

### Migration 安全机制

数据库迁移是一个明确的部署步骤，并且可以安全重复执行：

```bash
pnpm db:migrate
```

API 启动时会比较数据库中的 `schema_migrations` 版本与代码内置 Migration 版本。如果数据库结构落后，服务会拒绝启动并提示执行迁移命令，避免运行一段时间后才因缺表或缺字段产生不可预期错误。

## 可靠性主线（阅读提纲）

外部消息网关采用 **至少一次（at-least-once）** 投递：同一通知可能重复到达、顺序可能短暂错乱、连接可能中断。平台在网关之上用 PostgreSQL 与 Worker 把「不可靠边界」收敛成 **可持久化、可恢复、可对账** 的内部状态。下面按 **入站 / 出站** 归纳要处理的逻辑（面试讲解或读代码时可作 checklist）。

### 消息进来（入站 / SSE）

| 关注点       | 要做什么                                                                             |
| ------------ | ------------------------------------------------------------------------------------ |
| **重复**     | 同一 `msgId` / `eventId` 只处理一次；时间线保持一行（验收：`pnpm scenario s2`）      |
| **乱序**     | 展示按 `sentAt`（及 keyset 游标），不按 SSE 到达先后                                 |
| **掉线**     | SSE 断开后用 `since` 续传；游标持久化，进程重启可接着收                              |
| **自身消息** | 网关回流的己方 `message` 合并到原 outbound；`isOwn=true`；不触发 Agent（验收：`s3`） |
| **账号状态** | `account_status`、发送失败等驱动状态机（限流 / 终态 / 在线离线）                     |
| **成员变化** | `member_joined` / `member_left` 更新成员表，与异步建群 Job 对齐                      |
| **写失败**   | 不能丢事件、不能假成功；推送 `inconsistency`，留 inbox 可重试                        |

去重依据是网关分配的 **业务编号**（`msgId`），不是消息文本是否相同：两个不同 `msgId` 即使内容一字不差，也记两行。

### 消息 / 命令出去（出站 / 调网关）

| 关注点         | 要做什么                                                                              |
| -------------- | ------------------------------------------------------------------------------------- |
| **下发可靠性** | 先落库再调网关（outbox）；崩溃重启后续发（验收：`smoke`）                             |
| **生命周期**   | `queued → accepted → sent` / `failed` / `unknown` / `cancelled`                       |
| **限流**       | `429` → 账号 `rate_limited`；排队消息不丢，到期按序再发（验收：`s4`）                 |
| **504**        | 结果不明 → `unknown` → 按 `clientMsgId` 对账 → 确认未发出时最多重试一次（验收：`s5`） |
| **命令**       | 建群 / 进群 / 踢 / 退 / 发消息多为异步与错误码，需 Job 与重试策略（见 A3、B2）        |

### 挂在这两条链上的能力

- **Agent**：他人消息触发（`agentEnabled`）；`send` / `kick` 前 audit；同 run 内 `idempotency_key` 幂等（验收：`agent`、`s6`）
- **定时序列**：排期发送走同一套出站管道（验收：`sequence:verify`）
- **WebSocket**：账号 / 消息 / Agent / 序列状态推送给控制台；断线用 `sinceSeq` 补发（B4）

更细的约束见 [可靠性约束](docs/reliability-invariants.md)。

## 可靠性场景

启动系统后，可以分别运行：

```bash
pnpm scenario smoke  # 消息从 queued -> accepted -> sent
pnpm scenario s2     # 每个 SSE 事件重复投递两次，时间线仍然只有一条
pnpm scenario s3     # 自己的 message 先于 message_sent 到达，仍合并成一行
pnpm scenario s4     # 账号被限流后自动恢复，并继续发送排队消息
pnpm scenario s5     # 网关返回 504 但消息随后落地，系统对账后不重复发送
pnpm scenario s6     # Agent 返回坏 JSON，系统记录错误并继续完成本轮运行
pnpm scenario agent  # 外部消息 -> 读取上下文 -> 审计发送 -> 完成
pnpm lab:verify      # 运行页面中的五项真实故障实验并校验持久化证据
pnpm auth:verify     # 验证 Refresh Token 轮换、重放撤销与 Logout
pnpm sequence:verify # 验证 S7 并发互斥和 S8 占位符预检
pnpm group-lifecycle:verify # 验证邀请过期恢复与群主最后退群
pnpm account-concurrency:verify # 验证并发连接/断开后数据库与网关状态一致
```

这些脚本会自动准备所需账号和群组，向 Mock 服务注入指定故障，通过公开 API 执行业务流程，并断言用户可观察的最终结果。脚本不会直接修改数据库记录来伪造成功结果。

## 需求完成度与证据

| 需求                                | 状态           | 实现或验收证据                                                        |
| ----------------------------------- | -------------- | --------------------------------------------------------------------- |
| A0 可重复 Migration 与结构版本保护  | 已完成         | 重复运行 `pnpm db:migrate`；启动保护见 `db/migrations.ts`             |
| A0 admin/viewer 权限控制            | 已完成         | 前端操作可见性控制 + API 前置鉴权                                     |
| A1 账号状态机与 CAS 并发保护        | 已完成         | 账号级事务锁、并发验收脚本、条件更新与终态原子清理                    |
| A2 持久化消息发送生命周期           | 已完成         | `outbox-compensation.test.ts` 以及 `smoke`、`s4`、`s5` 真实场景       |
| A2 入站事件去重与己方消息合并       | 已完成         | 数据库唯一约束与 `s2`、`s3` 场景                                      |
| A2 SSE 根据持久化游标重连           | 已完成         | 只推进连续事件水位；有编号缺口时保留后续事件并持续补洞                |
| A3 异步建群                         | A 组要求已完成 | 持久化 Job、等待成员加入事件、提升管理员及前端任务状态展示            |
| A4 稳定游标消息时间线               | 已完成         | 使用 `(sent_at, id)` Keyset Cursor，加载更早消息不漂移                |
| A4 带鉴权和单调序号的 WebSocket     | 已完成         | 持久化 `ws_events`，补发期间先缓冲实时事件，再按单调序号无缝切换      |
| A5 每个群同时只运行一个 Agent       | 已完成         | PostgreSQL 部分唯一索引                                               |
| A5 Agent 循环、工具校验、审计与限制 | 已完成         | 全局 60 秒预算、运行租约续期、`agent`/`s6` 场景与完整步骤记录         |
| A5 Agent 发消息幂等                 | 已完成         | 唯一 `(run_id, idempotency_key)` 映射                                 |
| A6 页面 1～3                        | 已完成         | 登录、账号列表、群组时间线、成员列表、Agent 运行列表                  |
| B1 定时消息序列                     | 已完成         | 持久化排期 Worker、变量来源预检、单群唯一索引、S7/S8 验证脚本与页面 5 |
| B2 邀请过期与全员退群扩展           | 已完成         | 邀请未就绪/过期重试、`ALREADY_MEMBER` 对账、群主最后退出及控制台入口  |
| B3 Refresh Token 轮换               | 已完成         | HttpOnly Cookie、单次轮换、重放撤销整条会话、Logout 立即失效          |
| B4 前端断线游标与独立运行详情页     | 已完成         | `sinceSeq` 补发、WS 认证续期、客户端游标去重、Agent 步骤详情抽屉      |
| C1～C3                              | 未实现         | 按题目要求作为选做项，当前不占用核心实现时间                          |

## 设计文档

- [系统架构](docs/architecture.md)
- [可靠性约束](docs/reliability-invariants.md)
- [ADR 001：轻量级 Monorepo](docs/adr/001-lightweight-monorepo.md)
- [ADR 002：使用 PostgreSQL 进行协调](docs/adr/002-postgres-coordination.md)

## 常用命令

```bash
pnpm build       # 构建全部应用的生产版本
pnpm lint        # ESLint + TypeScript 类型检查 + Prettier 格式检查
pnpm test        # 运行自动化测试
pnpm format      # 使用 Prettier 统一格式
pnpm db:migrate  # 执行尚未应用的数据库迁移
```

## 质量门禁

- `pre-commit`：通过 `lint-staged` 对暂存的代码执行 ESLint 自动修复和 Prettier 格式化。
- `pre-push`：执行完整的 `pnpm lint && pnpm test`，避免已知问题被推送。
- GitHub Actions：每次推送到 `main` 或创建 Pull Request 时执行 Lint、单测和生产构建，并启动 PostgreSQL、API 与 Mock 服务跑 `smoke`、场景测试、S7/S8 全栈场景。本地 Hook 可以跳过，CI 才是最终门禁。
