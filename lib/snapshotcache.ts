import { gzipSync, gunzipSync } from "node:zlib";
import { getRedis } from "./kv";

/**
 * CÓPIA DE SEGURANÇA DOS ÚLTIMOS DADOS BONS.
 *
 * A app inteira morria com um 500 em branco sempre que a API do FPL
 * recusasse UM pedido. Aconteceu a 4 de setembro às 17:27 — um 403 no
 * /bootstrap-static/ — e a página deixou de existir para quem a abrisse
 * nesse minuto. Nada no código tinha memória de nada.
 *
 * A memória tem de viver FORA do processo. Uma cache em variável de
 * módulo parece resolver e não resolve: no plano Hobby a função arrefece
 * ao fim de poucos minutos sem tráfego, e a app é aberta duas ou três
 * vezes por dia. Quase todas as visitas são um arranque a frio, com a
 * memória do processo vazia — exatamente quando o retry já falhou e a
 * cópia era precisa. Por isso o snapshot vai para o Redis.
 *
 * DOIS CUIDADOS, porque um snapshot é uma mentira em potência:
 *
 *  1. Só é lido quando o pedido em direto falhou. Nunca substitui dados
 *     frescos, nunca é preferido por ser mais rápido.
 *  2. Guarda a hora a que foi tirado, e quem o usa é obrigado a dizê-lo
 *     ao ecrã. Preços e lesões desatualizados em silêncio são piores do
 *     que uma página em branco: uma página em branco não engana ninguém.
 *
 * O /bootstrap-static/ tem alguns MB. Vai comprimido (gzip + base64,
 * ~10:1 em JSON) e partido em pedaços, porque o limite de tamanho por
 * pedido do Upstash não é generoso e falhar por 1 byte a mais devolveria
 * exatamente o tipo de erro silencioso que este ficheiro existe para
 * eliminar. Um snapshot incompleto é tratado como inexistente.
 */

/** Pedaços com folga confortável abaixo do limite por pedido do Upstash. */
const CHUNK_CHARS = 300_000;
/** Mais do que isto não é um snapshot, é um abuso do armazenamento. */
const MAX_CHUNKS = 12;
/** Um snapshot mais velho do que isto não serve para decidir nada. */
const SNAPSHOT_TTL_SECONDS = 60 * 60 * 30; // 30 horas
/**
 * Escrever a cada render gastaria a largura de banda do plano gratuito em
 * dias. Uma vez por período é suficiente: o snapshot só serve para o caso
 * em que a alternativa é não haver app nenhuma.
 */
const WRITE_INTERVAL_SECONDS = 60 * 60 * 6; // 6 horas

const dataKey = (name: string, index: number) => `snap:${name}:${index}`;
const metaKey = (name: string) => `snap:${name}:meta`;
const lockKey = (name: string) => `snap:${name}:lock`;

interface SnapshotMeta {
  /** Milissegundos epoch de quando o snapshot foi tirado. */
  at: number;
  /** Quantos pedaços compõem este snapshot. */
  parts: number;
}

export interface LoadedSnapshot<T> {
  value: T;
  /** Quando estes dados foram lidos da API do FPL pela última vez. */
  at: number;
}

export function encodeSnapshot(value: unknown): string {
  return gzipSync(Buffer.from(JSON.stringify(value), "utf8")).toString(
    "base64"
  );
}

export function decodeSnapshot<T>(encoded: string): T {
  return JSON.parse(
    gunzipSync(Buffer.from(encoded, "base64")).toString("utf8")
  ) as T;
}

export function splitEncoded(encoded: string, size = CHUNK_CHARS): string[] {
  const parts: string[] = [];
  for (let i = 0; i < encoded.length; i += size) {
    parts.push(encoded.slice(i, i + size));
  }
  // Uma string vazia produziria zero pedaços, e zero pedaços lê-se como
  // "não há snapshot" na reconstrução. Um pedaço vazio é honesto.
  return parts.length > 0 ? parts : [""];
}

/**
 * Guarda um snapshot, no máximo uma vez por `WRITE_INTERVAL_SECONDS`.
 *
 * Devolve `true` só quando escreveu de facto. Nunca lança: falhar a
 * guardar a cópia de segurança não pode ser o motivo pelo qual a página
 * que estava a correr bem deixa de responder.
 */
export async function saveSnapshot(
  name: string,
  value: unknown
): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    // SET NX EX: quem conseguir pôr a marca é quem escreve. Sem isto,
    // dois renders simultâneos escreveriam o mesmo snapshot duas vezes.
    const won = await redis.set(lockKey(name), Date.now(), {
      nx: true,
      ex: WRITE_INTERVAL_SECONDS,
    });
    if (!won) return false;

    const parts = splitEncoded(encodeSnapshot(value));
    if (parts.length > MAX_CHUNKS) return false;

    for (let i = 0; i < parts.length; i += 1) {
      await redis.set(dataKey(name, i), parts[i], {
        ex: SNAPSHOT_TTL_SECONDS,
      });
    }
    // O meta é escrito EM ÚLTIMO, de propósito: enquanto os pedaços estão
    // a ser escritos, o meta antigo continua a apontar para um conjunto
    // coerente. Só quando todos os pedaços novos existem é que o leitor
    // passa a ver o snapshot novo.
    const meta: SnapshotMeta = { at: Date.now(), parts: parts.length };
    await redis.set(metaKey(name), meta, { ex: SNAPSHOT_TTL_SECONDS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Lê o último snapshot bom, ou null se não houver um completo.
 *
 * "Completo" é levado à letra: se faltar um pedaço — expirou, a escrita
 * foi interrompida, o Redis perdeu-o — devolve null em vez de tentar
 * reconstruir a partir do que sobrou. Dados meio-lidos são pior do que
 * dados nenhuns.
 */
export async function loadSnapshot<T>(
  name: string
): Promise<LoadedSnapshot<T> | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const meta = await redis.get<SnapshotMeta>(metaKey(name));
    if (!meta || typeof meta.parts !== "number" || meta.parts < 1) return null;
    if (meta.parts > MAX_CHUNKS) return null;

    const parts: string[] = [];
    for (let i = 0; i < meta.parts; i += 1) {
      const part = await redis.get<string>(dataKey(name, i));
      if (typeof part !== "string") return null;
      parts.push(part);
    }
    return { value: decodeSnapshot<T>(parts.join("")), at: meta.at };
  } catch {
    return null;
  }
}
