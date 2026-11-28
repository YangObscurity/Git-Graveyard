import { type RunRecord } from "@/lib/runs/run-store";
import { EventStore } from "@/lib/events/event-store";

/**
 * Reads the run's admin publish state. A run counts as published when the store row is marked
 * published, when an `admin.publish` event was appended, or (for a store without an event log)
 * when the events table records one. Any read failure is ignored so a missing table or log can
 * never turn a published run into an unpublished one.
 */
export function hasAdminPublishEvent(
  run: RunRecord,
  eventStore: EventStore | null,
  db: unknown
): boolean {
  if (run.isPublished) {
    return true;
  }
  if (eventStore) {
    try {
      const events = eventStore.getEvents(run.runId, { kind: "admin.publish", limit: 1 });
      if (events && events.length > 0) {
        return true;
      }
    } catch {
      // Ignore
    }
  }
  if (db && typeof (db as { prepare?: (s: string) => { get: (id: string) => unknown } }).prepare === "function") {
    try {
      const stmt = (db as { prepare: (s: string) => { get: (id: string) => unknown } }).prepare(
        "SELECT 1 FROM events WHERE runId = ? AND kind = 'admin.publish' LIMIT 1"
      );
      const row = stmt.get(run.runId);
      if (row) {
        return true;
      }
    } catch {
      // Table might not exist in db
    }
  }
  return false;
}

/**
 * Reads the run's admin hide state. A run counts as removed when the store row is marked removed,
 * when an `admin.hide` event was appended, or (for a store without an event log) when the events
 * table records one. Any read failure is ignored so a missing table or log can never turn a
 * removed run back into a visible one.
 */
export function isRunRemoved(
  run: RunRecord,
  eventStore: EventStore | null,
  db: unknown
): boolean {
  if (run.isRemoved) {
    return true;
  }
  if (eventStore) {
    try {
      const events = eventStore.getEvents(run.runId, { kind: "admin.hide", limit: 1 });
      if (events && events.length > 0) {
        return true;
      }
    } catch {
      // Ignore
    }
  }
  if (db && typeof (db as { prepare?: (s: string) => { get: (id: string) => unknown } }).prepare === "function") {
    try {
      const stmt = (db as { prepare: (s: string) => { get: (id: string) => unknown } }).prepare(
        "SELECT 1 FROM events WHERE runId = ? AND kind = 'admin.hide' LIMIT 1"
      );
      const row = stmt.get(run.runId);
      if (row) {
        return true;
      }
    } catch {
      // Table might not exist in db
    }
  }
  return false;
}