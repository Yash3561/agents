import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>NeonPing — AI Shopping Assistant</h1>
        <p className={styles.text}>
          Boost sales with live AI product recommendations. Always real-time, never stale.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Your Shopify store domain</span>
              <input className={styles.input} type="text" name="shop" placeholder="your-store.myshopify.com" />
            </label>
            <button className={styles.button} type="submit">
              Install NeonPing
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Live catalog, zero sync.</strong> NeonPing reads directly from Shopify — prices, inventory, and variants are always current. No stale data, ever.
          </li>
          <li>
            <strong>AI that closes sales.</strong> Personalized greetings, product recommendations, discount negotiation, and abandoned cart recovery — all handled automatically.
          </li>
          <li>
            <strong>Revenue you can measure.</strong> Track conversations to conversions, AOV lift, and cart recovery rate right from your merchant dashboard.
          </li>
        </ul>
      </div>
    </div>
  );
}
