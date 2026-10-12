// Prisma CLI configuration (used by `prisma migrate ...` and `prisma generate`).
// The running app does not read this file: it connects through app/lib/prisma.ts.
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Migrations need a direct connection. On Neon that is the address WITHOUT
    // "-pooler" in the host name. DATABASE_URL is the fallback, so a setup with
    // a single address keeps working.
    url: process.env["DIRECT_URL"] || process.env["DATABASE_URL_UNPOOLED"] || process.env["DATABASE_URL"],
  },
});
