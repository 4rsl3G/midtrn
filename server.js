import "dotenv/config";
import express from "express";
import CryptoJS from "crypto-js";
import { snap, getSnapJsUrl } from "./midtrans.js";

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use("/public", express.static("public", { maxAge: "1h", etag: true }));

/** In-memory DB (demo) */
const db = new Map();

function makeOrderId() {
  return `ORDER-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeStatus(s) {
  return (s || "unknown").toString();
}

function isFinalStatus(s) {
  return ["settlement", "capture", "expire", "cancel", "deny", "failure"].includes(s);
}

/** ===== Shell page ===== */
app.get("/", (req, res) => {
  res.render("app", {
    title: "SNAP AJAX",
    snapJsUrl: getSnapJsUrl(),
    clientKey: process.env.MIDTRANS_CLIENT_KEY || ""
  });
});

/** ===== Partials ===== */
app.get("/partial/checkout", (req, res) => res.render("partials/checkout"));
app.get("/partial/success/:orderId", (req, res) => {
  const trx = db.get(req.params.orderId);
  if (!trx) return res.status(404).send("Order tidak ditemukan.");
  res.render("partials/success", { trx });
});
app.get("/partial/failed/:orderId", (req, res) => {
  const trx = db.get(req.params.orderId);
  if (!trx) return res.status(404).send("Order tidak ditemukan.");
  res.render("partials/failed", { trx });
});

/** ===== API: Create SNAP token (AJAX) =====
 * Backend acquire Snap token via /snap/v1/transactions using Server Key.  [oai_citation:2‡Midtrans Documentation](https://docs.midtrans.com/docs/snap-snap-integration-guide?utm_source=chatgpt.com)
 */
app.post("/api/snap/create", async (req, res) => {
  try {
    const itemName = (req.body.itemName || "Produk").toString().trim().slice(0, 50);
    const qty = Math.max(1, Number(req.body.qty || 1));
    const unitPrice = Number(req.body.amount || 0);

    if (!Number.isFinite(unitPrice) || unitPrice < 1000) {
      return res.status(400).json({ ok: false, message: "Nominal minimal 1000" });
    }

    const grossAmount = Math.round(unitPrice * qty);
    const orderId = makeOrderId();

    const parameter = {
      transaction_details: {
        order_id: orderId,
        gross_amount: grossAmount
      },
      item_details: [
        { id: "item-1", price: Math.round(unitPrice), quantity: qty, name: itemName || "Produk" }
      ],
      customer_details: {
        first_name: "Customer",
        email: "customer@example.com"
      }
      // Optional: callbacks/redirect url bisa di-set via Dashboard Snap Preference  [oai_citation:3‡Midtrans Documentation](https://docs.midtrans.com/docs/snap-advanced-feature?utm_source=chatgpt.com)
    };

    // createTransactionToken returns token string.  [oai_citation:4‡GitHub](https://github.com/Midtrans/midtrans-nodejs-client?utm_source=chatgpt.com)
    const token = await snap.createTransactionToken(parameter);

    db.set(orderId, {
      orderId,
      itemName: itemName || "Produk",
      qty,
      unitPrice: Math.round(unitPrice),
      grossAmount,
      status: "pending",
      snapToken: token,
      createdAt: new Date().toISOString()
    });

    return res.json({ ok: true, orderId, token });
  } catch (e) {
    const apiMsg =
      e?.ApiResponse?.validation_messages?.[0] ||
      e?.ApiResponse?.status_message ||
      e?.message;

    console.error("SNAP CREATE ERROR:", apiMsg);
    if (e?.ApiResponse) console.error("ApiResponse:", e.ApiResponse);

    return res.status(500).json({
      ok: false,
      message: apiMsg || "Gagal membuat Snap token. Cek keys & logs."
    });
  }
});

/** ===== API: Get status (AJAX) =====
 * Get Status API works for Snap & Core API.  [oai_citation:5‡Midtrans Documentation](https://docs.midtrans.com/reference/get-transaction-status?utm_source=chatgpt.com)
 */
app.get("/api/trx/status/:orderId", async (req, res) => {
  const { orderId } = req.params;
  const trx = db.get(orderId);
  if (!trx) return res.status(404).json({ ok: false, message: "Order tidak ditemukan." });

  try {
    // snap has no status method; status via Core API endpoint in midtrans-client is CoreApi.
    // Tapi midtrans-client Snap tidak expose status, jadi kita hit via fetch manual atau pakai coreApi jika kamu masih punya.
    // Agar simpel: gunakan HTTP GET ke /v2/{order_id}/status dengan Basic Auth Server Key.
    const isProd = process.env.MIDTRANS_IS_PRODUCTION === "true";
    const base = isProd ? "https://api.midtrans.com" : "https://api.sandbox.midtrans.com";

    const auth = Buffer.from(`${process.env.MIDTRANS_SERVER_KEY}:`).toString("base64");
    const resp = await fetch(`${base}/v2/${encodeURIComponent(orderId)}/status`, {
      headers: { Authorization: `Basic ${auth}` }
    });
    const data = await resp.json();

    const s = normalizeStatus(data?.transaction_status);
    trx.status = s;
    trx.statusDetail = data;
    db.set(orderId, trx);

    return res.json({ ok: true, orderId, status: s, isFinal: isFinalStatus(s) });
  } catch (e) {
    console.error("STATUS ERROR:", e?.message || e);
    return res.status(500).json({ ok: false, message: "Gagal mengambil status." });
  }
});

/** ===== Webhook (same endpoint) ===== */
app.post("/midtrans/notification", async (req, res) => {
  try {
    const n = req.body || {};
    const { order_id, status_code, gross_amount, signature_key } = n;
    if (!order_id || !status_code || !gross_amount || !signature_key) {
      return res.status(400).send("Bad request");
    }

    const serverKey = process.env.MIDTRANS_SERVER_KEY;
    const raw = `${order_id}${status_code}${gross_amount}${serverKey}`;
    const expected = CryptoJS.SHA512(raw).toString(CryptoJS.enc.Hex);
    if (expected !== signature_key) return res.status(401).send("Invalid signature");

    const trx = db.get(order_id) || { orderId: order_id };
    trx.status = normalizeStatus(n.transaction_status);
    trx.notification = n;
    db.set(order_id, trx);

    return res.status(200).json({ received: true });
  } catch (e) {
    console.error("WEBHOOK ERROR:", e?.message || e);
    return res.status(500).send("Error");
  }
});

/** Vercel handler support */
export default app;
if (process.env.VERCEL !== "1") {
  app.listen(PORT, () => console.log(`Running http://localhost:${PORT}`));
}
