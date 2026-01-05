/* global $, toastr */

const App = {
  pollingTimer: null,
  overlayCount: 0,

  init() {
    toastr.options = { positionClass: "toast-bottom-right", timeOut: 2200, progressBar: true };
    this.loadCheckout(false);

    window.addEventListener("popstate", (e) => {
      const st = e.state || {};
      if (st.view === "success" && st.orderId) this.loadSuccess(st.orderId, false);
      else if (st.view === "failed" && st.orderId) this.loadFailed(st.orderId, false);
      else this.loadCheckout(false);
    });

    $(document).on("click", "[data-nav='checkout']", (e) => {
      e.preventDefault();
      this.loadCheckout(true);
    });
  },

  showOverlay(text = "Memproses…") {
    this.overlayCount++;
    $("#overlayText").text(text);
    $("#overlay").addClass("show");
  },
  hideOverlay() {
    this.overlayCount = Math.max(0, this.overlayCount - 1);
    if (this.overlayCount === 0) $("#overlay").removeClass("show");
  },

  stopPolling() {
    if (this.pollingTimer) clearInterval(this.pollingTimer);
    this.pollingTimer = null;
  },

  setView(html) {
    $("#view").html(html);
    $("#view > *").addClass("fade-up");
  },

  setSkeleton() {
    this.setView(`
      <section class="grid gap-6 lg:grid-cols-5">
        <div class="lg:col-span-3 rounded-2xl bg-white shadow-soft ring-1 ring-slate-200 p-6">
          <div class="h-6 w-48 rounded-lg bg-slate-100 shimmer"></div>
          <div class="mt-3 h-4 w-80 rounded-lg bg-slate-100 shimmer"></div>
          <div class="mt-6 space-y-4">
            <div class="h-12 rounded-xl bg-slate-100 shimmer"></div>
            <div class="grid sm:grid-cols-2 gap-4">
              <div class="h-12 rounded-xl bg-slate-100 shimmer"></div>
              <div class="h-12 rounded-xl bg-slate-100 shimmer"></div>
            </div>
            <div class="h-12 w-40 rounded-xl bg-slate-100 shimmer"></div>
          </div>
        </div>
        <div class="lg:col-span-2 rounded-2xl bg-white shadow-soft ring-1 ring-slate-200 p-6">
          <div class="h-5 w-36 rounded-lg bg-slate-100 shimmer"></div>
          <div class="mt-4 space-y-3">
            <div class="h-10 rounded-xl bg-slate-100 shimmer"></div>
            <div class="h-10 rounded-xl bg-slate-100 shimmer"></div>
            <div class="h-10 rounded-xl bg-slate-100 shimmer"></div>
          </div>
        </div>
      </section>
    `);
  },

  async loadCheckout(push = true) {
    this.stopPolling();
    this.setSkeleton();
    try {
      const html = await $.get("/partial/checkout");
      this.setView(html);
      if (push) history.pushState({ view: "checkout" }, "", "/");
    } catch (e) {
      this.setView(`
        <div class="rounded-2xl bg-white shadow-soft ring-1 ring-slate-200 p-6">
          <div class="flex items-start gap-3">
            <div class="h-10 w-10 rounded-xl bg-rose-600 text-white flex items-center justify-center">
              <i class="ri-error-warning-line"></i>
            </div>
            <div>
              <div class="font-semibold">Gagal memuat checkout</div>
              <div class="text-sm text-slate-600 mt-1">Endpoint /partial/checkout tidak merespons.</div>
              <button data-nav="checkout"
                class="mt-3 inline-flex items-center gap-2 rounded-xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white">
                <i class="ri-refresh-line"></i> Coba lagi
              </button>
            </div>
          </div>
        </div>
      `);
      toastr.error("Partial checkout gagal dimuat.");
    }
  },

  async loadSuccess(orderId, push = true) {
    this.stopPolling();
    this.setSkeleton();
    const html = await $.get(`/partial/success/${encodeURIComponent(orderId)}`);
    this.setView(html);
    if (push) history.pushState({ view: "success", orderId }, "", `#/success/${orderId}`);
  },

  async loadFailed(orderId, push = true) {
    this.stopPolling();
    this.setSkeleton();
    const html = await $.get(`/partial/failed/${encodeURIComponent(orderId)}`);
    this.setView(html);
    if (push) history.pushState({ view: "failed", orderId }, "", `#/failed/${orderId}`);
  },

  startPolling(orderId) {
    const tick = async (silent = true) => {
      try {
        // ✅ status endpoint baru untuk Snap
        const resp = await $.getJSON(`/api/trx/status/${encodeURIComponent(orderId)}`);
        if (!resp.ok) return;

        if (!silent) {
          if (resp.status === "pending") toastr.info("Menunggu pembayaran…");
          if (resp.status === "settlement" || resp.status === "capture") toastr.success("Pembayaran sukses ✅");
          if (["expire", "cancel", "deny", "failure"].includes(resp.status)) toastr.error("Pembayaran gagal/expired.");
        }

        if (resp.isFinal) {
          this.stopPolling();
          if (resp.status === "settlement" || resp.status === "capture") this.loadSuccess(orderId, true);
          else this.loadFailed(orderId, true);
        }
      } catch (_) {}
    };

    tick(false);
    this.pollingTimer = setInterval(() => tick(true), 3000);
  }
};

$(document).ready(() => {
  App.init();

  // ✅ Create Snap Token + Open Snap Popup (AJAX)
  $(document).on("submit", "#formCheckout", async function (e) {
    e.preventDefault();

    const payload = {
      itemName: $("#itemName").val(),
      qty: $("#qty").val(),
      amount: $("#amount").val()
    };

    App.showOverlay("Membuat pembayaran…");
    try {
      const resp = await $.ajax({
        url: "/api/snap/create",
        method: "POST",
        contentType: "application/json",
        data: JSON.stringify(payload)
      });

      if (!resp.ok) throw new Error(resp.message || "Gagal");

      // pastikan snap.js kebaca
      if (!window.snap || typeof window.snap.pay !== "function") {
        throw new Error("Snap.js belum termuat. Pastikan script snap.js + data-client-key ada di app.ejs");
      }

      toastr.success("Membuka Snap…");
      App.hideOverlay(); // overlay ditutup sebelum popup muncul

      window.snap.pay(resp.token, {
        onSuccess: function () {
          toastr.success("Pembayaran sukses ✅");
          App.loadSuccess(resp.orderId, true);
        },
        onPending: function () {
          toastr.info("Menunggu pembayaran…");
          App.startPolling(resp.orderId);
        },
        onError: function () {
          toastr.error("Pembayaran gagal.");
          App.loadFailed(resp.orderId, true);
        },
        onClose: function () {
          toastr.warning("Popup ditutup. Kamu bisa lanjutkan pembayaran kapan saja.");
          App.startPolling(resp.orderId);
        }
      });
    } catch (err) {
      const msg = err?.responseJSON?.message || err?.message || "Gagal membuat pembayaran.";
      toastr.error(msg);
    } finally {
      App.hideOverlay();
    }
  });

  // New payment
  $(document).on("click", "[data-action='new-payment']", (e) => {
    e.preventDefault();
    App.loadCheckout(true);
  });

  // Copy order id (dipakai di success/failed partial kalau ada)
  $(document).on("click", "[data-copy-order]", async function () {
    const orderId = $(this).attr("data-copy-order");
    try {
      await navigator.clipboard.writeText(orderId);
      toastr.success("Order ID tersalin");
    } catch {
      toastr.warning("Tidak bisa copy di device ini.");
    }
  });

  // Optional: manual check status jika kamu buat tombolnya di UI
  $(document).on("click", "#btnCheckStatus", async function () {
    const orderId = $(this).attr("data-order");
    App.showOverlay("Mengecek status…");
    try {
      const resp = await $.getJSON(`/api/trx/status/${encodeURIComponent(orderId)}`);
      if (!resp.ok) throw new Error(resp.message || "Gagal");

      if (resp.isFinal) {
        if (resp.status === "settlement" || resp.status === "capture") await App.loadSuccess(orderId, true);
        else await App.loadFailed(orderId, true);
      } else {
        toastr.info("Status: " + resp.status);
      }
    } catch {
      toastr.error("Gagal cek status.");
    } finally {
      App.hideOverlay();
    }
  });
});
