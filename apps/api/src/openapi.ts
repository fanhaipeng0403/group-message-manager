import type { FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

export async function registerOpenApi(app: FastifyInstance): Promise<void> {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "RelayOps API",
        version: "1.0.0",
        description:
          "多账号群组消息平台。重点展示持久化 Inbox/Outbox、状态机、异步任务和可审计 Agent 工具循环。",
      },
      tags: [
        { name: "System", description: "服务状态与版本" },
        { name: "Auth", description: "操作员认证" },
        { name: "Accounts", description: "服务账号和状态机" },
        { name: "Groups", description: "群组和异步任务" },
        { name: "Messages", description: "持久化消息时间线和 Outbox" },
        { name: "Agent Runs", description: "Agent 运行与工具步骤" },
        { name: "Reliability Lab", description: "仅演示环境开启的真实故障注入实验" },
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
    },
    transform: jsonSchemaTransform,
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list", deepLinking: true, persistAuthorization: true },
    staticCSP: true,
  });
}
