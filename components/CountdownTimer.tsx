"use client";

import { useEffect, useState } from "react";

function formatRemaining(ms: number): string {
  if (ms <= 0) return "Deadline passado";
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (days > 0) return `${days}d ${pad(hours)}h ${pad(minutes)}m`;
  return `${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
}

export default function CountdownTimer({ deadlineIso }: { deadlineIso: string }) {
  const [remaining, setRemaining] = useState<string | null>(null);

  useEffect(() => {
    const deadline = new Date(deadlineIso).getTime();
    const tick = () => setRemaining(formatRemaining(deadline - Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [deadlineIso]);

  return (
    <span className="font-mono tabular text-2xl font-semibold text-accent">
      {remaining ?? "—"}
    </span>
  );
}
