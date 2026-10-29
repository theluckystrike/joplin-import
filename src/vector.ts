// Golden vector driver. The plugin does not use it: tests/vectors.test.ts and the end-to-end test call it.
// A case gives tar members as text or base64. The driver makes a real tar file, reads it with the plugin's
// tar reader and converts it with planImport. Paths in "existing" act as files that are already in the vault.
import { planImport } from './convert';
import { readJex } from './joplin';
import { writeTar } from './tar';

export interface VectorMember { name: string; text?: string; base64?: string; type?: string; link?: string }

function bytesOf(m: VectorMember): Uint8Array {
	if (m.base64 !== undefined) {
		const raw = atob(m.base64);
		const b = new Uint8Array(raw.length);
		for (let i = 0; i < raw.length; i++) b[i] = raw.charCodeAt(i);
		return b;
	}
	return new TextEncoder().encode(m.text ?? '');
}

export function jexBytes(members: VectorMember[]): Uint8Array {
	return writeTar(members.map((m) => ({ name: m.name, data: bytesOf(m), type: m.type, link: m.link })));
}

/** Reads and plans a JEX made from the members. Returns the plan summary, or the error text. */
export function importCase(members: VectorMember[], folder: string, existing: string[] = []): Record<string, unknown> {
	try {
		const a = readJex(jexBytes(members));
		const plan = planImport(a, folder, (p) => existing.includes(p));
		return {
			counts: plan.counts,
			folders: plan.folders,
			notes: Object.fromEntries(plan.notes.map((n) => [n.path, n.text])),
			newPaths: [...plan.attachments, ...plan.notes].filter((x) => x.status === 'new').map((x) => x.path),
			skipped: [...plan.attachments, ...plan.notes].filter((x) => x.status === 'existing').map((x) => x.path),
			attachments: plan.attachments.map((x) => ({ path: x.path, size: x.data.length })),
			report: plan.report,
		};
	} catch (e) {
		return { error: e instanceof Error ? e.message : String(e) };
	}
}
