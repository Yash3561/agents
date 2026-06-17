import prisma from "../db.server";

/**
 * Checks if database migrations have been applied.
 * This is a lightweight check that queries the _prisma_migrations table
 * to determine if setup has already run, avoiding redundant migration execution.
 */
export async function ensureMigrationsApplied(): Promise<void> {
  try {
    console.log("[startup] Checking database migration status...");

    // Test basic database connectivity with timeout
    const connectionPromise = prisma.$executeRawUnsafe("SELECT 1");
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error("Database connection timeout after 10 seconds")
          ),
        10000
      )
    );

    await Promise.race([connectionPromise, timeoutPromise]);
    console.log("[startup] Database connection verified");

    // Check if migrations table exists and has entries
    const migrationCount = await prisma.$queryRaw<
      Array<{ count: bigint }>
    >`SELECT COUNT(*) as count FROM "_prisma_migrations"`;

    const hasRunMigrations =
      migrationCount &&
      migrationCount.length > 0 &&
      Number(migrationCount[0].count) > 0;

    if (hasRunMigrations) {
      console.log(
        `[startup] Migrations already applied (${migrationCount[0].count} migrations found)`
      );
    } else {
      console.log("[startup] No prior migrations found - migrations will run on first deploy");
    }
  } catch (error) {
    if (error instanceof Error) {
      console.warn(`[startup] Migration check failed: ${error.message}`);
    } else {
      console.warn("[startup] Migration check failed:", error);
    }
    // Gracefully continue - the app can still start
    // Migrations may fail if DB is truly unavailable, but we don't want to block startup
    console.warn(
      "[startup] Continuing without migration verification - app may have issues if DB is unreachable"
    );
  } finally {
    await prisma.$disconnect();
  }
}
