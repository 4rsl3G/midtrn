// server.js
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

/**
 * Simpan transaksi di memori biar simpel.
 * (Untuk production: simpan di DB.)
 */
const db = new Map();
/**
 * db.set(orderId, {
 *   orderId, grossAmount, itemName, qty, status, qrUrl, rawChargeResponse
 * })
 */

function makeOrderId() {
  // order_id harus unik
  return `ORDER-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

app.get("/", (req, res) => {
  res.render("index", { title: "Checkout QRIS Dinamis" });
});

app.post("/pay", async (req, res) => {
  try {
    const itemName = (req.body.itemName || "Produk").toString().slice(0, 50);
    const grossAmount = Number(req.body.amount || 0);
    const qty = Math.max(1, Number(req.body.qty || 1));

    if (!Number.isFinite(grossAmount) || grossAmount < 1000) {
      return res.status(400).send("Amount minimal 1000");
    }

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
          price: grossAmount,
          quantity: qty,
          name: itemName
        }
      ],
      // optional:
      // customer_details: { first_name, last_name, email, phone }
      // qris: { acquirer: "gopay" } // kalau mau spesifik acquirer (opsional, tergantung akun)
      custom_expiry: {
        order_time: new Date().toISOString(),
        expiry_duration: 15,
        unit: "minute"
      }
    };

    // Buat transaksi QRIS dinamis via Core API /charge  [oai_citation:3‡Midtrans Documentation](https://docs.midtrans.com/reference/qris?utm_source=chatgpt.com)
    const chargeResponse = await coreApi.charge(payload);
    const qrUrl = extractQrUrl(chargeResponse);

    db.set(orderId, {
      orderId,
      grossAmount,
      itemName,
      qty,
      status: "pending",
      qrUrl,
      rawChargeResponse: chargeResponse
    });

    return res.redirect(`/pay/${orderId}`);
  } catch (e) {
    console.error(e);
    return res.status(500).send("Gagal membuat transaksi QRIS.");
  }
});

app.get("/pay/:orderId", (req, res) => {
  const { orderId } = req.params;
  const trx = db.get(orderId);
  if (!trx) return res.status(404).send("Order tidak ditemukan.");

  res.render("pay", {
    title: "Scan QRIS",
    trx
  });
});

app.get("/api/status/:orderId", async (req, res) => {
  const { orderId } = req.params;
  const trx = db.get(orderId);
  if (!trx) return res.status(404).json({ ok: false, message: "Not found" });

  try {
    // GET status API: /v2/{order_id}/status  [oai_citation:4‡Midtrans Documentation](https://docs.midtrans.com/docs/get-status-api-requests?utm_source=chatgpt.com)
    const status = await coreApi.transaction.status(orderId);

    // map status sederhana
    const transactionStatus = status?.transaction_status || "unknown";
    trx.status = transactionStatus;
    db.set(orderId, trx);

    return res.json({ ok: true, orderId, transactionStatus, status });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "Failed to fetch status" });
  }
});

/**
 * Webhook Midtrans: verifikasi signature_key
 * signature = SHA512(order_id + status_code + gross_amount + serverKey)  [oai_citation:5‡Midtrans Documentation](https://docs.midtrans.com/reference/handle-notifications?utm_source=chatgpt.com)
 */
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

    if (expected !== signature_key) {
      return res.status(401).send("Invalid signature");
    }

    // (Opsional tapi disarankan) verifikasi lagi pakai GET status API  [oai_citation:6‡Midtrans Documentation](https://docs.midtrans.com/docs/https-notification-webhooks?utm_source=chatgpt.com)
    const status = await coreApi.transaction.status(order_id);
    const trx = db.get(order_id) || { orderId: order_id };
    trx.status = status?.transaction_status || trx.status || "unknown";
    trx.statusDetail = status;
    db.set(order_id, trx);

    // Balas 200 biar Midtrans anggap sukses  [oai_citation:7‡Midtrans Documentation](https://docs.midtrans.com/reference/best-practices-to-handle-notification?utm_source=chatgpt.com)
    return res.status(200).json({ received: true });
  } catch (e) {
    console.error(e);
    // 500 => Midtrans bisa retry  [oai_citation:8‡Midtrans Documentation](https://docs.midtrans.com/reference/best-practices-to-handle-notification?utm_source=chatgpt.com)
    return res.status(500).send("Error");
  }
});

app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
});
