export default function PrivacyPolicy() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "40px 20px", fontFamily: "system-ui, sans-serif", lineHeight: 1.6, color: "#1a1a1a" }}>
      <div style={{ background: "#fff3cd", border: "1px solid #ffe69c", borderRadius: 8, padding: "12px 16px", marginBottom: 32, fontSize: 14 }}>
        <strong>Draft content — not legal advice.</strong> This page accurately
        describes what NeonPing's code actually does as of the date below, but it has
        not been reviewed by a lawyer. Have it reviewed before relying on it for a real
        App Store submission.
      </div>

      <h1>Privacy Policy</h1>
      <p><em>Last updated: June 16, 2026</em></p>

      <p>
        NeonPing ("we", "us") provides an AI shopping assistant chat widget that
        merchants install on their Shopify storefronts. This policy describes what
        data we collect, why, and how it's handled, for both merchants who install
        NeonPing and their customers who use the chat widget.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Chat messages.</strong> The text of conversations between a
          customer and the widget, stored to power the conversation, generate
          merchant-facing analytics, and (when a customer is logged in) personalize
          future visits.
        </li>
        <li>
          <strong>Customer identifier.</strong> When a customer is logged into the
          storefront, we receive their Shopify customer ID. This is used to look up
          and store light personalization signals (recent search, cart-in-progress
          state) as Shopify customer metafields under the <code>neonping_chat</code>{" "}
          namespace.
        </li>
        <li>
          <strong>Cart and order identifiers.</strong> To show merchants which
          conversations led to a purchase, we store the cart token and resulting
          order ID/revenue amount when a chat-originated cart converts to a real
          order. We never see or store payment details — checkout happens entirely on
          Shopify's own hosted checkout.
        </li>
        <li>
          <strong>Merchant configuration.</strong> Settings a merchant chooses (brand
          voice, discount rules, widget appearance) in the NeonPing admin app.
        </li>
      </ul>

      <h2>What we don't collect</h2>
      <p>
        We never receive or store payment card numbers, bank details, or other
        payment credentials. We don't track customers across other websites.
      </p>

      <h2>Who processes this data</h2>
      <p>Data is processed by NeonPing and the following subprocessors:</p>
      <ul>
        <li>
          <strong>Microsoft Azure OpenAI Service</strong> — chat messages are sent
          here to generate the AI assistant's responses.
        </li>
        <li>
          <strong>Neon (PostgreSQL)</strong> — stores conversation records and
          merchant configuration.
        </li>
        <li>
          <strong>Upstash (Redis)</strong> — stores short-lived session state
          (cleared automatically after 30 minutes of inactivity).
        </li>
      </ul>

      <h2>Your rights</h2>
      <p>
        Customers can request a copy of their data or its deletion through the
        merchant's store. NeonPing responds to Shopify's standard data-request and
        deletion webhooks for this purpose, and deletes all associated chat history
        and personalization data within Shopify's required window. Merchants can
        also fully remove all NeonPing data for their store by uninstalling the app.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about this policy: <a href="mailto:kaushik@neonping.com">kaushik@neonping.com</a>
      </p>
    </main>
  );
}
