/**
 * test-export-patch.js
 * -----------------------------------------------------------------
 * Harness test untuk patch export, jalan di Node (tanpa device).
 *
 * Yang diuji:
 *   1. Patch meng-wrap Blockbench.export DAN .exportFile.
 *   2. custom_writer disuntikkan, jadi saveAs() tidak pernah dipanggil.
 *   3. Nama file mendapat ekstensi dari ExportOptions.
 *   4. Jalur SAF working-folder tidak ditimpa (sudah native & jalan).
 *   5. custom_writer milik caller sendiri tidak ditimpa.
 *   6. saveFile: string / Blob / ArrayBuffer / TypedArray semua benar.
 *   7. Share Sheet dibatalkan -> file tetap ada di cache (tidak hilang).
 *   8. Error saat tulis -> dilaporkan, tidak throw ke caller.
 *
 * Jalankan: node scripts/test-export-patch.js
 * -----------------------------------------------------------------
 */

import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = path.join(__dirname, '..');
const PATCH = path.join(ROOT, 'android-bridge', 'bb-export-android-patch.js');
const BRIDGE = path.join(ROOT, 'android-bridge', 'capacitor-bridge.js');

let passed = 0;
let failed = 0;

function check(name, cond, extra) {
	if (cond) {
		passed++;
		console.log(`  ok   ${name}`);
	} else {
		failed++;
		console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`);
	}
}

/** Fake Blob yang punya arrayBuffer() seperti browser. */
class FakeBlob {
	constructor(parts, opts) {
		this.type = (opts && opts.type) || '';
		this._buf = Buffer.concat(
			parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(String(p), 'utf-8')))
		);
	}
	async arrayBuffer() {
		return this._buf.buffer.slice(
			this._buf.byteOffset,
			this._buf.byteOffset + this._buf.byteLength
		);
	}
}

/**
 * Bangun lingkungan fake: WebView + Capacitor + Blockbench.
 * `storage` dan `shareCalls` dipakai untuk asserting.
 */
function makeEnv(opts = {}) {
	const storage = new Map();
	const shareCalls = [];
	const notices = [];
	const calls = { export: [], exportFile: [] };
	const bridgeCalls = [];

	const sandbox = {
		console: { log() {}, warn() {}, error() {}, warnOnce() {} },
		document: { addEventListener() {} },
		navigator: { userAgent: 'fake' },
		Blob: FakeBlob,
		ArrayBuffer,
		Uint8Array,
		Uint16Array,
		MouseEvent: class {},
		CustomEvent: class {},
		btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
		setTimeout: () => 0,
		clearTimeout: () => {},
		caches: { open: async () => ({ match: async () => undefined, put: async () => {} }) },
		// Fetch minimal: cukup untuk mendecode data: URL jadi Blob (dipakai
		// bridge saat menulis file biner) dan untuk intercept plugin cache.
		fetch: async (url) => {
			if (typeof url === 'string' && url.startsWith('data:')) {
				const b64 = url.slice(url.indexOf(',') + 1);
				const buf = Buffer.from(b64, 'base64');
				const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
				return { ok: true, clone() { return this; }, blob: async () => new FakeBlob([buf]) , arrayBuffer: async () => ab };
			}
			return { ok: true, clone() { return this; } };
		},
	};

	sandbox.window = sandbox;
	sandbox.globalThis = sandbox;
	sandbox.self = sandbox;

	sandbox.Capacitor = { Plugins: {} };
	// PENTING: tirukan shape ASLI runtime Capacitor 6 (JSExport.getPluginJS).
	// Plugin hanya berisi fungsi — TIDAK ada enum Directory/Encoding. Kalau
	// test ini menaruh enum di atas, dia akan menutupi bug yang sebenarnya.
	sandbox.CapacitorPlugins = {
		Filesystem: {
			writeFile: async ({ path, data, encoding }) => {
				if (opts.failWrite) throw new Error('disk full');
				// Direktori diterima sebagai string biasa oleh native bridge.
				if (typeof path !== 'string') throw new Error('path harus string');
				// Tirukan FilesystemPlugin.java: encoding WAJIB salah satu dari
				// utf8 | utf16 | ascii, atau undefined untuk mode base64.
				if (encoding != null && !['utf8', 'utf16', 'ascii'].includes(encoding)) {
					throw new Error('Unsupported encoding provided: ' + encoding);
				}
				if (encoding === undefined && typeof data !== 'string') {
					throw new Error('mode base64 butuh data string');
				}
				storage.set(path, { data, encoding: encoding === undefined ? 'BASE64_NATIVE' : encoding });
				return { uri: 'file:///data/user/0/app/cache/' + path };
			},
		},
		Share: {
			share: async (o) => {
				if (opts.failShare) throw new Error('Share cancelled by user');
				shareCalls.push(o);
				return { activityType: 'SEND' };
			},
		},
	};

	// Blockbench fake. exportFile + export adalah dua fungsi terpisah supaya
	// test bisa memastikan KEDUA alias ikut ter-wrap.
	//
	// `exportFile` asli Blockbench (js/file_system.ts:447) bercabang:
	//   if (usesWorkingFolder()) return writeToWorkingFolder(...)   <- dialog SAF
	//   downloadFile(...)                                          <- custom_writer
	// `usesWorkingFolder()` = !isApp && SAF.isSupported() && !saf_fallback
	//
	// Di WebView Android, `showDirectoryPicker` ADA, jadi isSupported() true
	// dan semua export terjebak di dialog "choose folder / download instead".
	// Test fake ini meniru perilaku itu supaya regresi bisa terdeteksi.
	function makeExport(key) {
		return function (options, callback) {
			calls[key].push(options);
			calls[key + '_calledOriginal'] = (calls[key + '_calledOriginal'] || 0) + 1;

			if (opts.safSupported !== false) {
				calls[key + '_usedSafDialog'] = (calls[key + '_usedSafDialog'] || 0) + 1;
				// writeToWorkingFolder: tampilkan dialog, lalu BERHENTI.
				// custom_writer TIDAK dipanggil — persis gejala yang dilaporkan.
				return { viaSafDialog: true };
			}

			if (typeof options.custom_writer === 'function') {
				const written = options.custom_writer(options.content, options.name);
				if (typeof callback === 'function') callback(options.name);
				return written;
			}
			// Tidak ada writer -> saveAs -> <a download> -> gagal senyap.
			calls[key + '_usedSaveAs'] = (calls[key + '_usedSaveAs'] || 0) + 1;
			return { viaSaveAs: true };
		};
	}

	sandbox.Blockbench = {
		export: makeExport('export'),
		exportFile: makeExport('exportFile'),
		// Kunci global yang BENAR-BENAR ada di js/api.ts:390 adalah
		// `workingFolder`, bukan `SAF`. Versi patch lama mengecek `B.SAF`
		// yang tidak pernah ada, jadi guard-nya jadi kode mati.
		workingFolder: {
			supported: () => opts.safSupported !== false,
			active: () => opts.safActive === true,
		},
		Project: { export_path: opts.safActive ? '/models/x' : '' },
		showQuickMessage: (m) => notices.push(m),
	};

	return { sandbox, storage, shareCalls, notices, calls, bridgeCalls };
}

function run(sandbox, file) {
	const code = fs.readFileSync(file, 'utf-8');
	vm.runInContext(code, vm.createContext(sandbox), { filename: file });
}

/**
 * Pasang spy di BBBridge.saveFile. Dipakai untuk membuktikan patch benar-benar
 * menulis lewat Capacitor — bukan sekadar "tidak error".
 * Tidak menimpa saveFile asli, jadi bridge asli tetap ikut teruji.
 */
function spyOnBridge(sandbox, bridgeCalls) {
	const original = sandbox.BBBridge.saveFile;
	sandbox.BBBridge.saveFile = function (filename, content, savetype) {
		bridgeCalls.push({ filename, content, savetype });
		return original.call(this, filename, content, savetype);
	};
}

// ==================================================================
console.log('\n=== 1. patch meng-wrap kedua alias ===');
{
	const { sandbox, calls, bridgeCalls } = makeEnv();
	run(sandbox, BRIDGE); // BBBridge harus ada, kalau tidak patch sengaja fallback
	run(sandbox, PATCH);
	spyOnBridge(sandbox, bridgeCalls);
	const ok = sandbox.BBExportAndroidPatch.install();

	check('install() mengembalikan true', ok === true);
	check('Blockbench.export ter-wrap', sandbox.Blockbench.export.__bbExportPatched === true);
	check('Blockbench.exportFile ter-wrap', sandbox.Blockbench.exportFile.__bbExportPatched === true);
	check('flag global terpasang', sandbox.Blockbench.__bbExportPatched === true);

	// Idempoten: pasang dua kali tidak boleh bungkus dua kali.
	sandbox.BBExportAndroidPatch.install();
	check('idempoten (tidak bungkus ulang)', sandbox.Blockbench.export.__bbExportPatched === true);

	sandbox.Blockbench.export({ name: 'model', type: 'Bedrock', extensions: ['bbmodel'], content: '{"x":1}' });
	check('bridge.saveFile dipanggil 1x', bridgeCalls.length === 1, bridgeCalls.length);
	check('nama file benar', bridgeCalls[0].filename === 'model.bbmodel', bridgeCalls[0].filename);
	check('content diteruskan utuh', bridgeCalls[0].content === '{"x":1}');
	check('exportFile asli TIDAK dipanggil', !calls.export_calledOriginal);
}

console.log('\n=== 2. alias exportFile juga di-takeover ===');
{
	const { sandbox, calls, bridgeCalls } = makeEnv();
	run(sandbox, BRIDGE);
	run(sandbox, PATCH);
	spyOnBridge(sandbox, bridgeCalls);
	sandbox.BBExportAndroidPatch.install();

	sandbox.Blockbench.exportFile({ name: 'tex', type: 'PNG', extensions: ['png'], content: 'data' });
	check('bridge.saveFile dipanggil 1x', bridgeCalls.length === 1);
	check('ekstensi .png ditambahkan', bridgeCalls[0].filename === 'tex.png', bridgeCalls[0].filename);
	check('exportFile asli TIDAK dipanggil', !calls.exportFile_calledOriginal);
}

console.log('\n=== 3. REGRESI: dialog SAF tidak pernah muncul ===');
{
	// Bug yang dilaporkan user: Android WebView punya showDirectoryPicker,
	// jadi SAF.isSupported() true dan exportAs melompat ke writeToWorkingFolder
	// -> dialog "choose folder / download instead" -> tidak terjadi apa-apa.
	// Default fakeEnv meniru kondisi WebView itu (safSupported !== false).
	const { sandbox, calls, bridgeCalls } = makeEnv();
	run(sandbox, BRIDGE);
	run(sandbox, PATCH);
	spyOnBridge(sandbox, bridgeCalls);
	sandbox.BBExportAndroidPatch.install();

	sandbox.Blockbench.export({ name: 'm', extensions: ['bbmodel'], content: '{}' });

	check('SAF dianggap supported di fake (kondisi WebView)', sandbox.Blockbench.workingFolder.supported() === true);
	check('tidak masuk jalur dialog SAF', !calls.export_usedSafDialog, calls.export_usedSafDialog);
	check('exportFile asli tidak dipanggil', !calls.export_calledOriginal);
	check('file tetap ditulis via bridge', bridgeCalls.length === 1);
}

console.log('\n=== 4. callback dipanggil dengan uri hasil ===');
{
	const { sandbox } = makeEnv();
	run(sandbox, BRIDGE);
	run(sandbox, PATCH);
	sandbox.BBExportAndroidPatch.install();

	let got = null;
	await sandbox.Blockbench.export({ name: 'm', extensions: ['bbmodel'], content: '{}' }, (p) => {
		got = p;
	});
	// afterDownload() hanya memakai pathToName(path) untuk pesan konfirmasi,
	// jadi uri cache sudah cukup — yang penting bukan undefined.
	check('callback dipanggil', got !== null && got !== undefined, got);
	check('callback berisi nama file', /m\.bbmodel/.test(got), got);
}

console.log('\n=== 5. working folder SAF AKTIF -> serahkan ke aslinya ===');
{
	// Kalau user benar-benar sudah memilih folder SAF dan izinnya ada,
	// Capacitor Filesystem tidak bisa menulis di sana, jadi patch harus
	// mundur dan membiarkan File System Access API yang menangani.
	const { sandbox, calls, bridgeCalls } = makeEnv({ safActive: true });
	run(sandbox, BRIDGE);
	run(sandbox, PATCH);
	spyOnBridge(sandbox, bridgeCalls);
	sandbox.BBExportAndroidPatch.install();

	sandbox.Blockbench.export({ name: 'm', extensions: ['bbmodel'], content: '{}' });
	check('bridge tidak dipakai', bridgeCalls.length === 0, bridgeCalls.length);
	check('jalur asli (SAF) yang menangani', calls.export_calledOriginal === 1);
}

console.log('\n=== 6. custom_writer caller dipanggil, bukan ditimpa ===');
{
	// Codec seperti obj/gltf/collada mengirim custom_writer untuk menulis ke
	// project scope. Patch harus memanggilnya dengan kontrak yang sama dengan
	// writeToWorkingFolder: (content, file_path, callback).
	const { sandbox, bridgeCalls } = makeEnv();
	run(sandbox, BRIDGE);
	run(sandbox, PATCH);
	spyOnBridge(sandbox, bridgeCalls);
	sandbox.BBExportAndroidPatch.install();

	let writerArgs = null;
	let writerCallbackFired = false;
	await sandbox.Blockbench.export(
		{
			name: 'm',
			extensions: ['bbmodel'],
			content: '{"a":1}',
			custom_writer: function (content, filePath, callback) {
				writerArgs = { content, filePath };
				if (typeof callback === 'function') {
					callback(filePath);
					writerCallbackFired = true;
				}
			},
		},
		() => {}
	);

	check('custom_writer caller dipanggil', !!writerArgs);
	check('content diteruskan ke writer', writerArgs && writerArgs.content === '{"a":1}');
	check('file_path sudah termasuk ekstensi', writerArgs && writerArgs.filePath === 'm.bbmodel', writerArgs && writerArgs.filePath);
	check('writer boleh memanggil callback', writerCallbackFired);
	check('bridge.saveFile TIDAK ikut dipanggil', bridgeCalls.length === 0, bridgeCalls.length);
}

console.log('\n=== 7. bridge: nama file dapat ekstensi ===');
{
	const { sandbox, storage } = makeEnv();
	run(sandbox, BRIDGE);
	run(sandbox, PATCH);
	sandbox.BBExportAndroidPatch.install();

	await sandbox.Blockbench.export({
		name: 'my_model',
		type: 'Bedrock',
		extensions: ['geo.json'],
		content: '{}',
	});

	const keys = [...storage.keys()];
	check('file tersimpan di exports/', keys.length === 1 && keys[0] === 'exports/my_model.geo.json', keys);
}

console.log('\n=== 7b. nama file: ekstensi sudah ada tidak digandakan ===');
{
	// exportFile hanya menambahkan ekstensi kalau belum ada (lihat
	// `!options.extensions.includes(extension)`). Kalau tidak, user akan
	// melihat "model.json.json".
	const { sandbox, bridgeCalls } = makeEnv();
	run(sandbox, BRIDGE);
	run(sandbox, PATCH);
	spyOnBridge(sandbox, bridgeCalls);
	sandbox.BBExportAndroidPatch.install();

	await sandbox.Blockbench.export({ name: 'model.json', extensions: ['json'], content: '{}' });
	check('tidak digandakan', bridgeCalls[0].filename === 'model.json', bridgeCalls[0].filename);

	await sandbox.Blockbench.export({ name: 'tex.png', extensions: ['png'], content: '{}' });
	check('png tidak digandakan', bridgeCalls[1].filename === 'tex.png', bridgeCalls[1].filename);
}

console.log('\n=== 7c. REGRESI: enum Directory tidak diambil dari plugin ===');
{
	// Bug asli: bridge menulis `const { Directory, Encoding } = Filesystem`.
	// Di runtime Capacitor 6, plugin object TIDAK punya enum itu, jadi
	// Directory = undefined -> `Directory.Cache` jadi TypeError.
	// Test ini memaksa test lain TIDAK diam-diam menyamarkan bug tersebut.
	const { sandbox } = makeEnv();
	run(sandbox, BRIDGE);

	const capPlugin = sandbox.CapacitorPlugins.Filesystem;
	check('plugin tidak punya Directory (ciri runtime asli)', capPlugin.Directory === undefined);
	check('plugin tidak punya Encoding (ciri runtime asli)', capPlugin.Encoding === undefined);

	// Kalau bridge masih salah ambil enum, pemanggilan ini harus gagal.
	// Kalau bridge sudah benar, dia harus bisa tulis file.
	const res = await sandbox.BBBridge.saveFile('enumcheck.bbmodel', '{}');
	check('saveFile tetap jalan tanpa enum dari plugin', res.success === true, res.error && res.error.message);
}

console.log('\n=== 8. bridge: konten string (utf8) ===');
{
	const { sandbox, storage } = makeEnv();
	run(sandbox, BRIDGE);
	await sandbox.BBBridge.saveFile('a.bbmodel', '{"nama":"blok"}');
	const rec = storage.get('exports/a.bbmodel');
	check('ditulis', !!rec);
	check('encoding utf8', rec.encoding === 'utf8', rec.encoding);
	check('isi utuh', rec.data === '{"nama":"blok"}');
}

console.log('\n=== 9. bridge: Blob -> base64 ===');
{
	const { sandbox, storage } = makeEnv();
	run(sandbox, BRIDGE);
	const blob = new FakeBlob(['PNG'], { type: 'image/png' });
	const res = await sandbox.BBBridge.saveFile('tex.png', blob);
	check('sukses', res.success === true);
	// encoding harus undefined (mode base64 native), BUKAN string 'base64'
	// yang akan ditolak plugin dengan "Unsupported encoding provided".
	check('encoding undefined (mode base64 native)', storage.get('exports/tex.png').encoding === 'BASE64_NATIVE');
	check('base64 benar', storage.get('exports/tex.png').data === Buffer.from('PNG').toString('base64'));
}

console.log('\n=== 10. bridge: ArrayBuffer -> base64 ===');
{
	const { sandbox, storage } = makeEnv();
	run(sandbox, BRIDGE);
	const ab = new Uint8Array([1, 2, 3, 250]).buffer;
	const res = await sandbox.BBBridge.saveFile('bin.bin', ab);
	check('sukses', res.success === true);
	check('isi base64 benar', storage.get('exports/bin.bin').data === Buffer.from([1, 2, 3, 250]).toString('base64'));
}

console.log('\n=== 11. bridge: TypedArray -> base64 ===');
{
	const { sandbox, storage } = makeEnv();
	run(sandbox, BRIDGE);
	const view = new Uint8Array([9, 8, 7]);
	const res = await sandbox.BBBridge.saveFile('v.bin', view);
	check('sukses', res.success === true);
	check('isi base64 benar', storage.get('exports/v.bin').data === Buffer.from([9, 8, 7]).toString('base64'));
}

console.log('\n=== 12. bridge: Share dibatalkan -> file tetap ada ===');
{
	const { sandbox, storage, shareCalls, notices } = makeEnv({ failShare: true });
	run(sandbox, BRIDGE);
	const res = await sandbox.BBBridge.saveFile('keep.bbmodel', '{}');
	check('tetap sukses', res.success === true);
	check('file tetap tertulis', storage.has('exports/keep.bbmodel'));
	check('share tidak tercatat', shareCalls.length === 0);
	check('user diberi tahu file aman', notices.some((n) => /exports\//.test(n)), notices);
}

console.log('\n=== 13. bridge: Share sukses -> uri dikembalikan ===');
{
	const { sandbox, shareCalls } = makeEnv();
	run(sandbox, BRIDGE);
	const res = await sandbox.BBBridge.saveFile('ok.bbmodel', '{}');
	check('sukses', res.success === true);
	check('share dipanggil 1x', shareCalls.length === 1);
	check('share bawa uri file', /exports\/ok\.bbmodel/.test(shareCalls[0].url), shareCalls[0].url);
	check('uri dikembalikan', /ok\.bbmodel/.test(res.uri));
}

console.log('\n=== 14. bridge: gagal tulis -> error dilaporkan, tidak throw ===');
{
	const { sandbox, notices } = makeEnv({ failWrite: true });
	run(sandbox, BRIDGE);
	const res = await sandbox.BBBridge.saveFile('bad.bbmodel', '{}');
	check('sukses=false', res.success === false);
	check('error tersimpan di hasil', !!res.error);
	check('user diberi tahu gagal', notices.some((n) => /Gagal/.test(n)), notices);
}

console.log('\n=== 15. bridge: tipe konten tak didukung ditolak rapi ===');
{
	const { sandbox } = makeEnv();
	run(sandbox, BRIDGE);
	const res = await sandbox.BBBridge.saveFile('x.bin', 12345);
	check('sukses=false', res.success === false);
	check('ada pesan error', /tidak didukung/i.test(res.error.message), res.error && res.error.message);
}

console.log('\n=== 16. patch fallback kalau BBBridge belum ada ===');
{
	const { sandbox, calls } = makeEnv();
	run(sandbox, PATCH);
	sandbox.BBExportAndroidPatch.install();
	delete sandbox.BBBridge; // bridge gagal termuat

	sandbox.Blockbench.export({ name: 'm', extensions: ['bbmodel'], content: '{}' });
	check('tidak crash', true);
	check('menyerahkan ke exportFile asli', calls.export_calledOriginal === 1, calls.export_calledOriginal);
}

console.log('\n=== 17. REGRESI: data URL (export PNG) ditulis sebagai BINER ===');
{
	// image.js:168 mengirim `content` berupa data URL string dengan
	// savetype 'image'. Kalau string itu ditulis apa adanya sebagai UTF8,
	// file .png berisi teks "data:image/png;base64,..." — file ada tapi
	// TIDAK bisa dibuka. Ini diam-diam, sama seperti gejala sebelumnya.
	const { sandbox, storage } = makeEnv();
	run(sandbox, BRIDGE);

	// PNG 1x1 transparan, base64.
	const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
	const res = await sandbox.BBBridge.saveFile('tex.png', dataUrl, 'image');

	check('sukses', res.success === true, res.error && res.error.message);
	const rec = storage.get('exports/tex.png');
	check('ditulis dalam mode base64 (bukan utf8)', rec.encoding === 'BASE64_NATIVE', rec.encoding);
	check('isi bukan data URL mentah', !/^data:/.test(rec.data));
	check('isi adalah base64 PNG yang valid', rec.data === dataUrl.split(',')[1], rec.data);
}

console.log('\n=== 18. REGRESI: savetype=binary dengan string -> biner ===');
{
	// downloadFile (file_system.ts:564) memakai Blob untuk zip/buffer/binary.
	// String dengan savetype biner harus di-encode ke byte, bukan ditulis
	// sebagai teks mentah.
	const { sandbox, storage } = makeEnv();
	run(sandbox, BRIDGE);

	const res = await sandbox.BBBridge.saveFile('anim.bin', 'ABC', 'binary');
	check('sukses', res.success === true, res.error && res.error.message);
	const rec = storage.get('exports/anim.bin');
	check('mode base64 native', rec.encoding === 'BASE64_NATIVE', rec.encoding);
	check('isi = base64 dari byte string', rec.data === Buffer.from('ABC', 'latin1').toString('base64'), rec.data);
}

console.log('\n=== 19. savetype sebagai fungsi dievaluasi ===');
{
	// some caller boleh mengoper savetype berupa fungsi
	// (`typeof options.savetype == 'function' ? ... : options.savetype`).
	const { sandbox, storage } = makeEnv();
	run(sandbox, BRIDGE);

	const res = await sandbox.BBBridge.saveFile('t.png', 'data:image/png;base64,QUJD', () => 'image');
	check('sukses', res.success === true, res.error && res.error.message);
	check('fungsi savetype dievaluasi -> biner', storage.get('exports/t.png').encoding === 'BASE64_NATIVE');
}

console.log('\n=== 20. teks biasa tetap utf8 (tidak ikut jadi biner) ===');
{
	const { sandbox, storage } = makeEnv();
	run(sandbox, BRIDGE);
	const res = await sandbox.BBBridge.saveFile('m.bbmodel', '{"nama":"blok"}', undefined);
	check('sukses', res.success === true);
	check('tetap utf8', storage.get('exports/m.bbmodel').encoding === 'utf8');
}

console.log('\n=== 21. patch meneruskan savetype ke bridge ===');
{
	const { sandbox, bridgeCalls } = makeEnv();
	run(sandbox, BRIDGE);
	run(sandbox, PATCH);
	spyOnBridge(sandbox, bridgeCalls);
	sandbox.BBExportAndroidPatch.install();

	await sandbox.Blockbench.export({ name: 't', extensions: ['png'], content: 'data:image/png;base64,QQ==', savetype: 'image' });
	check('savetype diteruskan', bridgeCalls[0].savetype === 'image', bridgeCalls[0].savetype);
}

console.log('\n=== RINGKASAN ===');
console.log(`  ${passed} lulus, ${failed} gagal`);
process.exit(failed > 0 ? 1 : 0);