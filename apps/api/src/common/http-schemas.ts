import { ApiErrorSchema } from "@platform/contracts";
import { z } from "zod";

export const BearerSecurity = [{ bearerAuth: [] }] as const;
export const ErrorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  404: ApiErrorSchema,
  409: ApiErrorSchema,
  422: ApiErrorSchema,
  500: ApiErrorSchema,
};

export const UuidIdParamsSchema = z.object({ id: z.string().uuid().describe("资源 UUID") });
export const AccountIdParamsSchema = z.object({ id: z.string().min(1).describe("服务账号 ID") });
export const OkSchema = z.object({ ok: z.literal(true) });
