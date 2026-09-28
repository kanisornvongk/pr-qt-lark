# PR + QT → Lark

เว็บสำหรับอัปโหลด **ใบขอซื้อ (PR)** และ **ใบเสนอราคา (QT)** ให้ AI (Claude) อ่านข้อมูล
แล้วบันทึกลง Table **PR** ใน Lark Base

- รายการสินค้ายึดตาม PR, ราคาเติมจาก QT
- รองรับไฟล์ PDF, Excel (.xlsx/.xls/.csv), รูปภาพ (JPG/PNG/WEBP)
- ตรวจ/แก้ข้อมูลก่อนบันทึกได้ทุกช่อง
- ถ้า PR Number มีใน Lark อยู่แล้ว จะ **อัปเดตแถวเดิม** แทนการเพิ่มใหม่
- แนบไฟล์ QT เข้าคอลัมน์ `QT` อัตโนมัติ

ทดลองหน้าตาโดยไม่ต้องเชื่อมต่อ: เปิด `index.html?demo`

## โครงสร้าง

```
index.html  style.css  app.js  config.js   ← หน้าเว็บ (GitHub Pages)
worker/worker.js                           ← Backend (Cloudflare Worker)
```

หน้าเว็บเป็นไฟล์ static บน GitHub Pages ส่วน API key และ Lark App Secret เก็บไว้ใน Cloudflare Worker
เพราะหน้าเว็บสาธารณะเก็บความลับไม่ได้ และ Lark API ไม่อนุญาตให้เบราว์เซอร์เรียกโดยตรง

คอลัมน์ใน Lark ที่เว็บเขียน: `Date`, `List`, `QT`, `PR Number`, `PR`, `INV`, `Price`, `รหัสค่าใช้จ่าย`
(ถ้าเปลี่ยนชื่อคอลัมน์ใน Lark ให้แก้ค่าคงที่ `F` ใน `worker/worker.js`)

## ติดตั้ง

### 1. สร้าง Lark App

1. เข้า <https://open.larksuite.com/app> → **Create Custom App**
2. **Permissions & Scopes** → เพิ่ม
   - `bitable:app` (ดู แก้ไข และจัดการ Base)
   - `drive:drive` (อัปโหลดไฟล์แนบ)
3. **Version Management & Release** → สร้างเวอร์ชันแล้วขออนุมัติจากผู้ดูแลระบบ Lark ขององค์กร
4. จด **App ID** และ **App Secret** จากหน้า Credentials
5. เปิด Base ใน Lark → ปุ่ม `…` มุมขวาบน → **Add Document App** (เพิ่มแอปในเอกสาร) → เลือกแอปนี้ ให้สิทธิ์ **แก้ไขได้**

### 2. Claude API key

สร้าง key ที่ <https://console.anthropic.com/settings/keys>

### 3. Deploy Cloudflare Worker

1. <https://dash.cloudflare.com> → **Workers & Pages** → **Create** → **Create Worker** ตั้งชื่อ เช่น `pr-qt-lark` → Deploy
2. **Edit code** → ลบโค้ดเดิม วางเนื้อหา `worker/worker.js` ทั้งไฟล์ → **Deploy**
3. **Settings → Variables and Secrets** เพิ่ม:

| ชื่อ | ชนิด | ค่า |
|---|---|---|
| `ANTHROPIC_API_KEY` | Secret | key จากข้อ 2 |
| `LARK_APP_ID` | Secret | App ID จากข้อ 1 |
| `LARK_APP_SECRET` | Secret | App Secret จากข้อ 1 |
| `ACCESS_CODE` | Secret | รหัสผ่านที่ผู้ใช้ต้องกรอกบนหน้าเว็บ (ตั้งเอง) |
| `LARK_APP_TOKEN` | Text | ส่วน `/base/<ตรงนี้>?table=` ของลิงก์ Base |
| `LARK_TABLE_ID` | Text | ส่วน `?table=<ตรงนี้>` ของลิงก์ (Table PR) |
| `ALLOWED_ORIGIN` | Text | `https://<username>.github.io` (ใส่ `*` ระหว่างทดสอบได้) |

4. จด URL ของ Worker เช่น `https://pr-qt-lark.<account>.workers.dev`

### 4. เปิด GitHub Pages

Repo → **Settings → Pages** → Source: **Deploy from a branch** → Branch `main` / `(root)` → Save
รอสักครู่ เว็บจะอยู่ที่ `https://<username>.github.io/<repo>/`

(ถ้าต้องการไม่ให้ผู้ใช้ต้องกรอก Worker URL เอง ใส่ URL ไว้ใน `config.js`)

### 5. ใช้งาน

เปิดเว็บ → **ตั้งค่า** → ใส่ Worker URL และรหัสเข้าใช้งาน → **บันทึกและทดสอบ**
ถ้าขึ้น "เชื่อมต่อสำเร็จ" แสดงว่าพร้อมใช้งาน

## หมายเหตุ

- ค่าใช้จ่าย Claude API คิดตามขนาดเอกสาร ใบ PR + QT ทั่วไปใช้ไม่กี่บาทต่อครั้ง
- `Price` ในตาราง Lark เป็นช่องข้อความ เว็บจะเขียนเป็นตัวเลขมีคอมม่า เช่น `69,978` (เลือกได้ว่ารวม VAT หรือก่อน VAT)
- คอลัมน์ `Text` ถูกล็อกใน Lark เว็บจึงไม่เขียนคอลัมน์นี้
