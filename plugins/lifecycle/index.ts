import * as lifecycle from "@friday/lifecycle";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { EXECUTION_CAPABILITY } from "../execution/contract.js";
import {
  LIFECYCLE_CAPABILITY,
  LIFECYCLE_HANDOFF_CONTRIBUTION,
  type LifecycleHandoffParticipant,
  type LifecycleService,
} from "./contract.js";

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

const lifecyclePlugin: FridayPlugin = definePlugin({ id: "lifecycle", requires: [EXECUTION_CAPABILITY], provides: [LIFECYCLE_CAPABILITY] }, (ctx) => {
  const execution = ctx.services.require(EXECUTION_CAPABILITY);
  lifecycle.installExecutionAccess({
    launchDetachedProcess(command, args, options) {
      return execution.api.launchDetachedProcess(command, args, options);
    },
    isProcessAlive(pid) {
      return execution.api.isProcessAlive(pid);
    },
    terminateProcess(pid) {
      execution.api.signalProcessGroupOrProcess(pid, "SIGTERM");
    },
    signalProcess(pid, signal) {
      execution.api.signalProcessGroupOrProcess(pid, signal);
    },
  });

  const quiesced = new Map<string, LifecycleHandoffParticipant>();
  const activated = new Map<string, LifecycleHandoffParticipant>();
  const participants = (): readonly LifecycleHandoffParticipant[] => {
    const values = [...ctx.collect(LIFECYCLE_HANDOFF_CONTRIBUTION)].sort((left, right) => left.id.localeCompare(right.id));
    const ids = new Set<string>();
    for (const participant of values) {
      const id = participant.id.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
        throw new Error(`Invalid lifecycle handoff participant id: ${JSON.stringify(participant.id)}`);
      }
      if (ids.has(id)) throw new Error(`Duplicate lifecycle handoff participant: ${id}`);
      ids.add(id);
    }
    return values;
  };

  const service: LifecycleService = Object.freeze({
    api: lifecycle,
    handoff: Object.freeze({
      async quiesce(): Promise<void> {
        const errors: Error[] = [];
        const newlyQuiesced: LifecycleHandoffParticipant[] = [];
        for (const participant of [...participants()].reverse()) {
          if (quiesced.has(participant.id)) continue;
          try {
            await participant.quiesce();
            quiesced.set(participant.id, participant);
            newlyQuiesced.push(participant);
          } catch (error) {
            const quiesceError = errorValue(error);
            errors.push(quiesceError);
            // A participant can fail after partially stopping itself. Because it was
            // never recorded in `quiesced`, a later handoff.resume() cannot repair
            // that partial stop. Compensate immediately before aborting the handoff.
            try {
              await participant.activate();
            } catch (compensationError) {
              errors.push(new Error(
                `Lifecycle participant ${participant.id} failed to reactivate after quiesce failure`,
                { cause: errorValue(compensationError) },
              ));
            }
          }
        }
        if (errors.length > 0) {
          // Callers cannot know which participants stopped before quiesce rejected.
          // Restore every participant stopped by this invocation before reporting
          // the failed handoff. Keep only failed restorations in `quiesced` so a
          // later explicit resume can retry them.
          for (const participant of newlyQuiesced.reverse()) {
            try {
              await participant.activate();
              quiesced.delete(participant.id);
            } catch (compensationError) {
              errors.push(new Error(
                `Lifecycle participant ${participant.id} failed to resume after another participant could not quiesce`,
                { cause: errorValue(compensationError) },
              ));
            }
          }
          throw new AggregateError(errors, "One or more lifecycle resources could not quiesce");
        }
      },
      async resume(): Promise<void> {
        const errors: Error[] = [];
        for (const participant of participants()) {
          if (!quiesced.has(participant.id)) continue;
          try {
            await participant.activate();
            quiesced.delete(participant.id);
          } catch (error) {
            errors.push(errorValue(error));
          }
        }
        if (errors.length > 0) throw new AggregateError(errors, "One or more lifecycle resources could not resume");
      },
      async activate(): Promise<void> {
        const newlyActivated: LifecycleHandoffParticipant[] = [];
        try {
          for (const participant of participants()) {
            if (activated.has(participant.id)) continue;
            await participant.activate();
            activated.set(participant.id, participant);
            newlyActivated.push(participant);
          }
        } catch (primaryError) {
          const errors = [errorValue(primaryError)];
          for (const participant of newlyActivated.reverse()) {
            try {
              await participant.quiesce();
              activated.delete(participant.id);
            } catch (cleanupError) {
              errors.push(errorValue(cleanupError));
            }
          }
          throw new AggregateError(errors, "Lifecycle successor activation failed");
        }
      },
      status: () => Object.freeze({
        quiesced: Object.freeze([...quiesced.keys()].sort()),
        activated: Object.freeze([...activated.keys()].sort()),
      }),
    }),
  });
  ctx.services.provide(LIFECYCLE_CAPABILITY, service);
});

export default lifecyclePlugin;
