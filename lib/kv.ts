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
/**
 * The same Upstash Redis database is exposed under TWO different sets of
 * environment-variable names depending on how it was connected:
 *
 *   - `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` when the
 *     credentials are taken straight from upstash.com and pasted in.
 *   - `KV_REST_API_URL` / `KV_REST_API_TOKEN` when the database is added
 *     through Vercel's Storage tab, which still uses the naming inherited
 *     from the old Vercel KV product.
 *
 * This code originally only looked for the first pair, so a database
 * created the normal way — through Vercel's own UI, correctly created and
 * correctly linked to the project — was invisible to the app, which then
 * reported that storage "was not connected". The failure looked like a
 * setup mistake by the user when it was a wrong assumption here.
 *
 * Note that `KV_REST_API_READ_ONLY_TOKEN` is deliberately NOT accepted:
 * this app writes (Shadow Team, accuracy snapshots, tactical notes), so a
 * read-only token would fail later, at the first write, which is exactly
 * the kind of delayed and confusing failure this file exists to avoid.
 */
function readCredentials(): { url: string; token: string } | null {
  const url =
    process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

export function getRedis(): Redis | null {
  if (client !== undefined) return client;
  const creds = readCredentials();
  if (!creds) {
    client = null;
    return client;
  }
  client = new Redis({ url: creds.url, token: creds.token });
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
