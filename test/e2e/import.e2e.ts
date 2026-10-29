import { browser, expect } from '@wdio/globals';
import data from '../../tests/vectors/joplin-import.json';
import type { SponsorsManager } from '../../src/license/index';
import type JoplinImportPlugin from '../../src/main';
import { jexBytes, type VectorMember } from '../../src/vector';
import { demoPng } from '../../tests/sample';
import { pluginId } from './load';

// Real-app checks on the demo vault. "Joplin Export Import/Joplin export.jex" has 3 notebooks, 5 notes (1 HTML),
// 2 tags and 2 resources (1 without a file). tests/sample.test.ts pins the same numbers. No check depends on
// timing (waits poll a state) or on the theme.
const vectors = data as unknown as { cases: { name: string; args: unknown[]; expected: Record<string, unknown> }[] };
type Plugins = { plugins: { plugins: Record<string, JoplinImportPlugin> } };
const DIR = 'Joplin Export Import';
const DEMO = `${DIR}/Joplin export.jex`;
const LATER = `${DIR}/Joplin export later.jex`;
const PLAN = 'Q3 plan--4d5e6f70819243a4a526d7e8f90a1b23.md';
const TRIP = 'Lisbon trip--6f708192a31445c6c748f90a1b2c3d45.md';
const PHOTO = '_resources/92a3b4c5d64758f9fa7b2c3d4e5f6078.png';

async function closeModals(): Promise<void> {
	await browser.executeObsidian(({ app }, id) => { (app as unknown as Plugins).plugins.plugins[id]!.closeImportWindows(); }, pluginId);
}

/** Pro on: a synthetic token store and GitHub answer. Pro off: sign out. No network request. */
async function setPro(on: boolean): Promise<void> {
	await browser.executeObsidian(async ({ app }, id, enabled) => {
		const pro = (app as unknown as Plugins).plugins.plugins[id]!.pro as SponsorsManager;
		if (!enabled) { pro.signOut(); return; }
		let token: string | null = 'gho_' + '0'.repeat(36);
		pro.opts.tokens.get = () => token; pro.opts.tokens.set = (v) => { token = v; }; pro.opts.tokens.clear = () => { token = null; };
		pro.opts.http = async () => ({ status: 200, json: { data: { viewer: { login: 'demo-reader', totalSponsorshipAmountAsSponsorInCents: 1500 }, user: { viewerIsSponsoring: true, sponsorshipForViewerAsSponsor: { isActive: true, isOneTimePayment: false, tier: { name: '$5 a month', monthlyPriceInCents: 500 } } } } } });
		await pro.refreshNow();
	}, pluginId, on);
}

/** Writes a .jex file into the vault from bytes made on the test side. */
async function putJex(path: string, members: VectorMember[]): Promise<void> {
	await browser.executeObsidian(async ({ app }, p, bytes) => {
		const old = app.vault.getFileByPath(p);
		if (old) await app.vault.delete(old);
		const dir = p.split('/').slice(0, -1).join('/');
		if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
		await app.vault.createBinary(p, new Uint8Array(bytes).buffer);
	}, path, Array.from(jexBytes(members)));
}

async function openWindow(archive: string, folder: string): Promise<void> {
	await browser.executeObsidian(({ app }, id, f) => { (app as unknown as Plugins).plugins.plugins[id]!.settings.folder = f; }, pluginId, folder);
	await browser.executeObsidianCommand(`${pluginId}:import-archive`);
	await browser.$('.joplin-import-modal select').selectByAttribute('value', archive);
}

const statusText = async () => browser.$('.joplin-import-status').getText();

describe('Joplin Export Import in the real app', function () {
	afterEach(async () => { await closeModals(); await setPro(false); });

	it('runs the golden vectors with the plugin reader in the app', async () => {
		for (const c of vectors.cases.filter((v) => (v.args[2] as string[] | undefined) === undefined)) {
			const path = `E2E vectors/case.jex`;
			await putJex(path, c.args[0] as VectorMember[]);
			const got = await browser.executeObsidian(async ({ app }, id, p, folder) => {
				const pl = (app as unknown as Plugins).plugins.plugins[id]!;
				try {
					const plan = pl.prepare(await pl.readArchive(app.vault.getFileByPath(p)!), folder);
					return JSON.stringify({
						counts: plan.counts, folders: plan.folders,
						notes: Object.fromEntries(plan.notes.map((n) => [n.path, n.text])),
						newPaths: [...plan.attachments, ...plan.notes].filter((x) => x.status === 'new').map((x) => x.path),
						skipped: [...plan.attachments, ...plan.notes].filter((x) => x.status === 'existing').map((x) => x.path),
						attachments: plan.attachments.map((x) => ({ path: x.path, size: x.data.length })),
						report: plan.report,
					});
				} catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
			}, pluginId, path, c.args[1] as string);
			const parsed = JSON.parse(got) as Record<string, unknown>;
			expect(Object.fromEntries(Object.keys(c.expected).map((k) => [k, parsed[k]]))).toEqual(c.expected);
		}
	});

	it('closing the window after Preview creates no folder or file', async () => {
		const before = await browser.executeObsidian(({ app }) => app.vault.getAllLoadedFiles().length);
		await openWindow(DEMO, 'E2E closed');
		await browser.$('button=Preview').click();
		await browser.waitUntil(async () => (await statusText()).includes('Preview ready'), { timeout: 20000, timeoutMsg: 'Preview did not finish' });
		expect(await browser.$('.joplin-import-counts').getText()).toBe('5 notes · 3 notebooks · 2 tags · 2 resources');
		await browser.keys('Escape');
		await browser.waitUntil(async () => !(await browser.$('.joplin-import-modal').isExisting()), { timeout: 20000 });
		expect(await browser.executeObsidian(({ app }) => app.vault.getAllLoadedFiles().length)).toBe(before);
		expect(await browser.executeObsidian(({ app }) => app.vault.getAbstractFileByPath('E2E closed'))).toBeNull();
	});

	it('imports the demo archive in the window: folders, links, embed, tags, dates and report', async () => {
		await openWindow(DEMO, 'E2E import');
		await browser.$('button=Preview').click();
		await browser.waitUntil(async () => (await statusText()).includes('Preview ready'), { timeout: 20000 });
		expect(await browser.$('.joplin-import-plan').getText()).toContain('New: 4 notes and 1 attachments in E2E import.');
		await browser.$('button=Import').click();
		await browser.waitUntil(async () => (await statusText()).includes('Import complete'), { timeout: 20000, timeoutMsg: 'Import did not finish' });
		expect(await statusText()).toContain('4 notes and 1 attachments created, 0 existing paths skipped, 0 errors.');
		await browser.waitUntil(async () => browser.executeObsidian(({ app }, plan, trip) => {
			const f = app.vault.getFileByPath(`E2E import/Work/${plan}`);
			const t = app.vault.getFileByPath(`E2E import/Personal/${trip}`);
			return !!f && !!t && !!app.metadataCache.getFileCache(f)?.frontmatter
				&& app.metadataCache.getFileCache(f)?.links?.length === 2
				&& app.metadataCache.getFileCache(t)?.embeds?.length === 1;
		}, PLAN, TRIP), { timeout: 20000, timeoutMsg: 'metadata cache did not index the note' });
		const out = await browser.executeObsidian(async ({ app }, plan, trip, photo) => {
			const p = app.vault.getFileByPath(`E2E import/Work/${plan}`)!;
			const t = app.vault.getFileByPath(`E2E import/Personal/${trip}`)!;
			const fm = app.metadataCache.getFileCache(p)!.frontmatter!;
			const links = (app.metadataCache.getFileCache(p)?.links ?? []).map((l) => app.metadataCache.getFirstLinkpathDest(l.link.split('#')[0]!, p.path)?.path ?? null);
			const embeds = (app.metadataCache.getFileCache(t)?.embeds ?? []).map((l) => app.metadataCache.getFirstLinkpathDest(l.link, t.path)?.path ?? null);
			const png = new Uint8Array(await app.vault.readBinary(app.vault.getFileByPath(`E2E import/${photo}`)!));
			return {
				fm: { tags: fm.tags as unknown, created: fm.created as unknown, updated: fm.updated as unknown, id: fm.joplin_id as unknown },
				links, embeds, pngMagic: Array.from(png.slice(0, 4)),
				trip: await app.vault.read(t),
				reports: app.vault.getMarkdownFiles().filter((f) => f.path.startsWith('E2E import/Joplin import report')).length,
				meetings: app.vault.getAbstractFileByPath('E2E import/Work/Meetings') !== null,
				html: app.vault.getMarkdownFiles().some((f) => f.path.startsWith('E2E import/') && f.path.includes('Web clip')),
			};
		}, PLAN, TRIP, PHOTO);
		expect(out.fm).toEqual({ tags: ['Research'], created: '2023-02-01T09:30:00.000Z', updated: '2023-06-15T09:30:00.000Z', id: '4d5e6f70819243a4a526d7e8f90a1b23' });
		expect(out.links).toEqual(['E2E import/Work/Meetings/Weekly standup--5e6f7081920344b5b637e8f90a1b2c34.md', 'E2E import/Personal/Budget--8192a3b4c53647e8e96a1b2c3d4e5f67.md']);
		expect(out.embeds).toContain(`E2E import/${PHOTO}`);
		expect(out.pngMagic).toEqual([0x89, 0x50, 0x4e, 0x47]);
		expect(out.trip).toContain('The second photo is lost: ![Tram](:/a3b4c5d6e7586901ab8c3d4e5f607189)');
		expect(out.reports).toBe(1);
		expect(out.meetings).toBe(true);
		expect(out.html).toBe(false);
	});

	it('a second import skips existing paths and keeps their bytes', async () => {
		const out = await browser.executeObsidian(async ({ app }, id, demo, plan, photo) => {
			const p = (app as unknown as Plugins).plugins.plugins[id]!;
			const a = await p.readArchive(app.vault.getFileByPath(demo)!);
			await p.importPlan(p.prepare(a, 'E2E repeat'), demo);
			const note = app.vault.getFileByPath(`E2E repeat/Work/${plan}`)!;
			await app.vault.modify(note, 'My own text');
			const before = Array.from(new Uint8Array(await app.vault.readBinary(app.vault.getFileByPath(`E2E repeat/${photo}`)!)));
			const second = await p.importPlan(p.prepare(a, 'E2E repeat'), demo);
			const after = Array.from(new Uint8Array(await app.vault.readBinary(app.vault.getFileByPath(`E2E repeat/${photo}`)!)));
			return { second: { created: second.created, attachments: second.attachments, skipped: second.skipped }, text: await app.vault.read(note), same: JSON.stringify(before) === JSON.stringify(after) };
		}, pluginId, DEMO, PLAN, PHOTO);
		expect(out.second).toEqual({ created: 0, attachments: 0, skipped: 5 });
		expect(out.text).toBe('My own text');
		expect(out.same).toBe(true);
	});

	it('rejects an unsafe archive in the window before any write', async () => {
		const unsafe = vectors.cases.find((c) => c.name === 'tar member ../../outside.txt rejects the archive')!;
		await putJex('E2E unsafe/unsafe.jex', unsafe.args[0] as VectorMember[]);
		const before = await browser.executeObsidian(({ app }) => app.vault.getAllLoadedFiles().length);
		await openWindow('E2E unsafe/unsafe.jex', 'E2E unsafe out');
		await browser.$('button=Preview').click();
		await browser.waitUntil(async () => (await statusText()).includes('Unsafe archive member'), { timeout: 20000 });
		expect(await browser.$('button=Import').isEnabled()).toBe(false);
		expect(await browser.executeObsidian(({ app }) => app.vault.getAllLoadedFiles().length)).toBe(before);
		expect(await browser.executeObsidian(({ app }) => app.vault.getAbstractFileByPath('E2E unsafe out'))).toBeNull();
	});

	it('Pro resync updates changed notes, keeps an edited note, and the audit writes a table', async () => {
		await setPro(true);
		const out = await browser.executeObsidian(async ({ app }, id, demo, later) => {
			const p = (app as unknown as Plugins).plugins.plugins[id]!;
			p.settings.report = false;
			await p.importPlan(p.prepare(await p.readArchive(app.vault.getFileByPath(demo)!), 'E2E resync'), demo);
			const standup = app.vault.getFileByPath('E2E resync/Work/Meetings/Weekly standup--5e6f7081920344b5b637e8f90a1b2c34.md')!;
			await app.vault.append(standup, '\nMy edit.');
			p.settings.folder = 'E2E resync';
			const m = p.openImport(app.vault.getFileByPath(later)!);
			await m.refreshPreview();
			const preview = await m.previewChanges();
			await m.updateChanged();
			const plan = await app.vault.read(app.vault.getFileByPath('E2E resync/Work/Q3 plan--4d5e6f70819243a4a526d7e8f90a1b23.md')!);
			const audit = await m.writeAudit([demo, later]);
			p.settings.report = true;
			return { changed: preview.changed.map((c) => c.path), edited: preview.edited, plan, standup: await app.vault.read(standup), audit: await app.vault.read(app.vault.getFileByPath(audit)!) };
		}, pluginId, DEMO, LATER);
		expect(out.changed).toEqual(['E2E resync/Work/Q3 plan--4d5e6f70819243a4a526d7e8f90a1b23.md']);
		expect(out.edited).toEqual(['E2E resync/Work/Meetings/Weekly standup--5e6f7081920344b5b637e8f90a1b2c34.md']);
		expect(out.plan).toContain('updated: 2024-08-20T09:30:00.000Z');
		expect(out.standup).toContain('My edit.');
		expect(out.audit).toContain(`| ${DEMO} | 5 | 1 | 3 | 2 | 4 | 0 | 1 | 0 |`);
	});

	it('imports a note with a 100-character CJK title, and a link to it resolves', async () => {
		const long = '漢'.repeat(100);
		const nid = 'b1c2d3e4f5a6478899aabbccddeeff01';
		const lid = 'b1c2d3e4f5a6478899aabbccddeeff02';
		await putJex('E2E long/long.jex', [
			{ name: `${nid}.md`, text: `${long}\n\nLong title body\n\nid: ${nid}\nparent_id: \nmarkup_language: 1\ntype_: 1` },
			{ name: `${lid}.md`, text: `Linker\n\nSee [the long note](:/${nid})\n\nid: ${lid}\nparent_id: \nmarkup_language: 1\ntype_: 1` },
		]);
		const out = await browser.executeObsidian(async ({ app }, id) => {
			const p = (app as unknown as Plugins).plugins.plugins[id]!;
			p.settings.report = false;
			const r = await p.importPlan(p.prepare(await p.readArchive(app.vault.getFileByPath('E2E long/long.jex')!), 'E2E long out'), 'E2E long/long.jex');
			p.settings.report = true;
			const names = app.vault.getMarkdownFiles().filter((f) => f.path.startsWith('E2E long out/')).map((f) => f.name);
			return { created: r.created, errors: r.errors, names };
		}, pluginId);
		expect(out.errors).toEqual([]);
		expect(out.created).toBe(2);
		const longName = out.names.find((n) => n.endsWith(`--${nid}.md`))!;
		expect(new TextEncoder().encode(longName).length).toBeLessThanOrEqual(255);
		await browser.waitUntil(async () => browser.executeObsidian(({ app }, linker) => {
			const f = app.vault.getMarkdownFiles().find((x) => x.path === linker);
			const link = f ? app.metadataCache.getFileCache(f)?.links?.[0]?.link : undefined;
			return !!f && !!link && app.metadataCache.getFirstLinkpathDest(link, f.path) !== null;
		}, `E2E long out/Linker--${lid}.md`), { timeout: 20000, timeoutMsg: 'the link to the long-title note did not resolve' });
	});

	it('Reading view of an imported note shows the image and resolved note links', async () => {
		await browser.executeObsidian(async ({ app }, id, demo) => {
			const p = (app as unknown as Plugins).plugins.plugins[id]!;
			p.settings.report = false;
			await p.importPlan(p.prepare(await p.readArchive(app.vault.getFileByPath(demo)!), 'E2E reading'), demo);
			p.settings.report = true;
		}, pluginId, DEMO);
		await browser.executeObsidian(async ({ app }, trip) => {
			await app.workspace.getLeaf(false).openFile(app.vault.getFileByPath(`E2E reading/Personal/${trip}`)!, { state: { mode: 'preview' } });
		}, TRIP);
		await browser.waitUntil(async () => (await browser.$$('.workspace-leaf.mod-active .markdown-reading-view .image-embed img').length) > 0, { timeout: 20000, timeoutMsg: 'Reading view shows no image embed' });
		const img = await browser.$('.workspace-leaf.mod-active .markdown-reading-view .image-embed img');
		expect(await img.getAttribute('src')).toContain('92a3b4c5d64758f9fa7b2c3d4e5f6078.png');
		await browser.waitUntil(async () => browser.execute(() => {
			const el = document.querySelector('.workspace-leaf.mod-active .markdown-reading-view img') as HTMLImageElement | null;
			return !!el && el.complete && el.naturalWidth === 240;
		}), { timeout: 20000, timeoutMsg: 'the embedded image did not load' });
		await browser.executeObsidian(async ({ app }, plan) => {
			await app.workspace.getLeaf(false).openFile(app.vault.getFileByPath(`E2E reading/Work/${plan}`)!, { state: { mode: 'preview' } });
		}, PLAN);
		await browser.waitUntil(async () => (await browser.$$('.workspace-leaf.mod-active .markdown-reading-view a.internal-link').length) === 2, { timeout: 20000, timeoutMsg: 'Reading view does not show 2 note links' });
		const unresolved = await browser.$$('.workspace-leaf.mod-active .markdown-reading-view a.internal-link.is-unresolved').length;
		expect(unresolved).toBe(0);
	});

	it('a web clip: linked images and an img tag show the image, and the note link resolves', async () => {
		const clip = 'c1c2d3e4f5a6478899aabbccddeeff01';
		const other = 'c1c2d3e4f5a6478899aabbccddeeff02';
		const res = 'c1c2d3e4f5a6478899aabbccddeeff03';
		const png = btoa(String.fromCharCode(...demoPng()));
		const body = [`[![](:/${res})](https://example.com/page)`, '', `[![photo](:/${res})](:/${other})`, '', `<img src=":/${res}" alt="x" width="120">`].join('\n');
		await putJex('E2E clip/clip.jex', [
			{ name: `${clip}.md`, text: `Clip\n\n${body}\n\nid: ${clip}\nparent_id: \nmarkup_language: 1\ntype_: 1` },
			{ name: `${other}.md`, text: `Other note\n\nTarget\n\nid: ${other}\nparent_id: \nmarkup_language: 1\ntype_: 1` },
			{ name: `${res}.md`, text: `coast.png\n\nid: ${res}\nmime: image/png\nfile_extension: png\ntype_: 4` },
			{ name: `resources/${res}.png`, base64: png },
		]);
		const path = await browser.executeObsidian(async ({ app }, id) => {
			const p = (app as unknown as Plugins).plugins.plugins[id]!;
			p.settings.report = false;
			const plan = p.prepare(await p.readArchive(app.vault.getFileByPath('E2E clip/clip.jex')!), 'E2E clip out');
			await p.importPlan(plan, 'E2E clip/clip.jex');
			p.settings.report = true;
			return plan.notes.find((n) => n.path.includes('/Clip--'))!.path;
		}, pluginId);
		const resolved = async () => browser.executeObsidian(async ({ app }, p) => {
			const f = app.vault.getFileByPath(p)!;
			const c = app.metadataCache.getFileCache(f);
			const targets = [...(c?.links ?? []), ...(c?.embeds ?? [])].map((l) => [l.link, app.metadataCache.getFirstLinkpathDest(l.link.split('#')[0]!, p)?.path ?? null]);
			return { ok: targets.length === 4 && targets.every((t) => t[1] !== null), targets, text: await app.vault.read(f) };
		}, path);
		try {
			await browser.waitUntil(async () => (await resolved()).ok, { timeout: 20000 });
		} catch {
			throw new Error(`the clip links and embeds did not resolve: ${JSON.stringify(await resolved())}`);
		}
		await browser.executeObsidian(async ({ app }, p) => {
			await app.workspace.getLeaf(false).openFile(app.vault.getFileByPath(p)!, { state: { mode: 'preview' } });
		}, path);
		await browser.waitUntil(async () => browser.execute(() => {
			const imgs = [...document.querySelectorAll('.workspace-leaf.mod-active .markdown-reading-view img')] as HTMLImageElement[];
			return imgs.length === 3 && imgs.every((i) => i.complete && i.naturalWidth === 240);
		}), { timeout: 20000, timeoutMsg: 'Reading view does not show 3 loaded images' });
		const text = await browser.$('.workspace-leaf.mod-active .markdown-reading-view').getText();
		expect(text).not.toContain('](');
		expect(text).not.toContain(':/');
	});

	it('without Pro the resync and the audit are refused and write nothing', async () => {
		await setPro(false);
		const out = await browser.executeObsidian(async ({ app }, id, demo) => {
			const p = (app as unknown as Plugins).plugins.plugins[id]!;
			const plan = p.prepare(await p.readArchive(app.vault.getFileByPath(demo)!), 'E2E free');
			const errors: string[] = [];
			try { await p.resyncPreview(plan); } catch (e) { errors.push(String(e)); }
			try { await p.audit([app.vault.getFileByPath(demo)!], 'E2E free'); } catch (e) { errors.push(String(e)); }
			return { errors, folder: app.vault.getAbstractFileByPath('E2E free') !== null };
		}, pluginId, DEMO);
		expect(out.errors.length).toBe(2);
		expect(out.errors.every((e) => e.includes('needs Pro'))).toBe(true);
		expect(out.folder).toBe(false);
	});
});
