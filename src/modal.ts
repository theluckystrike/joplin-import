import { Modal, Setting, type TFile } from 'obsidian';
import type { Plan } from './convert';
import { jexFiles, type ResyncPreview } from './importer';
import { TEXT } from './copy';
import { isPro, proNotice } from './pro';
import type JoplinImportPlugin from './main';

export const TITLE = 'Import a Joplin archive';

export class ImportModal extends Modal {
	private file: TFile | null;
	private plan: Plan | null = null;
	private resync: ResyncPreview | null = null;
	private folder: string;
	private busy = false;
	private disposed = false;
	private generation = 0;
	private readonly auditPick = new Set<string>();
	private status: HTMLElement | null = null;
	private preview: HTMLElement | null = null;
	private actions: HTMLElement | null = null;
	private proEl: HTMLElement | null = null;

	constructor(private readonly plugin: JoplinImportPlugin, file?: TFile) {
		super(plugin.app);
		const files = jexFiles(plugin.app.vault);
		this.file = file ?? files[0] ?? null;
		this.folder = plugin.settings.folder;
	}

	onOpen(): void {
		this.setTitle(TITLE);
		this.modalEl.addClass('joplin-import-modal');
		this.contentEl.addClass('joplin-import');
		const files = jexFiles(this.app.vault);
		this.contentEl.createEl('p', { text: TEXT.intro });
		if (!files.length) {
			this.contentEl.createEl('p', { cls: 'joplin-import-empty', text: 'No .jex file is in this vault. In Joplin, select File, Export all, JEX. Then copy the file into the vault and run this command again.' });
		} else {
			new Setting(this.contentEl).setName('Archive').setDesc(TEXT.archiveHelp).addDropdown((d) => {
				for (const f of files) d.addOption(f.path, f.path);
				d.setValue(this.file?.path ?? '').onChange((path) => {
					this.file = files.find((f) => f.path === path) ?? null;
					this.invalidate();
				});
			});
		}
		new Setting(this.contentEl).setName('Output folder').setDesc('The plugin creates this folder if it does not exist. Existing paths in it are skipped.').addText((t) => t.setValue(this.folder).onChange((v) => {
			this.folder = v;
			this.invalidate();
		}));
		this.status = this.contentEl.createDiv({ cls: 'joplin-import-status', attr: { role: 'status', 'aria-live': 'polite' } });
		this.preview = this.contentEl.createDiv({ cls: 'joplin-import-preview' });
		this.actions = this.contentEl.createDiv({ cls: 'joplin-import-actions' });
		this.proEl = this.contentEl.createDiv({ cls: 'joplin-import-pro' });
		this.invalidate();
		this.updatePro();
	}

	private invalidate(): void {
		this.generation++;
		this.plan = null;
		this.resync = null;
		this.preview?.empty();
		this.message(this.file ? 'Select Preview to read the archive.' : 'No archive selected.');
		this.drawActions();
	}

	private message(text: string): void {
		this.status?.setText(text);
	}

	private async run(action: () => Promise<void>): Promise<void> {
		if (this.busy || this.disposed) return;
		this.busy = true;
		this.drawActions();
		this.updatePro();
		try {
			await action();
		} catch (e) {
			this.plan = null;
			this.resync = null;
			this.preview?.empty();
			this.message(e instanceof Error ? e.message : String(e));
		} finally {
			this.busy = false;
			if (!this.disposed) {
				this.drawActions();
				this.updatePro();
			}
		}
	}

	/** Reads the archive and converts it in memory. Writes nothing. */
	async refreshPreview(): Promise<void> {
		if (!this.file) throw new Error('No archive selected.');
		const generation = ++this.generation;
		this.message(`Reading ${this.file.name}…`);
		const archive = await this.plugin.readArchive(this.file);
		const plan = this.plugin.prepare(archive, this.folder);
		if (this.disposed || generation !== this.generation) return;
		this.plan = plan;
		this.resync = null;
		this.drawPreview(plan);
		this.drawActions();
		this.updatePro();
		this.message('Preview ready. Nothing is written until you select Import.');
	}

	private drawPreview(plan: Plan): void {
		const el = this.preview;
		if (!el) return;
		el.empty();
		const c = plan.counts;
		el.createEl('p', { cls: 'joplin-import-counts', text: `${c.notes} notes · ${c.notebooks} notebooks · ${c.tags} tags · ${c.resources} resources` });
		const newNotes = plan.notes.filter((n) => n.status === 'new').length;
		const newFiles = plan.attachments.filter((a) => a.status === 'new').length;
		const existing = plan.notes.length - newNotes + plan.attachments.length - newFiles;
		el.createEl('p', { cls: 'joplin-import-plan', text: `New: ${newNotes} notes and ${newFiles} attachments in ${plan.folder}. Existing paths to skip: ${existing}.` });
		const list = el.createEl('ul', { cls: 'joplin-import-paths' });
		for (const n of plan.notes.slice(0, 6)) list.createEl('li', { text: n.path });
		if (plan.notes.length > 6) list.createEl('li', { text: `${plan.notes.length - 6} more notes.` });
		this.list(el, 'Missing resources', plan.report.missingResources);
		this.list(el, 'Missing note links', plan.report.missingNotes);
		this.list(el, 'Unsupported items', plan.report.unsupported);
		this.list(el, 'Changed tags', plan.report.tags);
		this.list(el, 'Notebook problems', plan.report.notebooks);
	}

	private list(el: HTMLElement, title: string, values: string[]): void {
		if (!values.length) return;
		const details = el.createEl('details', { cls: 'joplin-import-list' });
		details.createEl('summary', { text: `${title} (${values.length})` });
		const ul = details.createEl('ul');
		for (const v of values.slice(0, 30)) ul.createEl('li', { text: v });
		if (values.length > 30) ul.createEl('li', { text: `${values.length - 30} more items.` });
	}

	private drawActions(): void {
		const el = this.actions;
		if (!el || this.disposed) return;
		el.empty();
		const plan = this.plan;
		const canWrite = !!plan && (plan.notes.some((n) => n.status === 'new') || plan.attachments.some((a) => a.status === 'new'));
		new Setting(el)
			.addButton((b) => b.setButtonText('Preview').setDisabled(this.busy || !this.file).onClick(() => void this.run(() => this.refreshPreview())))
			.addButton((b) => b.setButtonText('Import').setCta().setDisabled(this.busy || !canWrite).onClick(() => void this.run(() => this.doImport())));
	}

	/** Writes the previewed plan. */
	async doImport(): Promise<void> {
		const plan = this.plan;
		const file = this.file;
		if (!plan || !file) throw new Error('Select Preview first.');
		this.message('Writing files…');
		const r = await this.plugin.importPlan(plan, file.path);
		this.plan = null;
		if (this.disposed) return;
		this.preview?.empty();
		this.message(`Import complete: ${r.created} notes and ${r.attachments} attachments created, ${r.skipped} existing paths skipped, ${r.errors.length} errors.${r.report ? ` Report: ${r.report}` : ''}`);
		if (this.preview) this.list(this.preview, 'Import errors', r.errors);
		this.plugin.settings.folder = plan.folder;
		await this.plugin.saveSettings();
	}

	updatePro(): void {
		const el = this.proEl;
		if (!el || this.disposed) return;
		el.empty();
		const pro = isPro();
		const off = !pro || this.busy;
		el.createEl('h3', { text: TEXT.resync });
		el.createEl('p', { cls: 'setting-item-description', text: pro ? 'After Preview, list the imported notes whose source changed. Notes that you edited in the vault are listed and kept.' : 'With Pro, a later archive can update the notes of an earlier import. Notes that you edited in the vault stay unchanged.' });
		const rs = new Setting(el).addButton((b) => b.setButtonText('Preview changes').setDisabled(off || !this.plan).onClick(() => void this.run(() => this.previewChanges().then(() => undefined))));
		const changed = this.resync?.changed.length ?? 0;
		rs.addButton((b) => b.setButtonText(`Update ${changed} notes`).setDisabled(off || changed === 0).onClick(() => void this.run(() => this.updateChanged())));
		el.createEl('h3', { text: TEXT.audit });
		const files = jexFiles(this.app.vault);
		el.createEl('p', { cls: 'setting-item-description', text: 'Check the note links and resource links of the selected archives. The audit writes one report note into the output folder.' });
		for (const f of files) {
			new Setting(el).setName(f.path).addToggle((t) => t.setValue(this.auditPick.has(f.path)).setDisabled(off).onChange((v) => {
				if (v) this.auditPick.add(f.path);
				else this.auditPick.delete(f.path);
			}));
		}
		new Setting(el).setDesc('With no archive selected, the audit uses each .jex file in the vault.').addButton((b) => b.setButtonText('Write audit').setDisabled(off || !files.length).onClick(() => void this.run(() => this.writeAudit().then(() => undefined))));
	}

	/** Pro: lists the notes of the previewed archive that changed since the earlier import. Writes nothing. */
	async previewChanges(): Promise<ResyncPreview> {
		if (!this.plan) throw new Error('Select Preview first.');
		const generation = this.generation;
		const r = await this.plugin.resyncPreview(this.plan);
		if (this.disposed || generation !== this.generation) return r;
		this.resync = r;
		this.showResync(r);
		this.updatePro();
		return r;
	}

	/** Pro: writes the changed notes of the last change preview. */
	async updateChanged(): Promise<void> {
		if (!this.resync) throw new Error('Select Preview changes first.');
		const r = await this.plugin.applyResync(this.resync);
		this.resync = null;
		this.message(`Resync complete: ${r.updated} notes updated, ${r.skipped.length} skipped.`);
		this.updatePro();
	}

	/** Pro: writes the audit note for the selected archives, or for each archive when none is selected. */
	async writeAudit(paths: string[] = [...this.auditPick]): Promise<string> {
		const files = jexFiles(this.app.vault);
		const picked = files.filter((f) => paths.includes(f.path));
		const path = await this.plugin.audit(picked.length ? picked : files, this.folder);
		this.message(`Audit written: ${path}`);
		return path;
	}

	private showResync(r: ResyncPreview): void {
		this.message(`${r.changed.length} changed · ${r.edited.length} edited in the vault (kept) · ${r.unchanged} unchanged · ${r.notInVault} not imported yet.`);
		if (!this.preview) return;
		this.list(this.preview, 'Notes to update', r.changed.map((c) => c.path));
		this.list(this.preview, 'Edited in the vault (kept)', r.edited);
		this.list(this.preview, 'Other files at the note path (kept)', r.other);
	}

	onClose(): void {
		this.disposed = true;
		this.generation++;
		this.contentEl.empty();
		this.plan = null;
		this.resync = null;
		this.plugin.closed(this);
	}
}

export function notifyNeedsPro(feature: string): void {
	proNotice(`${feature} needs Pro.`);
}
