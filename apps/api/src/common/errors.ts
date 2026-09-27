import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function sendError(
  reply: FastifyReply,
  requestId: string,
  statusCode: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
) {
  return reply.status(statusCode).send({ error: { code, message, requestId, ...details } });
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request: FastifyRequest, reply) => {
    if (error instanceof AppError) {
      return sendError(reply, request.id, error.statusCode, error.code, error.message, error.details);
    }
    if (error instanceof ZodError) {
      return sendError(reply, request.id, 400, "VALIDATION_ERROR", "Request validation failed", {
        issues: error.issues,
      });
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode < 500
    ) {
      const message =
        "message" in error && typeof error.message === "string" ? error.message : "Invalid request";
      return sendError(reply, request.id, error.statusCode, "VALIDATION_ERROR", message);
    }
    request.log.error({ err: error }, "unhandled request error");
    return sendError(reply, request.id, 500, "INTERNAL_ERROR", "Internal server error");
  });
}
