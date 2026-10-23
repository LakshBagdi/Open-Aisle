/**
 * One database connection for the whole process.
 *
 * `postgres` is the driver (talks to Postgres over the network).
 * `drizzle` wraps it so we can write queries in TypeScript with types.
 */
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env";
import * as schema from "./schema";

export type DB = PostgresJsDatabase<typeof schema>;

let client: ReturnType<typeof postgres> | undefined;
let instance: DB | undefined;

export function getDb(): DB {
  if (!instance) {
    client = postgres(env().DATABASE_URL, { max: 10, onnotice: () => {} });
    instance = drizzle(client, { schema });
  }
  return instance;
}

/** Close the connection (scripts and tests call this so the process can exit). */
export async function closeDb() {
  await client?.end({ timeout: 5 });
  client = undefined;
  instance = undefined;
}

export { schema };
