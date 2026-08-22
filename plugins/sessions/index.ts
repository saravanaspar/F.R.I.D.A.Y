import * as sessions from "@friday/sessions";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { SESSIONS_CAPABILITY, type SessionsService } from "./contract.js";

const sessionsPlugin: FridayPlugin = definePlugin({ id: "sessions", provides: [SESSIONS_CAPABILITY] }, (ctx) => {
  const service: SessionsService = Object.freeze({ api: sessions });
  ctx.services.provide(SESSIONS_CAPABILITY, service);
});

export default sessionsPlugin;
