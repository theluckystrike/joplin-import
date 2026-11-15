// Wall-clock budgets of the tests (s1108 T1 CI-TIME). A per-test timeout or a wait deadline is a hang guard, not a
// speed check: the speed checks are the growth and ratio guards, which divide two times from the same machine. In a
// full factory run a GitHub runner ran a test 3.3 to 7.1 times slower than alone (s1104 CIRUN) and up to 21 times
// slower than the agent Mac (run 40988743467), so a fixed budget failed on machine speed. TIME_SCALE multiplies each
// budget: PF_TEST_TIME_SCALE when it is set (turbo strips it in CI), else 4 when CI is set, else 1. A hang still fails.

/** Scale factor for wall-clock budgets, from the environment. Values below 1 or not numbers give the default. */
export function timeScale(env: Record<string, string | undefined> = process.env): number {
	const set = Number(env['PF_TEST_TIME_SCALE']);
	if (Number.isFinite(set) && set >= 1) return set;
	return env['CI'] ? 4 : 1;
}

export const TIME_SCALE = timeScale();

/** A wall-clock budget of `ms` milliseconds on this Mac, scaled for the machine that runs the test. */
export function budget(ms: number): number {
	return Math.round(ms * TIME_SCALE);
}
