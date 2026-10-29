// Reads a Joplin JEX archive: a tar file with one "<id>.md" item file for each note, notebook, tag, note-tag
// relation and resource, and the resource bytes under "resources/". The item format is the Joplin sync format:
// the title, a blank line, the body, a blank line, then "key: value" lines. The last block is read from the end.
import { readTar, type TarMember } from './tar';

export const TYPE = { note: 1, folder: 2, resource: 4, tag: 5, noteTag: 6 } as const;
const TYPE_NAMES: Record<number, string> = { 3: 'setting', 7: 'saved search', 8: 'alarm', 9: 'master key', 10: 'item change', 11: 'note resource', 12: 'resource local state', 13: 'revision', 14: 'migration', 15: 'smart filter', 16: 'command' };

export interface JoplinItem { type: number; title: string; body: string; props: Record<string, string> }
export interface Note { id: string; parentId: string; title: string; body: string; markup: 'markdown' | 'html'; created: string | null; updated: string | null; todo: boolean; todoDone: boolean }
export interface Folder { id: string; parentId: string; title: string }
export interface Tag { id: string; title: string }
export interface Resource { id: string; title: string; mime: string; ext: string; data: Uint8Array | null }
export interface Archive {
	notes: Note[];
	folders: Folder[];
	tags: Tag[];
	/** Tag titles for each note id, in archive order. */
	noteTags: Map<string, string[]>;
	resources: Map<string, Resource>;
	/** Items that the import does not convert, one line each. */
	unsupported: string[];
}

export const ID = /^[0-9a-f]{32}$/;

function unescape(v: string): string {
	return v.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\\n/g, '\\n').replace(/\\\r/g, '\\r');
}

/** Parses one item file like Joplin's BaseItem.unserialize. Throws when the type_ line is missing. */
export function parseItem(content: string): JoplinItem {
	const lines = content.split('\n');
	const props: Record<string, string> = {};
	const body: string[] = [];
	let readingProps = true;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i] ?? '';
		if (readingProps) {
			const t = line.trim();
			if (t === '') { readingProps = false; continue; }
			const p = t.indexOf(':');
			if (p < 0) throw new Error(`Invalid property line "${t.slice(0, 60)}".`);
			props[t.slice(0, p).trim()] = unescape(t.slice(p + 1).trim());
		} else {
			body.push(line);
		}
	}
	const type = Number(props.type_);
	if (!props.type_ || !Number.isInteger(type)) throw new Error('Missing property type_.');
	body.reverse();
	const title = body.length ? body.splice(0, 2)[0] ?? '' : '';
	return { type, title, body: type === TYPE.note ? body.join('\n') : '', props };
}

/** A Joplin time value (ISO text or Unix milliseconds) as an ISO value in UTC, or null. */
export function isoTime(v: string | undefined): string | null {
	if (!v) return null;
	const ms = /^-?\d+$/.test(v) ? Number(v) : Date.parse(v);
	const date = new Date(ms);
	if (!Number.isFinite(date.getTime()) || v === '0') return null;
	return date.toISOString();
}

const decoder = new TextDecoder('utf-8');

/** Builds the archive model from tar members. Unknown members and item types go into the unsupported list. */
export function readMembers(members: TarMember[]): Archive {
	const a: Archive = { notes: [], folders: [], tags: [], noteTags: new Map(), resources: new Map(), unsupported: [] };
	const relations: { noteId: string; tagId: string }[] = [];
	const blobs = new Map<string, { ext: string; data: Uint8Array }>();
	const other = new Map<string, number>();
	const seenIds = new Set<string>();
	for (const m of members) {
		const blob = /^resources\/([0-9a-f]{32})(?:\.([^/]*))?$/.exec(m.name);
		if (blob) { blobs.set(blob[1]!, { ext: blob[2] ?? '', data: m.data }); continue; }
		const item = /^([0-9a-f]{32})\.md$/.exec(m.name);
		if (!item) { a.unsupported.push(`Unknown archive member ${m.name}`); continue; }
		let it: JoplinItem;
		try { it = parseItem(decoder.decode(m.data)); } catch (e) {
			a.unsupported.push(`Item ${m.name} cannot be read: ${e instanceof Error ? e.message : String(e)}`);
			continue;
		}
		const id = ID.test(it.props.id ?? '') ? it.props.id! : item[1]!;
		if (seenIds.has(id)) throw new Error(`Duplicate Joplin item ID ${id}. The import stops before it writes a file.`);
		seenIds.add(id);
		if (it.props.encryption_applied === '1') { a.unsupported.push(`Encrypted item ${id}`); continue; }
		const p = it.props;
		switch (it.type) {
			case TYPE.note:
				a.notes.push({
					id, parentId: p.parent_id ?? '', title: it.title, body: it.body,
					markup: p.markup_language === '2' ? 'html' : 'markdown',
					created: isoTime(p.user_created_time) ?? isoTime(p.created_time),
					updated: isoTime(p.user_updated_time) ?? isoTime(p.updated_time),
					todo: p.is_todo === '1', todoDone: p.is_todo === '1' && !!p.todo_completed && p.todo_completed !== '0',
				});
				break;
			case TYPE.folder: a.folders.push({ id, parentId: p.parent_id ?? '', title: it.title }); break;
			case TYPE.tag: a.tags.push({ id, title: it.title }); break;
			case TYPE.noteTag: if (p.note_id && p.tag_id) relations.push({ noteId: p.note_id, tagId: p.tag_id }); break;
			case TYPE.resource: a.resources.set(id, { id, title: it.title, mime: p.mime ?? '', ext: p.file_extension ?? '', data: null }); break;
			default: {
				const n = TYPE_NAMES[it.type] ?? `type ${it.type}`;
				other.set(n, (other.get(n) ?? 0) + 1);
			}
		}
	}
	for (const r of a.resources.values()) {
		const b = blobs.get(r.id);
		if (b) { r.data = b.data; if (b.ext) r.ext = b.ext; }
	}
	for (const [id] of blobs) if (!a.resources.has(id)) a.unsupported.push(`Resource file without metadata ${id}`);
	const tagTitle = new Map(a.tags.map((t) => [t.id, t.title]));
	for (const r of relations) {
		const t = tagTitle.get(r.tagId);
		if (t === undefined) continue;
		const list = a.noteTags.get(r.noteId) ?? [];
		if (!list.includes(t)) list.push(t);
		a.noteTags.set(r.noteId, list);
	}
	for (const [n, c] of other) a.unsupported.push(`${c} ${n} ${c === 1 ? 'item' : 'items'} (not imported)`);
	return a;
}

/** Reads a JEX file. Throws for a damaged or unsafe tar archive before the caller can write a file. */
export function readJex(bytes: Uint8Array): Archive {
	const a = readMembers(readTar(bytes));
	if (!a.notes.length && !a.folders.length) throw new Error('The archive has no Joplin notes or notebooks. Select a JEX file from Joplin (File, Export all, JEX).');
	return a;
}
