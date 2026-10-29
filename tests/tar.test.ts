import { describe, expect, it } from 'vitest';
import { MAX_TAR_BYTES, readTar, safeMemberName, writeTar } from '../src/tar';
import { isoTime, parseItem, readJex } from '../src/joplin';
import { fnv, safeFolder, tagName, unchangedSinceImport } from '../src/convert';

const enc = new TextEncoder();

describe('tar reader', () => {
	it('reads members written by the test writer, with a ustar prefix and a pax path', () => {
		const tar = writeTar([{ name: 'a.md', data: enc.encode('one') }, { name: 'dir/', data: new Uint8Array(), type: '5' }, { name: 'resources/b.png', data: new Uint8Array(600) }]);
		const m = readTar(tar);
		expect(m.map((x) => [x.name, x.data.length])).toEqual([['a.md', 3], ['resources/b.png', 600]]);
		const pax = enc.encode('32 path=resources/long-name.png\n');
		const t2 = writeTar([{ name: 'PaxHeader', data: pax, type: 'x' }, { name: 'short', data: enc.encode('x') }]);
		expect(readTar(t2).map((x) => x.name)).toEqual(['resources/long-name.png']);
	});

	it('rejects a damaged header, a truncated member, a hard link and a device', () => {
		const tar = writeTar([{ name: 'a.md', data: enc.encode('one') }]);
		const bad = tar.slice();
		bad[0] = 0x62;
		expect(() => readTar(bad)).toThrow(/checksum/);
		expect(() => readTar(new Uint8Array(100))).toThrow(/too short/);
		const big = writeTar([{ name: 'a.md', data: new Uint8Array(2000) }]);
		expect(() => readTar(big.slice(0, 1024))).toThrow(/truncated/);
		expect(() => readTar(writeTar([{ name: 'h', data: new Uint8Array(), type: '1', link: 'a.md' }]))).toThrow(/links are not allowed/);
		expect(() => readTar(writeTar([{ name: 'dev', data: new Uint8Array(), type: '3' }]))).toThrow(/Unsupported archive member/);
	});

	it('refuses unsafe names', () => {
		for (const n of ['../x', 'a/../../x', '/abs', 'C:/x', 'a\\b']) expect(() => safeMemberName(n)).toThrow(/Unsafe/);
		expect(safeMemberName('./a/b.md')).toBe('a/b.md');
	});

	it('refuses an archive above the size limit before it parses', () => {
		const fake = { length: MAX_TAR_BYTES + 1 } as Uint8Array;
		expect(() => readTar(fake)).toThrow(/larger than 100 MiB/);
	});
});

describe('Joplin items', () => {
	it('parses like BaseItem.unserialize, with escaped new lines in values', () => {
		const it1 = parseItem('Title\n\nBody line\n\nlast\n\nid: x\nsource_url: a\\nb\ntype_: 1');
		expect(it1).toEqual({ type: 1, title: 'Title', body: 'Body line\n\nlast', props: { id: 'x', source_url: 'a\nb', type_: '1' } });
		expect(() => parseItem('Title\n\nid: x')).toThrow(/type_/);
		expect(() => parseItem('no colon here\ntype_: 1')).toThrow(/Invalid property/);
	});

	it('reads time values as ISO in UTC', () => {
		expect(isoTime('2024-01-02T03:04:05.000Z')).toBe('2024-01-02T03:04:05.000Z');
		expect(isoTime('1700000000000')).toBe('2023-11-14T22:13:20.000Z');
		expect(isoTime('')).toBeNull();
		expect(isoTime('0')).toBeNull();
	});

	it('refuses a file that is not a tar archive', () => {
		expect(() => readJex(enc.encode('# Not a tar file'.padEnd(600, ' ')))).toThrow(/not a tar archive/);
	});
});

describe('helpers', () => {
	it('checks the output folder', () => {
		expect(safeFolder(' /Imports/Joplin/ ')).toBe('Imports/Joplin');
		for (const f of ['', '..', 'a/../b', '.obsidian', 'a/.hidden', 'a:b']) expect(() => safeFolder(f)).toThrow();
	});

	it('makes Obsidian tags', () => {
		expect(tagName('Research')).toBe('Research');
		expect(tagName(' #two words ')).toBe('two-words');
		expect(tagName('2024')).toBeNull();
		expect(tagName('!!!')).toBeNull();
		expect(tagName('área/sub')).toBe('área/sub');
	});

	it('finds notes that changed after the import by the hash line', () => {
		expect(fnv('')).toBe('811c9dc5');
		const text = '---\ntitle: "A"\njoplin_hash: ' + fnv('---\ntitle: "A"\n---\nBody') + '\n---\nBody';
		expect(unchangedSinceImport(text)).toBe(true);
		expect(unchangedSinceImport(text + ' edited')).toBe(false);
		expect(unchangedSinceImport('no hash')).toBe(false);
	});
});
