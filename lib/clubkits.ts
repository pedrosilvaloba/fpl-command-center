/* Official FPL team codes verified 2026-11-10; codes are stable across seasons. */
const codes: Record<string, number> = {"ARS": 3, "AVL": 7, "BOU": 91, "BRE": 94, "BHA": 36, "CHE": 8, "COV": 9, "CRY": 31, "EVE": 11, "FUL": 54, "HUL": 88, "IPS": 40, "LEE": 2, "LIV": 14, "MCI": 43, "MUN": 1, "NEW": 4, "NFO": 17, "TOT": 6, "SUN": 56};
export function clubKitUrl(shortName:string,isKeeper=false,teamCode?:number){
 const code=teamCode??codes[shortName];
 return Number.isSafeInteger(code)&&code>0 ? `https://fantasy.premierleague.com/dist/img/shirts/standard/shirt_${code}${isKeeper?"_1":""}-66.png` : null;
}
