import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@oa/shared";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>;

export function createDb(url = env.databaseUrl) {
  const client = postgres(url, { max: 10 });
  return drizzle(client, { schema });
}
