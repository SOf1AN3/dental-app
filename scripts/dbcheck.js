// eslint-disable-next-line @typescript-eslint/no-require-imports
const postgres = require("postgres");
(async () => {
  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  try {
    const rows = await sql`SELECT setting FROM pg_settings WHERE name='max_connections'`;
    console.log("max_connections", rows[0].setting);
    const a = await sql`SELECT count(*)::int c, state, application_name FROM pg_stat_activity GROUP BY state, application_name ORDER BY c DESC`;
    console.log(JSON.stringify(a, null, 2));
    const total = await sql`SELECT count(*)::int c FROM pg_stat_activity`;
    console.log("total_connections", total[0].c);
  } catch (e) {
    console.error("ERR", e.message);
  }
  await sql.end();
})();
