// Timing guards that hold on a slow shared CI runner (s1101 FIX item 4). A wall-clock limit such as "less than 300 ms"
// failed on GitHub runners that were 12 to 20 times slower than the agent Mac. These guards divide two times that the
// same test measures on the same machine, so a slow runner slows both times and the ratio stays.

/** Fastest time of `rounds` rounds, in ms. A round repeats fn until it took at least minMs, so a sub-ms timer step does not count. */
export function timeOf(fn: () => unknown, rounds: number, minMs = 0): number {
	let best = Infinity;
	for (let r = 0; r < rounds; r++) {
		let reps = 0;
		let took = 0;
		const t0 = performance.now();
		do {
			fn();
			reps++;
			took = performance.now() - t0;
		} while (took < minMs);
		best = Math.min(best, took / reps);
	}
	return best;
}

/**
 * 10 times the input gives about 10 times the time for linear work and about 100 times for quadratic work.
 * 40 is 4 times the linear value and 2.5 times below the quadratic value. On the agent Mac (2026-11-01) linear work gave 8 to 20.
 */
export const GROWTH_LIMIT = 40;

/** Rounds per guard. Each round times the small work and then the big work, back to back. */
export const ROUNDS = 5;

/**
 * Lowest time of big divided by lowest time of small over ROUNDS rounds, both measured in this test (s1103 CIFIX review
 * D1). Noise only adds time, so the lowest time of each side is its cost. A load burst on one side cannot lower the
 * ratio, and a slow runner slows both sides. A first small run warms up the JIT.
 */
export function pairedRatio(small: () => unknown, big: () => unknown): { ratio: number; text: string } {
	timeOf(small, 1, 20);
	let s = Infinity;
	let b = Infinity;
	for (let round = 0; round < ROUNDS; round++) {
		s = Math.min(s, timeOf(small, 1, 20));
		b = Math.min(b, timeOf(big, 1));
	}
	return { ratio: b / s, text: `${b.toFixed(2)} ms against ${s.toFixed(3)} ms` };
}

/**
 * Time at full size n divided by time at size n / 10, as pairedRatio measures them. make(n) builds the input outside
 * the timing and returns the work. Linear work gives about 10 and quadratic work about 100.
 */
export function growth(make: (n: number) => () => unknown, n: number): { ratio: number; text: string } {
	const tenth = Math.round(n / 10);
	const r = pairedRatio(make(tenth), make(n));
	return { ratio: r.ratio, text: `${r.text}, at size ${n} against size ${tenth}` };
}
