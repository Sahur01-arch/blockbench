import { pathToName } from './util';

const DB_NAME = 'blockbench_saf';
const DB_VERSION = 1;
const STORE_NAME = 'handles';
const ROOT_KEY = 'directory';

export type SAFPermissionMode = 'read' | 'readwrite';

export interface SAFPermissionDescriptor {
	mode?: SAFPermissionMode
}

export interface SAFWritable {
	write(data: Blob | BufferSource | string): Promise<void>
	close(): Promise<void>
	abort?(): Promise<void>
}

export interface SAFFileHandle {
	readonly kind: 'file'
	readonly name: string
	getFile(): Promise<File>
	createWritable(options?: { keepExistingData?: boolean }): Promise<SAFWritable>
	queryPermission?(descriptor?: SAFPermissionDescriptor): Promise<string>
	requestPermission?(descriptor?: SAFPermissionDescriptor): Promise<string>
}

export interface SAFDirectoryHandle {
	readonly kind: 'directory'
	readonly name: string
	getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<SAFDirectoryHandle>
	getFileHandle(name: string, options?: { create?: boolean }): Promise<SAFFileHandle>
	removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
	entries(): AsyncIterableIterator<[string, SAFFileHandle | SAFDirectoryHandle]>
	queryPermission?(descriptor?: SAFPermissionDescriptor): Promise<string>
	requestPermission?(descriptor?: SAFPermissionDescriptor): Promise<string>
	isSameEntry?(other: unknown): Promise<boolean>
}

export interface SAFPickerType {
	description?: string
	accept: Record<string, string[]>
}

export interface SAFPickerOptions {
	id?: string
	mode?: SAFPermissionMode
	startIn?: unknown
	suggestedName?: string
	types?: SAFPickerType[]
	excludeAcceptAllOption?: boolean
	multiple?: boolean
}

interface SAFWindow {
	showDirectoryPicker?(options?: SAFPickerOptions): Promise<SAFDirectoryHandle>
	showSaveFilePicker?(options?: SAFPickerOptions): Promise<SAFFileHandle>
	showOpenFilePicker?(options?: SAFPickerOptions): Promise<SAFFileHandle[]>
}

function getWindow(): SAFWindow {
	return window as unknown as SAFWindow
}

let database_promise: Promise<IDBDatabase> | undefined
function openDatabase(): Promise<IDBDatabase> {
	if (!database_promise) {
		database_promise = new Promise<IDBDatabase>((resolve, reject) => {
			let request = indexedDB.open(DB_NAME, DB_VERSION)
			request.onupgradeneeded = () => {
				if (!request.result.objectStoreNames.contains(STORE_NAME)) {
					request.result.createObjectStore(STORE_NAME)
				}
			}
			request.onsuccess = () => resolve(request.result)
			request.onerror = () => reject(request.error)
		}).catch(error => {
			database_promise = undefined
			throw error
		})
	}
	return database_promise
}

async function withStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	let database = await openDatabase()
	return await new Promise<T>((resolve, reject) => {
		let request = action(database.transaction(STORE_NAME, mode).objectStore(STORE_NAME))
		request.onsuccess = () => resolve(request.result)
		request.onerror = () => reject(request.error)
	})
}

export namespace SAF {
	export type WriteType = 'text' | 'buffer' | 'binary' | 'zip' | 'image'
	export type ReadType = 'buffer' | 'binary' | 'text' | 'image' | 'none'

	export interface WriteOptions {
		content?: string | ArrayBuffer | Blob
		savetype?: WriteType | ((file: string) => WriteType)
	}

	export interface PickDirectoryOptions {
		/** Identifier used by the browser to remember the last used folder
		 */
		id?: string
		title?: string
	}

	let directory: SAFDirectoryHandle | null = null
	let remembered: Record<string, string> = {}

	/** Whether the current browser exposes the File System Access API
	 */
	export function isSupported(): boolean {
		if (typeof window == 'undefined') return false
		if (typeof (window as any).isSecureContext == 'boolean' && !(window as any).isSecureContext) return false
		return typeof getWindow().showDirectoryPicker == 'function'
	}

	/** Whether a working folder is currently selected, without checking its permission
	 */
	export function isActive(): boolean {
		return isSupported() && directory != null
	}

	export function getDirectoryName(): string | undefined {
		return directory?.name
	}

	export function getDirectoryHandle(): SAFDirectoryHandle | null {
		return directory
	}

	export function normalizePath(path: string | undefined | null): string {
		if (typeof path != 'string') return ''
		return path.replace(/\\/g, '/').split('/').filter(part => part && part != '.' && part != '..').join('/')
	}

	export function dirname(path: string): string {
		return normalizePath(path).split('/').slice(0, -1).join('/')
	}

	export function basename(path: string): string {
		return normalizePath(path).split('/').pop() || ''
	}

	export async function ensurePermission(
		handle: SAFDirectoryHandle | SAFFileHandle,
		mode: SAFPermissionMode = 'readwrite',
		interactive: boolean = false
	): Promise<boolean> {
		if (typeof handle.queryPermission != 'function') return true
		if (await handle.queryPermission({mode}) == 'granted') return true
		if (!interactive || typeof handle.requestPermission != 'function') return false
		try {
			return await handle.requestPermission({mode}) == 'granted'
		} catch (error) {
			return false
		}
	}

	/** Load the working folder previously stored in IndexedDB
	 */
	export async function initialize(): Promise<boolean> {
		if (!isSupported()) return false
		try {
			let handle = await withStore<SAFDirectoryHandle>('readonly', store => store.get(ROOT_KEY))
			if (handle && handle.kind == 'directory') {
				directory = handle
			}
		} catch (error) {
			console.warn('Could not restore the working folder', error)
		}
		remembered = StateMemory.get('saf_paths') || {}
		return directory != null
	}

	async function persist(handle: SAFDirectoryHandle | null) {
		try {
			if (handle) {
				await withStore('readwrite', store => store.put(handle, ROOT_KEY))
			} else {
				await withStore('readwrite', store => store.delete(ROOT_KEY))
			}
		} catch (error) {
			console.warn('Could not persist the working folder', error)
		}
	}

	/** Ask the user for a working folder. Requires a user gesture.
	 */
	export async function pickDirectory(options: PickDirectoryOptions = {}): Promise<string | undefined> {
		if (!isSupported()) {
			Blockbench.showMessageBox({
				title: tl('saf.folder.unsupported.title'),
				icon: 'error_outline',
				message: tl('saf.folder.unsupported.message'),
				buttons: ['dialog.close']
			})
			return undefined
		}
		let handle: SAFDirectoryHandle
		try {
			handle = await getWindow().showDirectoryPicker!({
				id: options.id || 'blockbench_saf',
				mode: 'readwrite',
				startIn: directory ?? undefined
			})
		} catch (error) {
			if (!isAbortError(error)) console.warn(error)
			return undefined
		}
		if (!await ensurePermission(handle, 'readwrite', true)) {
			Blockbench.showMessageBox({
				title: tl('saf.folder.permission.title'),
				icon: 'error_outline',
				message: tl('saf.folder.permission.message'),
				buttons: ['dialog.close']
			})
			return undefined
		}
		directory = handle
		await persist(handle)
		return handle.name
	}

	/** Ask the user to pick files. Requires a user gesture.
	 */
	export async function openFiles(options: {
		extensions?: string[]
		types?: SAFPickerType[]
		multiple?: boolean
		id?: string
	} = {}): Promise<SAFFileHandle[] | null> {
		if (!isSupported() || typeof getWindow().showOpenFilePicker != 'function') return null
		let types = options.types
		if (!types && options.extensions?.length) {
			types = [{
				description: options.extensions[0],
				accept: {['*/*']: options.extensions.map(ext => '.' + ext)}
			}]
		}
		try {
			return await getWindow().showOpenFilePicker!({
				id: options.id ? 'blockbench_' + options.id : 'blockbench_files',
				multiple: options.multiple === true,
				types,
				excludeAcceptAllOption: false,
				startIn: directory ?? undefined
			})
		} catch (error) {
			if (!isAbortError(error)) reportError(error)
			return null
		}
	}

	/** Remove the working folder and stop using SAF for import/export
	 */
	export async function forget() {
		directory = null
		remembered = {}
		StateMemory.set('saf_paths', {})
		await persist(null)
	}

	/** Stop using the working folder for the rest of the session, but keep it remembered
	 */
	export async function detach() {
		directory = null
	}

	/** Returns the working folder, optionally asking the user for one
	 */
	export async function getDirectory(interactive: boolean = false): Promise<SAFDirectoryHandle | null> {
		if (!isSupported()) return null
		if (directory) {
			if (await ensurePermission(directory, 'readwrite', interactive)) return directory
		}
		if (!interactive) return null
		await pickDirectory()
		return directory
	}

	async function resolve(path: string, interactive: boolean): Promise<{ directory: SAFDirectoryHandle, file_name: string }> {
		let handle = await getDirectory(interactive)
		if (!handle) throw new Error('No working folder selected')
		let parts = normalizePath(path).split('/').filter(Boolean)
		let file_name = parts.pop()
		if (!file_name) throw new Error('Invalid file path: ' + path)
		for (let part of parts) {
			handle = await handle.getDirectoryHandle(part, {create: interactive})
		}
		return {directory: handle, file_name}
	}

	export async function getFileHandle(path: string, options: { create?: boolean, interactive?: boolean } = {}): Promise<SAFFileHandle | null> {
		try {
			let {directory, file_name} = await resolve(path, options.interactive === true)
			return await directory.getFileHandle(file_name, {create: options.create === true})
		} catch (error) {
			return null
		}
	}

	export async function fileExists(path: string): Promise<boolean> {
		return await getFileHandle(path) != null
	}

	export async function removeFile(path: string) {
		try {
			let parts = normalizePath(path).split('/').filter(Boolean)
			let file_name = parts.pop()
			let handle = await getDirectory(false)
			if (!handle || !file_name) return
			for (let part of parts) handle = await handle.getDirectoryHandle(part, {create: false})
			await handle.removeEntry(file_name)
		} catch (error) {
			console.warn(error)
		}
	}

	async function toWritable(content: string | ArrayBuffer | Blob | undefined, options: WriteOptions, file_name: string) {
		let savetype = typeof options.savetype == 'function' ? options.savetype(file_name) : options.savetype
		if (typeof content == 'string' && (savetype == 'image' || /^(data|blob):/.test(content))) {
			if (content.startsWith('data:')) {
				return await (await fetch(content)).blob()
			}
		}
		return content
	}

	export async function writeFile(path: string, options: WriteOptions = {}, interactive: boolean = true): Promise<string> {
		let file_path = normalizePath(path)
		if (!file_path) throw new Error('Invalid file path')
		let {directory, file_name} = await resolve(file_path, interactive)
		let handle = await directory.getFileHandle(file_name, {create: true})
		let writable = await handle.createWritable()
		try {
			await writable.write(await toWritable(options.content, options, file_name) as string)
		} catch (error) {
			writable.abort?.()
			throw error
		}
		await writable.close()
		return file_path
	}

	export async function readFile(path: string, readtype: ReadType | ((file: string) => ReadType) = 'text'): Promise<{ name: string, path: string, content?: string | ArrayBuffer }> {
		let file_path = normalizePath(path)
		let type = typeof readtype == 'function' ? readtype(file_path) : readtype
		if (type == 'none') {
			return {name: basename(file_path), path: file_path}
		}
		let handle = await getFileHandle(file_path)
		if (!handle) throw new Error('File not found: ' + file_path)
		let file = await handle.getFile()
		let content: string | ArrayBuffer
		if (type == 'image') {
			content = /tga$/i.test(file.name) ? await file.arrayBuffer() : await readAsDataURL(file)
		} else if (type == 'buffer' || type == 'binary') {
			content = await file.arrayBuffer()
		} else {
			content = await file.text()
			if (content.charCodeAt(0) === 0xFEFF) content = content.substr(1)
		}
		return {name: pathToName(file_path, true), path: file_path, content}
	}

	function readAsDataURL(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			let reader = new FileReader()
			reader.onloadend = () => resolve(reader.result as string)
			reader.onerror = () => reject(reader.error)
			reader.readAsDataURL(file)
		})
	}

	export async function listFiles(path: string = ''): Promise<{ name: string, path: string, is_directory: boolean }[]> {
		let handle = await getDirectory(false)
		if (!handle) return []
		let results: { name: string, path: string, is_directory: boolean }[] = []
		let parts = normalizePath(path).split('/').filter(Boolean)
		try {
			for (let part of parts) handle = await handle.getDirectoryHandle(part, {create: false})
			for await (let [name, entry] of handle.entries()) {
				results.push({
					name,
					path: normalizePath(path) ? normalizePath(path) + '/' + name : name,
					is_directory: entry.kind == 'directory'
				})
			}
		} catch (error) {
			return []
		}
		return results
	}

	/** Build the path of a file to export, relative to the working folder
	 */
	export function getExportPath(options: { name?: string, startpath?: string, resource_id?: string }): string {
		let file_name = normalizePath(options.name) || 'file'
		let startpath = normalizePath(options.startpath)
		if (!startpath && options.resource_id) {
			let last_path = normalizePath(remembered[options.resource_id])
			if (last_path) startpath = last_path + '/' + file_name
		}
		return startpath || file_name
	}

	export function rememberPath(resource_id: string | undefined, path: string) {
		if (!resource_id) return
		remembered[resource_id] = dirname(path)
		StateMemory.set('saf_paths', remembered)
	}

	export function isAbortError(error: unknown): boolean {
		return error instanceof Error && error.name == 'AbortError'
	}

	export function reportError(error: unknown, path?: string) {
		if (isAbortError(error)) return
		console.error(error)
		Blockbench.showMessageBox({
			title: tl('saf.error.title'),
			icon: 'error_outline',
			message: (path ? '`' + path.replace(/[`"<>]/g, '') + '`\n\n' : '') + (error instanceof Error ? error.message : String(error)),
			buttons: ['dialog.close']
		})
	}
}

Object.assign(window, {SAF});
