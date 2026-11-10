"use client";
import {useState} from "react";
import {clubKitUrl} from "@/lib/clubkits";

export default function ClubKit({shortName,isKeeper=false,size=30,teamCode}:{
 shortName:string;isKeeper?:boolean;size?:number;teamCode?:number;
}){
 const src=clubKitUrl(shortName,isKeeper,teamCode);
 const [failed,setFailed]=useState<string|null>(null);
 if(!src||failed===src)return <span title={`Equipamento indisponível · ${shortName}`}
   className="inline-flex shrink-0 items-center justify-center rounded bg-surface-2 text-[9px] font-bold"
   style={{width:size,height:size}}>{shortName}</span>;
 return <img src={src} alt={`Equipamento ${shortName}${isKeeper?' · guarda-redes':''}`}
   width={size} height={size} className="shrink-0 object-contain" loading="lazy"
   onError={()=>setFailed(src)}/>;
}
