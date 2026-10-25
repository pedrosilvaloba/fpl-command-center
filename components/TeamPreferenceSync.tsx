"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Migrate an older browser-only team preference and keep future navigation
 * server-authoritative. A Team ID is public FPL data, not an auth secret. */
export default function TeamPreferenceSync({
  activeTeamId, explicit,
}: { activeTeamId: number; explicit: boolean }) {
  const router = useRouter();
  useEffect(() => {
    const key = "fpl_team_id";
    try {
      const cookie = document.cookie.split("; ").some((v) => v.startsWith(key + "="));
      if (!explicit && !cookie) {
        const legacy = window.localStorage.getItem(key);
        if (legacy && /^[1-9]\d{0,8}$/.test(legacy) && Number(legacy) !== activeTeamId) {
          const params = new URLSearchParams(window.location.search);
          params.set("team", legacy);
          router.replace("/?" + params.toString(), { scroll: false });
          return;
        }
      }
      if (explicit || !cookie) {
        document.cookie = key + "=" + activeTeamId + "; Path=/; Max-Age=31536000; SameSite=Lax";
      }
      window.localStorage.setItem(key, String(activeTeamId));
    } catch {
      // Storage/cookies may be disabled; explicit ?team= remains authoritative.
    }
  }, [activeTeamId, explicit, router]);
  return null;
}
