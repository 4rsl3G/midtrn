// midtrans.js
import midtransClient from "midtrans-client";

export const coreApi = new midtransClient.CoreApi({
  isProduction: process.env.MIDTRANS_IS_PRODUCTION === "true",
  serverKey: process.env.MIDTRANS_SERVER_KEY,
  clientKey: "" // QRIS core api tidak butuh client key di server
});

/**
 * Ambil URL QR dari response /charge.
 * Di doc, QRIS charge mengembalikan QR code image URL (umumnya via actions[].url).  [oai_citation:2‡Midtrans Documentation](https://docs.midtrans.com/reference/qris?utm_source=chatgpt.com)
 */
export function extractQrUrl(chargeResponse) {
  const actions = chargeResponse?.actions || [];
  const candidate =
    actions.find(a => /qr/i.test(a.name || "") && typeof a.url === "string") ||
    actions.find(a => typeof a.url === "string");

  return candidate?.url || null;
}
