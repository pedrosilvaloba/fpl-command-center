"use client";

/**
 * O QUE SE VÊ QUANDO ALGO CORRE MAL.
 *
 * Até aqui: nada. Uma exceção no servidor produzia o ecrã de erro cru da
 * Vercel — fundo branco, "500: INTERNAL_SERVER_ERROR", um código de
 * identificação e mais nada. Para quem abre a app isso é
 * indistinguível de "a app desapareceu", e não dá pista nenhuma sobre se
 * o problema é do lado do FPL, da Vercel, ou de uma alteração recente.
 *
 * A diferença entre esta página e a anterior não é decorativa: é a
 * diferença entre "isto está avariado" e "isto vai voltar, e eis porquê".
 */

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Vai para os registos da Vercel, que é onde este erro é diagnosticável.
    console.error("[fpl-command-center] render falhou:", error);
  }, [error]);

  const message = error?.message ?? "";
  // A causa esmagadoramente mais provável, e a única sobre a qual há algo
  // útil a dizer: a API do FPL recusou ou não respondeu.
  const isFplApi = /FPL API|fantasy\.premierleague/i.test(message);

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-2xl flex-col justify-center gap-5 px-5 py-12">
      <div>
        <p className="eyebrow text-warn">Interrupção</p>
        <h1 className="text-balance font-display text-2xl font-bold tracking-tight text-text md:text-3xl">
          {isFplApi
            ? "A API do Fantasy não respondeu"
            : "Alguma coisa falhou ao montar a página"}
        </h1>
      </div>

      <div className="flex flex-col gap-3 text-[15px] leading-relaxed text-text-muted">
        {isFplApi ? (
          <>
            <p>
              Os dados desta app vêm todos do servidor oficial do Fantasy
              Premier League. Nesta altura ele recusou o pedido — acontece
              em picos de tráfego, à volta dos deadlines e durante os
              jogos, e costuma durar segundos ou poucos minutos.
            </p>
            <p>
              <strong className="text-text">Não é preciso fazer nada.</strong>{" "}
              Recarrega daqui a bocado. Se persistir mais de meia hora, o
              problema é do lado deles e a app volta sozinha quando eles
              voltarem.
            </p>
          </>
        ) : (
          <p>
            O erro está registado do lado do servidor. Recarregar resolve
            quase sempre, porque a maioria destas falhas é um pedido de
            dados que correu mal e não se repete.
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2.5">
        <button
          type="button"
          onClick={reset}
          className="rounded-md bg-accent-vivid px-4 py-2 text-sm font-semibold text-accent-contrast"
        >
          Tentar outra vez
        </button>
        <a
          href="/"
          className="rounded-md border border-border px-4 py-2 text-sm font-semibold text-text"
        >
          Voltar ao início
        </a>
      </div>

      {/* O digest é o que permite encontrar este erro exato nos registos da
          Vercel. Sem ele, um relato de "deu erro" é impossível de ligar a
          uma linha de log. */}
      <p className="font-mono text-[11px] text-text-muted opacity-70">
        {error?.digest ? `ref ${error.digest}` : "sem referência"}
        {message ? ` · ${message.slice(0, 160)}` : ""}
      </p>
    </main>
  );
}
