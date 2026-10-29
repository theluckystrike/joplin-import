import { browser, expect } from '@wdio/globals';
import { pluginId, reloadPlugin } from './load';

describe(`${pluginId} smoke test`, function () {
	it('is enabled and reloads with no console errors', async function () {
		const state = await reloadPlugin(pluginId);
		expect(state).toEqual({ enabled: true, reloaded: true, errors: [] });
	});

	it('has the import command', async function () {
		const ids = await browser.executeObsidian(({ app }) => Object.keys((app as unknown as { commands: { commands: Record<string, unknown> } }).commands.commands));
		expect(ids).toContain(`${pluginId}:import-archive`);
	});
});
