import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { config } from "@/config/env";

const globalPool = globalThis as typeof globalThis & { __odPool?: pg.Pool };
export const pool =
  globalPool.__odPool ??
  new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    ssl:
      config.NODE_ENV === "production"
        ? { rejectUnauthorized: true }
        : undefined,
  });
if (config.NODE_ENV !== "production") globalPool.__odPool = pool;
export const db: NodePgDatabase<typeof schema> = drizzle(pool, { schema });
export async function checkDatabase(): Promise<void> {
  await pool.query("select 1");
}
