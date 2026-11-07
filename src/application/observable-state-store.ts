/**
 * Observable State Store Wrapper (Milestone 2.26)
 *
 * Wraps a StateStorePort so that whenever transactions or direct event appends
 * commit to the underlying SQLite WAL store, genuine PersistedEvents are broadcast
 * to the registered EventEmitter on channel `run:<runId>`.
 *
 * Guarantees:
 * 1. Durability First: Events are only emitted AFTER the database transaction commits.
 *    If a transaction fails or rolls back, no uncommitted events are ever broadcast.
 * 2. Complete Coverage: Catches insertRun, updateRun, appendEvent, insertAction, updateAction,
 *    insertAttempt, updateAttempt, transitionAttempt.
 * 3. Transparent Delegation: All other queries and mutations pass through directly to the underlying store.
 */

import type { EventEmitter } from "node:events";
import type { DomainEvent } from "../domain/events.js";
import type {
  PersistedEvent,
  StateStorePort,
  StorageTransaction,
} from "../ports/state-store.port.js";

export function createObservableStateStore(
  store: StateStorePort,
  eventBroadcaster: EventEmitter
): StateStorePort {
  return new Proxy(store, {
    get(target, prop) {
      if (prop === "transaction") {
        return <T>(operation: (tx: StorageTransaction) => T): T => {
          const pendingEvents: PersistedEvent[] = [];
          const result = target.transaction((tx) => {
            const wrappedTx = new Proxy(tx, {
              get(tTx, txProp) {
                const orig = (tTx as any)[txProp];
                if (typeof orig !== "function") return orig;
                if (
                  txProp === "insertRun" ||
                  txProp === "updateRun" ||
                  txProp === "appendEvent" ||
                  txProp === "insertAction" ||
                  txProp === "updateAction" ||
                  txProp === "insertAttempt" ||
                  txProp === "updateAttempt"
                ) {
                  return (...args: any[]) => {
                    const persisted = orig.apply(tTx, args);
                    if (persisted && typeof (persisted as PersistedEvent).runId === "string") {
                      pendingEvents.push(persisted as PersistedEvent);
                    }
                    return persisted;
                  };
                }
                if (txProp === "transitionAttempt" || txProp === "transitionAction") {
                  return (...args: any[]) => {
                    const res = orig.apply(tTx, args);
                    if (res && res.event && typeof res.event.runId === "string") {
                      pendingEvents.push(res.event);
                    }
                    return res;
                  };
                }
                return orig.bind(tTx);
              },
            });
            return operation(wrappedTx);
          });
          // Transaction committed successfully! Emit all persisted events.
          for (const evt of pendingEvents) {
            if (evt && evt.runId) {
              eventBroadcaster.emit(`run:${evt.runId}`, evt);
            }
          }
          return result;
        };
      }
      if (prop === "appendEvent" && typeof (target as any).appendEvent === "function") {
        return (event: DomainEvent): PersistedEvent => {
          const persisted = (target as any).appendEvent(event);
          if (persisted && persisted.runId) {
            eventBroadcaster.emit(`run:${persisted.runId}`, persisted);
          }
          return persisted;
        };
      }
      const val = (target as any)[prop];
      if (typeof val === "function") {
        return val.bind(target);
      }
      return val;
    },
  });
}
