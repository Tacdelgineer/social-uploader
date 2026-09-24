import type { AppEvent } from "../shared/contracts";
import type { Env } from "./env";

const EVENT_PREFIX = "event:";
const EVENT_TTL_SECONDS = 30 * 24 * 60 * 60;

type NewAppEvent = Omit<AppEvent, "id" | "timestamp"> & { timestamp?: string };

export async function recordAppEvent(env: Env, input: NewAppEvent): Promise<void> {
  const event: AppEvent = {
    ...input,
    id: crypto.randomUUID(),
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
  try {
    await env.METADATA.put(`${EVENT_PREFIX}${event.timestamp}:${event.id}`, JSON.stringify(event), {
      expirationTtl: EVENT_TTL_SECONDS,
    });
  } catch (error) {
    console.error("Could not store app event", error);
  }
}

export async function listAppEvents(env: Env, limit = 50): Promise<AppEvent[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.METADATA.list({ prefix: EVENT_PREFIX, cursor, limit: 1000 });
    keys.push(...page.keys.map((item) => item.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const recentKeys = keys.sort().reverse().slice(0, limit);
  const events = await Promise.all(
    recentKeys.map((key) => env.METADATA.get<AppEvent>(key, "json")),
  );
  return events.filter((event): event is AppEvent => event !== null);
}
