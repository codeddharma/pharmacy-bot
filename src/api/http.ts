import type { FastifyReply, FastifyRequest } from "fastify";
import { z, type ZodType } from "zod";
import type { Permission } from "../auth/permissions.ts";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (m: string) => new HttpError(400, m);
export const notFound = (m = "Not found") => new HttpError(404, m);
export const forbidden = (m = "You don't have permission to do that") => new HttpError(403, m);

export function parse<T>(schema: ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw badRequest(r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  }
  return r.data;
}

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  roleKey: string;
  roleName: string;
  permissions: Permission[];
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
    rawBody?: Buffer;
  }
}

export function currentUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw new HttpError(401, "Please log in");
  return req.user;
}

export function can(req: FastifyRequest, ...perms: Permission[]): boolean {
  const u = req.user;
  return !!u && perms.some((p) => u.permissions.includes(p));
}

/** Route guard: the user must have at least one of the permissions. */
export function requireAny(...perms: Permission[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    currentUser(req);
    if (perms.length && !can(req, ...perms)) throw forbidden();
  };
}

export const idParam = z.object({ id: z.coerce.number().int().positive() });
export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
