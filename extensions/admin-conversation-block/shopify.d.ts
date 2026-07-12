import '@shopify/ui-extensions';

//@ts-expect-error -- module augmentation for a virtual/generated path, no exported members to type
declare module './src/BlockExtension.jsx' {
  const shopify: import('@shopify/ui-extensions/admin.order-details.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}
