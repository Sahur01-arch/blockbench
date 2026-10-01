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

	// Plugin Capacitor di-register oleh native bridge (atau oleh
	// <script src="capacitor.js"> kalau fallback web). Lokasinya beda-beda
	// tergantung versi, jadi ambil dari mana saja yang ada.
	function getPlugin(name) {
		const candidates = [
			window.Capacitor?.Plugins?.[name],
			window.CapacitorPlugins?.[name],
			window[name],
		];
		return candidates.find(Boolean);
	}

	// Pastikan hanya jalan di dalam Capacitor (bukan di browser desktop biasa)
	if (!window.Capacitor) {
		console.warn('[BB-Bridge] Capacitor tidak terdeteksi, bridge tidak diaktifkan.');
		return;
	}

	const Filesystem = getPlugin('Filesystem');
	const Share = getPlugin('Share');
	if (!Filesystem || !Share) {
		console.error(
			'[BB-Bridge] Plugin @capacitor/filesystem / @capacitor/share belum termuat. ' +
			'Jalankan `npx cap sync android` lalu build ulang.'
		);
		return;
	}

	const { Directory, Encoding } = Filesystem;

	// -----------------------------------------------------------------
	// 1. FILE SAVE / EXPORT
	// -----------------------------------------------------------------
	// MASALAH YANG DIPERBAIKI:
	// Blockbench (versi web) export lewat `file-saver`, yang pada akhirnya
	// membuat <a download> lalu dispatchEvent('click'). Di Android WebView
	// tanpa DownloadListener, klik itu DIABAIKAN SENYAP — tidak ada file,
	// tidak ada error, tidak ada notifikasi. Persis gejala "export tidak
	// bekerja dan tidak ada notifikasi".
	//
	// Di sini kita intercept jalur itu: file ditulis ke cache app, lalu
	// Offer Share Sheet (bisa pilih Drive/WhatsApp/dll). Kalau user MEMBATAL
	// Share Sheet, file tetap aman di folder exports/ — jadi tidak hilang.
	//
	// PENTING: fungsi ini di-patch ke `Filesystem.exportFile` oleh
	// `downloadFile()`. Tanpa patch itu, saveAs() tetap jalan dan buta.

	const EXPORT_DIR = 'exports';

	function showNotice(message, isError) {
		// Blockbench punya showQuickMessage, tapi tidak selalu tersedia
		// (mis. saat dipanggil sebelum UI selesai load). Coba pakai itu
		// dulu supaya notifikasi terasa native, jatuh ke console kalau tidak.
		try {
			if (typeof Blockbench !== 'undefined' && Blockbench.showQuickMessage) {
				Blockbench.showQuickMessage(message, isError ? 4000 : 2500);
				return;
			}
		} catch (e) {
			// abaikan, lanjut ke fallback
		}
		(isError ? console.error : console.log)('[BB-Bridge] ' + message);
	}

	// Terjemahkan isi file (string / Blob / ArrayBuffer) menjadi bentuk
	// yang diterima Filesystem.writeFile.
	function toWritablePayload(content) {
		const isText = typeof content === 'string';

		// Encoding UTF8 hanya valid kalau datanya string; untuk data binary
		// kita konversi ke base64 dulu (lihat cabang di bawah).
		if (isText) {
			return { data: content, encoding: Encoding.UTF8 };
		}

		if (content instanceof Blob) {
			// Blob -> base64 (Filesystem tidak menerima Blob langsung
			// di semua versi plugin).
			return content.arrayBuffer().then((buf) => ({
				data: arrayBufferToBase64(buf),
				encoding: Encoding.Base64,
			}));
		}

		if (content instanceof ArrayBuffer) {
			return { data: arrayBufferToBase64(content), encoding: Encoding.Base64 };
		}

		if (ArrayBuffer.isView(content)) {
			return {
				data: arrayBufferToBase64(content.buffer),
				encoding: Encoding.Base64,
			};
		}

		return null;
	}

	function arrayBufferToBase64(buffer) {
		const bytes = new Uint8Array(buffer);
		// Chunking supaya tidak blew stack untuk file besar (mis. texture 4K).
		let binary = '';
		const CHUNK = 0x8000;
		for (let i = 0; i < bytes.length; i += CHUNK) {
			binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
		}
		return btoa(binary);
	}

	async function saveFile(filename, content) {
		try {
			showNotice('Menyimpan ' + filename + '...');

			const payload = await toWritablePayload(content);
			if (!payload) {
				throw new Error('Tipe konten tidak didukung: ' + Object.prototype.toString.call(content));
			}

			const write = await Filesystem.writeFile({
				path: EXPORT_DIR + '/' + filename,
				data: payload.data,
				encoding: payload.encoding,
				directory: Directory.Cache,
				recursive: true,
			});

			// Share Sheet hanya "tawaran". Kalau user batal, file tetap ada.
			try {
				await Share.share({
					title: 'Simpan file Blockbench',
					text: filename,
					url: write.uri,
					dialogTitle: 'Simpan atau bagikan ' + filename,
				});
				showNotice(filename + ' siap disimpan.');
			} catch (shareErr) {
				console.warn('[BB-Bridge] Share Sheet dibatalkan:', shareErr);
				showNotice(filename + ' tersimpan di folder exports/ app.');
			}

			return { success: true, uri: write.uri };
		} catch (err) {
			console.error('[BB-Bridge] Gagal menyimpan file:', err);
			showNotice('Gagal menyimpan ' + filename + '.', true);
			return { success: false, error: err };
		}
	}

	window.BBBridge = {

		// Dipanggil oleh interceptor di file `bb-export-android-patch.js`
		// yang menyuntikkan `custom_writer` ke downloadFile() Blockbench.
		// Signature: (filename, content) => Promise<{success, uri?, error?}>
		// `content` bisa string / Blob / ArrayBuffer / TypedArray.
		saveFile: saveFile,

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
