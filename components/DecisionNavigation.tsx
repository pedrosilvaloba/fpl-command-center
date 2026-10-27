"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { parseAppView, parseTeamId, viewHref } from "@/lib/appcontext";

function NavigationLinks() {
  const params = useSearchParams();
  const teamId = parseTeamId(params.get("team") ?? undefined);
  const current = parseAppView(params.get("view") ?? undefined);
  const links = [
    { id: "hoje", label: "A minha jornada" },
    { id: "simular", label: "Planear" },
    { id: "analisar", label: "Analisar" },
  ] as const;
  return (
    <nav aria-label="Navegação principal" className="decision-dock">
      <div className="decision-dock-inner">
        {links.map(link => (
          <a key={link.id} href={viewHref(teamId, link.id)}
            aria-current={current === link.id ? "page" : undefined}
            className={`decision-dock-link ${current === link.id ? "decision-dock-current" : ""}`}>
            {link.label}
          </a>
        ))}
        <a href={viewHref(teamId,"sistema")} aria-label="Definições e sistema"
          title="Definições e diagnóstico" className="decision-dock-settings">⚙</a>
      </div>
    </nav>
  );
}

export default function DecisionNavigation() {
  return (
    <Suspense fallback={null}>
      <NavigationLinks />
    </Suspense>
  );
}
