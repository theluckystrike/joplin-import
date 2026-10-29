import { PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { sponsorsSettingItems } from './license/github-obsidian';
import { safeFolder } from './convert';
import { PRO_UI } from './pro';
import type JoplinImportPlugin from './main';

export interface JoplinImportSettings {
	/** Default output folder. The import window can change it for one import. */
	folder: string;
	/** Write a report note into the output folder after each import. */
	report: boolean;
}

export const DEFAULT_SETTINGS: JoplinImportSettings = {
	folder: 'Joplin import',
	report: true,
};

/** Fills gaps and drops bad values from saved data, so old or hand-edited data.json never breaks the plugin. */
export function normalizeSettings(saved: unknown): JoplinImportSettings {
	const s = typeof saved === 'object' && saved !== null ? (saved as Partial<JoplinImportSettings>) : {};
	let folder = DEFAULT_SETTINGS.folder;
	try {
		if (typeof s.folder === 'string') folder = safeFolder(s.folder);
	} catch {
		// Keep the default folder.
	}
	return { folder, report: typeof s.report === 'boolean' ? s.report : DEFAULT_SETTINGS.report };
}

export class JoplinImportSettingTab extends PluginSettingTab {
	constructor(app: ConstructorParameters<typeof PluginSettingTab>[0], readonly plugin: JoplinImportPlugin) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{ name: 'Output folder', desc: 'Default vault folder for imported notes and attachments. You can change it in the import window.', control: { type: 'text', key: 'folder', defaultValue: DEFAULT_SETTINGS.folder } },
			{ name: 'Write a report note', desc: 'After each import, write a note with the counts, missing resources and unsupported items into the output folder.', control: { type: 'toggle', key: 'report', defaultValue: DEFAULT_SETTINGS.report } },
			...(this.plugin.pro ? sponsorsSettingItems(this.plugin.pro, PRO_UI) : []),
		];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key === 'folder' && typeof value === 'string') {
			try {
				safeFolder(value);
			} catch {
				return;
			}
		}
		await super.setControlValue(key, value);
		this.plugin.settings = normalizeSettings(this.plugin.settings);
	}
}
