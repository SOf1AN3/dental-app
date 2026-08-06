import "dotenv/config";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!);

async function main() {
  const users = await sql`SELECT id, name, email FROM "user" WHERE email = 'karim@test.dental'`;
  if (users.length === 0) {
    console.log("User not found. Run: npm run seed");
    return;
  }
  console.log("User:", users[0]);

  const existing = await sql`SELECT * FROM platform_owner WHERE user_id = ${users[0].id}`;
  if (existing.length > 0) {
    console.log("Already a platform owner");
    return;
  }

  await sql`INSERT INTO platform_owner (user_id, granted_by) VALUES (${users[0].id}, ${users[0].id})`;
  console.log("Platform owner created!");
  console.log("---");
  console.log("Login:    karim@test.dental");
  console.log("Password: test123");
  console.log("Console:  http://localhost:3000/owner");
}

main().catch(console.error).finally(() => sql.end());
