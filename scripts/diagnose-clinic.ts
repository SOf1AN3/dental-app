import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/lib/db/schema";

const url = (process.argv[2] || process.env.DATABASE_URL)!;

if (!url) {
  console.error("Aucune URL. Usage: npx tsx scripts/diagnose-clinic.ts <DATABASE_URL>");
  process.exit(1);
}

const urlForLog = url.replace(/\/\/.*@/, "//***:***@");
console.log("URL testée:", urlForLog);
console.log("Ponded? ", url.includes("-pooler.") ? "OUI (-pooler => PgBouncer)" : "non");

async function testInsert(client: postgres.Sql, label: string) {
  const db = drizzle(client, { schema });
  const slug = `test-diag-${Date.now()}`;
  try {
    const [clinic] = await db
      .insert(schema.clinics)
      .values({
        name: "Cabinet Test Diagnostic",
        slug,
        email: null,
        phone: null,
        address: null,
        wilayaCode: null,
      })
      .returning();
    console.log(`[OK] ${label}: clinique insérée (id=${clinic.id})`);
  } catch (e) {
    console.log(`[ECHEC] ${label}: insert clinique ->`);
    console.log(e);
  }
}

async function main() {
  console.log("\n--- Test 1: connexion simple (comme db.ts) ---");
  try {
    const client1 = postgres(url);
    await testInsert(client1, "postgres(url) sans options");
    await client1.end();
  } catch (e) {
    console.log("[ECHEC] connexion simple:", e);
  }

  console.log("\n--- Test 2: connexion avec { prepare: false } ---");
  try {
    const client2 = postgres(url, { prepare: false });
    await testInsert(client2, "postgres(url, { prepare: false })");
    await client2.end();
  } catch (e) {
    console.log("[ECHEC] connexion prepare false:", e);
  }

  console.log("\nDiagnostic terminé.");
}

main().catch((e) => {
  console.error("Erreur globale:", e);
  process.exit(1);
});
