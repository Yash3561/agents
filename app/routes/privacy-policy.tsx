/* eslint-disable react/no-unescaped-entities -- legal prose, literal quotes intended */
export default function PrivacyPolicy() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "40px 20px", fontFamily: "system-ui, sans-serif", lineHeight: 1.6, color: "#1a1a1a" }}>
      <h1>Privacy Policy</h1>
      <p><em>Last updated: July 12, 2026</em></p>

      <p>
        NeonPing ("we", "us") provides an AI shopping and support assistant for
        Shopify stores that operates through WhatsApp. This policy describes what
        data we collect, why, and how it's handled, for both merchants who install
        NeonPing and their customers who message the merchant's WhatsApp Business
        number.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>WhatsApp messages.</strong> The text of WhatsApp conversations
          between a customer and the assistant, stored to power the conversation,
          generate merchant-facing analytics, support follow-up, and personalize
          future interactions where applicable.
        </li>
        <li>
          <strong>Phone number and customer identifiers.</strong> We receive the
          customer's WhatsApp phone number from the WhatsApp Business Platform. When
          Shopify customer or order data is available for the request, we may also
          receive Shopify identifiers needed to look up or store light
          personalization signals, such as recent search or cart-in-progress state,
          as Shopify customer metafields under the <code>neonping_chat</code>{" "}
          namespace.
        </li>
        <li>
          <strong>Cart and order identifiers.</strong> To show merchants which
          WhatsApp conversations led to a purchase and to answer order-status
          questions, we process Shopify cart tokens, order IDs, order status, and
          revenue amounts where relevant. We never see or store payment details —
          checkout happens entirely on Shopify's own hosted checkout.
        </li>
        <li>
          <strong>Merchant configuration.</strong> Settings a merchant chooses (brand
          voice, discount rules, assistant behavior, knowledge base) in the NeonPing
          admin app.
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
          <strong>Meta / WhatsApp Business Platform</strong> — customer messages and
          phone numbers are transmitted through WhatsApp when customers message the
          merchant's WhatsApp Business number.
        </li>
        <li>
          <strong>Microsoft Azure OpenAI Service</strong> — WhatsApp messages are
          sent here to generate the AI assistant's responses.
        </li>
        <li>
          <strong>Neon (PostgreSQL)</strong> — stores conversation records and
          merchant configuration.
        </li>
        <li>
          <strong>Upstash (Redis)</strong> — stores short-lived operational state
          such as webhook deduplication, opt-out status, and rate-limit counters.
        </li>
      </ul>

      <h2>Your rights</h2>
      <p>
        Customers can request a copy of their data or its deletion through the
        merchant's store. NeonPing responds to Shopify's standard data-request and
        deletion webhooks for this purpose, and deletes all associated conversation
        history and personalization data within Shopify's required window. Merchants
        can also fully remove all NeonPing data for their store by uninstalling the
        app.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about this policy: <a href="mailto:kaushik@neonping.com">kaushik@neonping.com</a>
      </p>
    </main>
  );
}
