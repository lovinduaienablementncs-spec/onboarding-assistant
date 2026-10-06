import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { env } from "@oa/shared";

const client = postgres(env.databaseUrl, { max: 1 });
await client`create extension if not exists vector`;
await migrate(drizzle(client), { migrationsFolder: new URL("../migrations", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") });
await client.end();
console.log("migrations applied");
