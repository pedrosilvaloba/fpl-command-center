import assert from "node:assert/strict";
import {wildcardCaptainAwareValue} from "../lib/wildcarddecision";
const values=(n:number,p:number)=>Array.from({length:n},()=>({expectedPoints:p}));
const baseXi=values(11,20),bench=values(4,3);
// The premier player increases the captain value enough to outweigh a
// slightly lower projection across the other 10 starters.
const premiumXi=[...values(10,19),{expectedPoints:35}];
const without=wildcardCaptainAwareValue(baseXi,bench,baseXi[0]);
const withPremium=wildcardCaptainAwareValue(premiumXi,bench,premiumXi[10]);
assert.ok(withPremium>without);
assert.equal(without,220+20+1.8);
assert.equal(withPremium,225+35+1.8);
assert.equal(wildcardCaptainAwareValue(values(10,20),bench,baseXi[0]),Number.NEGATIVE_INFINITY);
// Names and ownership are deliberately not part of this metric.
assert.equal(wildcardCaptainAwareValue(premiumXi,bench,premiumXi[10]),withPremium);
console.log("Wildcard captain opportunity value: passed");
