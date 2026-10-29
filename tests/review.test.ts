import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from 'obsidian-test-mocks/obsidian';
import * as obsidian from 'obsidian';
import JoplinImportPlugin from '../src/main';
import manifest from '../manifest.json';
import { bindPro, resetPro } from '../src/pro';
import { auditArchives } from '../src/audit';
import { convertLinks, planImport, renderNote } from '../src/convert';
import { applyResync, prepareImport, resyncPreview, writeImport } from '../src/importer';
import { isoTime, parseItem, readJex, type Archive, type Note } from '../src/joplin';
import { readTar, writeTar } from '../src/tar';

const id = (n: number) => n.toString(16).padStart(32, '0');
const note = (body = 'Original'): Note => ({ id: id(1), parentId: '', title: 'Plan', body, markup: 'markdown', created: null, updated: null, todo: false, todoDone: false });
const archive = (): Archive => ({ notes: [note()], folders: [], tags: [], noteTags: new Map(), resources: new Map(), unsupported: [] });
const enc = new TextEncoder();

vi.mock('obsidian', async (importOriginal) => ({
	...await importOriginal<typeof import('obsidian')>(),
	requestUrl: vi.fn().mockRejectedValue(new Error('Unexpected request')),
}));

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); resetPro(); });

describe('independent review regressions', () => {
	it('does not start a refresh timer after unloading before the layout is ready', async () => {
		const app = App.createConfigured__({ files: {} });
		const plugin = new JoplinImportPlugin(app, manifest);
		let ready: (() => unknown) | undefined;
		vi.spyOn(app.workspace, 'onLayoutReady').mockImplementation((cb) => { ready = cb; });
		await plugin.onload();
		plugin.onunload();
		const interval = vi.spyOn(window, 'setInterval').mockReturnValue(1);
		ready!();
		expect(interval).not.toHaveBeenCalled();
	});

	it('Preview reads a changed archive again in the same import window', async () => {
		const app = App.createConfigured__({ files: { 'export.jex': 'placeholder' } });
		const plugin = new JoplinImportPlugin(app, manifest);
		const first = archive();
		const second = archive();
		second.notes[0]!.title = 'Later';
		vi.spyOn(plugin, 'readArchive').mockResolvedValueOnce(first).mockResolvedValueOnce(second);
		const modal = plugin.openImport(app.vault.getFileByPath('export.jex')!);
		await modal.refreshPreview();
		await modal.refreshPreview();
		expect(modal.contentEl.querySelector('.joplin-import-paths')?.textContent).toContain('Later--');
		modal.close();
	});

	it('discards a resync preview if the output folder changes during the read', async () => {
		const app = App.createConfigured__({ files: { 'export.jex': 'placeholder' } });
		const plugin = new JoplinImportPlugin(app, manifest);
		vi.spyOn(plugin, 'readArchive').mockResolvedValue(archive());
		bindPro({ isPro: () => true, onChange: () => () => undefined } as never);
		const modal = plugin.openImport(app.vault.getFileByPath('export.jex')!);
		await modal.refreshPreview();
		let finish!: (value: Awaited<ReturnType<typeof resyncPreview>>) => void;
		vi.spyOn(plugin, 'resyncPreview').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
		const pending = modal.previewChanges();
		const input = modal.contentEl.querySelector('input')!;
		input.value = 'Other folder';
		input.dispatchEvent(new Event('input'));
		finish({ changed: [{ id: id(1), path: 'Old/Plan.md', text: 'new', previousText: 'old' }], edited: [], unchanged: 0, notInVault: 0, other: [] });
		await pending;
		const update = [...modal.contentEl.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Update '));
		expect(update?.disabled).toBe(true);
		expect(modal.contentEl.querySelector('.joplin-import-status')?.textContent).toBe('Select Preview to read the archive.');
		modal.close();
	});

	it('loads and imports without a token or a network request', async () => {
		vi.useFakeTimers();
		const app = App.createConfigured__({ files: {} });
		const request = vi.mocked(obsidian.requestUrl);
		request.mockClear();
		const plugin = new JoplinImportPlugin(app, manifest);
		await plugin.onload();
		app.workspace.setLayoutReady__();
		await plugin.pro!.refreshNow();
		const result = await plugin.importPlan(plugin.prepare(archive(), 'Out'), 'source.jex');
		expect(result).toMatchObject({ created: 1, errors: [] });
		expect(request).not.toHaveBeenCalled();
		plugin.pro!.dispose();
		plugin.onunload();
	});

	it('preserves a large note without blocking for five seconds', () => {
		const body = 'A line of source text\n'.repeat(200_000);
		const started = performance.now();
		const parsed = parseItem(`Large note\n\n${body}\n\nid: ${id(1)}\ntype_: 1`);
		expect(parsed.body).toBe(body);
		expect(performance.now() - started).toBeLessThan(5000);
	});
	it('keeps an edit made when resync reaches the write operation', async () => {
		const app = App.createConfigured__({ files: {} });
		const plan = prepareImport(app.vault, archive(), 'Out');
		await writeImport(app.vault, plan, 'source.jex', { report: false });
		const later = archive();
		later.notes[0]!.body = 'New source';
		const preview = await resyncPreview(app.vault, prepareImport(app.vault, later, 'Out'));
		const file = app.vault.getFileByPath(plan.notes[0]!.path)!;
		const edit = plan.notes[0]!.text + '\nMy concurrent edit';
		const modify = app.vault.modify.bind(app.vault);
		const process = app.vault.process.bind(app.vault);
		vi.spyOn(app.vault, 'modify').mockImplementation(async (f, text, options) => {
			await modify(f, edit);
			return modify(f, text, options);
		});
		vi.spyOn(app.vault, 'process').mockImplementation(async (f, fn, options) => {
			await modify(f, edit);
			return process(f, fn, options);
		});
		expect(await applyResync(app.vault, preview)).toEqual({ updated: 0, skipped: [file.path] });
		expect(await app.vault.read(file)).toBe(edit);
	});

	it('keeps a newer import when an old resync preview is applied', async () => {
		const app = App.createConfigured__({ files: {} });
		const plan = prepareImport(app.vault, archive(), 'Out');
		await writeImport(app.vault, plan, 'source.jex', { report: false });
		const later = archive();
		later.notes[0]!.body = 'Second source';
		const preview = await resyncPreview(app.vault, prepareImport(app.vault, later, 'Out'));
		const file = app.vault.getFileByPath(plan.notes[0]!.path)!;
		const newest = renderNote(note('Third source'), [], 'Third source');
		await app.vault.modify(file, newest);
		expect(await applyResync(app.vault, preview)).toEqual({ updated: 0, skipped: [file.path] });
		expect(await app.vault.read(file)).toBe(newest);
	});

	it('creates the parents of a nested output folder without notebooks', async () => {
		const app = App.createConfigured__({ files: {} });
		const plan = prepareImport(app.vault, archive(), 'Imports/Joplin');
		expect(plan.folders).toEqual(['Imports', 'Imports/Joplin']);
		expect(await writeImport(app.vault, plan, 'source.jex', { report: false })).toMatchObject({ created: 1, errors: [] });
	});

	it('omits an out of range time instead of stopping the archive reader', () => {
		expect(isoTime('999999999999999999')).toBeNull();
	});

	it('keeps a source date before 1970', () => {
		expect(isoTime('1960-01-01T00:00:00.000Z')).toBe('1960-01-01T00:00:00.000Z');
	});

	it('keeps literal backslash n and r in Joplin properties', () => {
		const original = 'C:\\notes\\research\nsecond line\r';
		const serialized = original.replace(/\\n/g, '\\\\n').replace(/\\r/g, '\\\\r').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
		expect(parseItem(`Title\n\nBody\n\nsource_url: ${serialized}\ntype_: 1`).props.source_url).toBe(original);
	});

	it('keeps links inside a long fence with shorter fence lines', () => {
		const body = `\`\`\`\`markdown\n\`\`\`\n[Code](:/${id(2)})\n\`\`\`\`\n[Outside](:/${id(2)})`;
		expect(convertLinks(body, new Map([[id(2), 'Out/Target']]), new Map()).body).toBe(body.replace('[Outside](:/' + id(2) + ')', '[[Out/Target|Outside]]'));
	});

	it('does not close a fence with a line that has text after the fence', () => {
		const body = `~~~\n~~~ still code\n[Code](:/${id(2)})\n~~~`;
		expect(convertLinks(body, new Map([[id(2), 'Out/Target']]), new Map()).body).toBe(body);
	});

	it('reads PAX record lengths as bytes for Unicode paths', () => {
		const path = 'resources/é.png';
		const payload = `path=${path}\n`;
		let length = enc.encode(payload).length + 2;
		while (length !== enc.encode(`${length} ${payload}`).length) length = enc.encode(`${length} ${payload}`).length;
		const data = enc.encode(`${length} ${payload}13 uid=1000\n`);
		const tar = writeTar([{ name: 'PaxHeader', type: 'x', data }, { name: 'short', data: enc.encode('image') }]);
		expect(readTar(tar)[0]!.name).toBe(path);
	});

	it('keeps notebook paths when archive member order changes', () => {
		const a = archive();
		a.folders = [{ id: id(10), parentId: '', title: 'Work' }, { id: id(11), parentId: '', title: 'work' }];
		a.notes[0]!.parentId = id(10);
		const first = planImport(a, 'Out', () => false);
		a.folders.reverse();
		expect(planImport(a, 'Out', () => false).notes[0]!.path).toBe(first.notes[0]!.path);
	});

	it('does not count an HTML target as a resolved import link', () => {
		const a = archive();
		a.notes[0]!.body = `[HTML](:/${id(2)})`;
		a.notes.push({ ...note('<p>HTML</p>'), id: id(2), markup: 'html' });
		const result = auditArchives([{ name: 'a.jex', archive: a }]).archives[0]!;
		expect(result.resolved).toBe(0);
		expect(result.missing).toHaveLength(1);
	});

	it('does not count fenced code samples as missing audit links', () => {
		const a = archive();
		a.notes[0]!.body = `\`\`\`\n[Example](:/${id(2)})\n\`\`\``;
		const result = auditArchives([{ name: 'a.jex', archive: a }]).archives[0]!;
		expect(result.noteLinks).toBe(0);
		expect(result.missing).toEqual([]);
	});

	it('rejects two different item files with the same source ID before writes', () => {
		const tar = writeTar([1, 2].map((n) => ({ name: `${id(n)}.md`, data: enc.encode(`Title ${n}\n\nBody ${n}\n\nid: ${id(1)}\ntype_: 1`) })));
		expect(() => readJex(tar)).toThrow(/Duplicate Joplin item ID/);
	});
});
