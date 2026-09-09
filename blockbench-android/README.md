# Blockbench Android Wrapper (Capacitor)

Wrapper ini membungkus **source code Blockbench asli** (bukan versi web
hosted blockbench.net) jadi APK Android, dengan dua hal yang sudah
diatur khusus:

1. **Storage** — export/import file (.bbmodel, texture) lewat Android
   Share Sheet & Storage Access Framework (bukan `<a download>` yang
   sering gagal di WebView).
2. **Plugin offline cache** — plugin yang pernah diakses otomatis
   tersimpan lokal (Cache Storage), jadi tidak perlu re-download tiap
   buka app.

⚠️ **Prasyarat**: semua langkah di bawah ini dijalankan di **PC/laptop**
(Windows/Linux/Mac), BUKAN di HP — sesuai yang sudah kita bahas
sebelumnya, build APK butuh Android Studio + Node.js.

---

## 1. Install prasyarat di PC

- Node.js LTS (v18+): https://nodejs.org
- Android Studio (untuk SDK + build APK): https://developer.android.com/studio
- JDK 17 (biasanya sudah ikut ter-install bareng Android Studio)

---

## 2. Clone source Blockbench asli

Dari folder project ini (`blockbench-android/`), jalankan:

```bash
git clone https://github.com/JannisX11/blockbench.git blockbench-src
```

Ini men-download source code resmi Blockbench (lisensi GPLv3 — baca
catatan lisensi di bagian bawah README ini).

---

## 3. Build versi web Blockbench

```bash
npm run build:blockbench
```

Ini menjalankan `npm install` + `npm run build` di dalam folder
`blockbench-src/`. Hasil build (folder `dist/`) berisi versi web murni
Blockbench (HTML/CSS/JS), tanpa bagian Electron-nya.

> Catatan: kalau nama folder output build Blockbench ternyata bukan
> `dist` (bisa berubah tergantung versi), sesuaikan variabel
> `SRC_DIST` di `scripts/copy-blockbench-dist.js`.

---

## 4. Install dependency wrapper ini

```bash
npm install
```

---

## 5. Salin hasil build ke `www/` + suntik bridge script

```bash
npm run copy:www
```

Script ini otomatis:
- Copy semua file dari `blockbench-src/dist/` ke `www/`
- Copy `bridge/capacitor-bridge.js` ke `www/bridge/`
- Menambahkan `<script src="bridge/capacitor-bridge.js">` ke
  `www/index.html` SEBELUM bundle utama Blockbench, supaya override
  `fetch` dan fungsi storage aktif lebih dulu.

---

## 6. Tambahkan platform Android

```bash
npx cap add android
npx cap sync android
```

---

## 7. Buka & build lewat Android Studio

```bash
npm run open:android
```

Setelah Android Studio terbuka:
- Tunggu Gradle sync selesai.
- Pilih **Build → Build Bundle(s) / APK(s) → Build APK(s)**.
- APK hasil build ada di `android/app/build/outputs/apk/debug/`.

Install APK itu ke HP timmu (perlu aktifkan "Install from unknown
sources" di Android kalau bukan dari Play Store).

---

## 8. (Opsional) Bundling plugin wajib tim secara permanen

Kalau ada plugin yang WAJIB selalu tersedia tanpa perlu internet sama
sekali (bukan cuma cache):

1. Taruh file `.js` plugin di `www/bundled-plugins/`.
2. Edit `bridge/capacitor-bridge.js`, tambahkan path-nya ke array
   `window.BB_BUNDLED_PLUGINS`.
3. Ulangi dari langkah 5 (`npm run copy:www`) supaya perubahan ikut
   ter-copy, lalu `npx cap sync android` lagi.

---

## Catatan Lisensi (PENTING)

Source code Blockbench dilisensikan **GPLv3**. Ini artinya:
- Kamu **boleh** memodifikasi & membungkusnya seperti ini.
- Kalau APK ini didistribusikan ke orang lain (termasuk ke tim
  5-orangmu di luar dirimu sendiri), secara ketentuan GPLv3 kamu
  **wajib menyediakan source code modifikasimu juga** (folder
  `bridge/` ini + perubahan lain yang kamu buat) ke pihak yang
  menerima APK-nya.
- File plugin pihak ketiga yang kamu bundle (langkah 8) tetap ikut
  lisensi masing-masing plugin tersebut — cek dulu sebelum bundle.

Kalau wrapper ini cuma dipakai sendiri (tidak dibagikan ke siapapun),
kewajiban share source tidak berlaku, tapi tetap disarankan simpan
source-nya rapi untuk jaga-jaga.

---

## Troubleshooting umum

| Masalah | Kemungkinan penyebab |
|---|---|
| APK crash saat buka | Cek `webContentsDebuggingEnabled: true` di `capacitor.config.json`, lalu debug lewat `chrome://inspect` di Chrome desktop sambil HP tersambung USB |
| Export file tidak muncul dialog Share | Pastikan plugin `@capacitor/share` & `@capacitor/filesystem` sudah ke-sync (`npx cap sync android`) |
| Plugin tidak ke-load sama sekali | Cek koneksi internet pertama kali (butuh online sekali untuk isi cache), setelah itu baru bisa offline |
| Build Blockbench error | Kemungkinan versi Node.js tidak cocok — cek `package.json` di `blockbench-src/` untuk requirement versi Node yang didukung |
