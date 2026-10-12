/**
 * The app's one database connection.
 *
 * Every route and library reads and writes through this Prisma client. There
 * are no other connection pools, and nothing here (or anywhere in the running
 * app) creates or alters tables: the schema is changed only by the migrations
 * in prisma/migrations, applied with `npm run db:migrate`.
 *
 * Serverless notes:
 *  - One client is kept per server instance (on `globalThis`), so repeated
 *    imports, hot reloads and separately bundled routes all share one pool.
 *  - The pool is small. On Neon, DATABASE_URL should be the POOLED address
 *    (host name containing "-pooler"), which is built for many short-lived
 *    serverless connections.
 *  - TLS follows the connection string (`sslmode=require` on Neon) and the
 *    server certificate is verified. Certificate checks are never switched off.
 *  - Importing this file does not connect. The first query does, so builds and
 *    previews without a database still work.
 */
import { PrismaClient } from "@/app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function poolSize(): number {
  const n = Number(process.env.DATABASE_POOL_MAX);
  return Number.isInteger(n) && n > 0 && n <= 50 ? n : 5;
}

function createPrismaClient() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    max: poolSize(),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  return new PrismaClient({ adapter });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();
globalForPrisma.prisma = prisma;

export default prisma;
