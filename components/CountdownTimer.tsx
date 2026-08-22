"use client";

import { useEffect, useState } from "react";

function parts(ms: number): { value: string; unit: string }[] | null {
  if (ms <= 0) return null;
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  // Below a day, seconds start to matter and days stop being informative.
  if (days > 0) {
    return [
      { value: String(days), unit: "d" },
      { value: pad(hours), unit: "h" },
      { value: pad(minutes), unit: "m" },
    ];
  }
  return [
    { value: pad(hours), unit: "h" },
    { value: pad(minutes), unit: "m" },
    { value: pad(seconds), unit: "s" },
  ];
}

/**
 * The deadline clock.
 *
 * This is the one number on the page that is relevant on every single visit,
 * so it gets display type and the brand green rather than being one stat
 * among four. The unit letters are set smaller and dimmer than the figures so
 * the eye lands on the numbers first.
 */
export default function CountdownTimer({
  deadlineIso,
  urgentHours = 24,
}: {
  deadlineIso: string;
  /** Below this many hours remaining, the clock switches to the alert colour. */
  urgentHours?: number;
}) {
  const [remainingMs, setRemainingMs] = useState<number | null>(null);

  useEffect(() => {
    const deadline = new Date(deadlineIso).getTime();
    const tick = () => setRemainingMs(deadline - Date.now());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [deadlineIso]);

  if (remainingMs === null) {
    return <span className="font-display text-xl font-bold text-white/40">—</span>;
  }

  const chunks = parts(remainingMs);
  if (!chunks) {
    return (
      <span className="font-display text-lg font-bold text-[var(--brand-pink)]">
        Deadline passado
      </span>
    );
  }

  const urgent = remainingMs < urgentHours * 3600 * 1000;
  const color = urgent ? "var(--brand-pink)" : "var(--brand-green)";

  return (
    <span
      className="font-display text-xl font-bold leading-none tracking-tight tabular md:text-2xl"
      style={{ color }}
      suppressHydrationWarning
    >
      {chunks.map((c, i) => (
        <span key={c.unit}>
          {i > 0 && <span className="mx-1 opacity-30">·</span>}
          {c.value}
          <span className="ml-0.5 text-[0.6em] font-medium opacity-60">{c.unit}</span>
        </span>
      ))}
    </span>
  );
}
