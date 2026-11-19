import { describe, expect, it } from 'vitest';
import { auditArchives } from '../src/audit';
import { convertLinks } from '../src/convert';
import type { Archive, Note, Resource } from '../src/joplin';

// The audit must read the same Joplin link forms that the import converts (src/convert.ts convertLinks).
const id = (n: number) => n.toString(16).padStart(32, '0');
const note = (n: number, body: string, title = `Note ${n}`): Note => ({ id: id(n), parentId: '', title, body, markup: 'markdown', created: null, updated: null, todo: false, todoDone: false });
const resource = (n: number, data: Uint8Array | null = new Uint8Array([1])): Resource => ({ id: id(n), title: `photo${n}.png`, mime: 'image/png', ext: 'png', data });
const archive = (notes: Note[], resources: Resource[] = []): Archive => ({ notes, folders: [], tags: [], noteTags: new Map(), resources: new Map(resources.map((r) => [r.id, r])), unsupported: [] });
const one = (a: Archive) => auditArchives([{ name: 'a.jex', archive: a }]).archives[0]!;

describe('audit reads an image inside a note link', () => {
	const body = `[![photo](:/${id(9)})](:/${id(2)})`;

	it('names the outer note when it is in no selected archive', () => {
		const r = one(archive([note(1, body, 'Clip')], [resource(9)]));
		expect(r.resourceLinks).toBe(1);
		expect(r.noteLinks).toBe(1);
		expect(r.missing).toEqual([`${id(2)} in note "Clip" is in no selected archive`]);
		expect(r.unused).toEqual([]);
	});

	it('counts the outer note as resolved when it is in the archive', () => {
		const r = one(archive([note(1, body, 'Clip'), note(2, 'o')], [resource(9)]));
		expect(r.noteLinks).toBe(1);
		expect(r.resolved).toBe(2);
		expect(r.missing).toEqual([]);
	});

	it('names the outer note when it is in another selected archive', () => {
		const result = auditArchives([{ name: 'a.jex', archive: archive([note(1, body, 'Clip')], [resource(9)]) }, { name: 'b.jex', archive: archive([note(2, 'o')]) }]);
		expect(result.archives[0]!.inOther).toEqual([`${id(2)} in note "Clip" is in b.jex`]);
	});

	it('does not count an outer web URL as a note link', () => {
		const r = one(archive([note(1, `[![](:/${id(9)})](https://example.com/p "T")`)], [resource(9)]));
		expect(r.noteLinks).toBe(0);
		expect(r.resourceLinks).toBe(1);
		expect(r.missing).toEqual([]);
	});

	it('agrees with the converter on the missing targets', () => {
		const a = archive([note(1, body, 'Clip')], [resource(9)]);
		const conv = convertLinks(body, new Map([[id(1), 'Clip']]), new Map([[id(9), 'r/photo9.png']]));
		expect(conv.missing).toEqual([id(2)]);
		expect(one(a).missing.map((m) => m.slice(0, 32))).toEqual(conv.missing);
	});
});

describe('audit reads link labels with brackets', () => {
	it('counts a label with escaped brackets', () => {
		const r = one(archive([note(1, `See [\\[WIP\\] Other](:/${id(2)})`, 'Links')]));
		expect(r.noteLinks).toBe(1);
		expect(r.missing).toEqual([`${id(2)} in note "Links" is in no selected archive`]);
	});

	it('counts a label with nested brackets', () => {
		const r = one(archive([note(1, `See [a [b] c](:/${id(2)})`), note(2, 'o')]));
		expect(r.noteLinks).toBe(1);
		expect(r.resolved).toBe(1);
	});

	it('counts an image with brackets in the alt text as a used resource', () => {
		const r = one(archive([note(1, `![a [b] c](:/${id(9)})`)], [resource(9)]));
		expect(r.resourceLinks).toBe(1);
		expect(r.unused).toEqual([]);
	});
});

describe('audit reads HTML image tags', () => {
	it('counts a resource in an img tag as used', () => {
		const r = one(archive([note(1, `<img src=":/${id(9)}" width="300">`)], [resource(9)]));
		expect(r.resourceLinks).toBe(1);
		expect(r.resolved).toBe(1);
		expect(r.unused).toEqual([]);
	});

	it('names an img tag resource that has no file', () => {
		const r = one(archive([note(1, `<img src=":/${id(9)}">`, 'Clip')], [resource(9, null)]));
		expect(r.missing).toEqual([`Resource "photo9.png" (${id(9)}) in note "Clip" has no file`]);
	});

	it('names an img tag target that is in no selected archive', () => {
		const r = one(archive([note(1, `<img src=":/${id(9)}">`, 'Clip')]));
		expect(r.missing).toEqual([`${id(9)} in note "Clip" is in no selected archive`]);
	});

	it('ignores an img tag inside a fence', () => {
		const r = one(archive([note(1, `\`\`\`\n<img src=":/${id(9)}">\n\`\`\``)], [resource(9)]));
		expect(r.resourceLinks).toBe(0);
		expect(r.unused).toEqual([`Resource "photo9.png" (${id(9)})`]);
	});

	it('counts an uppercase IMG tag with an uppercase SRC', () => {
		const r = one(archive([note(1, `<IMG SRC=":/${id(9)}">`)], [resource(9)]));
		expect(r.resourceLinks).toBe(1);
		expect(r.unused).toEqual([]);
	});

	it('counts an img tag with a single-quoted src', () => {
		const r = one(archive([note(1, `<img src=':/${id(9)}'>`)], [resource(9)]));
		expect(r.resourceLinks).toBe(1);
		expect(r.unused).toEqual([]);
	});
});

describe('img tags with angle brackets in a quoted attribute', () => {
	it('reads an img tag with "<" in a quoted alt text', () => {
		const body = `<img alt="a<b" src=":/${id(9)}">`;
		expect(convertLinks(body, new Map(), new Map([[id(9), 'r/photo9.png']])).body).toBe('![[r/photo9.png]]');
		expect(one(archive([note(1, body)], [resource(9)])).unused).toEqual([]);
	});

	it('reads an img tag with ">" in a single-quoted alt text', () => {
		const body = `<img alt='a>b' src=":/${id(9)}">`;
		expect(convertLinks(body, new Map(), new Map([[id(9), 'r/photo9.png']])).body).toBe('![[r/photo9.png]]');
		expect(one(archive([note(1, body)], [resource(9)])).resourceLinks).toBe(1);
	});
});

describe('link forms next to backslashes', () => {
	it('does not read an escaped bracket as a link start', () => {
		const body = `\\[x](:/${id(2)})`;
		expect(body.startsWith('\\[')).toBe(true);
		expect(one(archive([note(1, body)])).noteLinks).toBe(0);
	});

	it('reads a link after an escaped backslash', () => {
		const body = `\\\\[x](:/${id(2)})`;
		expect(body.slice(0, 3)).toBe('\\\\[');
		expect(one(archive([note(1, body), note(2, 'o')])).resolved).toBe(1);
		expect(convertLinks(body, new Map([[id(2), 'Other']]), new Map()).body).toBe('\\\\[[Other|x]]');
	});
});

// A long note on one line must not stall the audit or the import. The fixed code takes about 15 ms per case on 1 MB.
describe('time on 1 MB single-line notes', () => {
	const MB = 1 << 20;
	const fill = (unit: string) => unit.repeat(Math.ceil(MB / unit.length)).slice(0, MB);
	const cases: Record<string, string> = { open: fill('['), escaped: fill('\\['), imgOpen: fill('<img '), imgSrc: fill(`<img src=":/${id(9)}" `), mixed: fill('[[!<img ](\\['), quotes: fill('<img alt="'), quoteOpen: fill('<img "'), backslashes: fill('\\') + '[x](:/' + id(2) + ')' };
	for (const [name, body] of Object.entries(cases)) {
		it(`${name} takes less than 150 ms`, () => {
			const a = archive([note(1, body)]);
			let t = performance.now();
			one(a);
			const audit = performance.now() - t;
			t = performance.now();
			convertLinks(body, new Map(), new Map());
			const conv = performance.now() - t;
			expect(Math.max(audit, conv)).toBeLessThan(150);
		});
	}
});
