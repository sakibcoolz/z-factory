import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    // Empty during `prisma generate` on a machine without a database (e.g. CI install step).
    url: process.env.WEB_FACTORY_DATABASE_URL ?? "",
  },
});
