import * as compaction from "@friday/compaction";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { MODEL_CAPABILITY } from "../model/contract.js";
import { SESSIONS_CAPABILITY } from "../sessions/contract.js";
import { COMPACTION_CAPABILITY, type CompactionService } from "./contract.js";

const compactionPlugin: FridayPlugin = definePlugin({ id: "compaction", requires: [MODEL_CAPABILITY, SESSIONS_CAPABILITY], provides: [COMPACTION_CAPABILITY] }, (ctx) => {
  const model = ctx.services.require(MODEL_CAPABILITY);
  const sessions = ctx.services.require(SESSIONS_CAPABILITY);

  const completeSimple = model.completeSimple as unknown as compaction.CompactionModelAccess["completeSimple"];
  compaction.installModelAccess({ completeSimple });
  compaction.installSessionAccess({
    open: (path, cwdOverride) =>
      sessions.SessionManager.open(path, undefined, cwdOverride) as unknown as compaction.CompactionSessionPort,
  });

  const service: CompactionService = Object.freeze({ compactSession: compaction.compactSession });
  ctx.services.provide(COMPACTION_CAPABILITY, service);
});

export default compactionPlugin;
