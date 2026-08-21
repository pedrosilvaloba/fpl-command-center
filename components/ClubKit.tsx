/**
 * A club's shirt, drawn as an inline SVG.
 *
 * FPL's own API publishes no club colours — only names, short names and
 * strength ratings — so the palette below is hand-maintained, keyed on the
 * short name (which is stable across seasons in a way ids are not). Clubs
 * outside the map fall back to the app's brand purple rather than being
 * skipped, so a promoted side that nobody has added yet still renders a
 * shirt instead of a hole in the pitch.
 */

const KITS: Record<string, [string, string]> = {
  ARS: ["#ef0107", "#ffffff"],
  AVL: ["#95bfe5", "#670e36"],
  BHA: ["#0057b8", "#ffffff"],
  BOU: ["#da291c", "#000000"],
  BRE: ["#e30613", "#ffffff"],
  BUR: ["#6c1d45", "#99d6ea"],
  CHE: ["#034694", "#ffffff"],
  CRY: ["#1b458f", "#c4122e"],
  EVE: ["#003399", "#ffffff"],
  FUL: ["#ffffff", "#000000"],
  IPS: ["#3a64a3", "#ffffff"],
  LEE: ["#ffffff", "#1d428a"],
  LEI: ["#003090", "#fdbe11"],
  LIV: ["#c8102e", "#00b2a9"],
  MCI: ["#6cabdd", "#ffffff"],
  MUN: ["#da291c", "#fbe122"],
  NEW: ["#241f20", "#ffffff"],
  NFO: ["#dd0000", "#ffffff"],
  SOU: ["#d71920", "#ffffff"],
  TOT: ["#ffffff", "#132257"],
  WHU: ["#7a263a", "#1bb1e7"],
  WOL: ["#fdb913", "#231f20"],
  SUN: ["#eb172b", "#ffffff"],
  COV: ["#6caddf", "#ffffff"],
  MID: ["#dc2e35", "#ffffff"],
  WBA: ["#122f67", "#ffffff"],
  NOR: ["#00a650", "#fff200"],
  SHU: ["#ee2737", "#000000"],
  LUT: ["#f78f1e", "#ffffff"],
  WAT: ["#fbee23", "#ed2127"],
  STO: ["#e03a3e", "#ffffff"],
  HUL: ["#f5971d", "#000000"],
  QPR: ["#005cab", "#ffffff"],
  BIR: ["#0000ff", "#ffffff"],
  MIL: ["#002f6c", "#ffffff"],
  CAR: ["#0070b5", "#ffffff"],
  BLB: ["#009ee0", "#ffffff"],
  DER: ["#ffffff", "#000000"],
  PLY: ["#007b5f", "#ffffff"],
  OXF: ["#ffd700", "#00205b"],
  PRE: ["#ffffff", "#b2b2b2"],
  SWA: ["#ffffff", "#000000"],
};

const FALLBACK: [string, string] = ["#37003c", "#00ff87"];

export default function ClubKit({
  shortName,
  isKeeper = false,
  size = 30,
}: {
  shortName: string;
  isKeeper?: boolean;
  size?: number;
}) {
  // Keepers wear something different from the outfield kit — showing them in
  // the outfield shirt is the kind of small wrongness that makes a whole
  // panel feel careless.
  const [primary, secondary] = isKeeper
    ? (["#1f9d55", "#0b3d24"] as [string, string])
    : (KITS[shortName] ?? FALLBACK);

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M11 4 6 7 4 13l4 1.6V28h16V14.6l4-1.6-2-6-5-3-1.2 2.2a4.2 4.2 0 0 1-7.6 0Z"
        fill={primary}
        stroke="rgba(0,0,0,0.35)"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <path d="M12.2 4h1.6l1 2h4.4l1-2h1.6l-2 4h-5.6Z" fill={secondary} opacity="0.9" />
      <path d="M8 14.6 4 13l2-6 3-1.8v9.4Z" fill={secondary} opacity="0.55" />
      <path d="M24 14.6 28 13l-2-6-3-1.8v9.4Z" fill={secondary} opacity="0.55" />
    </svg>
  );
}
