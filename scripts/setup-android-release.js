/**
 * setup-android-release.js
 * -----------------------------------------------------------------
 * Menyiapkan konfigurasi signing untuk build APK release.
 *
 * Kenapa perlu script ini? Folder `android/` di-ignore oleh .gitignore dan
 * di-regenerate oleh `npx cap add android`, jadi `signingConfigs` TIDAK bisa
 * di-commit ke dalam `android/app/build.gradle`. Script ini dipanggil dari
 * CI (setiap run) untuk:
 *
 *   1. Decode keystore dari base64 (GitHub secret `KEYSTORE_BASE64`)
 *      -> android/app/release.keystore
 *   2. Validate keystore + password via `keytool` (gagal cepat, sebelum
 *      Gradle build yang memakan waktu)
 *   3. Patch `android/app/build.gradle` supaya buildType `release` memakai
 *      signing config tersebut
 *   4. (Opsional) override `versionName` dari argumen `--version-name`
 *
 * Password TIDAK pernah ditulis ke file Gradle — build.gradle membaca lewat
 * `System.getenv()`, jadi kredensial hanya ada di environment runner.
 *
 * Dipanggil dari CI lewat `node scripts/setup-android-release.js`.
 *
 * Env yang dibutuhkan:
 *   KEYSTORE_BASE64   (wajib)  isi file .jks/.keystore dalam base64
 *   KEYSTORE_PASSWORD (wajib)  password store
 *   KEY_ALIAS        (wajib)  alias key di dalam keystore
 *   KEY_PASSWORD     (wajib)  password key
 * Argumen opsional:
 *   --version-name <x>  override versionName di defaultConfig
 *   --version-code <n>  override versionCode di defaultConfig
 * -----------------------------------------------------------------
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const APP_DIR = path.join(ROOT, 'android', 'app');
const BUILD_GRADLE = path.join(APP_DIR, 'build.gradle');
const KEYSTORE_PATH = path.join(APP_DIR, 'release.keystore');

const KEYSTORE_FILENAME = 'release.keystore';
const SIGNING_MARKER = '// >>> ci-release-signing >>>';
const SIGNING_END_MARKER = '// <<< ci-release-signing <<<';

function fail(msg, ...hints) {
	console.error(`\n[setup-release] ERROR: ${msg}`);
	for (const hint of hints) console.error(`  - ${hint}`);
	process.exit(1);
}

// --- 1. Parse argumen ----------------------------------------------------

const args = process.argv.slice(2);

function readArg(flag) {
	const idx = args.indexOf(flag);
	if (idx === -1) return undefined;
	const value = args[idx + 1];
	if (!value || value.startsWith('--')) {
		fail(`Argumen ${flag} butuh nilai, mis: ${flag} 1.0.7`);
	}
	return value;
}

const versionName = readArg('--version-name');
const versionCode = readArg('--version-code');
if (versionCode !== undefined && !/^\d+$/.test(versionCode)) {
	fail(`--version-code harus angka bulat positif, dapat: "${versionCode}"`);
}

// Opt-in: izinkan build tetap jalan walau keystore belum ada. APK ditandatangani
// dengan debug key Gradle, jadi bisa di-install untuk testing, TAPI tidak bisa
// dikirim ke Play Store dan tiap build memakai key yang berbeda.
const allowDebugSigning = args.includes('--allow-debug-signing');

// --- 2. Validasi env -----------------------------------------------------

const required = ['KEYSTORE_BASE64', 'KEYSTORE_PASSWORD', 'KEY_ALIAS', 'KEY_PASSWORD'];
const missing = required.filter((key) => !process.env[key] || !process.env[key].trim());
const useDebugKey = missing.length > 0 && allowDebugSigning;

if (missing.length && !allowDebugSigning) {
	fail(
		`Environment variable belum di-set: ${missing.join(', ')}`,
		'Di GitHub repo Settings > Secrets and variables > Actions, tambahkan:',
		'  KEYSTORE_BASE64   = isi file keystore, di-encode base64 (bukan path file!)',
		'  KEYSTORE_PASSWORD = password dari `keytool -genkeypair`',
		'  KEY_ALIAS        = alias key, mis. "blockbench"',
		'  KEY_PASSWORD     = password key itu',
		'',
		'Cara bikin keystore:',
		'  keytool -genkeypair -v -keystore release.keystore -alias blockbench \\',
		'    -keyalg RSA -keysize 2048 -validity 10000',
		'',
		'Cara encode base64 (Linux/macOS):',
		'  base64 -w0 release.keystore > release.keystore.b64',
		'',
		'Kalau hanya mau APK untuk testing dan belum punya keystore,',
		'jalankan dengan flag --allow-debug-signing.',
		'',
		'Untuk testing di lokal, export manual dulu, mis:',
		'  export KEYSTORE_BASE64="$(base64 -w0 release.keystore)"'
	);
}

if (useDebugKey) {
	console.warn('');
	console.warn('[setup-release] ###########################################################');
	console.warn('[setup-release] MODE DEBUG: keystore tidak dipakai karena secret berikut kosong:');
	for (const key of missing) console.warn(`[setup-release]   - ${key}`);
	console.warn('[setup-release] APK akan ditandatangani dengan debug key Gradle.');
	console.warn('[setup-release] BAWAH INI HANYA UNTUK TESTING:');
	console.warn('[setup-release]   - tidak bisa diunggah ke Play Store');
	console.warn('[setup-release]   - tiap run memakai key yang BERBEDA, jadi update');
	console.warn('[setup-release]     APK lama di HP tidak akan bisa ditimpa');
	console.warn('[setup-release] ###########################################################');
	console.warn('');
}

const {
	KEYSTORE_BASE64: keystoreB64,
	KEYSTORE_PASSWORD: storePassword,
	KEY_ALIAS: keyAlias,
	KEY_PASSWORD: keyPassword,
} = process.env;

if (!fs.existsSync(BUILD_GRADLE)) {
	fail(
		`${BUILD_GRADLE} tidak ditemukan`,
		'Folder `android/` belum ada. Jalankan `npx cap add android` dulu',
		'(di CI ini otomatis dilakukan sebelum script ini dipanggil).'
	);
}

// --- 3. Tulis keystore dari base64 + validasi via keytool -----------------
// Lewati seluruh bagian ini kalau jalan di mode debug.

if (!useDebugKey) {
	// Toleransi whitespace/newline dari `base64 -w0` vs `base64` (macOS, wrapped).
	const normalizedB64 = keystoreB64.replace(/\s+/g, '');
	const keystore = Buffer.from(normalizedB64, 'base64');
	if (keystore.length === 0) {
		fail(
			'KEYSTORE_BASE64 tidak berisi data base64 yang valid',
			'Pastikan formatnya: `base64 -w0 release.keystore` (Linux)',
			'atau `base64 -i release.keystore | tr -d "\\n"` (macOS)'
		);
	}
	// Deteksi magic bytes biar base64 yang salah (mis. teks biasa) ketahuan.
	//   JKS    : FE ED FE ED
	//   PKCS12 : 30 82 (DER)
	const isJks = keystore[0] === 0xfe && keystore[1] === 0xed
		&& keystore[2] === 0xfe && keystore[3] === 0xed;
	const isPkcs12 = keystore[0] === 0x30 && keystore[1] === 0x82;
	if (!isJks && !isPkcs12) {
		console.warn(
			'[setup-release] PERINGATAN: hasil decode tidak punya magic bytes JKS (FEEDFEED)'
		);
		console.warn('[setup-release] atau PKCS12/DER (3082). Pastikan base64 dari file .jks asli, bukan teks.');
	}

	fs.writeFileSync(KEYSTORE_PATH, keystore, { mode: 0o600 });
	console.log(`[setup-release] Keystore ditulis: ${path.relative(ROOT, KEYSTORE_PATH)} (${keystore.length} bytes)`);

	// Validasi keystore via keytool (fail cepat, sebelum Gradle build).
	try {
		const output = execFileSync(
			'keytool',
			[
				'-list',
				'-v',
				'-keystore', KEYSTORE_PATH,
				'-alias', keyAlias,
				'-storepass', storePassword,
				'-keypass', keyPassword,
			],
			{ encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
		);
		const aliasMatch = output.match(/Alias name:\s*(.+)/);
		const createdMatch = output.match(/Created on:\s*(.+)/);
		const validFrom = output.match(/Valid from:\s*(.+)/);
		console.log(
			`[setup-release] keytool OK — alias "${(aliasMatch?.[1] || keyAlias).trim()}"`
			+ `${createdMatch ? `, dibuat ${createdMatch[1].trim()}` : ''}`
			+ `${validFrom ? `, valid ${validFrom[1].trim()}` : ''}`
		);
	} catch (err) {
		const stderr = err.stderr?.toString() || '';
		const stdout = err.stdout?.toString() || '';
		const detail = (stderr || stdout).split('\n').filter(Boolean).slice(0, 6).join('\n  ');
		fail(
			'keytool tidak bisa membuka keystore dengan kredensial tersebut',
			detail || err.message,
			'',
			'Periksa: KEYSTORE_PASSWORD, KEY_ALIAS, dan KEY_PASSWORD sudah saling cocok.',
			'Jalankan manual untuk melihat error lengkap:',
			`  keytool -list -keystore ${path.relative(ROOT, KEYSTORE_PATH)} -alias ${keyAlias}`
		);
	}
}

// --- 4. Patch android/app/build.gradle ------------------------------------

let gradle = fs.readFileSync(BUILD_GRADLE, 'utf-8');
const isAlreadyPatched = gradle.includes(SIGNING_MARKER);

// 4a. signingConfigs block — disisipkan sebelum `buildTypes {`.
//     Di mode debug blok ini dilewati: AGP sudah menyediakan `signingConfigs.debug`
//     secara default, jadi kita cuma butuh menyambungkan buildType release ke sana.
const targetSigningConfig = useDebugKey ? 'signingConfigs.debug' : 'signingConfigs.release';

if (useDebugKey) {
	console.log('[setup-release] Mode debug: blok signingConfigs dilewati, pakai signingConfigs.debug.');
} else {
	const signingBlock = [
		SIGNING_MARKER,
		'    // Ditambahkan oleh scripts/setup-android-release.js (dont edit manual)',
		'    signingConfigs {',
		'        release {',
		`            storeFile file('${KEYSTORE_FILENAME}')`,
		"            storePassword System.getenv('KEYSTORE_PASSWORD')",
		"            keyAlias System.getenv('KEY_ALIAS')",
		"            keyPassword System.getenv('KEY_PASSWORD')",
		'        }',
		'    }',
		SIGNING_END_MARKER,
	].join('\n');

	if (isAlreadyPatched) {
		console.log('[setup-release] signingConfigs sudah ada, dilewati (idempotent).');
	} else {
		if (!/^\s*buildTypes\s*\{/m.test(gradle)) {
			fail(
				'Tidak menemukan blok `buildTypes {` di android/app/build.gradle',
				'Struktur file mungkin berubah. Patch manual signingConfigs + signingConfig.',
				'Atau pakai capacitor.config.json / build.gradle yang sudah di-track repo.'
			);
		}
		gradle = gradle.replace(/^(\s*)buildTypes\s*\{/m, `${signingBlock}\n$1buildTypes {`);
		console.log('[setup-release] Blok signingConfigs disisipkan.');
	}
}

// 4b. wiring signingConfig ke buildType release
//     Penting: targetkan blok `release {` yang ADA DI DALAM `buildTypes {`,
//     bukan `release {` milik signingConfigs yang baru saja disisipkan di 4a.
const buildTypesMatch = /^[ \t]*buildTypes[ \t]*\{/m.exec(gradle);
if (!buildTypesMatch) {
	fail(
		'Tidak menemukan blok `buildTypes {` di android/app/build.gradle',
		`Struktur file mungkin berubah. Patch manual: signingConfig ${targetSigningConfig}`
	);
}
const buildTypesIdx = buildTypesMatch.index;

// Cari `release {` pertama SETELAH buildTypes {
const searchFrom = buildTypesIdx + buildTypesMatch[0].length;
const releaseMatch = /^[ \t]*release[ \t]*\{[ \t]*$/m.exec(gradle.slice(searchFrom));
if (!releaseMatch) {
	fail(
		'Tidak menemukan buildType `release` di dalam `buildTypes {`',
		`Tambahkan manual: signingConfig ${targetSigningConfig}`
	);
}

const releaseBlockStart = searchFrom + releaseMatch.index;
const releaseHeadEnd = releaseBlockStart + releaseMatch[0].length;
const alreadyWired = gradle.slice(releaseHeadEnd, releaseHeadEnd + 400).includes(targetSigningConfig);

if (alreadyWired) {
	console.log('[setup-release] buildType release sudah ter-sign, dilewati (idempotent).');
} else {
	// Sisipkan tepat setelah baris `release {` milik buildTypes
	const indent = releaseMatch[0].match(/^[ \t]*/)[0];
	const wired = `${gradle.slice(0, releaseHeadEnd)}\n${indent}    signingConfig ${targetSigningConfig}${gradle.slice(releaseHeadEnd)}`;
	gradle = wired;
	console.log(`[setup-release] buildType release dikaitkan ke ${targetSigningConfig}.`);
}

// 4c. (opsional) override versionName / versionCode di defaultConfig.
//     Android menolak install APK dengan versionCode <= yang sudah terpasang,
//     jadi versionCode WAJIB naik tiap rilis.
function patchGradleValue(pattern, replacement, label) {
	// PENTING: bedakan "pola tidak cocok" dari "nilai sudah persis yang
	// diminta". Kalau kita cuma membandingkan string sebelum/sesudah,
	// menjalankan ulang dengan nilai yang sama akan dianggap gagal —
	// padahal file-nya sudah benar.
	if (!pattern.test(gradle)) {
		fail(
			`Tidak menemukan baris ${label} untuk di-patch`,
			'Cek blok defaultConfig di android/app/build.gradle'
		);
	}
	gradle = gradle.replace(pattern, replacement);
}

if (versionName) {
	// Izinkan `versionName "x"` dan `versionName = "x"`. Template Capacitor
	// memakai bentuk kedua, jadi pola lama gagal match di sana.
	patchGradleValue(
		/(versionName\s*=?\s*)["'][^"']*["']/,
		`$1"${versionName}"`,
		'versionName'
	);
	console.log(`[setup-release] versionName di-set ke "${versionName}".`);
}

if (versionCode) {
	// Izinkan juga `versionCode = 4` (dengan tanda sama). Template resmi
	// Capacitor pakai bentuk itu, jadi pola lama `versionCode\s+\d+` gagal
	// match kalau kebetulangenerate dengan gaya tersebut.
	patchGradleValue(
		/(versionCode\s*=?\s*)\d+/,
		`$1${versionCode}`,
		'versionCode'
	);
	console.log(`[setup-release] versionCode di-set ke ${versionCode}.`);
}

fs.writeFileSync(BUILD_GRADLE, gradle, 'utf-8');
console.log(`[setup-release] ${path.relative(ROOT, BUILD_GRADLE)} siap dipakai untuk assembleRelease.`);
