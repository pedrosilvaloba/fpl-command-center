import { getRedis } from "./kv";

/**
 * CHUNKED SUBMISSION — because the pipe is narrower than anyone can measure
 * from either end.
 *
 * The scheduled research session can only reach this app through a GET, so
 * findings travel in a query string. Twice now that has failed on length, and
 * BOTH TIMES THE FAILURE WAS INVISIBLE from the sending side: the session
 * believed it had submitted, the app recorded an empty week, and the two
 * agreed with each other.
 *
 * Compression (see `decodeCompressedPayload`) shrinks a ten-finding
 * submission from ~4,400 URL characters to ~560, which should be ample. But
 * "should be ample" is exactly what was believed about 8,000 characters, and
 * the limit is not ours to see: it lives in a proxy between the session and
 * here, it is not documented anywhere either side can read, and attempting to
 * probe it from this end returns 403 without a length in sight.
 *
 * So the design stops guessing. Any submission can be split into parts, none
 * of which needs to be long, and the server reassembles them. The sender
 * picks a submission id, says how many parts there are, and sends them in any
 * order; the last one to arrive completes the set and triggers processing.
 *
 * WHAT MAKES THIS SAFE RATHER THAN JUST MORE MOVING PARTS: an incomplete set
 * does NOTHING. It is not recorded, not partially applied, and the response
 * names exactly which parts are still missing. The failure mode of this
 * protocol is "nothing happened and it said so", which is the opposite of
 * the failure mode it replaces.
 */

/** Parts live only as long as one submission plausibly takes. */
const CHUNK_TTL_SECONDS = 900;
/** More parts than this is not a submission, it is a storage attempt. */
export const MAX_CHUNKS = 12;

const key = (sid: string, index: number) => `insights:chunk:${sid}:${index}`;

export interface ChunkStatus {
  complete: boolean;
  received: number[];
  missing: number[];
  /** Present only when every part has arrived. */
  assembled?: string;
}

/** Submission ids are caller-chosen, so they are constrained rather than
 * trusted: short, alphanumeric, and unable to reach outside their namespace. */
export function isValidSubmissionId(sid: string): boolean {
  return /^[A-Za-z0-9_-]{4,40}$/.test(sid);
}

export async function storeChunk(
  sid: string,
  index: number,
  total: number,
  part: string
): Promise<ChunkStatus> {
  const redis = getRedis();
  if (!redis) {
    throw new Error("armazenamento não configurado — envio por partes indisponível");
  }
  await redis.set(key(sid, index), part, { ex: CHUNK_TTL_SECONDS });

  const indices = Array.from({ length: total }, (_, i) => i + 1);
  const parts = await Promise.all(indices.map((i) => redis.get<string>(key(sid, i))));

  const received: number[] = [];
  const missing: number[] = [];
  indices.forEach((i, at) => {
    if (typeof parts[at] === "string") received.push(i);
    else missing.push(i);
  });

  if (missing.length > 0) return { complete: false, received, missing };
  return {
    complete: true,
    received,
    missing,
    assembled: (parts as string[]).join(""),
  };
}

/** Clears a completed submission's parts. Best-effort: a leftover part is
 * harmless (it expires) and must never fail the submission it belongs to. */
export async function clearChunks(sid: string, total: number): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await Promise.all(
      Array.from({ length: total }, (_, i) => redis.del(key(sid, i + 1)))
    );
  } catch {
    /* ignored on purpose — see the note above */
  }
}
