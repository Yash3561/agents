import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "~/db.server";
import { redis } from "~/redis.server";
import { clearWhatsAppOAuthStates } from "~/lib/whatsapp-oauth-state.server";

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const merchant = await prisma.merchant.findUnique({
    where: { shopDomain: session.shop },
    select: { wabaId: true },
  });

  await prisma.merchant.update({
    where: { shopDomain: session.shop },
    data: {
      wabaId: null,
      waPhoneNumberId: null,
      waAccessToken: null,
      waPhone: null,
      waConnectedAt: null,
    },
  });

  if (merchant?.wabaId) {
    await redis.del(`wa:tplstatus:${merchant.wabaId}`).catch(() => null);
  }
  await clearWhatsAppOAuthStates(session.shop);

  return new Response("OK", { status: 200 });
}
