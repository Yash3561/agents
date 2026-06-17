#!/usr/bin/env node

/**
 * Startup script for NeonPing container
 *
 * This script:
 * 1. Verifies database connectivity with timeout
 * 2. Checks if migrations have been applied
 * 3. Logs startup progress for debugging
 * 4. Exits gracefully if checks fail (app still starts)
 */

import { PrismaClient } from "@prisma/client";

async function runStartupChecks() {
  let prisma;

  try {
    console.log("[startup] NeonPing container starting...");
    console.log(`[startup] Node environment: ${process.env.NODE_ENV || "development"}`);
    console.log(`[startup] Database: ${process.env.DATABASE_URL ? "configured" : "NOT configured"}`);

    // Initialize Prisma client
    prisma = new PrismaClient();

    console.log("[startup] Checking database connection...");

    // Test basic database connectivity with 10-second timeout
    const connectionPromise = prisma.$executeRawUnsafe("SELECT 1");
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Database connection timeout after 10 seconds")),
        10000
      )
    );

    await Promise.race([connectionPromise, timeoutPromise]);
    console.log("[startup] Database connection verified");

    // Check if migrations table exists and has entries
    console.log("[startup] Checking migration status...");
    const migrationCount = await prisma.$queryRaw`
      SELECT COUNT(*) as count FROM "_prisma_migrations"
    `;

    const count =
      migrationCount &&
      Array.isArray(migrationCount) &&
      migrationCount.length > 0
        ? Number(migrationCount[0].count)
        : 0;

    if (count > 0) {
      console.log(`[startup] Migrations already applied (${count} migrations found)`);
    } else {
      console.log("[startup] No prior migrations found - schema setup pending");
    }

    console.log("[startup] Startup checks complete - app ready to start");
    process.exit(0);
  } catch (error) {
    if (error instanceof Error) {
      console.warn(`[startup] Warning: ${error.message}`);
    } else {
      console.warn("[startup] Warning: Startup check failed");
    }
    // Gracefully continue - app can still start even if DB is temporarily unavailable
    console.log("[startup] Continuing app startup (migrations may fail if DB unreachable)");
    process.exit(0); // Exit 0 to allow app to start despite issues
  } finally {
    if (prisma) {
      await prisma.$disconnect();
    }
  }
}

// Run startup checks
runStartupChecks();
