import { Redis } from "@upstash/redis";

let client: Redis | null | undefined;

/**
 * Returns a configured Upstash Redis client, or null when the integration
 * hasn't been connected yet. Vercel auto-injects UPSTASH_REDIS_REST_URL and
 * UPSTASH_REDIS_REST_TOKEN once the (free) Upstash Redis integration is
 * added from the Marketplace to this project — nothing to copy by hand.
 * Callers must treat null as "storage not configured yet" and degrade
 * gracefully (e.g. client-only localStorage) rather than throwing, so the
 * app keeps working before and independently of that setup step.
 */
export function getRedis(): Redis | null {
  if (client !== undefined) return client;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    client = null;
    return client;
  }
  client = new Redis({ url, token });
  return client;
}
