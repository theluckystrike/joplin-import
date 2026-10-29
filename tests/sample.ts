// The demo archives for screenshots and the end-to-end vault. tests/sample.test.ts checks that the committed
// .jex files equal these members. Run "WRITE_SAMPLE=1 pnpm exec vitest run tests/sample.test.ts" to write them.
import { deflateSync } from 'node:zlib';
import type { VectorMember } from '../src/vector';

const crcTable = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
function crc32(b: Uint8Array): number {
	let c = 0xffffffff;
	for (const v of b) c = crcTable[(c ^ v) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const dv = new DataView(out.buffer);
	dv.setUint32(0, data.length);
	out.set(new TextEncoder().encode(type), 4);
	out.set(data, 8);
	dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
	return out;
}
/** A 240 x 120 PNG: a sky gradient over a green hill. */
export function demoPng(): Uint8Array {
	const w = 240, h = 120;
	const raw = new Uint8Array((w * 3 + 1) * h);
	for (let y = 0; y < h; y++) {
		raw[y * (w * 3 + 1)] = 0;
		for (let x = 0; x < w; x++) {
			const hill = y > 80 - 25 * Math.sin((x / w) * Math.PI);
			const i = y * (w * 3 + 1) + 1 + x * 3;
			raw[i] = hill ? 60 : 120 + Math.round(y / 2);
			raw[i + 1] = hill ? 150 : 170 + Math.round(y / 3);
			raw[i + 2] = hill ? 70 : 230;
		}
	}
	const ihdr = new Uint8Array(13);
	const dv = new DataView(ihdr.buffer);
	dv.setUint32(0, w);
	dv.setUint32(4, h);
	ihdr.set([8, 2, 0, 0, 0], 8);
	const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))), chunk('IEND', new Uint8Array())];
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) { out.set(p, at); at += p.length; }
	return out;
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
export const ids = {
	work: '1a2b3c4d5e6f40718293a4b5c6d7e8f0', meetings: '2b3c4d5e6f7041829304b5c6d7e8f901', personal: '3c4d5e6f708142939415c6d7e8f90a12',
	plan: '4d5e6f70819243a4a526d7e8f90a1b23', standup: '5e6f7081920344b5b637e8f90a1b2c34', trip: '6f708192a31445c6c748f90a1b2c3d45',
	clip: '708192a3b42546d7d8590a1b2c3d4e56', budget: '8192a3b4c53647e8e96a1b2c3d4e5f67',
	photo: '92a3b4c5d64758f9fa7b2c3d4e5f6078', lost: 'a3b4c5d6e7586901ab8c3d4e5f607189',
	research: 'b4c5d6e7f8697a12bc9d4e5f60718293', travel: 'c5d6e7f8097a8b23cdae5f6071829304',
};
const T = (d: string) => `${d}T09:30:00.000Z`;
function item(title: string | null, body: string | null, props: [string, string][]): VectorMember['text'] {
	const p = props.map(([k, v]) => `${k}: ${v}`).join('\n');
	return [title, body, p].filter((x) => x !== null && x !== '').join('\n\n');
}
function note(id: string, title: string, body: string, parent: string, created: string, updated: string, extra: [string, string][] = []): VectorMember {
	const base: [string, string][] = [['id', id], ['parent_id', parent], ['created_time', T(created)], ['updated_time', T(updated)], ['is_conflict', '0'], ['is_todo', '0'], ['todo_completed', '0'], ['source', 'joplin-desktop'], ['user_created_time', T(created)], ['user_updated_time', T(updated)], ['encryption_applied', '0'], ['markup_language', '1'], ['type_', '1']];
	const over = new Map(extra);
	return { name: `${id}.md`, text: item(title, body, base.map(([k, v]) => [k, over.get(k) ?? v])) };
}
const folder = (id: string, title: string, parent = ''): VectorMember => ({ name: `${id}.md`, text: item(title, null, [['id', id], ['created_time', T('2023-01-10')], ['updated_time', T('2023-01-10')], ['parent_id', parent], ['type_', '2']]) });
const tag = (id: string, title: string): VectorMember => ({ name: `${id}.md`, text: item(title, null, [['id', id], ['created_time', T('2023-01-10')], ['type_', '5']]) });
const rel = (id: string, noteId: string, tagId: string): VectorMember => ({ name: `${id}.md`, text: item(null, null, [['id', id], ['note_id', noteId], ['tag_id', tagId], ['type_', '6']]) });
const res = (id: string, title: string, mime: string, ext: string): VectorMember => ({ name: `${id}.md`, text: item(title, null, [['id', id], ['mime', mime], ['filename', ''], ['file_extension', ext], ['encryption_applied', '0'], ['type_', '4']]) });

/** The demo export: 3 notebooks, 5 notes (1 HTML), 2 tags, 2 resources (1 without a file). */
export function demoMembers(later = false): VectorMember[] {
	const i = ids;
	return [
		folder(i.work, 'Work'), folder(i.meetings, 'Meetings', i.work), folder(i.personal, 'Personal'),
		note(i.plan, 'Q3 plan', `# Goals\n\n- Ship the mobile import\n- Review the [weekly standup](:/${i.standup}) notes\n\nBudget details are in [Budget](:/${i.budget}).`, i.work, '2023-02-01', later ? '2024-08-20' : '2023-06-15'),
		note(i.standup, 'Weekly standup', later ? `Decisions:\n\n1. Keep the [Q3 plan](:/${i.plan}) scope.\n2. Move the demo to Friday.\n3. Add a phone test.` : `Decisions:\n\n1. Keep the [Q3 plan](:/${i.plan}) scope.\n2. Move the demo to Friday.`, i.meetings, '2023-03-07', later ? '2024-08-21' : '2023-03-07'),
		note(i.trip, 'Lisbon trip', `Day one at the coast.\n\n![Coast photo](:/${i.photo})\n\nThe second photo is lost: ![Tram](:/${i.lost})`, i.personal, '2023-05-20', '2023-05-22'),
		note(i.budget, 'Budget', '| Item | Cost |\n|---|---|\n| Hotel | 420 |\n| Train | 85 |', i.personal, '2023-05-01', '2023-05-02'),
		note(i.clip, 'Web clip', '<p>Saved from a <b>web page</b>.</p>', i.work, '2023-04-04', '2023-04-04', [['markup_language', '2']]),
		tag(i.research, 'Research'), tag(i.travel, 'travel plans'),
		rel('d5e6f708192a3b4cdeaf607182930415', i.plan, i.research), rel('e6f708192a3b4c5defb0718293041526', i.trip, i.travel), rel('f708192a3b4c5d6ef0c1829304152637', i.budget, i.travel),
		res(i.photo, 'coast.png', 'image/png', 'png'), res(i.lost, 'tram.jpg', 'image/jpeg', 'jpg'),
		{ name: `resources/${i.photo}.png`, base64: b64(demoPng()) },
	];
}
