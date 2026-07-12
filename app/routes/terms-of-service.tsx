/* eslint-disable react/no-unescaped-entities -- legal prose, literal quotes intended */
export default function TermsOfService() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "40px 20px", fontFamily: "system-ui, sans-serif", lineHeight: 1.6, color: "#1a1a1a" }}>
      <h1>Terms of Service</h1>
      <p><em>Last updated: July 12, 2026</em></p>

      <p>
        These terms govern a merchant's use of NeonPing, an AI shopping assistant
        for Shopify stores that operates through WhatsApp. By installing NeonPing, a
        merchant agrees to these terms.
      </p>

      <h2>The service</h2>
      <p>
        NeonPing provides an AI assistant that helps a merchant's customers browse
        products, manage their cart, check order status, receive discount codes, and
        get support through WhatsApp. Checkout happens on the merchant's own
        Shopify-hosted checkout. NeonPing never processes payments directly.
      </p>

      <h2>Merchant responsibilities</h2>
      <ul>
        <li>Keep store and product information accurate — the assistant answers
          customers using the merchant's live catalog and policies.</li>
        <li>Configure discount rules and brand voice settings responsibly; the
          merchant is responsible for any discount codes the assistant issues under
          the limits the merchant sets.</li>
        <li>Comply with applicable consumer protection and data privacy laws for
          their own store and customers.</li>
      </ul>

      <h2>Acceptable use</h2>
      <p>
        The service may not be used for unlawful purposes, to misrepresent products,
        or to circumvent Shopify's own platform terms. NeonPing reserves the right to
        suspend access for violations.
      </p>

      <h2>Disclaimer and limitation of liability</h2>
      <p>
        The service is provided "as is." NeonPing's AI assistant uses large language
        models and, while grounded in the merchant's real catalog and policy data,
        may occasionally produce imperfect responses. NeonPing is not liable for
        indirect, incidental, or consequential damages arising from use of the
        service, to the maximum extent permitted by law.
      </p>

      <h2>Changes</h2>
      <p>
        We may update these terms as the product evolves. Continued use of NeonPing
        after an update constitutes acceptance of the revised terms.
      </p>

      <h2>Contact</h2>
      <p>
        <a href="mailto:kaushik@neonping.com">kaushik@neonping.com</a>
      </p>
    </main>
  );
}
