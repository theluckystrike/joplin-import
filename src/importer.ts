import { TFile, TFolder, normalizePath, type Vault } from 'obsidian';
import { planImport, reportText, unchangedSinceImport, type Plan } from './convert';
import { readJex, type Archive } from './joplin';
import { MAX_TAR_BYTES } from './tar';

export interface ImportResult { created: number; attachments: number; skipped: number; errors: string[]; report: string | null }
export interface ResyncItem { id: string; path: string; text: string; previousText: string }
export interface ResyncPreview { changed: ResyncItem[]; edited: string[]; unchanged: number; notInVault: number; other: string[] }

/** The .jex files in the vault, sorted by path. */
export function jexFiles(vault: Vault): TFile[] {
	return vault.getFiles().filter((f) => f.extension.toLowerCase() === 'jex').sort((a, b) => a.path.localeCompare(b.path));
}

/** Reads and checks a .jex file of the vault. The size check comes before the read. */
export async function readArchiveFile(vault: Vault, file: TFile): Promise<Archive> {
	if (file.stat.size > MAX_TAR_BYTES) throw new Error(`${file.name} is larger than ${MAX_TAR_BYTES / 1024 / 1024} MiB. Export fewer notebooks from Joplin and import each file.`);
	return readJex(new Uint8Array(await vault.readBinary(file)));
}

/** Converts the archive in memory and marks the paths that exist. Writes nothing. */
export function prepareImport(vault: Vault, archive: Archive, folder: string): Plan {
	const plan = planImport(archive, folder, (p) => vault.getAbstractFileByPath(normalizePath(p)) !== null);
	for (const f of plan.folders) {
		const found = vault.getAbstractFileByPath(normalizePath(f));
		if (found && !(found instanceof TFolder)) throw new Error(`A file blocks the folder ${f}. Select a different output folder.`);
	}
	return plan;
}

export async function ensureFolders(vault: Vault, folders: string[]): Promise<void> {
	for (const f of folders) {
		const path = normalizePath(f);
		const found = vault.getAbstractFileByPath(path);
		if (found instanceof TFolder) continue;
		if (found) throw new Error(`A file blocks the folder ${path}.`);
		await vault.createFolder(path);
	}
}

/**
 * Creates each missing folder. A folder that cannot be created goes into the returned map with its error, and its
 * sub-folders are not tried. The folders are in parent-first order.
 */
async function createFolders(vault: Vault, folders: string[]): Promise<Map<string, string>> {
	const failed = new Map<string, string>();
	for (const f of folders) {
		const path = normalizePath(f);
		if (insideFailed(failed, path) !== null) continue;
		const found = vault.getAbstractFileByPath(path);
		if (found instanceof TFolder) continue;
		try {
			if (found) throw new Error('A file blocks the folder');
			await vault.createFolder(path);
		} catch (e) {
			failed.set(path, (e instanceof Error ? e.message : String(e)).replace(/\.$/, ''));
		}
	}
	return failed;
}

/** The failed folder that is path or that holds path, or null. */
function insideFailed(failed: Map<string, string>, path: string): string | null {
	for (const f of failed.keys()) if (path === f || path.startsWith(`${f}/`)) return f;
	return null;
}

/** "2026-10-14 093005" in local time, for the report file name. */
export function stamp(d: Date): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export const STOPPED = 'The plugin was turned off during the import. The import stopped. Import the archive again to add the other files.';

function withStop(result: ImportResult): ImportResult {
	result.errors.push(STOPPED);
	return result;
}

/**
 * Writes the new attachments, then the new notes, then the report note. An existing path is skipped and keeps
 * its bytes. The check runs again for each file just before its write. A folder that cannot be created gives one
 * error line, and its notes and attachments are not written; the import goes on with the other folders. When stopped() returns true (plugin unload),
 * no further file is written and the result has the STOPPED error.
 */
export async function writeImport(vault: Vault, plan: Plan, source: string, opts: { report: boolean; now?: Date; stopped?: () => boolean } = { report: true }): Promise<ImportResult> {
	const result: ImportResult = { created: 0, attachments: 0, skipped: 0, errors: [], report: null };
	const stopped = opts.stopped ?? (() => false);
	const failed = await createFolders(vault, plan.folders);
	const lost = new Map([...failed.keys()].map((f) => [f, { notes: 0, attachments: 0 }]));
	for (const a of plan.attachments) {
		const f = insideFailed(failed, normalizePath(a.path));
		if (f !== null) lost.get(f)!.attachments++;
	}
	for (const n of plan.notes) {
		const f = insideFailed(failed, normalizePath(n.path));
		if (f !== null) lost.get(f)!.notes++;
	}
	for (const [f, c] of lost) result.errors.push(`${f}: ${failed.get(f)!}. The ${c.notes} notes and ${c.attachments} attachments in this folder are not imported.`);
	for (const a of plan.attachments) {
		if (stopped()) return withStop(result);
		const path = normalizePath(a.path);
		if (failed.size && insideFailed(failed, path) !== null) continue;
		if (vault.getAbstractFileByPath(path)) { result.skipped++; continue; }
		try {
			const copy = a.data.slice();
			await vault.createBinary(path, copy.buffer);
			result.attachments++;
		} catch (e) { result.errors.push(`${path}: ${e instanceof Error ? e.message : String(e)}`); }
	}
	for (const n of plan.notes) {
		if (stopped()) return withStop(result);
		const path = normalizePath(n.path);
		if (failed.size && insideFailed(failed, path) !== null) continue;
		if (vault.getAbstractFileByPath(path)) { result.skipped++; continue; }
		try {
			await vault.create(path, n.text);
			result.created++;
		} catch (e) { result.errors.push(`${path}: ${e instanceof Error ? e.message : String(e)}`); }
	}
	if (stopped()) return withStop(result);
	if (opts.report) {
		const s = stamp(opts.now ?? new Date());
		let path = normalizePath(`${plan.folder}/Joplin import report ${s}.md`);
		for (let i = 2; vault.getAbstractFileByPath(path) && i < 100; i++) path = normalizePath(`${plan.folder}/Joplin import report ${s} ${i}.md`);
		try {
			await vault.create(path, reportText(plan, source, s, result));
			result.report = path;
		} catch (e) { result.errors.push(`${path}: ${e instanceof Error ? e.message : String(e)}`); }
	}
	return result;
}

/**
 * Pro: compares each planned note with the note at its path. A note is "changed" when the archive gives a
 * different text and the vault note is as the import wrote it. A note that you edited is listed and kept.
 */
export async function resyncPreview(vault: Vault, plan: Plan): Promise<ResyncPreview> {
	const out: ResyncPreview = { changed: [], edited: [], unchanged: 0, notInVault: 0, other: [] };
	for (const n of plan.notes) {
		const file = vault.getAbstractFileByPath(normalizePath(n.path));
		if (!(file instanceof TFile)) { out.notInVault++; continue; }
		const text = await vault.read(file);
		if (!new RegExp(`^joplin_id: ${n.id}$`, 'm').test(text)) { out.other.push(n.path); continue; }
		if (text === n.text) { out.unchanged++; continue; }
		if (!unchangedSinceImport(text)) { out.edited.push(n.path); continue; }
		out.changed.push({ id: n.id, path: n.path, text: n.text, previousText: text });
	}
	return out;
}

/** Pro: writes the changed notes of a resync preview. Each note is checked again just before the write. */
export async function applyResync(vault: Vault, preview: ResyncPreview, stopped: () => boolean = () => false): Promise<{ updated: number; skipped: string[] }> {
	const out = { updated: 0, skipped: [] as string[] };
	for (const item of preview.changed) {
		if (stopped()) { out.skipped.push(item.path); continue; }
		const file = vault.getAbstractFileByPath(normalizePath(item.path));
		if (!(file instanceof TFile)) { out.skipped.push(item.path); continue; }
		let updated = false;
		await vault.process(file, (text) => {
			if (file.path !== normalizePath(item.path) || text !== item.previousText || !unchangedSinceImport(text) || !new RegExp(`^joplin_id: ${item.id}$`, 'm').test(text)) return text;
			updated = true;
			return item.text;
		});
		if (updated) out.updated++;
		else out.skipped.push(item.path);
	}
	return out;
}
