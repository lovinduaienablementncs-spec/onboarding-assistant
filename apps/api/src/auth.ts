import type { FastifyReply, FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Role } from "@oa/shared";

export interface AuthUser {
  id: string;
  name?: string;
  roles: Role[];
  /** Entra group ids from the token (when the app is configured to emit them). */
  groups?: string[];
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export type TokenVerifier = (token: string) => Promise<AuthUser>;

/** Validates Entra ID access tokens for this API: signature (tenant JWKS), issuer, audience and expiry. */
export function entraVerifier(tenantId: string, audiences: string[]): TokenVerifier {
  const jwks = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`));
  const issuers = [`https://login.microsoftonline.com/${tenantId}/v2.0`, `https://sts.windows.net/${tenantId}/`];
  return async (token) => {
    const { payload } = await jwtVerify(token, jwks, { issuer: issuers, audience: audiences, clockTolerance: 60 });
    return toUser(payload);
  };
}

function toUser(p: JWTPayload): AuthUser {
  const oid = (p.oid as string | undefined) ?? p.sub;
  if (!oid) throw new Error("Token has no subject");
  const roles = Array.isArray(p.roles) ? (p.roles as Role[]) : [];
  const groups = Array.isArray(p.groups) ? (p.groups as string[]) : undefined;
  return { id: oid, name: (p.name as string | undefined) ?? (p.preferred_username as string | undefined), roles, groups };
}

/**
 * Local development only: accept any bearer token as a fixed user.
 * The server refuses to start with this enabled when NODE_ENV=production.
 */
export function devVerifier(roles: Role[]): TokenVerifier {
  return async () => ({ id: "dev-user", name: "Local Developer", roles });
}

export function authenticate(verify: TokenVerifier) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return reply.code(401).send({ error: "Missing bearer token" });
    try {
      req.user = await verify(header.slice(7));
    } catch {
      return reply.code(401).send({ error: "Invalid or expired token" });
    }
  };
}

/** Allows the request only if the user holds at least one of the roles. */
export function requireRole(...allowed: Role[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user?.roles.some((r) => allowed.includes(r))) {
      return reply.code(403).send({ error: "Forbidden" });
    }
  };
}
