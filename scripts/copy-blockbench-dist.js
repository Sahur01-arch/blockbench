/**
 * copy-blockbench-dist.js
 * -----------------------------------------------------------------
 * Menyalin hasil build web Blockbench (dari folder blockbench-src/)
 * ke folder www/ milik project Capacitor ini, lalu menyuntikkan
 * <script> tag untuk capacitor-bridge.js ke index.html hasil build.
 *
 * Jalankan lewat: npm run copy:www
 * (setelah npm run build:blockbench selesai)
 * -----------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const SRC_DIST = path.join(__dirname, '..', 'blockbench-src'); // Blockbench web = seluruh repo, bukan folder dist terpisah
const DEST_WWW = path.join(__dirname, '..', 'www');
const BRIDGE_SRC = path.join(__dirname, '..', 'bridge', 'capacitor-bridge.js');
const BRIDGE_DEST = path.join(DEST_WWW, 'bridge', 'capacitor-bridge.js');

// Folder/file yang TIDAK perlu ikut ke APK (source Node.js, git, dokumen dev)
const EXCLUDE = new Set([
	'node_modules', '.git', '.github', '.vscode',
	'scripts', 'build', // folder script build Electron-nya, bukan aset web
	'package.json', 'package-lock.json', 'webpack.config.js',
	'main.js', // entry point Electron, tidak dipakai di web
	'.gitignore', '.travis.yml', 'CONTRIBUTING.md', 'jsconfig.json',
]);

function copyRecursive(src, dest, isRoot) {
	if (!fs.existsSync(src)) {
		console.error(`[copy-www] Folder sumber tidak ditemukan: ${src}`);
		console.error('Pastikan kamu sudah clone Blockbench ke ./blockbench-src dan menjalankan build-nya dulu.');
		process.exit(1);
	}
	fs.mkdirSync(dest, { recursive: true });
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		if (isRoot && EXCLUDE.has(entry.name)) continue; // filter cuma di level root repo
		const s = path.join(src, entry.name);
		const d = path.join(dest, entry.name);
		if (entry.isDirectory()) {
			copyRecursive(s, d, false);
		} else {
			fs.copyFileSync(s, d);
		}
	}
}

// 1. Bersihkan & copy dist Blockbench ke www/
if (fs.existsSync(DEST_WWW)) {
	fs.rmSync(DEST_WWW, { recursive: true, force: true });
}
copyRecursive(SRC_DIST, DEST_WWW, true);
console.log('[copy-www] Dist Blockbench berhasil disalin ke www/');

// 2. Copy bridge script
fs.mkdirSync(path.dirname(BRIDGE_DEST), { recursive: true });
fs.copyFileSync(BRIDGE_SRC, BRIDGE_DEST);

// 3. Suntik <script> tag ke index.html hasil build
const indexPath = path.join(DEST_WWW, 'index.html');
let html = fs.readFileSync(indexPath, 'utf-8');

const injectTag = '<script src="bridge/capacitor-bridge.js"></script>\n';
if (!html.includes('capacitor-bridge.js')) {
	html = html.replace('</head>', `${injectTag}</head>`);
	fs.writeFileSync(indexPath, html, 'utf-8');
	console.log('[copy-www] Bridge script berhasil disuntik ke index.html');
} else {
	console.log('[copy-www] Bridge script sudah ada di index.html, dilewati.');
}

console.log('[copy-www] Selesai. Lanjutkan dengan: npx cap sync android');
