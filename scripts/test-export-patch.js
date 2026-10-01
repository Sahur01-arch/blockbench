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
		fetch: async () => ({ ok: true, clone() { return this; } }),
	};

	sandbox.window = sandbox;
	sandbox.globalThis = sandbox;
	sandbox.self = sandbox;

	sandbox.Capacitor = { Plugins: {} };
	// PENTING: tirukan shape ASLI runtime Capacitor 6 (JSExport.getPluginJS).
	// Plugin hanya berisi fungsi — TIDAK ada enum Directory/Encoding. Kalau
	// test ini挂了 enum di atas, dia akan menutupi bug yang sebenarnya.
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
	function makeExport(key) {
		return function (options, callback) {
			calls[key].push(options);
			if (typeof options.custom_writer === 'function') {
				// Meniru downloadFile(): pakai writer, JANGAN saveAs.
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
		SAF: { isActive: () => opts.safActive === true },
		Project: { export_path: opts.safActive ? '/models/x' : '' },
		showQuickMessage: (m) => notices.push(m),
	};

	return { sandbox, storage, shareCalls, notices, calls };
}

function run(sandbox, file) {
	const code = fs.readFileSync(file, 'utf-8');
	vm.runInContext(code, vm.createContext(sandbox), { filename: file });
}

// ==================================================================
console.log('\n=== 1. patch meng-wrap kedua alias ===');
{
	const { sandbox, calls } = makeEnv();
	run(sandbox, BRIDGE); // BBBridge harus ada, kalau tidak patch sengaja fallback
	run(sandbox, PATCH);
	const ok = sandbox.BBExportAndroidPatch.install();

	check('install() mengembalikan true', ok === true);
	check('Blockbench.export ter-wrap', sandbox.Blockbench.export.__bbExportPatched === true);
	check('Blockbench.exportFile ter-wrap', sandbox.Blockbench.exportFile.__bbExportPatched === true);
	check('flag global terpasang', sandbox.Blockbench.__bbExportPatched === true);

	// Idempoten: pasang dua kali tidak boleh bungkus dua kali.
	sandbox.BBExportAndroidPatch.install();
	check('idempoten (tidak bungkus ulang)', sandbox.Blockbench.export.__bbExportPatched === true);

	sandbox.Blockbench.export({ name: 'model', type: 'Bedrock', extensions: ['bbmodel'], content: '{"x":1}' });
	const opt = calls.export[0];
	check('export tercatat di spy', !!opt);
	check('custom_writer disuntikkan', typeof opt.custom_writer === 'function');
	check('saveAs TIDAK dipakai', !calls.export_usedSaveAs);
	check('content diteruskan utuh', opt.content === '{"x":1}');
	check('nama asli dipertahankan', opt.name === 'model');
}

console.log('\n=== 2. alias exportFile juga menghasilkan writer ===');
{
	const { sandbox, calls } = makeEnv();
	run(sandbox, BRIDGE);
	run(sandbox, PATCH);
	sandbox.BBExportAndroidPatch.install();

	sandbox.Blockbench.exportFile({ name: 'tex', type: 'PNG', extensions: ['png'], content: 'data' });
	check('exportFile tercatat di spy', !!calls.exportFile[0]);
	check('exportFile menyuntik writer', typeof calls.exportFile[0].custom_writer === 'function');
	check('exportFile tidak lewat saveAs', !calls.exportFile_usedSaveAs);
}

console.log('\n=== 3. callback diteruskan ===');
{
	const { sandbox } = makeEnv();
	run(sandbox, BRIDGE);
	run(sandbox, PATCH);
	sandbox.BBExportAndroidPatch.install();

	let got = null;
	sandbox.Blockbench.export({ name: 'm', extensions: ['bbmodel'], content: '{}' }, (p) => { got = p; });
	check('callback dipanggil dengan nama file', got === 'm');
}

console.log('\n=== 4. jalur SAF tidak ditimpa ===');
{
	const { sandbox, calls } = makeEnv({ safActive: true });
	run(sandbox, PATCH);
	sandbox.BBExportAndroidPatch.install();

	sandbox.Blockbench.export({ name: 'm', extensions: ['bbmodel'], content: '{}' });
	check('tidak ada writer saat SAF aktif', !calls.export[0].custom_writer);
	check('jalur asli (SAF) dipakai', calls.export_usedSaveAs === 1);
}

console.log('\n=== 5. custom_writer caller tidak ditimpa ===');
{
	const { sandbox, calls } = makeEnv();
	run(sandbox, PATCH);
	sandbox.BBExportAndroidPatch.install();

	const custom = () => 'custom';
	sandbox.Blockbench.export({ name: 'm', extensions: ['bbmodel'], content: '{}', custom_writer: custom });
	check('writer caller dipertahankan', calls.export[0].custom_writer === custom);
}

console.log('\n=== 6. bridge: nama file dapat ekstensi ===');
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

console.log('\n=== 6b. REGRESI: enum Directory tidak diambil dari plugin ===');
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

console.log('\n=== 7. bridge: konten string (utf8) ===');
{
	const { sandbox, storage } = makeEnv();
	run(sandbox, BRIDGE);
	await sandbox.BBBridge.saveFile('a.bbmodel', '{"nama":"blok"}');
	const rec = storage.get('exports/a.bbmodel');
	check('ditulis', !!rec);
	check('encoding utf8', rec.encoding === 'utf8', rec.encoding);
	check('isi utuh', rec.data === '{"nama":"blok"}');
}

console.log('\n=== 8. bridge: Blob -> base64 ===');
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

console.log('\n=== 9. bridge: ArrayBuffer -> base64 ===');
{
	const { sandbox, storage } = makeEnv();
	run(sandbox, BRIDGE);
	const ab = new Uint8Array([1, 2, 3, 250]).buffer;
	const res = await sandbox.BBBridge.saveFile('bin.bin', ab);
	check('sukses', res.success === true);
	check('isi base64 benar', storage.get('exports/bin.bin').data === Buffer.from([1, 2, 3, 250]).toString('base64'));
}

console.log('\n=== 10. bridge: TypedArray -> base64 ===');
{
	const { sandbox, storage } = makeEnv();
	run(sandbox, BRIDGE);
	const view = new Uint8Array([9, 8, 7]);
	const res = await sandbox.BBBridge.saveFile('v.bin', view);
	check('sukses', res.success === true);
	check('isi base64 benar', storage.get('exports/v.bin').data === Buffer.from([9, 8, 7]).toString('base64'));
}

console.log('\n=== 11. bridge: Share dibatalkan -> file tetap ada ===');
{
	const { sandbox, storage, shareCalls, notices } = makeEnv({ failShare: true });
	run(sandbox, BRIDGE);
	const res = await sandbox.BBBridge.saveFile('keep.bbmodel', '{}');
	check('tetap sukses', res.success === true);
	check('file tetap tertulis', storage.has('exports/keep.bbmodel'));
	check('share tidak tercatat', shareCalls.length === 0);
	check('user diberi tahu file aman', notices.some((n) => /exports\//.test(n)), notices);
}

console.log('\n=== 12. bridge: Share sukses -> uri dikembalikan ===');
{
	const { sandbox, shareCalls } = makeEnv();
	run(sandbox, BRIDGE);
	const res = await sandbox.BBBridge.saveFile('ok.bbmodel', '{}');
	check('sukses', res.success === true);
	check('share dipanggil 1x', shareCalls.length === 1);
	check('share bawa uri file', /exports\/ok\.bbmodel/.test(shareCalls[0].url), shareCalls[0].url);
	check('uri dikembalikan', /ok\.bbmodel/.test(res.uri));
}

console.log('\n=== 13. bridge: gagal tulis -> error dilaporkan, tidak throw ===');
{
	const { sandbox, notices } = makeEnv({ failWrite: true });
	run(sandbox, BRIDGE);
	const res = await sandbox.BBBridge.saveFile('bad.bbmodel', '{}');
	check('sukses=false', res.success === false);
	check('error tersimpan di hasil', !!res.error);
	check('user diberi tahu gagal', notices.some((n) => /Gagal/.test(n)), notices);
}

console.log('\n=== 14. bridge: tipe konten tak didukung ditolak rapi ===');
{
	const { sandbox } = makeEnv();
	run(sandbox, BRIDGE);
	const res = await sandbox.BBBridge.saveFile('x.bin', 12345);
	check('sukses=false', res.success === false);
	check('ada pesan error', /tidak didukung/i.test(res.error.message), res.error && res.error.message);
}

console.log('\n=== 15. patch fallback kalau BBBridge belum ada ===');
{
	const { sandbox, calls } = makeEnv();
	run(sandbox, PATCH);
	sandbox.BBExportAndroidPatch.install();
	delete sandbox.BBBridge; // bridge gagal termuat

	sandbox.Blockbench.export({ name: 'm', extensions: ['bbmodel'], content: '{}' });
	check('tidak crash, jalur asli jalan', calls.export_usedSaveAs === 1);
}

console.log('\n=== RINGKASAN ===');
console.log(`  ${passed} lulus, ${failed} gagal`);
process.exit(failed > 0 ? 1 : 0);