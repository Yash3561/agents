import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";

/**
 * Resolve a merchant's offline access token for storefront-originated requests
 * (widget calls arrive outside the Shopify admin iframe, so authenticate.admin
 * fails there — fall back to the offline token stored in Prisma's Session table).
 */
export async function getStorefrontAccessToken(
  request: Request,
  shop: string,
): Promise<string> {
  try {
    const { session: shopifySession } = await authenticate.admin(request);
    return shopifySession.accessToken ?? "";
  } catch {
    const stored = await prisma.session.findFirst({
      where: { shop, isOnline: false },
      select: { accessToken: true },
    });
    return stored?.accessToken ?? "";
  }
}
