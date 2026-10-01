/**
 * harden-android-release.js
 * -----------------------------------------------------------------
 * Mematikan WebView remote-debugging untuk build release.
 *
 * `capacitor.config.json` di root repo diset `true` karena itu memang
 * dipakai waktu dev (untuk inspect WebView via chrome://inspect). Capacitor
 *menyalin file itu apa adanya ke
 * `android/app/src/main/assets/capacitor.config.json`, lalu membakarnya jadi
 * `assets/capacitor.config.json` di dalam APK.
 *
 * Artinya: kalau dibiarkan, APK rilis kamu menyalakan debugging WebView —
 * siapa pun yang colok USB ke HP bisa inspecting seluruh isi app tanpa perlu
 * unlock. File config di root repo TIDAK diubah, jadi debug lokal tetap bisa
 * dipakai seperti biasa.
 *
 * Jalankan SESUDAH `npx cap sync android` dan SEBELUM `./gradlew assembleRelease`.
 * -----------------------------------------------------------------
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TARGET = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'capacitor.config.json');

if (!fs.existsSync(TARGET)) {
	console.error(`\n[harden-release] ERROR: ${path.relative(ROOT, TARGET)} tidak ditemukan.`);
	console.error('[harden-release] Jalankan `npx cap sync android` dulu — file ini hasil generate capacitor.');
	process.exit(1);
}

const config = JSON.parse(fs.readFileSync(TARGET, 'utf-8'));

if (!config.android || typeof config.android !== 'object') {
	config.android = {};
}

// Buang opsi yang sudah deprecated (bikin warning tiap sync).
if ('bundledWebRuntime' in config) {
	delete config.bundledWebRuntime;
}

const wasEnabled = config.android.webContentsDebuggingEnabled;
config.android.webContentsDebuggingEnabled = false;

// Tulis dengan format yang stabil supaya diff di dalam APK enak dibaca.
fs.writeFileSync(TARGET, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');

if (wasEnabled) {
	console.log(
		`[harden-release] webContentsDebuggingEnabled: ${wasEnabled} -> false`
		+ ' (WebView debugging dimatikan untuk build ini)'
	);
} else {
	console.log('[harden-release] webContentsDebuggingEnabled sudah false, dilewati (idempotent).');
}
console.log(`[harden-release] ${path.relative(ROOT, TARGET)} sudah diamankan.`);
