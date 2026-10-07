import "dotenv/config";
import { readFileSync } from "node:fs";
import { createPrismaClient } from "@/lib/db/client";
import { bootstrapAdmin } from "@/lib/services/user-service";

/**
 * Creates the first organization and its admin; refused once any user exists.
 *
 *   WEB_FACTORY_ADMIN_PASSWORD_FILE=/run/secrets/admin npm run create-admin -- \
 *     --org "Acme" --slug acme --email admin@acme.example --name "Ada Admin"
 *
 * The password is read from a file (never a flag), so it does not end up in shell history.
 */
function flag(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

async function main() {
  const passwordFile = process.env.WEB_FACTORY_ADMIN_PASSWORD_FILE;
  if (!passwordFile) throw new Error("WEB_FACTORY_ADMIN_PASSWORD_FILE names the file holding the first password");
  const url = process.env.WEB_FACTORY_DATABASE_URL;
  if (!url) throw new Error("WEB_FACTORY_DATABASE_URL is not set");
  const db = createPrismaClient(url);
  try {
    const result = await bootstrapAdmin(db, {
      organization: flag("org"),
      slug: flag("slug"),
      email: flag("email"),
      name: flag("name"),
      password: readFileSync(passwordFile, "utf8").replace(/\r?\n$/, ""),
    });
    console.log(JSON.stringify({ created: true, ...result }));
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
