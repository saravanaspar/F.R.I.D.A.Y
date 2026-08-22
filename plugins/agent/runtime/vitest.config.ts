import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["test/agent-loop.test.ts", "test/agent.test.ts", "test/retry.test.ts"],
		setupFiles: ["./test/model-access.setup.ts"],
	},
});
