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
const BRIDGE_SRC = path.join(ROOT, 'android-bridge', 'capacitor-bridge.js');
const BRIDGE_DEST = path.join(DEST_WWW, 'bridge', 'capacitor-bridge.js');

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

// 2. Copy bridge script
if (!fs.existsSync(BRIDGE_SRC)) {
	console.error(`[copy-www] Bridge script tidak ditemukan: ${BRIDGE_SRC}`);
	process.exit(1);
}
fs.mkdirSync(path.dirname(BRIDGE_DEST), { recursive: true });
fs.copyFileSync(BRIDGE_SRC, BRIDGE_DEST);
console.log('[copy-www] Bridge script berhasil disalin');

// 3. Suntik <script> tag ke index.html (sebelum bundle utama)
const indexPath = path.join(DEST_WWW, 'index.html');
let html = fs.readFileSync(indexPath, 'utf-8');
const injectTag = '\t<script src="bridge/capacitor-bridge.js"></script>\n';
const bundleTag = '<script type="module" src="dist/bundle.js"></script>';

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
