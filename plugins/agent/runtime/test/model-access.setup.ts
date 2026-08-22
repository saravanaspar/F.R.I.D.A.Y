import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import { afterAll, beforeAll } from "vitest";
import { installModelAccess, uninstallModelAccess } from "../src/model-access.js";

/**
 * The agent implementation consumes model services through an injected port.
 * Production installs that port from the FRIDAY plugin adapter. These unit tests run
 * the implementation directly, so provide only the model utilities that the runtime tests use.
 */
beforeAll(() => {
	installModelAccess({
		streamSimple() {
			throw new Error("Unexpected default model stream in agent unit test");
		},

		validateToolArguments(tool, toolCall) {
			const args = structuredClone(toolCall.arguments);
			Value.Convert(tool.parameters, args);
			const validator = Compile(tool.parameters);
			if (!validator.Check(args)) {
				throw new Error(`Validation failed for tool "${toolCall.name}"`);
			}
			return args;
		},

		createAssistantMessageDiagnostic(type, error, details) {
			const normalized =
				error instanceof Error
					? {
							name: error.name || undefined,
							message: error.message || error.name,
							stack: error.stack,
							code:
								typeof (error as Error & { code?: unknown }).code === "string" ||
								typeof (error as Error & { code?: unknown }).code === "number"
									? ((error as Error & { code?: string | number }).code ?? undefined)
									: undefined,
						}
					: { name: "ThrownValue", message: String(error) };

			return {
				type,
				timestamp: Date.now(),
				error: normalized,
				details,
			};
		},
	});
});

afterAll(() => {
	uninstallModelAccess();
});
