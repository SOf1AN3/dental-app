import postgres from "postgres";
const sql = postgres("postgres://postgres:postgres@localhost:5432/dentalcare", { max: 1 });
try {
  const r = await sql`select version()`;
  console.log("DB OK:", r[0].version.slice(0, 40));
} catch (e) {
  console.error("DB FAIL:", e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
