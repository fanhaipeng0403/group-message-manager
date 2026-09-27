import "@fastify/jwt";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; username: string; role: "admin" | "viewer"; sessionId: string };
    user: { sub: string; username: string; role: "admin" | "viewer"; sessionId: string };
  }
}
