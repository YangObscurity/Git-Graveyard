import type { Readable } from "node:stream";
import { Readable as NodeReadable } from "node:stream";
import * as fs from "node:fs";
import * as path from "node:path";
import type { EventEnvelope } from "./types";
import type { EventStore, GetEventsOptions } from "./event-store";

export interface EventStreamSource {
  iterateEvents(runId: string, options?: GetEventsOptions): Iterable<EventEnvelope>;
  getEvents?(runId: string, options?: GetEventsOptions): EventEnvelope[];
}

export function formatEventAsNdjson(event: EventEnvelope): string {
  return JSON.stringify(event) + "\n";
}

export function* generateNdjsonLines(
  source: EventStreamSource | EventStore,
  runId: string,
  options?: GetEventsOptions
): Generator<string, void, unknown> {
  for (const event of source.iterateEvents(runId, options)) {
    yield formatEventAsNdjson(event);
  }
}

export async function* streamEventsAsNdjson(
  source: EventStreamSource | EventStore,
  runId: string,
  options?: GetEventsOptions
): AsyncGenerator<string, void, unknown> {
  for (const event of source.iterateEvents(runId, options)) {
    yield formatEventAsNdjson(event);
  }
}

export function exportEventsAsNdjsonStream(
  source: EventStreamSource | EventStore,
  runId: string,
  options?: GetEventsOptions
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = source.iterateEvents(runId, options)[Symbol.iterator]();

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = iterator.next();
      if (next.done) {
        controller.close();
      } else {
        const line = formatEventAsNdjson(next.value);
        controller.enqueue(encoder.encode(line));
      }
    },
  });
}

export function createNdjsonStream(
  source: EventStreamSource | EventStore,
  runId: string,
  options?: GetEventsOptions
): ReadableStream<Uint8Array> {
  return exportEventsAsNdjsonStream(source, runId, options);
}

export function exportEventsAsNdjsonReadable(
  source: EventStreamSource | EventStore,
  runId: string,
  options?: GetEventsOptions
): Readable {
  const iterator = source.iterateEvents(runId, options)[Symbol.iterator]();

  return new NodeReadable({
    read() {
      const next = iterator.next();
      if (next.done) {
        this.push(null);
      } else {
        this.push(formatEventAsNdjson(next.value), "utf8");
      }
    },
  });
}

export function exportEventsToNdjson(
  source: EventStreamSource | EventStore,
  runId: string,
  options?: GetEventsOptions
): string {
  let output = "";
  for (const event of source.iterateEvents(runId, options)) {
    output += formatEventAsNdjson(event);
  }
  return output;
}

export async function exportEventsToNdjsonFile(
  source: EventStreamSource | EventStore,
  runId: string,
  filePath: string,
  options?: GetEventsOptions
): Promise<void> {
  const dir = path.dirname(filePath);
  if (dir && dir !== "." && !fs.existsSync(dir)) {
    await fs.promises.mkdir(dir, { recursive: true });
  }

  const writeStream = fs.createWriteStream(filePath, { encoding: "utf8" });
  try {
    for (const event of source.iterateEvents(runId, options)) {
      const line = formatEventAsNdjson(event);
      if (!writeStream.write(line)) {
        await new Promise<void>((resolve) => writeStream.once("drain", () => resolve()));
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      writeStream.end((err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

export function exportEventsToNdjsonFileSync(
  source: EventStreamSource | EventStore,
  runId: string,
  filePath: string,
  options?: GetEventsOptions
): void {
  const dir = path.dirname(filePath);
  if (dir && dir !== "." && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const content = exportEventsToNdjson(source, runId, options);
  fs.writeFileSync(filePath, content, "utf8");
}

export function parseNdjson(ndjson: string): EventEnvelope[] {
  if (!ndjson || typeof ndjson !== "string") {
    return [];
  }
  const lines = ndjson.split("\n");
  const events: EventEnvelope[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    events.push(JSON.parse(trimmed) as EventEnvelope);
  }
  return events;
}
