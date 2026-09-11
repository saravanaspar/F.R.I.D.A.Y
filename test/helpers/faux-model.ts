import * as modelRuntime from "@friday/model";
import type { ModelService } from "../../plugins/model/contract.js";

export function withTestModel(
  models: ModelService,
  registration: ReturnType<typeof modelRuntime.registerFauxProvider>,
): ModelService {
  const registered = registration.getModel();
  return Object.freeze({
    ...models,
    getModel(provider: string, modelId: string) {
      if (provider === String(registered.provider) && modelId === String(registered.id)) return registered;
      return models.getModel(provider as never, modelId as never);
    },
  }) as ModelService;
}
