import { strict as assert } from "node:assert";
import { manageReport, parseTrashCursor, requestJson, answerQuestion } from "../functions/restaurant-analysis/core.ts";
const id = "11111111-2222-4333-8444-555555555555";
Deno.test("trash cursor preserves database microseconds and rejects injected query fragments", () => {
  const at = "2026-10-31T05:39:20.123456+00:00";
  assert.deepEqual(parseTrashCursor(btoa(JSON.stringify({at,id}))), {at,id});
  assert.equal(parseTrashCursor(undefined), null);
  for (const value of [42, "!invalid!", btoa(JSON.stringify({at:at+",id.not.is.null",id})), btoa(JSON.stringify({at,id:"other.eq.value"}))]) assert.throws(()=>parseTrashCursor(value), /ゴミ箱/);
});
Deno.test("permanent deletion requires true confirmation and binds the authenticated owner", async () => {
  const calls:any[]=[];
  const admin={rpc:async(name:string,args:any)=>{calls.push({name,args});return {data:{deleted:true},error:null};}};
  for (const confirm of [undefined,false,"true",1]) await assert.rejects(()=>manageReport({},admin,"authenticated-owner",{action:"delete_report",reportId:id,confirm}), /確認/);
  assert.equal(calls.length,0);
  assert.deepEqual(await manageReport({},admin,"authenticated-owner",{action:"delete_report",reportId:id,confirm:true,userId:"attacker"}),{deleted:true,reportId:id});
  assert.equal(calls[0].args.p_user_id,"authenticated-owner");
  assert.equal(calls[0].args.p_report_id,id);
});
Deno.test("late provider usage updates never restore links removed by permanent deletion", async () => {
  const oldFetch=globalThis.fetch;
  const inserts:any[]=[],updates:any[]=[];
  const db={from:()=>({insert:async(row:any)=>{inserts.push(row);return {error:null};},update:(row:any)=>({eq:()=>({eq:async()=>{updates.push(row);return {error:null};}})})})};
  globalThis.fetch=async()=>Response.json({output_text:"answer",usage:{input_tokens:10,output_tokens:20}});
  try {
    await requestJson("https://api.openai.com/v1/responses","test-key",{model:"gpt-6.1-terra"},false,{costDb:db,userId:"owner",reportId:id,operation:"followup_question"});
    assert.equal(inserts[0].report_id,id);
    assert.equal(updates.at(-1).request_status,"succeeded");
    for(const field of ["user_id","report_id","run_id","job_id"]) assert.equal(Object.hasOwn(updates.at(-1),field),false);
  } finally {globalThis.fetch=oldFetch;}
});
Deno.test("a trashed report rejects questions before any provider call", async()=>{
  const oldFetch=globalThis.fetch;let sent=false;
  globalThis.fetch=async()=>{sent=true;throw Error("should not send");};
  const db={from:()=>({select:()=>({eq:()=>({eq:()=>({single:async()=>({data:{deleted_at:"2026-10-31T05:00:00Z"},error:null})})})})})};
  try {await assert.rejects(()=>answerQuestion(db,"owner",{reportId:id,question:"質問"},{}),/復元/);assert.equal(sent,false);}finally{globalThis.fetch=oldFetch;}
});
