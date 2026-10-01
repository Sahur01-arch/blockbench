/**
 * copy-blockbench-dist.js
 * -----------------------------------------------------------------
 * Menyiapkan folder `www/` yang dipakai Capacitor sebagai webDir.
 *
 * Repo ini ARE source code Blockbench, jadi bukan clone `blockbench-src`
 * terpisah: seluruh isi repo (kecuali file dev) disalin langsung ke
 * `www/`, termasuk `dist/bundle.js` hasil `npm run build-web`.
 * Setelah itu `bridge/capacitor-bridge.js` disalin dan `<script>`-tag-nya
 * disuntik ke `www/index.html` (harus SEBELUM bundle utama Blockbench
 * supaya override fetch/storage aktif duluan).
 *
 * Jalankan lewat: npm run copy:www
 * -----------------------------------------------------------------
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DEST_WWW = path.join(ROOT, 'www');
// Tiga file bridge yang disuntik ke index.html. Urutan dimsuk di
// BRIDGE_FILES di bawah itu penting, jangan diacak.
const BRIDGE_SRC = path.join(ROOT, 'android-bridge', 'capacitor-bridge.js');
const PATCH_SRC = path.join(ROOT, 'android-bridge', 'bb-export-android-patch.js');
const HOOK_SRC = path.join(ROOT, 'android-bridge', 'bb-export-hook.js');

// Folder/file yang TIDAK perlu ikut ke APK (source Node.js, tooling, dokumen dev)
const EXCLUDE_ROOT = new Set([
	'.git', '.github', '.vscode', '.idea',
	'node_modules', 'www', 'android', 'dist-electron', 'docs',
	'scripts', 'build', 'android-bridge', 'content', 'electron', 'types',
	'package.json', 'package-lock.json', 'tsconfig.json',
	'typedoc.json', 'typedoc.css', 'main.js', '.gitignore',
	'CONTRIBUTING.md', 'ANDROID_WRAPPER.md', 'LICENSE.MD',
	'README.md', 'CODE_OF_CONDUCT.MD', 'CNAME',
	'build.js', 'capacitor.config.json',
]);

// Nama file yang tidak boleh ikut di semua level folder
const EXCLUDE_ANY = new Set([
	'.DS_Store', 'service_worker.js', 'esbuild-metafile.json',
]);

// Pola nama file yang tidak boleh ikut di semua level folder
const EXCLUDE_PATTERNS = [/^workbox-/, /\.js\.map$/];

function copyRecursive(src, dest, isRoot) {
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		if (isRoot && EXCLUDE_ROOT.has(entry.name)) continue;
		if (EXCLUDE_ANY.has(entry.name)) continue;
		if (EXCLUDE_PATTERNS.some(pattern => pattern.test(entry.name))) continue;
		const s = path.join(src, entry.name);
		const d = path.join(dest, entry.name);
		if (entry.isDirectory()) {
			fs.mkdirSync(d, { recursive: true });
			copyRecursive(s, d, false);
		} else if (entry.isFile()) {
			fs.mkdirSync(path.dirname(d), { recursive: true });
			fs.copyFileSync(s, d);
		}
	}
}

// 1. Bersihkan & copy isi repo ke www/
if (!fs.existsSync(path.join(ROOT, 'dist', 'bundle.js'))) {
	console.error('[copy-www] dist/bundle.js tidak ditemukan.');
	console.error('Jalankan `npm run build-web` dulu (atau `npm run build:android`).');
	process.exit(1);
}
fs.rmSync(DEST_WWW, { recursive: true, force: true });
fs.mkdirSync(DEST_WWW, { recursive: true });
copyRecursive(ROOT, DEST_WWW, true);
console.log('[copy-www] Isi repo berhasil disalin ke www/');

// 2. Suntik <script> tag ke index.html (sebelum bundle utama)
//
// Urutan tag PENTING. Ketiganya harus dimuat SEBELUM bundle utama, dan
// dalam urutan ini:
//
//   capacitor-bridge.js  -> membuat window.BBBridge (penyedia saveFile)
//   export-patch.js      -> mendaftarkan installer patch (window.BBExportAndroidPatch)
//   export-hook.js       -> memanggil installer itu lewat polling, karena
//                           window.Blockbench baru ada setelah bundle selesai
//                           dievaluasi (ES module = dieksekusi paling akhir)
//
// Kalau urutan salah atau salah satu hilang, export akan balik ke
// saveAs() -> <a download> -> klik senyap yang diabaikan WebView.
const indexPath = path.join(DEST_WWW, 'index.html');
let html = fs.readFileSync(indexPath, 'utf-8');
const bundleTag = '<script type="module" src="dist/bundle.js"></script>';

const BRIDGE_DEST_DIR = path.join(DEST_WWW, 'bridge');

const BRIDGE_FILES = [
	{ src: BRIDGE_SRC, dest: 'capacitor-bridge.js' },
	{ src: PATCH_SRC, dest: 'export-patch.js' },
	{ src: HOOK_SRC, dest: 'export-hook.js' },
];

fs.mkdirSync(BRIDGE_DEST_DIR, { recursive: true });

for (const file of BRIDGE_FILES) {
	const dest = path.join(BRIDGE_DEST_DIR, file.dest);
	if (!fs.existsSync(file.src)) {
		console.error(`[copy-www] Bridge script tidak ditemukan: ${file.src}`);
		process.exit(1);
	}
	fs.copyFileSync(file.src, dest);
}
console.log(
	`[copy-www] ${BRIDGE_FILES.length} bridge script disalin: ` +
	BRIDGE_FILES.map((f) => f.dest).join(', ')
);

const injectTag = BRIDGE_FILES.map((f) => `\t<script src="bridge/${f.dest}"></script>\n`).join('');

if (!html.includes('capacitor-bridge.js')) {
	if (html.includes(bundleTag)) {
		html = html.replace(bundleTag, injectTag + bundleTag);
	} else {
		html = html.replace('</head>', `${injectTag}</head>`);
	}
	fs.writeFileSync(indexPath, html, 'utf-8');
	console.log('[copy-www] Bridge script berhasil disuntik ke index.html');
} else {
	console.log('[copy-www] Bridge script sudah ada di index.html, dilewati.');
}

console.log('[copy-www] Selesai. Lanjutkan dengan: npx cap sync android');
