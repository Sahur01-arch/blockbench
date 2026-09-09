/**
 * capacitor-bridge.js
 * -----------------------------------------------------------------
 * Jembatan antara source code Blockbench (versi web, bukan Electron)
 * dengan Capacitor, supaya jalan sebagai APK Android dengan:
 *   1. Akses simpan/buka file lewat Storage Access Framework (SAF),
 *      bukan lewat <input type=file> browser biasa yang terbatas.
 *   2. Plugin Blockbench di-cache secara lokal (offline-first) supaya
 *      tidak perlu fetch ulang dari internet tiap kali app dibuka.
 *
 * Cara pakai:
 *   Include file ini di index.html Blockbench SEBELUM script utama
 *   Blockbench (main bundle-nya), contoh:
 *     <script src="bridge/capacitor-bridge.js"></script>
 *     <script src="obfuscated.js"></script>  <-- bundle asli Blockbench
 * -----------------------------------------------------------------
 */

(function () {
	'use strict';

	// Pastikan hanya jalan di dalam Capacitor (bukan di browser desktop biasa)
	if (!window.Capacitor) {
		console.warn('[BB-Bridge] Capacitor tidak terdeteksi, bridge tidak diaktifkan.');
		return;
	}

	const { Filesystem, Directory, Encoding } = CapacitorFilesystem;
	const { Share } = CapacitorShare;

	// -----------------------------------------------------------------
	// 1. FILE SAVE / EXPORT
	// -----------------------------------------------------------------
	// Blockbench versi web normalnya export lewat trik <a download>,
	// yang di WebView Android sering gagal / tidak muncul dialog simpan.
	// Kita override supaya file ditulis dulu ke storage lokal app,
	// lalu tawarkan opsi "Share" (user bisa pilih simpan ke Drive,
	// kirim ke WhatsApp, dsb) via Android Share Sheet resmi.

	window.BBBridge = {

		async saveFile(filename, dataString, mimeType) {
			try {
				const write = await Filesystem.writeFile({
					path: filename,
					data: dataString,
					directory: Directory.Cache,
					encoding: mimeType.startsWith('text') ? Encoding.UTF8 : undefined,
				});

				await Share.share({
					title: 'Simpan file Blockbench',
					text: `File hasil export: ${filename}`,
					url: write.uri,
					dialogTitle: 'Simpan atau bagikan file',
				});

				return { success: true, uri: write.uri };
			} catch (err) {
				console.error('[BB-Bridge] Gagal menyimpan file:', err);
				return { success: false, error: err };
			}
		},

		// -----------------------------------------------------------------
		// 2. FILE OPEN / IMPORT
		// -----------------------------------------------------------------
		// Untuk import (buka .bbmodel / texture), kita tetap pakai
		// <input type=file> bawaan (ini sudah didukung baik oleh WebView
		// modern + SAF picker Android), tapi kita baca hasilnya lewat
		// FileReader lalu suntik ke fungsi import internal Blockbench.

		async readFileAsDataURL(file) {
			return new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(reader.result);
				reader.onerror = reject;
				reader.readAsDataURL(file);
			});
		},

		// -----------------------------------------------------------------
		// 3. PROJECT AUTOSAVE ke storage privat app (opsional tapi disarankan)
		// -----------------------------------------------------------------
		// Supaya kalau app ke-close tiba-tiba, progress model tidak hilang.

		async autosaveProject(jsonString) {
			try {
				await Filesystem.writeFile({
					path: 'autosave/last_project.bbmodel',
					data: jsonString,
					directory: Directory.Data,
					recursive: true,
				});
			} catch (err) {
				console.warn('[BB-Bridge] Autosave gagal:', err);
			}
		},

		async loadAutosave() {
			try {
				const result = await Filesystem.readFile({
					path: 'autosave/last_project.bbmodel',
					directory: Directory.Data,
				});
				return result.data;
			} catch (err) {
				return null; // belum ada autosave sebelumnya
			}
		},
	};

	// -----------------------------------------------------------------
	// 4. PLUGIN OFFLINE CACHE
	// -----------------------------------------------------------------
	// Blockbench fetch daftar plugin + file .js plugin dari
	// blockbench.net/plugins tiap kali menu Plugins dibuka.
	// Kita intercept fetch ke domain itu, pakai strategi
	// "cache-first, fallback ke network" supaya tim tetap bisa akses
	// plugin yang PERNAH didownload walau sedang offline.

	const PLUGIN_CACHE_NAME = 'blockbench-plugins-v1';
	const originalFetch = window.fetch;

	window.fetch = async function (input, init) {
		const url = typeof input === 'string' ? input : input.url;

		const isPluginRequest =
			url.includes('blockbench.net/plugins') ||
			url.includes('raw.githubusercontent.com/JannisX11/blockbench-plugins');

		if (!isPluginRequest) {
			return originalFetch(input, init);
		}

		const cache = await caches.open(PLUGIN_CACHE_NAME);
		const cached = await cache.match(url);

		if (cached) {
			console.log('[BB-Bridge] Plugin dimuat dari cache lokal:', url);
			// Tetap coba update cache di background kalau online (stale-while-revalidate)
			originalFetch(input, init)
				.then((res) => { if (res.ok) cache.put(url, res.clone()); })
				.catch(() => {});
			return cached;
		}

		try {
			const response = await originalFetch(input, init);
			if (response.ok) {
				cache.put(url, response.clone());
			}
			return response;
		} catch (err) {
			console.error('[BB-Bridge] Plugin tidak ada di cache & device offline:', url);
			throw err;
		}
	};

	// -----------------------------------------------------------------
	// 5. PRE-BUNDLE PLUGIN TIM (opsional)
	// -----------------------------------------------------------------
	// Kalau kamu mau plugin tertentu SELALU tersedia tanpa perlu
	// pernah online sama sekali (misal plugin wajib tim), taruh file
	// .js plugin-nya di folder www/bundled-plugins/, lalu daftarkan
	// di sini supaya otomatis ter-load saat app start.

	window.BB_BUNDLED_PLUGINS = [
		// contoh: 'bundled-plugins/boxuv_cube_flagger.js',
	];

	document.addEventListener('DOMContentLoaded', () => {
		window.BB_BUNDLED_PLUGINS.forEach((path) => {
			const script = document.createElement('script');
			script.src = path;
			document.body.appendChild(script);
		});
	});

	console.log('[BB-Bridge] Capacitor bridge aktif — storage & plugin cache siap.');
})();
