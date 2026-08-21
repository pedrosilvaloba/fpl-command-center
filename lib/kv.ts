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

/**
 * Is persistent storage actually connected?
 *
 * Three separate features depend on this and every one of them degraded
 * SILENTLY when it was absent: the Shadow Team fell back to browser-only
 * storage, the model-accuracy panel recorded nothing, and — most
 * damagingly — the weekly tactical-research layer could pass every check
 * it had (authentication, name resolution, validation) and then fail at
 * the final write with nobody ever seeing the error. The dashboard showed
 * "no active notes", which reads as "the research found nothing" rather
 * than "this feature cannot store anything at all".
 *
 * That is the same class of failure as the odds key being absent: an
 * optional integration missing, and an interface that looks fine. Callers
 * should use this to say so out loud instead of rendering an empty state.
 */
export function isStorageConfigured(): boolean {
  return getRedis() !== null;
}
