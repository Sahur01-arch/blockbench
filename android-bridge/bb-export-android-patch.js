/**
 * bb-export-android-patch.js
 * -----------------------------------------------------------------
 * Mengambil alih penyimpanan file di Blockbench versi web yang
 * dibungkus Capacitor (APK Android).
 *
 * -----------------------------------------------------------------
 * MASALAH 1 — `saveAs()` buta di WebView
 *   Blockbench web menyimpan file lewat `saveAs()` (package `file-saver`).
 *   Implementasi browser-nya membuat `<a download>` lalu
 *   `dispatchEvent(new MouseEvent('click'))`. Di Android WebView TANPA
 *   DownloadListener, klik sintetis itu diabaikan sepenuhnya: tidak ada
 *   file, tidak ada exception, tidak ada notifikasi.
 *
 * MASALAH 2 — jalur SAF membajak export  (INI PENYEBAB UTAMA)
 *   `Filesystem.exportFile` (js/file_system.ts:447) bercabang seperti ini:
 *
 *       if (usesWorkingFolder()) return writeToWorkingFolder(...)
 *       downloadFile(...)
 *
 *   `usesWorkingFolder()` = `!isApp && SAF.isSupported() && !saf_fallback`
 *   dan `SAF.isSupported()` (js/util/saf.ts:119) hanya mengecek:
 *
 *       typeof window.showDirectoryPicker == 'function'
 *
 *   WebView Chromium modern MEMANG punya `showDirectoryPicker`, jadi
 *   `isSupported()` mengembalikan TRUE di Android. Akibatnya setiap export
 *   masuk `writeToWorkingFolder()`, yang menampilkan dialog
 *   "choose folder / download instead" lalu BERHENTI — `downloadFile()`
 *   (dan `custom_writer` di dalamnya) tidak pernah dipanggil.
 *
 *   Di WebView `showDirectoryPicker` memang tidak benar-benar bisa
 *   menulis file, jadi kedua pilihan dialog itu sama-sama gagal. Gejalanya:
 *   dialog muncul, lalu tidak terjadi apa-apa.
 *
 *   Versi patch sebelumnya menyuntik `custom_writer` lalu meneruskan ke
 *   `exportFile` — jadi tidak pernah sampai ke `downloadFile()`. Itu sebabnya
 *   patch "terpasang" (banner hijau) tapi export tetap tidak berfungsi.
 *
 * SOLUSI
 *   Di environment Capacitor, JANGAN pernah meneruskan export ke
 *   `exportFile` asli. Patch ini menghitung nama file persis seperti
 *   `exportFile` hacerlo, lalu langsung menulis lewat Capacitor Filesystem
 *   dan membuka Share Sheet.
 *
 *   working folder SAF yang benar-benar AKTIF (user sudah memilih folder
 *   dan izinnya diberikan) tetap dikCOSONGKAN — di situ Capacitor Filesystem
 *   memang tidak bisa menulis, jadi harus pakai File System Access API.
 *
 * CATATAN SOAL ORDER
 *   Bundle adalah ES module (`<script type="module">`), dan `window.Blockbench`
 *   baru terisi setelah `Object.assign(window, global)` di js/api.ts — baris
 *   terakhir modul. File ini hanya MENYEDIAKAN installer; pemanggilannya
 *   (polling) dilakukan `bb-export-hook.js`.
 *
 * YANG TIDAK DISENTUH
 *   - Jalur Electron desktop (`isApp`) — bundle ini tidak jalan di sana.
 *   - Import / baca file.
 *   - Working folder SAF yang benar-benar aktif.
 * -----------------------------------------------------------------
 */

(function () {
	'use strict';

	if (!window.Capacitor) {
		return; // Browser biasa: tidak perlu apa-apa.
	}

	function log(...args) {
		console.log('[BB-Export]', ...args);
	}

	// -----------------------------------------------------------------
	// Penetakan nama file
	// -----------------------------------------------------------------
	// Salinan PERSIS dari `pathToExtension` (js/util/util.js:450) supaya
	// nama file yang kita hasilkan sama dengan yang akan dibuat Blockbench.
	// Kalau berbeda, user akan melihat file dengan ekstensi ganda.
	function pathExtension(path) {
		if (typeof path !== 'string') return '';
		var matches = path.match(/\.\w{2,24}$/);
		if (!matches || !matches.length) return '';
		return matches[0].replace('.', '').toLowerCase();
	}

	// Salinan dari blok pembentuk nama file di `exportFile`
	// (js/file_system.ts:450-456).
	function exportFileName(options) {
		var fileName = options.name || 'file';
		var extension = pathExtension(fileName);
		// Pakai Array.isArray, bukan `instanceof Array` seperti di
		// exportFile: `instanceof` gagal kalau objek datang dari realm lain
		// (mis. iframe/worker), sedangkan isArray selalu benar.
		if (
			Array.isArray(options.extensions) &&
			!options.extensions.includes(extension) &&
			options.extensions[0]
		) {
			fileName += '.' + options.extensions[0];
		}
		return fileName;
	}

	// Working folder SAF yang benar-benar aktif. Kuncinya `workingFolder`
	// (js/api.ts:390), bukan `SAF` — nama itu tidak pernah ada di global.
	function isSafWorkingFolderActive() {
		try {
			var wf = window.Blockbench && window.Blockbench.workingFolder;
			return !!(wf && typeof wf.active === 'function' && wf.active());
		} catch (e) {
			return false;
		}
	}

	/**
	 * Bungkus satu fungsi export.
	 *
	 * PENTING: setiap alias dibungkus dengan implementasi aslinya sendiri.
	 * Kalau kita_wrap satu fungsi lalu menunjuk kedua alias ke hasil yang
	 * sama, memanggil `Blockbench.export` akan diam-diam menjalankan
	 * implementasi `exportFile`.
	 */
	function wrap(fn) {
		return function (options, callback) {
			var bridge = window.BBBridge;

			// Plugin Capacitor belum siap — lebih baik pakai jalur asli
			// daripada gagal total.
			if (!bridge || typeof bridge.saveFile !== 'function') {
				return fn.apply(this, arguments);
			}

			// Working folder SAF benar-benar aktif: di situ Capacitor
			// Filesystem tidak bisa menulis, jadi serahkan ke aslinya.
			if (isSafWorkingFolderActive()) {
				return fn.apply(this, arguments);
			}

			if (!options || typeof options !== 'object') {
				return fn.apply(this, arguments);
			}

			var fileName = exportFileName(options);
			var done = typeof callback === 'function' ? callback : function () {};

			// `custom_writer` milik caller: JANGAN timpa, tapi jangan juga
			// serahkan ke `exportFile` (itu akan memunculkan dialog SAF).
			// Kita panggil langsung dengan kontrak yang sama dengan
			// `writeToWorkingFolder`: (content, file_path, callback).
			if (typeof options.custom_writer === 'function') {
				try {
					return options.custom_writer(options.content, fileName, done);
				} catch (e) {
					console.error('[BB-Export] custom_writer gagal:', e);
					setStatus('failed', 'custom_writer gagal: ' + (e && e.message));
					return undefined;
				}
			}

			// Jalur utama: tulis sendiri lewat Capacitor, tanpa pernah
			// menyentuh `exportFile` (dan tanpa dialog SAF).
			// Savetype wajib diteruskan: tanpa itu file biner (PNG/zip)
			// akan ditulis sebagai teks dan jadi rusak.
			return Promise.resolve(
				bridge.saveFile(fileName, options.content, options.savetype)
			).then(
				function (result) {
					if (result && result.success === false) {
						// saveFile sudah memberi tahu user lewat quick message.
						return result;
					}
					// Callback dengan URI cache, sama seperti yang diharapkan
					// `afterDownload(path)` (hanya dipakai untuk pesan konfirmasi).
					done((result && result.uri) || fileName);
					return result;
				}
			);
		};
	}

	/**
	 * Pasang patch. Dipanggil oleh bb-export-hook.js lewat polling.
	 */
	function install() {
		var B = window.Blockbench;
		if (!B) return false;

		if (B.__bbExportPatched) {
			return true;
		}

		var originalExportFile = B.exportFile;
		var originalExport = B.export;

		if (typeof originalExportFile !== 'function' && typeof originalExport !== 'function') {
			return false;
		}

		if (typeof originalExportFile === 'function') {
			B.exportFile = wrap(originalExportFile);
			B.exportFile.__bbExportPatched = true;
		}

		if (typeof originalExport === 'function') {
			B.export = wrap(originalExport);
			B.export.__bbExportPatched = true;
		}

		B.__bbExportPatched = true;

		log('export di-takeover — file ditulis lewat Capacitor Filesystem (tanpa dialog SAF).');
		setStatus('installed', 'Blockbench.export & .exportFile di-takeover.');
		return true;
	}

	// Dipanggil oleh bb-export-hook.js (polling, karena `Blockbench`
	// global baru ada setelah modul selesai dievaluasi).
	window.BBExportAndroidPatch = { install: install };

	// -----------------------------------------------------------------
	// DIAGNOSTIK DI DALAM APP
	// -----------------------------------------------------------------
	// Masalah-masalah sebelumnya hanya terlihat dari logcat, yang tidak
	// selalu tersedia. Di sini status ditulis ke localStorage (bisa dibaca
	// dari chrome://inspect) dan ditampilkan sebagai banner di layar,
	// supaya user langsung tahu tanpa perlu logcat sama sekali.
	var STATUS_KEY = 'bb-export-status';

	function setStatus(state, detail) {
		try {
			localStorage.setItem(
				STATUS_KEY,
				JSON.stringify({
					state: state,
					detail: detail || '',
					time: new Date().toISOString(),
				})
			);
		} catch (e) {
			// storage bisa diblokir; tidak fatal
		}

		if (state === 'failed' || state === 'installed') {
			showBanner(state, detail);
		}
	}

	var BANNER_ID = 'bb-export-banner';

	function showBanner(state, detail) {
		try {
			if (!document.body) return;

			var el = document.getElementById(BANNER_ID);
			if (!el) {
				el = document.createElement('div');
				el.id = BANNER_ID;
				el.style.cssText = [
					'position:fixed', 'bottom:0', 'left:0', 'right:0', 'z-index:2147483647',
					'font:12px/1.4 monospace', 'padding:8px', 'white-space:pre-wrap',
					'background:#b00020', 'color:#fff', 'border-top:2px solid #ff5252',
				].join(';');
				document.body.appendChild(el);
			}
			el.style.background = state === 'installed' ? '#1b5e20' : '#b00020';
			el.textContent =
				(state === 'installed' ? 'BB-Export: aktif\n' : 'BB-Export: GAGAL\n') +
				(detail || '') +
				'\n(klik untuk tutup)';
			el.onclick = function () {
				el.remove();
			};
		} catch (e) {
			// DOM belum siap / tidak ada; abaikan
		}
	}

	window.BBExportAndroidPatch.setStatus = setStatus;
})();
