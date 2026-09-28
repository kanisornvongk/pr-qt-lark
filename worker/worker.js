/**
 * PR + QT → Lark Base  (Cloudflare Worker)
 *
 * Endpoints (all require header  X-Access-Code: <ACCESS_CODE>)
 *   GET  /meta             → fields of the PR table (+ options of select fields)
 *   GET  /find?pr=RQN..    → existing record with that PR Number (or null)
 *   POST /extract          → read PR + QT files with Claude, return structured JSON
 *   POST /save             → create / update the record in Lark (uploads QT files as attachments)
 *
 * Secrets / variables (Cloudflare dashboard → Worker → Settings → Variables and Secrets):
 *   ANTHROPIC_API_KEY   (secret)
 *   LARK_APP_ID         (secret)  e.g. cli_xxxxxxxx
 *   LARK_APP_SECRET     (secret)
 *   ACCESS_CODE         (secret)  password that users type on the web page
 *   ALLOWED_ORIGIN      (text)    e.g. https://<user>.github.io   ("*" while testing)
 *   LARK_APP_TOKEN      (text)    Base token from the URL:  /base/<LARK_APP_TOKEN>?table=...
 *   LARK_TABLE_ID       (text)    table id from the URL:    ?table=<LARK_TABLE_ID>
 *
 * Plain fetch is used for the Claude API because this file is meant to be pasted
 * straight into the Cloudflare dashboard, where npm packages (the Anthropic SDK) can't be imported.
 */

const LARK = "https://open.larksuite.com/open-apis";
const CLAUDE_MODEL = "claude-opus-5";

// Column names in the Lark "PR" table
const F = {
  date: "Date",
  list: "List",
  qt: "QT",
  prNumber: "PR Number",
  prCheck: "PR",
  invCheck: "INV",
  price: "Price",
  expense: "รหัสค่าใช้จ่าย",
};

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      if (!env.ACCESS_CODE || request.headers.get("X-Access-Code") !== env.ACCESS_CODE) {
        return json({ error: "รหัสเข้าใช้งานไม่ถูกต้อง" }, 401, cors);
      }
      const url = new URL(request.url);
      const route = `${request.method} ${url.pathname.replace(/\/+$/, "") || "/"}`;

      switch (route) {
        case "GET /meta":
          return json(await getMeta(env), 200, cors);
        case "GET /find":
          return json({ record: await findByPr(env, url.searchParams.get("pr") || "") }, 200, cors);
        case "POST /extract":
          return json(await extract(env, await request.json()), 200, cors);
        case "POST /save":
          return json(await save(env, await request.json()), 200, cors);
        default:
          return json({ error: "not found" }, 404, cors);
      }
    } catch (err) {
      return json({ error: String(err.message || err) }, 500, cors);
    }
  },
};

/* ───────────────────────── helpers ───────────────────────── */

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGIN || "*").split(",").map((s) => s.trim());
  const origin = request.headers.get("Origin") || "";
  const allowOrigin = allowed.includes("*") ? "*" : allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Access-Code",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
}

const required = (env, key) => {
  if (!env[key]) throw new Error(`ยังไม่ได้ตั้งค่า ${key} ใน Worker`);
  return env[key];
};
const appToken = (env) => required(env, "LARK_APP_TOKEN");
const tableId = (env) => required(env, "LARK_TABLE_ID");
const recordsUrl = (env) => `${LARK}/bitable/v1/apps/${appToken(env)}/tables/${tableId(env)}/records`;

/* ───────────────────────── Lark ───────────────────────── */

let cachedToken = null; // { value, expiresAt } — survives while the isolate is warm

async function larkToken(env) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const res = await fetch(`${LARK}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: env.LARK_APP_ID, app_secret: env.LARK_APP_SECRET }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Lark auth: ${data.msg}`);
  cachedToken = { value: data.tenant_access_token, expiresAt: Date.now() + data.expire * 1000 };
  return cachedToken.value;
}

async function lark(env, path, init = {}) {
  const token = await larkToken(env);
  const res = await fetch(path.startsWith("http") ? path : `${LARK}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      ...(init.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({ code: res.status, msg: res.statusText }));
  if (data.code !== 0) throw new Error(`Lark ${data.code}: ${data.msg}`);
  return data.data;
}

async function getMeta(env) {
  const data = await lark(env, `/bitable/v1/apps/${appToken(env)}/tables/${tableId(env)}/fields?page_size=100`);
  const fields = (data.items || []).map((f) => ({
    name: f.field_name,
    type: f.type, // 1 text, 2 number, 3 single select, 4 multi select, 5 date, 7 checkbox, 17 attachment
    options: (f.property?.options || []).map((o) => o.name),
  }));
  const expense = fields.find((f) => f.name === F.expense);
  return { fields, expenseOptions: expense ? expense.options : [], expenseType: expense ? expense.type : null };
}

async function findByPr(env, pr) {
  pr = pr.trim();
  if (!pr) return null;
  const data = await lark(env, `${recordsUrl(env)}/search?page_size=5`, {
    method: "POST",
    body: JSON.stringify({
      filter: { conjunction: "and", conditions: [{ field_name: F.prNumber, operator: "is", value: [pr] }] },
    }),
  });
  const item = (data.items || [])[0];
  if (!item) return null;
  return { record_id: item.record_id, fields: item.fields };
}

async function uploadAttachment(env, file) {
  const bytes = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
  const form = new FormData();
  form.append("file_name", file.name);
  form.append("parent_type", "bitable_file");
  form.append("parent_node", appToken(env));
  form.append("size", String(bytes.length));
  form.append("file", new Blob([bytes], { type: file.type || "application/octet-stream" }), file.name);
  const data = await lark(env, "/drive/v1/medias/upload_all", { method: "POST", body: form });
  return data.file_token;
}

/**
 * body = {
 *   values: { date: "YYYY-MM-DD", list, prNumber, price, expense, prCheck, invCheck },
 *   qtFiles: [{ name, type, data(base64) }],
 *   recordId?: string   // update this record instead of creating
 * }
 */
async function save(env, body) {
  const v = body.values || {};
  if (!v.prNumber) throw new Error("ต้องมี PR Number");

  const meta = await getMeta(env);
  const fieldType = (name) => meta.fields.find((f) => f.name === name)?.type;

  const fields = {};
  if (v.date) fields[F.date] = new Date(`${v.date}T00:00:00+07:00`).getTime();
  if (v.list != null) fields[F.list] = String(v.list);
  fields[F.prNumber] = String(v.prNumber).trim();
  if (v.price !== "" && v.price != null) {
    fields[F.price] = fieldType(F.price) === 2 ? Number(v.price) : formatMoney(v.price);
  }
  if (typeof v.prCheck === "boolean") fields[F.prCheck] = v.prCheck;
  if (typeof v.invCheck === "boolean") fields[F.invCheck] = v.invCheck;
  if (v.expense) {
    const t = fieldType(F.expense);
    fields[F.expense] = t === 4 ? [v.expense] : v.expense;
  }

  // If no explicit record id, upsert by PR Number
  let recordId = body.recordId || null;
  let existing = null;
  if (!recordId) {
    existing = await findByPr(env, fields[F.prNumber]);
    recordId = existing?.record_id || null;
  } else {
    existing = await lark(env, `${recordsUrl(env)}/${recordId}`).then((d) => d.record);
  }

  const qtFiles = body.qtFiles || [];
  if (qtFiles.length) {
    const tokens = [];
    for (const f of qtFiles) tokens.push({ file_token: await uploadAttachment(env, f) });
    const keep = (existing?.fields?.[F.qt] || []).map((a) => ({ file_token: a.file_token }));
    fields[F.qt] = [...keep, ...tokens];
  }

  const data = recordId
    ? await lark(env, `${recordsUrl(env)}/${recordId}`, { method: "PUT", body: JSON.stringify({ fields }) })
    : await lark(env, recordsUrl(env), { method: "POST", body: JSON.stringify({ fields }) });

  return { ok: true, action: recordId ? "updated" : "created", record_id: data.record.record_id };
}

function formatMoney(n) {
  const num = Number(String(n).replace(/,/g, ""));
  if (!isFinite(num)) return String(n);
  return num.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/* ───────────────────────── Claude ───────────────────────── */

const nullableNumber = { anyOf: [{ type: "number" }, { type: "null" }] };

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    pr_number: { type: "string", description: "เลขที่ PR เช่น RQN26-0343 (ว่างถ้าไม่พบ)" },
    pr_date: { type: "string", description: "วันที่ของ PR รูปแบบ YYYY-MM-DD ปี ค.ศ. (ว่างถ้าไม่พบ)" },
    title: { type: "string", description: "ชื่อสั้นของสิ่งที่ขอซื้อ สำหรับคอลัมน์ List เช่น 'Microsoft 365', 'TP LINK'" },
    requester: { type: "string" },
    vendor: { type: "string", description: "ชื่อผู้ขายจากใบ QT" },
    qt_number: { type: "string" },
    qt_date: { type: "string", description: "YYYY-MM-DD" },
    currency: { type: "string", description: "เช่น THB" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          qty: nullableNumber,
          unit: { type: "string" },
          unit_price: nullableNumber,
          amount: nullableNumber,
          source: { type: "string", enum: ["matched", "pr_only", "qt_only"] },
          note: { type: "string" },
        },
        required: ["description", "qty", "unit", "unit_price", "amount", "source", "note"],
        additionalProperties: false,
      },
    },
    subtotal: nullableNumber,
    discount: nullableNumber,
    vat: nullableNumber,
    grand_total: nullableNumber,
    expense_code: { type: "string", description: "ตัวเลือกรหัสค่าใช้จ่ายที่เหมาะสมที่สุดจากรายการที่ให้ไว้ (ว่างถ้าไม่แน่ใจ)" },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: [
    "pr_number", "pr_date", "title", "requester", "vendor", "qt_number", "qt_date", "currency",
    "items", "subtotal", "discount", "vat", "grand_total", "expense_code", "warnings",
  ],
  additionalProperties: false,
};

function fileBlocks(label, file) {
  const header = { type: "text", text: `=== ${label}: ${file.name} ===` };
  if (file.text != null) {
    return [header, { type: "text", text: file.text }];
  }
  const type = (file.type || "").toLowerCase();
  if (type === "application/pdf") {
    return [header, { type: "document", source: { type: "base64", media_type: "application/pdf", data: file.data } }];
  }
  if (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(type)) {
    return [header, { type: "image", source: { type: "base64", media_type: type, data: file.data } }];
  }
  throw new Error(`ไม่รองรับไฟล์ชนิด ${type || "ไม่ทราบ"} (${file.name})`);
}

/** body = { pr: File, qts: File[] }, File = { name, type, data(base64) } | { name, text } */
async function extract(env, body) {
  if (!body.pr) throw new Error("ต้องแนบไฟล์ PR");
  let expenseOptions = [];
  try {
    expenseOptions = (await getMeta(env)).expenseOptions;
  } catch {
    // Lark not configured yet — extraction still works without the option list
  }

  const content = [...fileBlocks("ไฟล์ PR (ใบขอซื้อ)", body.pr)];
  (body.qts || []).forEach((q, i) => content.push(...fileBlocks(`ไฟล์ QT (ใบเสนอราคา) #${i + 1}`, q)));
  content.push({
    type: "text",
    text: [
      "อ่านใบขอซื้อ (PR) และใบเสนอราคา (QT) ด้านบน แล้วสรุปเป็น JSON ตาม schema",
      "- รายการสินค้า (items) ให้ยึดตาม PR เป็นหลัก แล้วเติมราคาต่อหน่วย/จำนวนเงินจาก QT ที่ตรงกัน (source = matched)",
      "- รายการที่อยู่ใน PR แต่หาราคาใน QT ไม่เจอ ให้ source = pr_only และ unit_price/amount = null",
      "- รายการที่มีใน QT แต่ไม่มีใน PR ให้ใส่ด้วย source = qt_only",
      "- subtotal, discount, vat, grand_total เอาจาก QT; ถ้ามีหลายใบ QT ให้ใช้ใบที่ตรงกับ PR ที่สุด และแจ้งใน warnings",
      "- ตัวเลขเป็น number ไม่มีคอมม่า; วันที่ พ.ศ. ให้แปลงเป็น ค.ศ.",
      "- ถ้าจำนวนหรือรายการใน PR กับ QT ไม่ตรงกัน หรืออ่านไม่ชัด ให้เขียนแจ้งใน warnings เป็นภาษาไทย",
      expenseOptions.length
        ? `- เลือก expense_code จากรายการนี้เท่านั้น: ${JSON.stringify(expenseOptions)}`
        : "- expense_code ให้เป็นค่าว่าง",
    ].join("\n"),
  });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "server-side-fallback-2026-07-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { format: { type: "json_schema", schema: EXTRACT_SCHEMA } },
      messages: [{ role: "user", content }],
    }),
  });
  const msg = await res.json();
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${msg.error?.message || JSON.stringify(msg)}`);
  if (msg.stop_reason === "refusal") throw new Error("Claude ปฏิเสธการประมวลผลไฟล์นี้");
  if (msg.stop_reason === "max_tokens") throw new Error("ผลลัพธ์ยาวเกินไป ลองแยกไฟล์ให้น้อยลง");
  const text = (msg.content || []).find((b) => b.type === "text")?.text;
  if (!text) throw new Error("Claude ไม่ได้ส่งผลลัพธ์กลับมา");
  return { result: JSON.parse(text), expenseOptions };
}
