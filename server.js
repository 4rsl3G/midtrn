import "dotenv/config";
import express from "express";
import CryptoJS from "crypto-js";
import { coreApi, extractQrUrl } from "./midtrans.js";

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use("/public", express.static("public"));

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

/**
 * Midtrans custom_expiry.order_time must follow:
 * yyyy-MM-dd HH:mm:ss Z  (eg 2525-06-09 15:07:00 +0700)
 */
function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * Format date with explicit offset +0000 (UTC).
 * Example: 2026-01-04 23:40:41 +0000
 */
function formatMidtransOrderTimeUTC(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = pad2(date.getUTCMonth() + 1);
  const d = pad2(date.getUTCDate());
  const hh = pad2(date.getUTCHours());
  const mm = pad2(date.getUTCMinutes());
  const ss = pad2(date.getUTCSeconds());
  return `${y}-${m}-${d} ${hh}:${mm}:${ss} +0000`;
}

/** ===== Shell page ===== */
app.get("/", (req, res) => {
  res.render("app", { title: "QRIS Dinamis AJAX" });
});

/** ===== Partials for AJAX navigation ===== */
app.get("/partial/checkout", (req, res) => res.render("partials/checkout"));
app.get("/partial/pay/:orderId", (req, res) => {
  const trx = db.get(req.params.orderId);
  if (!trx) return res.status(404).send("Order tidak ditemukan.");
  res.render("partials/pay", { trx });
});
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

/** ===== API: Create QRIS (AJAX) ===== */
app.post("/api/qris/create", async (req, res) => {
  try {
    const itemName = (req.body.itemName || "Produk").toString().slice(0, 50);
    const qty = Math.max(1, Number(req.body.qty || 1));
    const unitPrice = Number(req.body.amount || 0);

    if (!Number.isFinite(unitPrice) || unitPrice < 1000) {
      return res.status(400).json({ ok: false, message: "Nominal minimal 1000" });
    }

    const grossAmount = Math.round(unitPrice * qty);
    const orderId = makeOrderId();

    const payload = {
      payment_type: "qris",
      transaction_details: {
        order_id: orderId,
        gross_amount: grossAmount
      },
      item_details: [
        {
          id: "item-1",
          price: Math.round(unitPrice),
          quantity: qty,
          name: itemName
        }
      ],
      // ✅ FIX: correct order_time format
      custom_expiry: {
        order_time: formatMidtransOrderTimeUTC(new Date()),
        expiry_duration: 15,
        unit: "minute"
      }
    };

    const chargeResponse = await coreApi.charge(payload);
    const qrUrl = extractQrUrl(chargeResponse);

    if (!qrUrl) {
      console.error("Charge OK but QR url not found:", chargeResponse);
      return res.status(500).json({ ok: false, message: "QR URL tidak ditemukan di response." });
    }

    const trx = {
      orderId,
      itemName,
      qty,
      unitPrice: Math.round(unitPrice),
      grossAmount,
      status: "pending",
      qrUrl,
      createdAt: new Date().toISOString(),
      rawChargeResponse: chargeResponse
    };
    db.set(orderId, trx);

    return res.json({ ok: true, orderId });
  } catch (e) {
    // return Midtrans validation message if exists
    const apiMsg = e?.ApiResponse?.validation_messages?.[0] || e?.ApiResponse?.status_message;
    console.error("MIDTRANS CHARGE ERROR:", apiMsg || e?.message || e);

    return res.status(500).json({
      ok: false,
      message: apiMsg || "Gagal membuat QRIS. Cek SERVER_KEY / payload / logs."
    });
  }
});

/** ===== API: Status (AJAX) ===== */
app.get("/api/qris/status/:orderId", async (req, res) => {
  const { orderId } = req.params;
  const trx = db.get(orderId);
  if (!trx) return res.status(404).json({ ok: false, message: "Order tidak ditemukan." });

  try {
    const statusResp = await coreApi.transaction.status(orderId);
    const s = normalizeStatus(statusResp?.transaction_status);

    trx.status = s;
    trx.statusDetail = statusResp;
    db.set(orderId, trx);

    return res.json({
      ok: true,
      orderId,
      status: s,
      isFinal: isFinalStatus(s)
    });
  } catch (e) {
    console.error("STATUS ERROR:", e?.message || e);
    return res.status(500).json({ ok: false, message: "Gagal mengambil status." });
  }
});

/** ===== Webhook (optional but recommended) ===== */
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

    const statusResp = await coreApi.transaction.status(order_id);
    const s = normalizeStatus(statusResp?.transaction_status);

    const trx = db.get(order_id) || { orderId: order_id };
    trx.status = s;
    trx.statusDetail = statusResp;
    db.set(order_id, trx);

    return res.status(200).json({ received: true });
  } catch (e) {
    console.error("WEBHOOK ERROR:", e?.message || e);
    return res.status(500).send("Error");
  }
});

app.listen(PORT, () => console.log(`Running http://localhost:${PORT}`));
