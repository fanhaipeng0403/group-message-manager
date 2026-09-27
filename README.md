# 群消息管理平台（Group Message Manager）

群消息管理平台是一个面向不可靠外部系统的多账号群组消息平台。它能够持久化消息时间线，协调账号与群组状态，并运行一套可审计的工具调用 Agent。即使外部网关出现事件重复、乱序、账号限流、请求超时或连接中断，系统仍然能够恢复、追踪并解释最终结果。

本次笔试实现优先保证可靠性主链路的深度：A 组和 B 组均已形成可运行闭环，C 组保留为明确的选做扩展，没有用空接口或占位页面伪装完成度。

## 这个实现有什么不同

- **故障可以真实复现**：Mock 网关和 Mock Agent 支持确定性故障注入，可以稳定复现 SSE 重复事件、账号限流、结果不确定的 504，以及 Agent 非法响应。
- **正确性存进数据库，而不是依赖进程记忆**：Inbox 事件编号、Outbox 投递状态、Agent 单群互斥和幂等键均由 PostgreSQL 持久化。
- **以证据说明完成度**：下方需求矩阵将每项能力对应到可运行的实验或自动化测试。
- **可靠性实验室**：操作员可以直接从页面注入 S2、S4、S5、S6 故障，并查看数据库中持久化的通过/失败证据，不是前端预设动画。
- **如实说明范围**：未实现的 C 组选做功能会明确列出，不使用空接口或占位页面伪装完成度。

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
pnpm infra:up
pnpm db:migrate
pnpm dev
```

浏览器访问 <http://localhost:5173>，使用以下演示账号登录：

- `admin / admin`：管理员，可读写
- `viewer / viewer`：观察员，只读；页面隐藏写操作，直接调用写接口也会返回 `403`

Swagger/OpenAPI 交互式文档：<http://localhost:3000/docs>  
机器可读的 OpenAPI JSON：<http://localhost:3000/docs/json>

接口参数校验、TypeScript 类型推导和 API 文档来自同一份 Zod 路由 Schema，避免代码与文档逐渐不一致。

默认端口：

| 服务          |  端口 |
| ------------- | ----: |
| API           |  3000 |
| Web           |  5173 |
| Mock 消息网关 |  4001 |
| Mock Agent    |  4002 |
| PostgreSQL    | 55432 |

可配置环境变量包括 `PORT`、`DATABASE_URL`、`GATEWAY_URL`、`AGENT_URL`、`JWT_SECRET`、`WEB_ORIGIN` 和 `DEMO_MODE`，具体示例见 `.env.example`。在笔试演示环境之外应设置 `DEMO_MODE=false`，关闭故障注入接口。

### Migration 安全机制

数据库迁移是一个明确的部署步骤，并且可以安全重复执行：

```bash
pnpm db:migrate
```

API 启动时会比较数据库中的 `schema_migrations` 版本与代码内置 Migration 版本。如果数据库结构落后，服务会拒绝启动并提示执行迁移命令，避免运行一段时间后才因缺表或缺字段产生不可预期错误。

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
- [面试演示指引](docs/interview-guide.md)

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
- GitHub Actions：每次推送到 `main` 或创建 Pull Request 时执行 Lint、单测和生产构建，并启动 PostgreSQL、API 与 Mock 服务跑 `smoke`、可靠性实验室、S7/S8 全栈场景。本地 Hook 可以跳过，CI 才是最终门禁。

## 如果继续开发

下一阶段会优先增加针对 Worker 精确崩溃点的 PostgreSQL 集成测试、批量且按账号公平的任务领取，以及 Playwright 端到端测试，然后再考虑 C1 媒体本地化与 C2 真实 LLM 适配服务。当前 Worker 每轮有意只领取一项工作，以换取笔试规模下更容易解释和验证的失败边界；生产吞吐扩大时再改成有界批量。C 组属于题目明确标注的选做增强项，不影响当前 A/B 主链路。
