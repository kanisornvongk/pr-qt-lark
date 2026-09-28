(() => {
  const $ = (id) => document.getElementById(id);
  const DEMO = new URLSearchParams(location.search).has("demo");
  const store = {
    get: (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
  };

  const state = {
    prFile: null,
    qtFiles: [],
    result: null,
    existingRecordId: null,
  };

  /* ───────── settings ───────── */

  const workerUrl = () => (store.get("workerUrl") || window.APP_CONFIG?.WORKER_URL || "").replace(/\/+$/, "");
  const accessCode = () => store.get("accessCode");

  $("workerUrl").value = workerUrl();
  $("accessCode").value = accessCode();
  $("settingsBtn").onclick = () => ($("settings").hidden = !$("settings").hidden);
  if (DEMO) $("demoBanner").hidden = false;
  else if (!workerUrl() || !accessCode()) $("settings").hidden = false;

  $("saveSettings").onclick = async () => {
    store.set("workerUrl", $("workerUrl").value.trim());
    store.set("accessCode", $("accessCode").value);
    $("settingsStatus").textContent = "กำลังทดสอบ…";
    try {
      const meta = await api("GET", "/meta");
      fillExpenseOptions(meta.expenseOptions);
      $("settingsStatus").textContent = `เชื่อมต่อสำเร็จ · พบ ${meta.fields.length} คอลัมน์ใน Table PR`;
    } catch (e) {
      $("settingsStatus").textContent = `ผิดพลาด: ${e.message}`;
    }
  };

  async function api(method, path, body) {
    if (DEMO) return demoApi(method, path, body);
    if (!workerUrl()) throw new Error("ยังไม่ได้ตั้งค่า Worker URL");
    const res = await fetch(workerUrl() + path, {
      method,
      headers: { "Content-Type": "application/json", "X-Access-Code": accessCode() },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({ error: res.statusText }));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  /* ───────── files ───────── */

  function bindDrop(dropId, inputId, multiple) {
    const drop = $(dropId), input = $(inputId);
    ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove("over")));
    input.addEventListener("change", () => {
      const files = [...input.files];
      if (multiple) state.qtFiles = files; else state.prFile = files[0] || null;
      renderFiles();
    });
  }
  bindDrop("prDrop", "prFile", false);
  bindDrop("qtDrop", "qtFile", true);

  const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function renderFiles() {
    $("prList").innerHTML = state.prFile ? `<li><span>${esc(state.prFile.name)}</span><span>${kb(state.prFile.size)}</span></li>` : "";
    $("qtList").innerHTML = state.qtFiles.map((f) => `<li><span>${esc(f.name)}</span><span>${kb(f.size)}</span></li>`).join("");
    $("extractBtn").disabled = !state.prFile;
  }

  const readAsBase64 = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

  // Large photos are shrunk before upload; Claude reads up to ~2500px anyway.
  async function shrinkImage(file) {
    if (file.size < 1.5 * 1048576) return file;
    const img = await createImageBitmap(file);
    const scale = Math.min(1, 2400 / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise((res) => canvas.toBlob((b) => res(new File([b], file.name, { type: "image/jpeg" })), "image/jpeg", 0.88));
  }

  const isSheet = (f) => /\.(xlsx|xls|csv)$/i.test(f.name);
  const mimeOf = (f) => {
    if (f.type) return f.type;
    const ext = f.name.split(".").pop().toLowerCase();
    return { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" }[ext] || "";
  };

  /** File → payload for /extract ({name,type,data} or {name,text} for spreadsheets) */
  async function toPayload(file) {
    if (isSheet(file)) {
      if (/\.csv$/i.test(file.name)) return { name: file.name, text: await file.text() };
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const text = wb.SheetNames.map((n) => `--- sheet: ${n} ---\n${XLSX.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false })}`).join("\n\n");
      return { name: file.name, text };
    }
    let f = file;
    const type = mimeOf(file);
    if (type.startsWith("image/")) f = await shrinkImage(file);
    return { name: file.name, type: f.type || type, data: await readAsBase64(f) };
  }

  /** File → attachment for /save (original bytes, any type) */
  async function toAttachment(file) {
    return { name: file.name, type: mimeOf(file), data: await readAsBase64(file) };
  }

  /* ───────── extract ───────── */

  $("extractBtn").onclick = async () => {
    const btn = $("extractBtn");
    btn.disabled = true;
    $("extractStatus").textContent = "กำลังอ่านเอกสาร… (ประมาณ 20–60 วินาที)";
    try {
      const body = { pr: await toPayload(state.prFile), qts: await Promise.all(state.qtFiles.map(toPayload)) };
      const { result, expenseOptions } = await api("POST", "/extract", body);
      state.result = result;
      fillExpenseOptions(expenseOptions);
      fillReview(result);
      $("extractStatus").textContent = "อ่านเสร็จแล้ว ตรวจสอบข้อมูลด้านล่าง";
      $("review").hidden = false;
      $("review").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {
      $("extractStatus").textContent = `ผิดพลาด: ${e.message}`;
    } finally {
      btn.disabled = !state.prFile;
    }
  };

  function fillExpenseOptions(options = []) {
    const sel = $("fExpense");
    const current = sel.value;
    sel.innerHTML = `<option value="">— ไม่ระบุ —</option>` + options.map((o) => `<option>${esc(o)}</option>`).join("");
    if (options.includes(current)) sel.value = current;
  }

  const num = (v) => {
    if (v === "" || v == null) return null;
    const n = Number(String(v).replace(/,/g, ""));
    return isFinite(n) ? n : null;
  };
  const money = (n) => (n == null ? "" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

  function fillReview(r) {
    $("warnings").innerHTML = (r.warnings || []).map((w) => `<li>${esc(w)}</li>`).join("");
    $("fPr").value = r.pr_number || "";
    $("fDate").value = /^\d{4}-\d{2}-\d{2}$/.test(r.pr_date) ? r.pr_date : "";
    $("fList").value = r.title || "";
    if (r.expense_code && [...$("fExpense").options].some((o) => o.value === r.expense_code)) $("fExpense").value = r.expense_code;
    $("qtMeta").textContent = [r.vendor && `ผู้ขาย: ${r.vendor}`, r.qt_number && `QT: ${r.qt_number}`, r.qt_date && `วันที่ QT: ${r.qt_date}`, r.currency]
      .filter(Boolean).join(" · ");
    renderItems(r.items || []);
    $("tSub").value = money(r.subtotal);
    $("tDisc").value = money(r.discount);
    $("tVat").value = money(r.vat);
    $("tGrand").value = money(r.grand_total);
    syncPrice();
    checkExisting();
  }

  const SOURCE_TAG = { matched: "", pr_only: "ไม่พบราคาใน QT", qt_only: "มีใน QT แต่ไม่มีใน PR" };

  function renderItems(items) {
    $("items").querySelector("tbody").innerHTML = items.map((it, i) => `
      <tr class="${esc(it.source)}" data-i="${i}">
        <td><input data-k="description" value="${esc(it.description)}">${SOURCE_TAG[it.source] ? `<span class="tag">${SOURCE_TAG[it.source]}</span>` : ""}</td>
        <td class="num"><input data-k="qty" inputmode="decimal" value="${it.qty ?? ""}"></td>
        <td><input data-k="unit" value="${esc(it.unit)}"></td>
        <td class="num"><input data-k="unit_price" inputmode="decimal" value="${money(it.unit_price)}"></td>
        <td class="num"><input data-k="amount" inputmode="decimal" value="${money(it.amount)}"></td>
        <td><button class="icon" data-del="${i}" type="button" title="ลบแถว">✕</button></td>
      </tr>`).join("");
  }

  $("items").addEventListener("input", (e) => {
    const tr = e.target.closest("tbody tr");
    if (!tr) return;
    const it = state.result.items[+tr.dataset.i];
    const k = e.target.dataset.k;
    it[k] = ["qty", "unit_price", "amount"].includes(k) ? num(e.target.value) : e.target.value;
    if (k === "qty" || k === "unit_price") {
      if (it.qty != null && it.unit_price != null) {
        it.amount = Math.round(it.qty * it.unit_price * 100) / 100;
        tr.querySelector('[data-k="amount"]').value = money(it.amount);
      }
    }
    recalcTotals();
  });
  $("items").addEventListener("click", (e) => {
    const i = e.target.dataset.del;
    if (i == null) return;
    state.result.items.splice(+i, 1);
    renderItems(state.result.items);
    recalcTotals();
  });

  // After editing line items: subtotal = sum of amounts, VAT 7% if the QT had VAT.
  function recalcTotals() {
    const sub = state.result.items.reduce((s, it) => s + (it.amount || 0), 0);
    const disc = num($("tDisc").value) || 0;
    const vat = num($("tVat").value) ? Math.round((sub - disc) * 7) / 100 : 0;
    $("tSub").value = money(sub);
    $("tVat").value = money(vat);
    $("tGrand").value = money(sub - disc + vat);
    syncPrice();
  }

  const priceMode = () => document.querySelector('input[name="priceMode"]:checked').value;
  function syncPrice() {
    const v = priceMode() === "grand" ? num($("tGrand").value) : num($("tSub").value) - (num($("tDisc").value) || 0);
    $("fPrice").value = money(v);
  }
  document.querySelectorAll('input[name="priceMode"]').forEach((r) => r.addEventListener("change", syncPrice));
  ["tSub", "tDisc", "tVat", "tGrand"].forEach((id) => $(id).addEventListener("change", syncPrice));

  let checkTimer;
  $("fPr").addEventListener("input", () => { clearTimeout(checkTimer); checkTimer = setTimeout(checkExisting, 500); });

  async function checkExisting() {
    const pill = $("prState");
    const pr = $("fPr").value.trim();
    state.existingRecordId = null;
    pill.className = "pill";
    pill.textContent = "";
    if (!pr) return;
    try {
      const { record } = await api("GET", `/find?pr=${encodeURIComponent(pr)}`);
      if (record) {
        state.existingRecordId = record.record_id;
        pill.className = "pill exists";
        pill.textContent = "มีแล้ว · จะอัปเดตแถวเดิม";
        const f = record.fields || {};
        if (f.INV === true) $("fInvCheck").checked = true;
      } else {
        pill.className = "pill new";
        pill.textContent = "ใหม่";
      }
    } catch {
      /* lookup is best-effort */
    }
  }

  /* ───────── save ───────── */

  $("saveBtn").onclick = async () => {
    const pr = $("fPr").value.trim();
    if (!pr) { toast("กรุณาใส่ PR Number", "err"); $("fPr").focus(); return; }
    const btn = $("saveBtn");
    btn.disabled = true;
    $("saveStatus").textContent = "กำลังบันทึก…";
    try {
      const body = {
        recordId: state.existingRecordId,
        values: {
          prNumber: pr,
          date: $("fDate").value,
          list: $("fList").value.trim(),
          price: num($("fPrice").value) ?? "",
          expense: $("fExpense").value,
          prCheck: $("fPrCheck").checked,
          invCheck: $("fInvCheck").checked,
        },
        qtFiles: $("attachQt").checked ? await Promise.all(state.qtFiles.map(toAttachment)) : [],
      };
      const res = await api("POST", "/save", body);
      state.existingRecordId = res.record_id;
      $("saveStatus").textContent = `${res.action === "created" ? "เพิ่มแถวใหม่" : "อัปเดตแถวเดิม"}แล้ว (record ${res.record_id})`;
      toast("บันทึกลง Lark เรียบร้อย", "ok");
      checkExisting();
    } catch (e) {
      $("saveStatus").textContent = `ผิดพลาด: ${e.message}`;
      toast("บันทึกไม่สำเร็จ", "err");
    } finally {
      btn.disabled = false;
    }
  };

  let toastTimer;
  function toast(msg, kind = "") {
    const t = $("toast");
    t.textContent = msg;
    t.className = `toast ${kind}`;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
  }

  /* ───────── demo mode (?demo) ───────── */

  async function demoApi(method, path) {
    await new Promise((r) => setTimeout(r, 600));
    const options = ["5310-IT Software", "5320-IT Hardware", "5330-IT Service/MA"];
    if (path === "/meta") return { fields: new Array(9), expenseOptions: options };
    if (path.startsWith("/find")) return { record: path.includes("RQN26-0343") ? { record_id: "recDemo", fields: {} } : null };
    if (path === "/save") return { ok: true, action: "created", record_id: "recDemoNew" };
    return {
      expenseOptions: options,
      result: {
        pr_number: "RQN26-4400", pr_date: "2026-09-25", title: "Notebook + Docking",
        requester: "IT", vendor: "บริษัท ตัวอย่าง ไอที จำกัด", qt_number: "QT-2609-118", qt_date: "2026-09-24", currency: "THB",
        items: [
          { description: "Notebook Lenovo ThinkPad E14 Gen 6", qty: 2, unit: "เครื่อง", unit_price: 28500, amount: 57000, source: "matched", note: "" },
          { description: "USB-C Docking Station", qty: 2, unit: "ชิ้น", unit_price: 4200, amount: 8400, source: "matched", note: "" },
          { description: "กระเป๋าโน้ตบุ๊ก", qty: 2, unit: "ใบ", unit_price: null, amount: null, source: "pr_only", note: "" },
        ],
        subtotal: 65400, discount: 0, vat: 4578, grand_total: 69978,
        expense_code: "5320-IT Hardware",
        warnings: ["ไม่พบราคา 'กระเป๋าโน้ตบุ๊ก' ในใบ QT"],
      },
    };
  }

  if (!DEMO && workerUrl() && accessCode()) {
    api("GET", "/meta").then((m) => fillExpenseOptions(m.expenseOptions)).catch(() => {});
  }
})();
