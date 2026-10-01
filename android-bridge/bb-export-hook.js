/**
 * bb-export-hook.js
 * -----------------------------------------------------------------
 * Pengait pemicu untuk patch export (lihat bb-export-android-patch.js).
 *
 * MASALAH ORDERING:
 *   Bundle Blockbench dimuat sebagai ES module
 *   (`<script type="module" src="dist/bundle.js">`). Modul ES dieksekusi
 *   SETELAH document selesai di-parse, dan `window.Blockbench` baru terisi
 *   setelah `Object.assign(window, global)` di js/api.ts dievaluasi —
 *   itu ARTAR PALING AKHIR dari modul.
 *
 *   Artinya: script klasik yang disuntik SEBELUM bundle tidak mungkin
 *   men.patch `Blockbench.export` langsung; global-nya belum ada.
 *
 * SOLUSI:
 *   Tunggu dengan polling. Sederhana, tidak perlu memodifikasi bundle,
 *   dan tidak rapuh terhadap perubahan urutan modul di masa depan.
 *
 * Kenapa tidak modifier bundle? Karena satu-satunya titik suntik yang aman
 * adalah `dist/bundle.js` hasil esbuild — file itu di-generate tiap build
 * danäft Hash-nya berubah. Menyuntik ke sana rapuh: regex harus cocok
 * dengan output minifier yang bisa berubah tiap versi esbuild. Polling
 * hanya bergantung pada bentuk API publik yang stabil.
 * -----------------------------------------------------------------
 */

(function () {
	'use strict';

	function attempt() {
		var patch = window.BBExportAndroidPatch;
		if (!patch || typeof patch.install !== 'function') return false;
		return patch.install();
	}

	// Kalau patch sudah memasang polling sendiri, jangan duplikat effort.
	if (window.__bbExportHookInstalled) return;
	window.__bbExportHookInstalled = true;

	var attempts = 0;
	var MAX = 150; // 150 x 100ms = 15 detik, cukup untuk modul 8MB di WebView lambat

	function poll() {
		if (attempt()) {
			console.log('[BB-Export] Patch export terpasang.');
			return;
		}

		if (++attempts < MAX) {
			setTimeout(poll, 100);
		} else {
			var msg =
				'Blockbench.export tidak ditemukan setelah 15 detik. ' +
				'Export akan fallback ke saveAs() yang gagal senyap.';
			console.error('[BB-Export] Patch export GAGAL: ' + msg);
			// Tampilkan di layar supaya user tidak perlu logcat untuk tahu.
			if (window.BBExportAndroidPatch && window.BBExportAndroidPatch.setStatus) {
				window.BBExportAndroidPatch.setStatus('failed', msg);
			}
		}
	}

	poll();
})();