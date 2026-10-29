// Pro: a link and attachment audit of several archives. Pure: it reads archive models and writes nothing.
import type { Archive } from './joplin';
import { mapOutsideFences } from './convert';

export interface ArchiveAudit {
	name: string;
	notes: number;
	htmlNotes: number;
	noteLinks: number;
	resourceLinks: number;
	/** Links to a note or resource in the same archive that the import can convert. */
	resolved: number;
	/** Links whose target is in a different selected archive, as "id in name". */
	inOther: string[];
	/** Link targets in no selected archive, and resources without a file. */
	missing: string[];
	/** Resources that no note links to. */
	unused: string[];
	unsupported: number;
}
export interface AuditResult { archives: ArchiveAudit[]; sharedNotes: string[] }

const LINK = /(!?)\[[^\]\n]*\]\(:\/([0-9a-f]{32})(?:#[^)\s]*)?\)/g;

export function auditArchives(list: { name: string; archive: Archive }[]): AuditResult {
	const owner = new Map<string, string[]>();
	for (const { name, archive } of list) {
		for (const id of [...archive.notes.map((n) => n.id), ...archive.resources.keys()]) {
			const names = owner.get(id) ?? [];
			if (!names.includes(name)) names.push(name);
			owner.set(id, names);
		}
	}
	const archives = list.map(({ name, archive }): ArchiveAudit => {
		const out: ArchiveAudit = { name, notes: archive.notes.length, htmlNotes: 0, noteLinks: 0, resourceLinks: 0, resolved: 0, inOther: [], missing: [], unused: [], unsupported: archive.unsupported.length };
		const noteIds = new Set(archive.notes.filter((n) => n.markup === 'markdown').map((n) => n.id));
		const htmlIds = new Set(archive.notes.filter((n) => n.markup === 'html').map((n) => n.id));
		const used = new Set<string>();
		for (const n of archive.notes) {
			if (n.markup === 'html') { out.htmlNotes++; continue; }
			const links: RegExpMatchArray[] = [];
			mapOutsideFences(n.body, (line) => { for (const match of line.matchAll(LINK)) links.push(match); return line; });
			for (const m of links) {
				const id = m[2]!;
				const res = archive.resources.get(id);
				if (res) {
					out.resourceLinks++;
					used.add(id);
					if (res.data) out.resolved++;
					else out.missing.push(`Resource "${res.title}" (${id}) in note "${n.title}" has no file`);
					continue;
				}
				out.noteLinks++;
				if (noteIds.has(id)) { out.resolved++; continue; }
				if (htmlIds.has(id)) { out.missing.push(`HTML note ${id} in note "${n.title}" is not imported`); continue; }
				const others = (owner.get(id) ?? []).filter((x) => x !== name);
				if (others.length) out.inOther.push(`${id} in note "${n.title}" is in ${others.join(', ')}`);
				else out.missing.push(`${id} in note "${n.title}" is in no selected archive`);
			}
		}
		for (const r of archive.resources.values()) if (!used.has(r.id)) out.unused.push(`Resource "${r.title}" (${r.id})`);
		return out;
	});
	const sharedNotes: string[] = [];
	const allNotes = new Set(list.flatMap((l) => l.archive.notes.map((n) => n.id)));
	for (const [id, names] of owner) if (names.length > 1 && allNotes.has(id)) sharedNotes.push(`${id} is in ${names.join(', ')}`);
	return { archives, sharedNotes };
}

export function auditMarkdown(r: AuditResult, stamp: string): string {
	const out = [`# Joplin archive audit ${stamp}`, '', `Archives: ${r.archives.length}. The audit reads the archives and does not change them.`, '', '| Archive | Notes | HTML notes | Note links | Resource links | Resolved | In other archive | Missing | Unused resources |', '|---|---|---|---|---|---|---|---|---|'];
	for (const a of r.archives) out.push(`| ${a.name.replace(/\|/g, '/')} | ${a.notes} | ${a.htmlNotes} | ${a.noteLinks} | ${a.resourceLinks} | ${a.resolved} | ${a.inOther.length} | ${a.missing.length} | ${a.unused.length} |`);
	for (const a of r.archives) {
		const lists: [string, string[]][] = [['Targets in a different archive', a.inOther], ['Missing targets', a.missing], ['Unused resources', a.unused]];
		if (!lists.some(([, l]) => l.length)) continue;
		out.push('', `## ${a.name}`);
		for (const [title, l] of lists) if (l.length) out.push('', `### ${title}`, '', ...l.map((x) => `- ${x}`));
	}
	if (r.sharedNotes.length) out.push('', '## Items in more than one archive', '', ...r.sharedNotes.map((x) => `- ${x}`));
	return `${out.join('\n')}\n`;
}
