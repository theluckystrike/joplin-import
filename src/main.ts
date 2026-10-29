import { Plugin, TFile, normalizePath } from 'obsidian';
import type { SponsorsManager } from './license/index';
import { createGitHubSponsors } from './license/github-obsidian';
import { TEXT } from './copy';
import { auditArchives, auditMarkdown } from './audit';
import { safeFolder, type Plan } from './convert';
import { applyResync, ensureFolders, prepareImport, readArchiveFile, resyncPreview, stamp, writeImport, type ImportResult, type ResyncPreview } from './importer';
import type { Archive } from './joplin';
import { ImportModal, TITLE, notifyNeedsPro } from './modal';
import { SPONSORS, bindPro, isPro, resetPro } from './pro';
import { JoplinImportSettingTab, normalizeSettings, type JoplinImportSettings } from './settings';

export default class JoplinImportPlugin extends Plugin {
	settings: JoplinImportSettings = normalizeSettings(null);
	/** GitHub Sponsors Pro state. Created in onload; null before that. */
	pro: SponsorsManager | null = null;
	private tab: JoplinImportSettingTab | null = null;
	private readonly modals = new Set<ImportModal>();
	private writing = false;
	private loadGeneration = 0;

	async onload(): Promise<void> {
		const generation = ++this.loadGeneration;
		await this.loadSettings();
		if (generation !== this.loadGeneration) return;
		// No request here: a request needs a GitHub sign in first (Settings, Pro, Sign in with GitHub).
		const pro = createGitHubSponsors(this.app, this.manifest.id, SPONSORS, this);
		pro.init();
		this.pro = pro;
		bindPro(pro);
		this.tab = new JoplinImportSettingTab(this.app, this);
		this.addSettingTab(this.tab);
		this.register(pro.onChange(() => {
			this.tab?.update();
			for (const m of this.modals) m.updatePro();
		}));
		this.addCommand({ id: 'import-archive', name: TITLE, callback: () => { this.openImport(); } });
		this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
			if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'jex') return;
			menu.addItem((item) => item.setTitle(TEXT.menu).setIcon('download').onClick(() => { this.openImport(file); }));
		}));
		this.app.workspace.onLayoutReady(() => {
			if (generation !== this.loadGeneration) return;
			void pro.refresh();
			this.registerInterval(window.setInterval(() => void pro.refresh(), 6 * 60 * 60 * 1000));
		});
	}

	onunload(): void {
		this.loadGeneration++;
		this.closeImportWindows();
		resetPro();
	}

	openImport(file?: TFile): ImportModal {
		this.closeImportWindows();
		const modal = new ImportModal(this, file);
		this.modals.add(modal);
		modal.open();
		return modal;
	}

	closeImportWindows(): void {
		for (const m of [...this.modals]) m.close();
		this.modals.clear();
	}

	closed(modal: ImportModal): void {
		this.modals.delete(modal);
	}

	readArchive(file: TFile): Promise<Archive> {
		return readArchiveFile(this.app.vault, file);
	}

	prepare(archive: Archive, folder: string): Plan {
		return prepareImport(this.app.vault, archive, folder);
	}

	async importPlan(plan: Plan, source: string, now?: Date): Promise<ImportResult> {
		if (this.writing) throw new Error('An import is in progress.');
		this.writing = true;
		try {
			const generation = this.loadGeneration;
			return await writeImport(this.app.vault, plan, source, { report: this.settings.report, now, stopped: () => generation !== this.loadGeneration });
		} finally {
			this.writing = false;
		}
	}

	/** Pro: lists the imported notes that a later archive changes. Writes nothing. */
	async resyncPreview(plan: Plan): Promise<ResyncPreview> {
		if (!isPro()) {
			notifyNeedsPro('Resync');
			throw new Error('Resync needs Pro.');
		}
		return resyncPreview(this.app.vault, plan);
	}

	/** Pro: writes the changed notes of a resync preview. */
	async applyResync(preview: ResyncPreview): Promise<{ updated: number; skipped: string[] }> {
		if (!isPro()) {
			notifyNeedsPro('Resync');
			throw new Error('Resync needs Pro.');
		}
		if (this.writing) throw new Error('An import is in progress.');
		this.writing = true;
		try {
			const generation = this.loadGeneration;
			return await applyResync(this.app.vault, preview, () => generation !== this.loadGeneration);
		} finally {
			this.writing = false;
		}
	}

	/** Pro: reads each archive and writes one audit note into the folder. Returns the note path. */
	async audit(files: TFile[], folderInput: string, now: Date = new Date()): Promise<string> {
		if (!isPro()) {
			notifyNeedsPro('The audit');
			throw new Error('The audit needs Pro.');
		}
		const folder = safeFolder(folderInput);
		const list: { name: string; archive: Archive }[] = [];
		for (const f of files) list.push({ name: f.path, archive: await this.readArchive(f) });
		const s = stamp(now);
		const text = auditMarkdown(auditArchives(list), s);
		const parts = folder.split('/');
		await ensureFolders(this.app.vault, parts.map((_, i) => parts.slice(0, i + 1).join('/')));
		let path = normalizePath(`${folder}/Joplin archive audit ${s}.md`);
		for (let i = 2; this.app.vault.getAbstractFileByPath(path) && i < 100; i++) path = normalizePath(`${folder}/Joplin archive audit ${s} ${i}.md`);
		await this.app.vault.create(path, text);
		return path;
	}

	async loadSettings(): Promise<void> {
		this.settings = normalizeSettings(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
