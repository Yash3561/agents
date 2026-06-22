import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL!);
const SHOP = "neonping-dev-a509ojgs.myshopify.com";

async function main() {
  // Count actual conversations in DB
  const actualCount = await prisma.conversation.count({
    where: { shopDomain: SHOP },
  });

  // Read current values
  const merchant = await prisma.merchant.findUnique({
    where: { shopDomain: SHOP },
    select: { conversationCount: true, conversationResetAt: true },
  });
  const redisVal = await redis.get(`usage:${SHOP}`);

  console.log("Before:", {
    dbCount: merchant?.conversationCount,
    redisCount: redisVal,
    actualConversations: actualCount,
  });

  // Update DB
  await prisma.merchant.update({
    where: { shopDomain: SHOP },
    data: { conversationCount: actualCount },
  });

  // Update Redis
  await redis.set(`usage:${SHOP}`, String(actualCount));

  console.log("After: conversationCount and Redis both set to", actualCount);

  await prisma.$disconnect();
  redis.disconnect();
}

main().catch(console.error);
