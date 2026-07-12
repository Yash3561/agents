import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, session, shop } = await authenticate.webhook(request);

  try {
    const current = Array.isArray(payload.current) ? payload.current.map(String) : [];
    const scope = current.join(",");

    if (session?.id) {
      await db.session.updateMany({
        where: { id: session.id },
        data: { scope },
      });
    }

    await db.session.updateMany({
      where: { shop, isOnline: false },
      data: { scope },
    });

    return new Response(null, { status: 200 });
  } catch (err) {
    console.error(`[app/scopes_update] Error processing webhook for ${shop}:`, err);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
};
