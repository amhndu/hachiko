import { defineConfig } from "vitest/config";

// Unit tests run in Node. The in-page scripts are tested against a real
// Chromium (test/inpage.test.ts); the Workers pieces run under `vite dev`.
export default defineConfig({
	test: { include: ["test/**/*.test.ts"], environment: "node", testTimeout: 30_000 },
});
