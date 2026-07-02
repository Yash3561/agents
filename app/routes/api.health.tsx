import prisma from "~/db.server";

export async function loader() {
  await prisma.$queryRaw`SELECT 1`;
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
}
