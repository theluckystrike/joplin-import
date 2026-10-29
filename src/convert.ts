// Pure conversion: from the archive model to a list of output files. No vault access. The caller gives a
// function that tells if a path exists, so the plan marks each existing path as skipped.
import type { Archive, Folder, Note } from './joplin';

export interface PlannedNote { id: string; path: string; text: string; status: 'new' | 'existing' }
export interface PlannedAttachment { id: string; path: string; data: Uint8Array; status: 'new' | 'existing' }
export interface Report {
	missingResources: string[];
	missingNotes: string[];
	unsupported: string[];
	tags: string[];
	notebooks: string[];
}
export interface Plan {
	folder: string;
	folders: string[];
	notes: PlannedNote[];
	attachments: PlannedAttachment[];
	report: Report;
	counts: Counts;
}
export interface Counts { notes: number; notebooks: number; tags: number; resources: number }

export const RESOURCE_DIR = '_resources';

/** The counts that the preview shows before import. */
export function counts(a: Archive): Counts {
	return { notes: a.notes.length, notebooks: a.folders.length, tags: a.tags.length, resources: a.resources.size };
}

/** UTF-8 bytes of a name part. Linux and Android file systems refuse a file name above 255 bytes. */
export const MAX_NAME_BYTES = 200;

const utf8 = new TextEncoder();

/**
 * A file or folder name part: no characters that Obsidian or the file system refuse, no leading dots. The cut keeps
 * whole code points (no lone surrogate) and stays at or below max characters and MAX_NAME_BYTES UTF-8 bytes, so the
 * note name with "--<id>.md" stays below 255 bytes. Dots and spaces at the end are removed after the cut, and a
 * reserved Windows name gets "_" after its reserved part.
 */
export function safeName(title: string, max = 80): string {
	const s = Array.from(title, (ch) => (ch.charCodeAt(0) < 32 ? ' ' : ch)).join('').replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/\.+$/, '').trim();
	const out = cut(s, max, MAX_NAME_BYTES);
	// Windows refuses CON, PRN, AUX, NUL, COM1-9 and LPT1-9, also with an extension: add "_" after the reserved part.
	if (RESERVED.test(out)) return cut(out, max - 1, MAX_NAME_BYTES - 1).replace(RESERVED, '$1_$2');
	return out;
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** The first code points of s, at most max of them and maxBytes UTF-8 bytes, without dots or spaces at the end. */
function cut(s: string, max: number, maxBytes: number): string {
	let out = '';
	let bytes = 0;
	let count = 0;
	for (const ch of s) {
		const size = utf8.encode(ch).length;
		if (count >= max || bytes + size > maxBytes) break;
		out += ch;
		bytes += size;
		count++;
	}
	return out.replace(/[.\s]+$/u, '');
}

/** Checks the output folder input and returns it without slashes at the ends. Throws for an unsafe path. */
export function safeFolder(input: string): string {
	const f = input.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
	if (!f) throw new Error('Type an output folder name.');
	if (f.split('/').some((p) => p === '..' || p === '.' || p.startsWith('.') || p.trim() !== p || p === '')) throw new Error('The output folder must be a plain vault path, without "..", without hidden folders and without spaces at the ends of a name.');
	if (/[*?"<>|:#^[\]]/.test(f)) throw new Error('The output folder has a character that a vault path cannot have.');
	return f;
}

/** Obsidian tag text for a Joplin tag title, or null when the title has no usable characters. */
export function tagName(title: string): string | null {
	const t = title.trim().replace(/^#+/, '').replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_\-/]/gu, '').replace(/^\/+|\/+$/g, '');
	if (!t || /^\d+$/.test(t)) return null;
	return t;
}

/** 32-bit FNV-1a of the text, as 8 hex digits. The plugin writes it to find notes that you changed in the vault. */
export function fnv(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}

const HASH_LINE = /^joplin_hash: ([0-9a-f]{8})\n/m;

/** Adds the hash line as the last frontmatter line. */
function withHash(front: string[], body: string): string {
	const plain = `---\n${front.join('\n')}\n---\n${body}`;
	return `---\n${front.join('\n')}\njoplin_hash: ${fnv(plain)}\n---\n${body}`;
}

/** True when the note text is as the import wrote it: its hash line matches the rest of the text. */
export function unchangedSinceImport(text: string): boolean {
	const m = HASH_LINE.exec(text);
	if (!m) return false;
	return fnv(text.replace(HASH_LINE, '')) === m[1];
}

/** The deepest notebook level that becomes a folder. Deeper notebooks use the folder of their level-64 parent. */
export const MAX_DEPTH = 64;

/**
 * Notebook id to folder path inside the output folder. Cycles and missing parents go to the top. A notebook below
 * MAX_DEPTH levels gets the folder of its level-64 parent and a report line. Each chain of parents is walked once.
 */
export function folderPaths(a: Archive, root: string, report: Report): Map<string, string> {
	const byId = new Map(a.folders.map((f) => [f.id, f]));
	const out = new Map<string, string>();
	const depth = new Map<string, number>();
	const used = new Map<string, Set<string>>();
	const place = (f: Folder, parent: string, parentDepth: number) => {
		if (parentDepth >= MAX_DEPTH) {
			report.notebooks.push(`Notebook "${f.title}" (${f.id}) is deeper than ${MAX_DEPTH} levels. Its notes go into ${parent}.`);
			out.set(f.id, parent);
			depth.set(f.id, parentDepth);
			return;
		}
		const siblings = used.get(parent) ?? new Set<string>();
		used.set(parent, siblings);
		let name = safeName(f.title) || `Untitled--${f.id}`;
		if (siblings.has(name.toLowerCase())) name = `${name}--${f.id}`;
		siblings.add(name.toLowerCase());
		out.set(f.id, `${parent}/${name}`);
		depth.set(f.id, parentDepth + 1);
	};
	for (const start of [...a.folders].sort((x, y) => x.id.localeCompare(y.id))) {
		if (out.has(start.id)) continue;
		// Walk up to a placed notebook, the top, a missing parent or a loop. Then place the chain from the top down.
		const chain: Folder[] = [];
		const onChain = new Set<string>();
		let cur: Folder | undefined = start;
		while (cur && !out.has(cur.id) && !onChain.has(cur.id)) {
			chain.push(cur);
			onChain.add(cur.id);
			cur = cur.parentId ? byId.get(cur.parentId) : undefined;
		}
		const top = chain[chain.length - 1]!;
		let parent = root;
		let parentDepth = 0;
		if (top.parentId) {
			if (!byId.has(top.parentId)) report.notebooks.push(`Notebook "${top.title}" (${top.id}) has a missing parent ${top.parentId}. It is put at the top of the output folder.`);
			else if (onChain.has(top.parentId)) report.notebooks.push(`Notebook "${top.title}" (${top.id}) is in a parent loop. It is put at the top of the output folder.`);
			else { parent = out.get(top.parentId)!; parentDepth = depth.get(top.parentId)!; }
		}
		for (let i = chain.length - 1; i >= 0; i--) {
			const f = chain[i]!;
			place(f, parent, parentDepth);
			parent = out.get(f.id)!;
			parentDepth = depth.get(f.id)!;
		}
	}
	return out;
}

// A label holds escaped brackets ("\\[WIP\\]", as Joplin escapeTitleText writes them) and one level of balanced
// brackets ("a [b] c"). A nested "[...]" that is followed by "(" is not allowed, so "[![alt](:/res)](target)" is not
// read as one link with the label "![alt](:/res)". A label has at most MAX_LABEL parts, so a long line of "\\[" is
// read in linear time; a longer label stays as source text and the report names the link.
const MAX_LABEL = 300;
const LABEL = String.raw`(?:\\.|[^[\]\\\n]|\[(?:\\.|[^[\]\\\n]){0,${MAX_LABEL}}\](?!\()){0,${MAX_LABEL}}`;
const LINK = new RegExp(String.raw`(!?)\[(${LABEL})\]\(:\/([0-9a-f]{32})(#[^)\s]*)?\)`, 'g');
// An image inside a link: [![alt](:/id)](:/id or URL "optional title"). The Joplin web clipper writes this form.
const LINKED_IMAGE = new RegExp(String.raw`\[!\[((?:\\.|[^[\]\\\n]){0,${MAX_LABEL}})\]\(:\/([0-9a-f]{32})(?:#[^)\s]*)?\)\]\((?::\/([0-9a-f]{32})(#[^)\s]*)?|([^)\s]*))(\s+"[^"\n]*")?\)`, 'g');
// A Joplin link target that is left after the conversion.
const LEFT = /\]\(:\/([0-9a-f]{32})/g;
// An HTML image tag: <img ...> with at most MAX_TAG characters inside. The src and the width are read inside the match.
// The Joplin rich text editor writes <img src=":/id" ...>.
const MAX_TAG = 1000;
const IMG_TAG = new RegExp(String.raw`<img\b[^>]{0,${MAX_TAG}}>`, 'gi');
const IMG_SRC = /\ssrc\s*=\s*(["']):\/([0-9a-f]{32})\1/i;

function label(text: string): string {
	return text.replace(/\\([[\]])/g, '$1').replace(/[|[\]]/g, ' ').replace(/\s+/g, ' ').trim();
}

function wiki(embed: string, target: string, text: string): string {
	const l = label(text);
	return `${embed}[[${target}${l ? `|${l}` : ''}]]`;
}

/** Changes only lines outside fenced code blocks. The fence length and closing line must match, as in CommonMark. */
export function mapOutsideFences(body: string, transform: (line: string) => string): string {
	let fence: string | null = null;
	const lines = body.split('\n').map((line) => {
		const f = /^\s*(`{3,}|~{3,})/.exec(line);
		if (fence !== null) {
			if (f && f[1]!.charAt(0) === fence.charAt(0) && f[1]!.length >= fence.length && line.slice(f[0].length).trim() === '') fence = null;
			return line;
		}
		// CommonMark: the info string of a backtick fence has no backtick, so "```js```" is inline code, not a fence.
		if (f && !(f[1]!.charAt(0) === '`' && line.slice(f[0].length).includes('`'))) {
			fence = f[1]!;
			return line;
		}
		return transform(line);
	});
	return lines.join('\n');
}

/**
 * Replaces Joplin links outside fences with vault links and returns the missing target IDs. An image inside a link
 * becomes a Markdown image inside a Markdown link, because a wikilink cannot hold an image. The vault paths go in
 * angle brackets. An HTML image tag with a resource that has a file becomes an embed; the other tags stay and are
 * returned in imgTags. A link target "](:/<id>" that is left outside fences and is not in missing is returned in
 * unconverted, so that the report names each Joplin link that stays as source text.
 */
export function convertLinks(body: string, notes: Map<string, string>, resources: Map<string, string>): { body: string; missing: string[]; imgTags: string[]; unconverted: string[] } {
	const missing: string[] = [];
	const imgTags: string[] = [];
	const miss = (id: string) => { if (!missing.includes(id)) missing.push(id); };
	const target = (id: string): string | undefined => {
		const note = notes.get(id);
		return note !== undefined ? `${note}.md` : resources.get(id);
	};
	const converted = mapOutsideFences(body, (line) => line
		.replace(LINKED_IMAGE, (all, alt: string, inner: string, outer: string | undefined, anchor: string | undefined, url: string | undefined, title: string | undefined) => {
			const image = target(inner);
			const link = outer === undefined ? url! : target(outer);
			if (image === undefined) miss(inner);
			if (outer !== undefined && link === undefined) miss(outer);
			if (image === undefined || link === undefined) return all;
			return `[![${alt}](<${image}>)](${outer === undefined ? link : `<${link}${notes.has(outer) ? anchor ?? '' : ''}>`}${title ?? ''})`;
		})
		.replace(IMG_TAG, (all: string) => {
			const id = IMG_SRC.exec(all)?.[2];
			if (id === undefined) return all;
			const res = resources.get(id);
			if (res === undefined) { if (!imgTags.includes(id)) imgTags.push(id); return all; }
			// A width in percent or with a fraction is not a pixel size: no size then.
			const width = /\swidth\s*=\s*["']?(\d+)(?![\d.%])/i.exec(all)?.[1];
			return `![[${res}${width ? `|${width}` : ''}]]`;
		})
		.replace(LINK, (all, bang: string, text: string, id: string, anchor: string | undefined) => {
			const note = notes.get(id);
			if (note !== undefined) return wiki(bang, `${note}${anchor ?? ''}`, text);
			const res = resources.get(id);
			if (res !== undefined) return wiki(bang, res, text);
			miss(id);
			return all;
		}));
	const unconverted: string[] = [];
	mapOutsideFences(converted, (line) => {
		for (const m of line.matchAll(LEFT)) if (!missing.includes(m[1]!) && !unconverted.includes(m[1]!)) unconverted.push(m[1]!);
		return line;
	});
	return { body: converted, missing, imgTags, unconverted };
}

/** The Markdown text of one imported note: fixed frontmatter fields, then the converted body. */
export function renderNote(n: Note, tags: string[], body: string): string {
	const front = [`title: ${JSON.stringify(n.title)}`, `joplin_id: ${n.id}`];
	if (n.created) front.push(`created: ${n.created}`);
	if (n.updated) front.push(`updated: ${n.updated}`);
	front.push(tags.length ? `tags:\n${tags.map((t) => `  - ${JSON.stringify(t)}`).join('\n')}` : 'tags: []');
	if (n.todo) front.push(`joplin_todo: ${n.todoDone ? 'done' : 'open'}`);
	return withHash(front, body);
}

/** Converts the archive in memory. exists(path) tells which output paths are present; the plan skips them. */
export function planImport(a: Archive, folderInput: string, exists: (path: string) => boolean): Plan {
	const folder = safeFolder(folderInput);
	const report: Report = { missingResources: [], missingNotes: [], unsupported: [...a.unsupported], tags: [], notebooks: [] };
	const folders = folderPaths(a, folder, report);
	const notePaths = new Map<string, string>();
	const noteIds = new Set(a.notes.map((n) => n.id));
	const markdown: Note[] = [];
	for (const n of a.notes) {
		if (n.markup === 'html') { report.unsupported.push(`HTML note "${n.title}" (${n.id}) is not imported. Only Markdown note bodies are converted.`); continue; }
		let dir = folder;
		if (n.parentId && folders.has(n.parentId)) dir = folders.get(n.parentId)!;
		else if (n.parentId) report.notebooks.push(`Note "${n.title}" (${n.id}) has a missing notebook ${n.parentId}. It is put at the top of the output folder.`);
		notePaths.set(n.id, `${dir}/${safeName(n.title) || 'Untitled'}--${n.id}`);
		markdown.push(n);
	}
	const resPaths = new Map<string, string>();
	const attachments: PlannedAttachment[] = [];
	for (const r of a.resources.values()) {
		if (!r.data) continue;
		const ext = safeName(r.ext, 12).replace(/\s/g, '');
		const path = `${folder}/${RESOURCE_DIR}/${r.id}${ext ? `.${ext}` : ''}`;
		resPaths.set(r.id, path);
		attachments.push({ id: r.id, path, data: r.data, status: exists(path) ? 'existing' : 'new' });
	}
	const renamed = new Set<string>();
	const notes: PlannedNote[] = markdown.map((n) => {
		const { body, missing, imgTags, unconverted } = convertLinks(n.body, notePaths, resPaths);
		for (const id of unconverted) report.unsupported.push(`Unconverted Joplin link to ${id} in note "${n.title}". The link stays as source text.`);
		for (const id of imgTags) report.unsupported.push(`HTML image tag in note "${n.title}" points to ${id}, which has no file in the archive. The tag stays as source text.`);
		for (const id of missing) {
			const r = a.resources.get(id);
			if (r) report.missingResources.push(`Resource "${r.title}" (${id}) in note "${n.title}": the archive has no file for it. The link stays as source text.`);
			else if (noteIds.has(id)) report.missingNotes.push(`Link to note ${id} in note "${n.title}": the target note is not imported. The link stays as source text.`);
			else report.missingResources.push(`Resource or note ${id} in note "${n.title}" is not in the archive. The link stays as source text.`);
		}
		const tags: string[] = [];
		for (const t of a.noteTags.get(n.id) ?? []) {
			const name = tagName(t);
			if (name === null) { if (!renamed.has(t)) report.tags.push(`Tag "${t}" has no usable characters and is not written.`); renamed.add(t); continue; }
			if (name !== t && !renamed.has(t)) { report.tags.push(`Tag "${t}" is written as "${name}".`); renamed.add(t); }
			if (!tags.includes(name)) tags.push(name);
		}
		const path = `${notePaths.get(n.id)!}.md`;
		return { id: n.id, path, text: renderNote(n, tags, body), status: exists(path) ? 'existing' : 'new' };
	});
	// The parents of the output folder, then each notebook folder once: the parent of a notebook folder is the output
	// folder or another notebook folder.
	const all = new Set<string>();
	const parts = folder.split('/');
	for (let i = 1; i <= parts.length; i++) all.add(parts.slice(0, i).join('/'));
	for (const p of folders.values()) all.add(p);
	if (attachments.length) all.add(`${folder}/${RESOURCE_DIR}`);
	const folderList = [...all].sort((x, y) => x.split('/').length - y.split('/').length || x.localeCompare(y));
	return { folder, folders: folderList, notes, attachments, report, counts: counts(a) };
}

/** The report note text. stamp is the local time text of the import. */
export function reportText(plan: Plan, source: string, stamp: string, result: { created: number; attachments: number; skipped: number; errors: string[] }): string {
	const c = plan.counts;
	const out = [
		`# Joplin import report ${stamp}`,
		'',
		`Source archive: ${source}`,
		`Archive counts: ${c.notes} notes, ${c.notebooks} notebooks, ${c.tags} tags, ${c.resources} resources.`,
		`Created: ${result.created} notes and ${result.attachments} attachments. Skipped existing paths: ${result.skipped}. Errors: ${result.errors.length}.`,
		'The import reads the archive and does not change it.',
	];
	const section = (title: string, lines: string[]) => {
		if (!lines.length) return;
		out.push('', `## ${title}`, '', ...lines.map((l) => `- ${l}`));
	};
	section('Errors', result.errors);
	section('Missing resources', plan.report.missingResources);
	section('Missing note links', plan.report.missingNotes);
	section('Unsupported items', plan.report.unsupported);
	section('Changed tags', plan.report.tags);
	section('Notebook problems', plan.report.notebooks);
	return `${out.join('\n')}\n`;
}
