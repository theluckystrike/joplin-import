// A small tar reader over Uint8Array. No fs, no path module, no stream: it runs the same on desktop and phone.
// It reads ustar, old tar, pax "x" path records and GNU "L" long names. It rejects a link, a device,
// an absolute path, a ".." segment and a duplicate name before the caller sees a member.

export interface TarMember { name: string; data: Uint8Array }

/** The largest archive that the plugin reads. A phone has less memory than a desktop. */
export const MAX_TAR_BYTES = 100 * 1024 * 1024;
export const MAX_MEMBERS = 100_000;
const BLOCK = 512;

const decoder = new TextDecoder('utf-8');

function text(b: Uint8Array, start: number, length: number): string {
	const part = b.subarray(start, start + length);
	const end = part.indexOf(0);
	return decoder.decode(end < 0 ? part : part.subarray(0, end));
}

function octal(b: Uint8Array, start: number, length: number, what: string): number {
	if ((b[start] ?? 0) & 0x80) throw new Error(`The archive uses a binary ${what} field, which this reader does not support.`);
	const raw = text(b, start, length).trim();
	if (raw === '') return 0;
	if (!/^[0-7]+$/.test(raw)) throw new Error(`The archive has a bad ${what} field.`);
	return parseInt(raw, 8);
}

function zeroBlock(b: Uint8Array, at: number): boolean {
	for (let i = at; i < at + BLOCK; i++) if (b[i] !== 0) return false;
	return true;
}

/** Returns the member name with "./" removed, or throws for a name that can go outside the output folder. */
export function safeMemberName(raw: string): string {
	const name = raw.replace(/^(\.\/)+/, '');
	const unsafe = name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').some((p) => p === '..');
	if (unsafe) throw new Error(`Unsafe archive member "${raw}". The import stops before it writes a file.`);
	return name;
}

function paxPath(data: Uint8Array): string | null {
	let i = 0;
	let path: string | null = null;
	while (i < data.length) {
		const space = data.indexOf(32, i);
		if (space < 0) break;
		const len = Number(decoder.decode(data.subarray(i, space)));
		if (!Number.isInteger(len) || len <= 0) break;
		const record = decoder.decode(data.subarray(space + 1, i + len - 1));
		const eq = record.indexOf('=');
		if (eq > 0 && record.slice(0, eq) === 'path') path = record.slice(eq + 1);
		i += len;
	}
	return path;
}

/**
 * Reads the regular files of a tar archive. Directories are skipped. The data of each member is a view into
 * the input bytes, not a copy. Throws for a bad checksum, a truncated member or an unsafe member.
 */
export function readTar(bytes: Uint8Array): TarMember[] {
	if (bytes.length > MAX_TAR_BYTES) throw new Error(`The archive is larger than ${MAX_TAR_BYTES / 1024 / 1024} MiB.`);
	if (bytes.length < BLOCK) throw new Error('The file is not a tar archive (JEX). It is too short.');
	const out: TarMember[] = [];
	const seen = new Set<string>();
	let at = 0;
	let longName: string | null = null;
	let headers = 0;
	while (at + BLOCK <= bytes.length) {
		if (zeroBlock(bytes, at)) break;
		if (++headers > MAX_MEMBERS * 2) throw new Error(`The archive has more than ${MAX_MEMBERS} members.`);
		let sum = 0;
		for (let i = at; i < at + BLOCK; i++) sum += i >= at + 148 && i < at + 156 ? 32 : (bytes[i] ?? 0);
		if (sum !== octal(bytes, at + 148, 8, 'checksum')) throw new Error('The file is not a tar archive (JEX), or it is damaged. A header checksum does not match.');
		const size = octal(bytes, at + 124, 12, 'size');
		const type = String.fromCharCode(bytes[at + 156] ?? 0);
		const headerAt = at;
		const start = at + BLOCK;
		if (start + size > bytes.length) throw new Error('The archive is truncated.');
		const data = bytes.subarray(start, start + size);
		at = start + Math.ceil(size / BLOCK) * BLOCK;
		let name = text(bytes, headerAt, 100);
		if (text(bytes, headerAt + 257, 5) === 'ustar') {
			const prefix = text(bytes, headerAt + 345, 155);
			if (prefix) name = `${prefix}/${name}`;
		}
		if (type === 'x') { longName = paxPath(data) ?? longName; continue; }
		if (type === 'L') { longName = text(data, 0, data.length); continue; }
		if (type === 'g') continue;
		if (longName !== null) { name = longName; longName = null; }
		if (type === '1' || type === '2' || type === 'K') throw new Error(`Unsafe archive member "${name}": links are not allowed. The import stops before it writes a file.`);
		const safe = safeMemberName(name);
		if (type === '5') continue;
		if (type !== '0' && type !== '\0' && type !== '7') throw new Error(`Unsupported archive member "${name}" (type ${type}). The import stops before it writes a file.`);
		if (seen.has(safe)) throw new Error(`The archive has two members with the name "${safe}".`);
		seen.add(safe);
		out.push({ name: safe, data });
	}
	return out;
}

/** Writes a ustar archive. The plugin does not use it: the tests and the sample data use it to make JEX files. */
export function writeTar(members: { name: string; data: Uint8Array; type?: string; link?: string }[]): Uint8Array {
	const enc = new TextEncoder();
	const parts: Uint8Array[] = [];
	for (const m of members) {
		const h = new Uint8Array(BLOCK);
		const put = (s: string, off: number, len: number) => { h.set(enc.encode(s).subarray(0, len), off); };
		const num = (n: number, off: number, len: number) => { put(n.toString(8).padStart(len - 1, '0'), off, len - 1); };
		put(m.name, 0, 100);
		num(0o644, 100, 8);
		num(0, 108, 8);
		num(0, 116, 8);
		num(m.data.length, 124, 12);
		num(0, 136, 12);
		h.fill(32, 148, 156);
		put(m.type ?? '0', 156, 1);
		if (m.link) put(m.link, 157, 100);
		put('ustar', 257, 6);
		put('00', 263, 2);
		let sum = 0;
		for (const v of h) sum += v;
		put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
		parts.push(h, m.data);
		const pad = (BLOCK - (m.data.length % BLOCK)) % BLOCK;
		if (pad) parts.push(new Uint8Array(pad));
	}
	parts.push(new Uint8Array(BLOCK * 2));
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const p of parts) { out.set(p, at); at += p.length; }
	return out;
}
