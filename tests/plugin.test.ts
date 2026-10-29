import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, TFile } from 'obsidian-test-mocks/obsidian';
import data from './vectors/joplin-import.json';
import JoplinImportPlugin from '../src/main';
import { PRO_UI, SPONSORS, bindPro, isPro, resetPro } from '../src/pro';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/settings';
import { jexBytes, type VectorMember } from '../src/vector';
import { jexFiles } from '../src/importer';
import manifest from '../manifest.json';

afterEach(() => resetPro());

const cases = (data as { cases: { name: string; args: unknown[] }[] }).cases;
const members = (name: string) => cases.find((c) => c.name === name)!.args[0] as VectorMember[];

function fakeManager(start: boolean) {
	let pro = start;
	const fns = new Set<() => void>();
	return {
		isPro: () => pro,
		onChange: (fn: () => void) => { fns.add(fn); return () => fns.delete(fn); },
		set(v: boolean) { pro = v; for (const fn of fns) fn(); },
	};
}

async function setup(files: Record<string, VectorMember[]>) {
	const app = App.createConfigured__({ files: { 'Start.md': 'Hello' } });
	const plugin = new JoplinImportPlugin(app as never, manifest as never);
	await plugin.loadSettings();
	for (const [path, m] of Object.entries(files)) {
		const b = jexBytes(m);
		const dir = path.split('/').slice(0, -1).join('/');
		if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
		await app.vault.createBinary(path, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
	}
	const vault = app.vault as unknown as { getFiles(): TFile[]; getFileByPath(p: string): TFile | null; read(f: TFile): Promise<string>; readBinary(f: TFile): Promise<ArrayBuffer>; modify(f: TFile, t: string): Promise<void>; getAbstractFileByPath(p: string): unknown };
	return { app, plugin, vault };
}

const PHOTO = 'resource embed copies one attachment and embeds it';

describe('settings', () => {
	it('loads defaults and repairs bad saved values', async () => {
		const { plugin } = await setup({});
		expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings({ folder: '../x', report: 'yes' })).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings({ folder: 'Imports/Joplin', report: false })).toEqual({ folder: 'Imports/Joplin', report: false });
		expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
	});
});

describe('import against an in-memory vault', () => {
	it('lists only .jex files', async () => {
		const { vault } = await setup({ 'Exports/b.jex': members(PHOTO), 'a.JEX': members(PHOTO) });
		expect(jexFiles(vault as never).map((f) => f.path)).toEqual(['a.JEX', 'Exports/b.jex']);
	});

	it('preview writes nothing; import writes the note, the attachment and the report', async () => {
		const { plugin, vault } = await setup({ 'export.jex': members(PHOTO) });
		const before = vault.getFiles().map((f) => f.path).sort();
		const archive = await plugin.readArchive(vault.getFileByPath('export.jex')! as never);
		const plan = plugin.prepare(archive, 'Joplin import');
		expect(plan.counts).toEqual({ notes: 1, notebooks: 1, tags: 0, resources: 1 });
		expect(vault.getFiles().map((f) => f.path).sort()).toEqual(before);
		expect(vault.getAbstractFileByPath('Joplin import')).toBeNull();
		const r = await plugin.importPlan(plan, 'export.jex', new Date(2026, 9, 14, 9, 30, 5));
		expect(r).toMatchObject({ created: 1, attachments: 1, skipped: 0, errors: [], report: 'Joplin import/Joplin import report 2026-10-14 093005.md' });
		const png = new Uint8Array(await vault.readBinary(vault.getFileByPath('Joplin import/_resources/eeee0001000000000000000000000001.png')!));
		expect(Array.from(png)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const note = await vault.read(vault.getFileByPath('Joplin import/Work/Trip--aaaa0001000000000000000000000001.md')!);
		expect(note).toContain('![[Joplin import/_resources/eeee0001000000000000000000000001.png|Photo]]');
		const report = await vault.read(vault.getFileByPath(r.report!)!);
		expect(report).toContain('Archive counts: 1 notes, 1 notebooks, 0 tags, 1 resources.');
		expect(report).toContain('Created: 1 notes and 1 attachments.');
		// The source archive stays unchanged.
		expect(new Uint8Array(await vault.readBinary(vault.getFileByPath('export.jex')!))).toEqual(jexBytes(members(PHOTO)));
	});

	it('a second import skips existing paths and keeps their bytes', async () => {
		const { plugin, vault } = await setup({ 'export.jex': members(PHOTO) });
		plugin.settings.report = false;
		const archive = await plugin.readArchive(vault.getFileByPath('export.jex')! as never);
		await plugin.importPlan(plugin.prepare(archive, 'Out'), 'export.jex');
		const notePath = 'Out/Work/Trip--aaaa0001000000000000000000000001.md';
		await vault.modify(vault.getFileByPath(notePath)!, 'My own text');
		const plan = plugin.prepare(archive, 'Out');
		expect([...plan.notes, ...plan.attachments].every((x) => x.status === 'existing')).toBe(true);
		const r = await plugin.importPlan(plan, 'export.jex');
		expect(r).toMatchObject({ created: 0, attachments: 0, skipped: 2, report: null });
		expect(await vault.read(vault.getFileByPath(notePath)!)).toBe('My own text');
	});

	it('a file that blocks a notebook folder stops the preview', async () => {
		const { app, plugin, vault } = await setup({ 'export.jex': members(PHOTO) });
		await app.vault.createFolder('Out');
		await app.vault.create('Out/Work', 'not a folder');
		const archive = await plugin.readArchive(vault.getFileByPath('export.jex')! as never);
		expect(() => plugin.prepare(archive, 'Out')).toThrow(/blocks the folder Out\/Work/);
	});

	it('an unsafe archive fails in readArchive, before any write', async () => {
		const { plugin, vault } = await setup({ 'bad.jex': members('tar member ../../outside.txt rejects the archive') });
		const before = vault.getFiles().length;
		await expect(plugin.readArchive(vault.getFileByPath('bad.jex')! as never)).rejects.toThrow(/Unsafe archive member/);
		expect(vault.getFiles().length).toBe(before);
	});

	it('refuses a file above 100 MiB by its size, before it reads the bytes', async () => {
		const { plugin, vault } = await setup({ 'big.jex': members(PHOTO) });
		const f = vault.getFileByPath('big.jex')!;
		f.stat.size = 100 * 1024 * 1024 + 1;
		const spy = vi.spyOn(vault, 'readBinary');
		await expect(plugin.readArchive(f as never)).rejects.toThrow(/larger than 100 MiB/);
		expect(spy).not.toHaveBeenCalled();
	});
});

describe('Pro', () => {
	it('uses the reference GitHub Sponsors values', () => {
		expect(SPONSORS).toEqual({ clientId: 'Ov23lic5UPGPZqhBlBGg', sponsorLogin: 'theluckystrike', minMonthlyUsd: 5, oneTimeUsd: 15, oneTimeMonths: 0, scope: 'read:user' });
		expect(PRO_UI.priceText).toContain('$5 a month, or $15 once');
	});

	it('resync and audit need Pro and write nothing without it', async () => {
		const { plugin, vault } = await setup({ 'export.jex': members(PHOTO) });
		expect(isPro()).toBe(false);
		const archive = await plugin.readArchive(vault.getFileByPath('export.jex')! as never);
		const plan = plugin.prepare(archive, 'Out');
		await expect(plugin.resyncPreview(plan)).rejects.toThrow(/needs Pro/);
		await expect(plugin.applyResync({ changed: [], edited: [], unchanged: 0, notInVault: 0, other: [] })).rejects.toThrow(/needs Pro/);
		await expect(plugin.audit([vault.getFileByPath('export.jex')!] as never, 'Out')).rejects.toThrow(/needs Pro/);
		expect(vault.getAbstractFileByPath('Out')).toBeNull();
	});

	it('resync updates a changed source note and keeps a note that you edited', async () => {
		const v1: VectorMember[] = members('note link becomes a vault link and keeps its label');
		const v2 = v1.map((m) => ({ ...m, text: m.text?.replace('Target.', 'Target, new text.').replace('Read [Other]', 'Now read [Other]') }));
		const { app, plugin, vault } = await setup({ 'v1.jex': v1, 'v2.jex': v2 });
		plugin.settings.report = false;
		const m = fakeManager(true);
		bindPro(m as never);
		await plugin.importPlan(plugin.prepare(await plugin.readArchive(vault.getFileByPath('v1.jex')! as never), 'Out'), 'v1.jex');
		const other = 'Out/Work/Other--aaaa0002000000000000000000000002.md';
		const plan = 'Out/Work/Plan--aaaa0001000000000000000000000001.md';
		const edited = (await vault.read(vault.getFileByPath(plan)!)).replace('first.', 'first. My note.');
		await vault.modify(vault.getFileByPath(plan)!, edited);
		const preview = await plugin.resyncPreview(plugin.prepare(await plugin.readArchive(vault.getFileByPath('v2.jex')! as never), 'Out'));
		expect(preview.changed.map((c) => c.path)).toEqual([other]);
		expect(preview.edited).toEqual([plan]);
		const r = await plugin.applyResync(preview);
		expect(r).toEqual({ updated: 1, skipped: [] });
		expect(await vault.read(vault.getFileByPath(other)!)).toContain('Target, new text.');
		expect(await vault.read(vault.getFileByPath(plan)!)).toBe(edited);
		void app;
	});

	it('audit of two archives finds links into the other archive and missing resources', async () => {
		const a: VectorMember[] = members('note link becomes a vault link and keeps its label').filter((m) => !m.text?.startsWith('Other'));
		const b: VectorMember[] = [...members('note link becomes a vault link and keeps its label').filter((m) => !m.text?.startsWith('Plan')), ...members('link to an absent resource stays and the report names it').filter((m) => m.text?.includes('type_: 4') || m.text?.startsWith('Broken'))];
		const { plugin, vault } = await setup({ 'a.jex': a, 'b.jex': b });
		bindPro(fakeManager(true) as never);
		const path = await plugin.audit([vault.getFileByPath('a.jex')!, vault.getFileByPath('b.jex')!] as never, 'Audits', new Date(2026, 9, 14, 8, 0, 0));
		expect(path).toBe('Audits/Joplin archive audit 2026-10-14 080000.md');
		const text = await vault.read(vault.getFileByPath(path)!);
		expect(text).toContain('| a.jex | 1 | 0 | 1 | 0 | 0 | 1 | 0 | 0 |');
		expect(text).toContain('| b.jex | 2 | 0 | 0 | 1 | 0 | 0 | 1 | 0 |');
		expect(text).toContain('aaaa0002000000000000000000000002 in note "Plan" is in b.jex');
		expect(text).toContain('Resource "lost.png" (eeee0001000000000000000000000001) in note "Broken" has no file');
	});
});

describe('import window', () => {
	it('Preview then close without Import creates no folder or file', async () => {
		const { plugin, vault } = await setup({ 'export.jex': members(PHOTO) });
		const before = vault.getFiles().map((f) => f.path).sort();
		const modal = plugin.openImport(vault.getFileByPath('export.jex')! as never);
		await modal.refreshPreview();
		expect(modal.contentEl.querySelector('.joplin-import-counts')?.textContent).toBe('1 notes · 1 notebooks · 0 tags · 1 resources');
		modal.close();
		expect(vault.getFiles().map((f) => f.path).sort()).toEqual(before);
		expect(vault.getAbstractFileByPath('Joplin import')).toBeNull();
	});

	it('Import in the window writes the files and shows the result', async () => {
		const { plugin, vault } = await setup({ 'export.jex': members(PHOTO) });
		plugin.settings.report = false;
		const modal = plugin.openImport(vault.getFileByPath('export.jex')! as never);
		await modal.refreshPreview();
		const button = [...modal.contentEl.querySelectorAll('button')].find((b) => b.textContent === 'Import');
		expect(button).toBeDefined();
		expect(button?.disabled).toBe(false);
		await modal.doImport();
		expect(modal.contentEl.querySelector('.joplin-import-status')?.textContent).toBe('Import complete: 1 notes and 1 attachments created, 0 existing paths skipped, 0 errors.');
		expect(vault.getFileByPath('Joplin import/Work/Trip--aaaa0001000000000000000000000001.md')).not.toBeNull();
		modal.close();
	});
});
