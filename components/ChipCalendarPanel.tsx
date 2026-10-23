import type { ChipCalendar } from "@/lib/chipcalendar";

/** O plano de uso dos chips da primeira metade, para nenhum caducar. */
export default function ChipCalendarPanel({ calendar }: { calendar: ChipCalendar }) {
  return (
    <div className="space-y-2">
      <p className="text-[13px] leading-relaxed text-text-muted">{calendar.note}</p>
      {calendar.slots.length > 0 && (
        <ol className="space-y-1.5">
          {calendar.slots.map((s) => (
            <li
              key={s.chip}
              className="flex flex-col gap-0.5 rounded-md border border-border bg-surface px-3 py-2 sm:flex-row sm:items-baseline sm:gap-3"
            >
              <span className="w-14 shrink-0 font-mono text-[13px] font-semibold text-accent">GW{s.event}</span>
              <span className="w-32 shrink-0 text-[13px] font-semibold text-text">{s.label}</span>
              <span className="text-[12px] leading-relaxed text-text-muted">{s.why}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
