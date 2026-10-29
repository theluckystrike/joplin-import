import data from './vectors/joplin-import.json';
import { describe, expect, it } from 'vitest';
import { importCase, type VectorMember } from '../src/vector';

const vectors = data as { cases: { name: string; args: unknown[]; expected: Record<string, unknown> }[] };

describe('golden vectors (packages/spec/vectors/joplin-import.json)', () => {
	it('has 20 or more cases', () => {
		expect(vectors.cases.length).toBeGreaterThanOrEqual(20);
	});
	for (const c of vectors.cases) {
		it(c.name, () => {
			const got = importCase(...(c.args as [VectorMember[], string, string[]?]));
			expect(Object.fromEntries(Object.keys(c.expected).map((k) => [k, got[k]]))).toEqual(c.expected);
		});
	}
});
