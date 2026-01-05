import midtransClient from "midtrans-client";

export const coreApi = new midtransClient.CoreApi({
  isProduction: process.env.MIDTRANS_IS_PRODUCTION === "true",
  serverKey: process.env.MIDTRANS_SERVER_KEY,
  clientKey: process.env.MIDTRANS_CLIENT_KEY // optional, kalau nanti mau dipakai di frontend
});

export function extractQrUrl(chargeResponse) {
  const actions = chargeResponse?.actions || [];
  const candidate =
    actions.find(a => /qr/i.test(a.name || "") && typeof a.url === "string") ||
    actions.find(a => typeof a.url === "string");
  return candidate?.url || null;
}
