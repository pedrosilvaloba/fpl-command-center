"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { parseAppView, type AppView } from "@/lib/appcontext";

function NavigationLinks() {
  const params = useSearchParams();
  const href = (view: AppView) => {
    const query = new URLSearchParams();
    const team = params.get("team");
    if (team) query.set("team", team);
    query.set("view", view);
    return "/?" + query.toString();
  };
  const current = parseAppView(params.get("view") ?? undefined);
  const links = [
    { id: "hoje", label: "Hoje" },
    { id: "simular", label: "Simular" },
    { id: "analisar", label: "Resultados" },
  ] as const;
  return (
    <nav aria-label="Navegação principal" className="decision-dock">
      <div className="decision-dock-inner">
        {links.map(link => (
          <a key={link.id} href={href(link.id)}
            aria-current={current === link.id ? "page" : undefined}
            className={`decision-dock-link ${current === link.id ? "decision-dock-current" : ""}`}>
            {link.label}
          </a>
        ))}
        <a href={href("sistema")} aria-label="Definições e sistema"
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
