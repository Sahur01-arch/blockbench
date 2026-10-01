/**
 * bb-export-android-patch.js
 * -----------------------------------------------------------------
 * Memperbaiki export file di Blockbench versi web yang dibungkus Capacitor.
 *
 * MASALAH:
 *   Blockbench web menyimpan file lewat `saveAs()` dari package `file-saver`.
 *   Implementasi browser-nya membuat elemen `<a download>`, lalu
 *   `dispatchEvent(new MouseEvent('click'))`.
 *
 *   Di Android WebView TANPA DownloadListener, klik sintetis itu diabaikan
 *   sepenuhnya: tidak ada file, tidak ada exception, tidak ada notifikasi.
 *   Gejalanya persis "export tidak bekerja sama sekali dan tidak ada notifikasi".
 *   Import tetap jalan karena jalur `<input type=file>` memang didukung WebView.
 *
 * SOLUSI (tanpa mengubah source Blockbench):
 *   Blockbench memetakan `Filesystem.exportFile` ke dua alias global:
 *     Blockbench.export      <- dipakai seluruh source
 *     Blockbench.exportFile  <- alias yang sama
 *   (lihat js/api.ts:383-384). Kita membungkus KEDUA alias itu dengan
 *   `custom_writer` yang memanggil BBBridge.saveFile, sehingga `saveAs()`
 *   tidak pernah dipanggil di environment ini.
 *
 *   `custom_writer` adalah hook resmi Blockbench (branch `if
 *   (options.custom_writer)` di js/file_system.ts), bukan API private.
 *
 * CATATAN PENTING SOAL ORDER:
 *   Bundle adalah ES module (`<script type="module">`), dan `window.Blockbench`
 *   baru terisi setelah `Object.assign(window, global)` di js/api.ts — itu
 *   baris terakhir dari modul. File ini karena itu hanya MENSEJAHKAN installer;
 *   pemanggilannya (polling) dilakukan `bb-export-hook.js`.
 *
 * YANG TIDAK DISENTUH:
 *   - Jalur Electron desktop (`isApp`) — tetap utuh.
 *   - Jalur SAF working folder (native, sudah berfungsi).
 *   - `custom_writer` milik user sendiri.
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

	/**
	 * Bungkus Blockbench.export / Blockbench.exportFile.
	 * Dipanggil oleh hook yang di-suntik ke dalam bundle (setelah
	 * Blockbench global siap).
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

		/**
		 * Bungkus satu fungsi export. PENTING: setiap alias dibungkus dengan
		 * implementasi aslinya sendiri. Kalau kita_wrap satu fungsi lalu
		 * menunjuk kedua alias ke hasil yang sama, memanggil `Blockbench.export`
		 * akan diam-diam menjalankan implementasi `exportFile`.
		 */
		function wrap(fn) {
			return function (options, callback) {
				var bridge = window.BBBridge;

				// Kalau plugin Capacitor somehow belum siap, lebih baik
				// jalankan jalur asli daripada gagal total.
				if (!bridge || typeof bridge.saveFile !== 'function') {
					return fn.apply(this, arguments);
				}

				// Working folder SAF = native, sudah jalan. Jangan ganggu.
				try {
					if (B.SAF && B.SAF.isActive && B.SAF.isActive()) {
						return fn.apply(this, arguments);
					}
				} catch (e) {
					/* abaikan, lanjut ke patched path */
				}

				if (!options || typeof options.custom_writer === 'function') {
					return fn.apply(this, arguments);
				}

				var fileName = options.name || 'export';
				var ext = Array.isArray(options.extensions) ? options.extensions[0] : null;
				if (ext && fileName.indexOf('.' + ext) === -1) {
					fileName += '.' + ext;
				}

				var patched = Object.create(options);
				patched.custom_writer = function (content) {
					return bridge.saveFile(fileName, content);
				};

				return fn.call(this, patched, function (filePath) {
					if (typeof callback === 'function') callback(filePath);
				});
			};
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

		log('export di-patch — file akan ditulis lewat Capacitor Filesystem.');
		setStatus('installed', 'Blockbench.export & .exportFile ter-wrap.');
		return true;
	}

	// Dipanggil oleh bb-export-hook.js (polling, karena `Blockbench`
	// global baru ada setelah modul selesai dievaluasi).
	window.BBExportAndroidPatch = { install: install };

	// -----------------------------------------------------------------
	// DIAGNOSTIK DI DALAM APP
	// -----------------------------------------------------------------
	// masalah sebelumnya (enum Directory/Encoding) hanya bisa dilihat dari
	// logcat, yang tidak selalutersedia. Di sini kita tulis status ke
	// localStorage supaya bisa dibaca dari chrome://inspect, dan tampilkan
	// banner di layar kalau bridge GAGAL aktif — supaya user langsung tahu
	// tanpa perlu logcat sama sekali.
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
			el.onclick = function () { el.remove(); };
		} catch (e) {
			// DOM belum siap / tidak ada; abaikan
		}
	}

	window.BBExportAndroidPatch.setStatus = setStatus;
})();