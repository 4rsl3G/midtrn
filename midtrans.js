import midtransClient from "midtrans-client";

export const coreApi = new midtransClient.CoreApi({
  isProduction: process.env.MIDTRANS_IS_PRODUCTION === "true",
  serverKey: process.env.MIDTRANS_SERVER_KEY
});

/**
 * Midtrans docs update:
 * - actions now may include `generate-qr-code-v2` object with URL to generate QR (ASPI format)
 * - previously: `generate-qr-code` or other url in actions
 * Source: Midtrans blog + docs reference.  [oai_citation:1‡Midtrans](https://midtrans.com/id/blog/midtrans-hadirkan-desain-baru-qris-dinamis-gopay-lebih-fleksibel-dan-sesuai-regulasi)
 */
export function extractQrUrl(chargeResponse) {
  const actions = Array.isArray(chargeResponse?.actions) ? chargeResponse.actions : [];

  // ✅ Preferred (new): generate-qr-code-v2
  const v2 = actions.find(a => (a?.name || "").toLowerCase() === "generate-qr-code-v2" && typeof a?.url === "string");
  if (v2?.url) return v2.url;

  // ✅ Common (old): generate-qr-code
  const v1 = actions.find(a => (a?.name || "").toLowerCase() === "generate-qr-code" && typeof a?.url === "string");
  if (v1?.url) return v1.url;

  // ✅ Fallback: any action containing "qr"
  const anyQr = actions.find(a => /qr/i.test(a?.name || "") && typeof a?.url === "string");
  if (anyQr?.url) return anyQr.url;

  // ✅ Last fallback: any action url
  const anyUrl = actions.find(a => typeof a?.url === "string");
  if (anyUrl?.url) return anyUrl.url;

  return null;
}

/**
 * Optional helper if someday you want to generate QR image yourself:
 * - Midtrans response sometimes includes qr_string (you can convert it into QR image).
 * Docs mention qr_string can be used as alternative.  [oai_citation:2‡Midtrans Documentation](https://docs.midtrans.com/docs/gopay-qris-pos-integration?utm_source=chatgpt.com)
 */
export function extractQrString(chargeResponse) {
  return typeof chargeResponse?.qr_string === "string" ? chargeResponse.qr_string : null;
}
