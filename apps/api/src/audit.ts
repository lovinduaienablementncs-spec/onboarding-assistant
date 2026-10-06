import type { FastifyRequest } from "fastify";
import { auditLog, type Db } from "@oa/db";

export async function audit(
  db: Db,
  req: FastifyRequest,
  action: string,
  entity: string,
  entityId: string | null,
  before?: unknown,
  after?: unknown,
) {
  await db.insert(auditLog).values({
    actorId: req.user!.id,
    actorName: req.user!.name,
    action,
    entity,
    entityId,
    before: before ?? null,
    after: after ?? null,
    ip: req.ip,
  });
}
