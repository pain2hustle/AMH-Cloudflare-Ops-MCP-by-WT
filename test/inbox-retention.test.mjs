import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const context=vm.createContext({Date,console});
const bundle=fs.readFileSync(new URL('../worker/live/index.js', import.meta.url),'utf8');
vm.runInContext(bundle.slice(bundle.indexOf('// WALO task detail retention:'), bundle.indexOf('function inboxBoardKV(storage)'))+'\n'+bundle.slice(bundle.indexOf('function inboxBoardKV(storage)'),bundle.indexOf('async function inboxImport(storage')),context);
const {inboxCompactTask:compact,inboxRetentionSweep:sweep,inboxScheduleBoard:schedule,inboxBoardKV:kv}=context;
const now=Date.parse('2026-10-19T12:00:00Z'), day=86400000;
const task=(overrides={})=>({id:'abc-12345678',to:'codex',from:'owner',status:'done',text:'Do task '.repeat(100),created:new Date(now-10*day).toISOString(),finished:new Date(now-8*day).toISOString(),result:'[usage] tokens=22\nDetails '.repeat(100)+'Phone report: Verified https://example.com/result',...overrides});
class Storage {
 constructor(entries=[]){this.map=new Map(entries);this.alarm=null;}
 async get(k){return this.map.get(k);}
 async put(k,v){this.map.set(k,v);}
 async list(o){return new Map([...this.map].sort(([a],[b])=>a.localeCompare(b)).filter(([k])=>k.startsWith(o.prefix)&&(!o.startAfter||k>o.startAfter)).slice(0,o.limit));}
 async transaction(fn){return fn(this);}
 async getAlarm(){return this.alarm;}
 async setAlarm(n){this.alarm=n;}
}
test('seven day boundary, evidence, bounded receipt, idempotence',()=>{
 const recent=task({finished:new Date(now-7*day+1).toISOString()});assert.equal(compact(recent,now),recent);
 const old=task({finished:new Date(now-7*day).toISOString()});const r=compact(old,now);
 assert.equal(r.receipt_only,true);assert.ok(r.text.length<=160);assert.ok(r.result.includes('https://example.com/result'));
 assert.ok(JSON.stringify(r).length<2500);assert.equal(compact(r,now+day),r);assert.equal(r.id,old.id);
});
test('open, claimed, failed, pending legacy done and invalid dates never erased',()=>{
 for(const status of ['open','claimed','failed']){const t=task({status});assert.equal(compact(t,now),t);}
 for(const result of ['Handed to grok as task abc','Phone report: NEEDS APPROVAL','NOT DONE: blocked','requested work still pending','could not verify','Handoff: codex']){const t=task({result});assert.equal(compact(t,now),t);}
 const t=task({finished:'bad'});assert.equal(compact(t,now),t);
});
test('old expiry cannot delete unresolved work on read/list/write',async()=>{
 const t=task({status:'open'}),s=new Storage([['board:task:'+t.id,{task:t,expires:1}]]);const adapter=kv(s);
 assert.equal((await adapter.get('task:'+t.id)).status,'open');assert.equal((await adapter.list()).keys.length,1);
 await adapter.put('task:'+t.id,JSON.stringify(t),{expirationTtl:1});assert.equal(s.map.get('board:task:'+t.id).expires,null);
});
test('daily sweep compacts completed tasks, protects blockers, skips when not due',async()=>{
 const s=new Storage([['board:task:a',{task:task(),expires:1}],['board:task:b',{task:task({status:'failed'}),expires:1}]]);
 const r=await sweep(s,now);assert.equal(r.compacted,1);assert.equal(r.next,now+day);
 assert.equal(s.map.get('board:task:a').task.receipt_only,true);assert.equal(s.map.get('board:task:b').task.status,'failed');assert.equal(s.map.get('board:task:b').expires,null);
 assert.equal(await sweep(s,now+1000),r);
});
test('bounded 200-record sweep continues and does not skip tail',async()=>{
 const s=new Storage(Array.from({length:201},(_,i)=>['board:task:'+String(i).padStart(4,'0'),{task:task(),expires:1}]));
 const a=await sweep(s,now);assert.ok(a.cursor);assert.equal(a.compacted,200);
 const b=await sweep(s,now+60000);assert.equal(b.cursor,null);assert.equal(b.compacted,201);
});
test('scheduler preserves earlier migration alarm and schedules idle cleanup',async()=>{
 const s=new Storage([['board:retention',{next:now+day}],['board:meta',{migration:'pending',next:now+1000}]]);
 await schedule({storage:s});assert.equal(s.alarm,now+1000);
 s.alarm=now+500;await schedule({storage:s});assert.equal(s.alarm,now+500);
 s.alarm=null;s.map.set('board:meta',{migration:'complete'});await schedule({storage:s});assert.equal(s.alarm,now+day);
});

