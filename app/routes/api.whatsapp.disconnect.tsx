import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "~/db.server";

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
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
  return new Response("OK", { status: 200 });
}
