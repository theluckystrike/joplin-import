import { defineConfig } from 'vitest/config';
import { budget } from './tests/time-scale';

// obsidian ships typings only, so tests run against obsidian-test-mocks in happy-dom.
export default defineConfig({
	resolve: { alias: { obsidian: 'obsidian-test-mocks/obsidian' } },
	test: {
		environment: 'happy-dom',
		setupFiles: ['obsidian-test-mocks/vitest-setup'],
		include: ['tests/**/*.test.ts'],
		// Large-input regression tests need more than 5 seconds on shared CI runners.
		testTimeout: budget(30_000),
		// Hooks get the same scale (s1108 T1). 10 s is the vitest default.
		hookTimeout: budget(10_000),
	},
});
