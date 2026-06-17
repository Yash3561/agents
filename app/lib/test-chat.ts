/**
 * Shared helper for sending a test message to /api/chat from server-side actions.
 * Used by the onboarding wizard and the AI Config chat playground.
 */
export async function sendTestMessage(
  shop: string,
  message: string,
  apiBaseUrl: string = "",
): Promise<{ text: string }> {
  const url = `${apiBaseUrl}/api/chat`;
  const sessionId = `admin-test-${Date.now()}`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shop, session_id: sessionId, message }),
    });
  } catch (err) {
    return { text: `Error reaching API: ${String(err)}` };
  }

  if (!resp.ok) return { text: `Error: ${resp.status}` };

  const text = await resp.text();
  let accumulated = "";
  for (const block of text.split("\n\n")) {
    const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
    const eventLine = block.split("\n").find((l) => l.startsWith("event:"));
    if (eventLine?.slice(6).trim() === "delta" && dataLine) {
      try {
        accumulated += JSON.parse(dataLine.slice(5).trim()).text;
      } catch {
        // skip malformed chunk
      }
    }
  }
  return { text: accumulated || "(no response)" };
}
