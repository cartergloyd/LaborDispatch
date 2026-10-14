import type { FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";

export function bearerAuth(token: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) {
      reply.code(503).send({ error: "API_TOKEN is not configured" });
      return reply;
    }
    const a = Buffer.from(presented);
    const b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      reply.code(401).send({ error: "unauthorized" });
      return reply;
    }
    return undefined;
  };
}
