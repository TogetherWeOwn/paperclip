import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import * as schema from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { drizzle } from "drizzle-orm/postgres-js";

const dbRequire = createRequire(new URL("../../../../packages/db/package.json", import.meta.url));
const postgres = dbRequire("postgres") as (
  url: string,
  options: Record<string, unknown>,
) => Db["$client"];

export function callerTransactionTestUrl(env: NodeJS.ProcessEnv): string | null {
  const value = env.PAPERCLIP_CALLER_TRANSACTION_TEST_DATABASE_URL;
  if (!value) return null;
  const url = new URL(value);
  // Explicit test-only binding; never fall back to DATABASE_URL or instance config.
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !env.PAPERCLIP_TEST_DATABASE_HOST ||
    url.hostname !== env.PAPERCLIP_TEST_DATABASE_HOST ||
    url.username !== "agent_test" ||
    url.pathname !== "/agent_test" ||
    url.password || url.search || url.hash ||
    (url.port && url.port !== "5432")
  ) {
    throw new Error("Caller-transaction acceptance requires the explicitly named disposable test database");
  }
  return value;
}

export async function createCallerTransactionDatabase(url: string) {
  const namespace = `caller_tx_${randomUUID().replaceAll("-", "")}`;
  const connect = () => postgres(url, {
    max: 1,
    prepare: false,
    connect_timeout: 3,
    idle_timeout: 0,
    connection: {
      application_name: namespace,
      search_path: namespace,
      statement_timeout: 2000,
      lock_timeout: 1000,
      idle_in_transaction_session_timeout: 5000,
    },
    onnotice: () => {},
  });
  const setup = connect();
  let created = false;
  try {
    const [identity] = await setup`select current_database() as database, current_user as role`;
    if (identity.database !== "agent_test" || identity.role !== "agent_test") {
      throw new Error("Disposable test database identity mismatch");
    }
    await setup.unsafe(`CREATE SCHEMA "${namespace}"`);
    created = true;
    // Build an empty fixture from the official declarative schema, not from a
    // live instance or the application migration runner. No extension install.
    const { generateDrizzleJson, generateMigration } = dbRequire("drizzle-kit/api");
    const statements: string[] = await generateMigration(
      generateDrizzleJson({}),
      generateDrizzleJson(schema),
    );
    // Composite foreign keys can target unique indexes emitted later by the
    // generator. Install those keys after their referenced indexes exist.
    const foreignKeys = statements.filter((statement) => statement.includes("FOREIGN KEY"));
    const definitions = statements.filter((statement) => !statement.includes("FOREIGN KEY"));
    for (const statement of [...definitions, ...foreignKeys]) {
      // Search indexes are unrelated to transaction routing and require pg_trgm.
      if (statement.includes("gin_trgm_ops")) continue;
      await setup.unsafe(statement.replaceAll('"public".', `"${namespace}".`));
    }
  } catch (error) {
    if (created) await setup.unsafe(`DROP SCHEMA "${namespace}" CASCADE`);
    throw error;
  } finally {
    await setup.end({ timeout: 1 });
  }

  let client: ReturnType<typeof connect> | undefined;
  return {
    open() {
      client = connect();
      return drizzle(client, { schema }) as Db;
    },
    async close() {
      // A failed single-pool case must cancel queued reads before the next case.
      await client?.end({ timeout: 0 });
      client = undefined;
    },
    async cleanup() {
      await this.close();
      const cleanup = connect();
      try {
        await cleanup.unsafe(`DROP SCHEMA "${namespace}" CASCADE`);
      } finally {
        await cleanup.end({ timeout: 1 });
      }
    },
  };
}

export async function withinTransactionDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          "Caller transaction did not settle within 1500ms; a nested pooled read cannot acquire the only connection",
        )), 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
