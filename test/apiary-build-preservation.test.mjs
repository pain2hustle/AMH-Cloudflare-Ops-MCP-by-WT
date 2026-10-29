import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url);
const read=fs.readFileSync(new URL('tests/apiary-read/apiary-read.js',root),'utf8');
const repair=fs.readFileSync(new URL('worker/live/apiary-cache-repair.js',root),'utf8');
const fixture=fs.readFileSync(new URL('tests/fixtures/apiary-cache-before.js',root),'utf8');
const base=fs.readFileSync(new URL('worker/mcp-oauth/base-live.mjs',root),'utf8');
test('OAuth build source contains the reviewed Apiary modules',()=>{assert.ok(base.replaceAll("\r\n","\n").includes(read.replaceAll("\r\n","\n")));const normalized=repair.replaceAll("\r\n","\n"),boundary=normalized.indexOf("var APIARY_REPAIR_TOOL_DEF = "); assert.ok(boundary>0); for(const block of [normalized.slice(0,boundary),normalized.slice(boundary)])assert.ok(base.replaceAll("\r\n","\n").includes(block));});
for(const [label,path] of [['source','worker/mcp-oauth/base-live.mjs'],['release','worker/live/index.js']]){
 const code=fs.readFileSync(new URL(path,root),'utf8'),start=code.indexOf('var APIARY_READ_ACCOUNT ='),end=code.indexOf('var PAGES_DEPLOY_TOOLS =',start);
 assert.ok(start>=0&&end>start,'Apiary build block missing');
 const scope=vm.createContext({__name:f=>f,fetch:()=>{throw Error('Unauthorized provider IO');}});
 vm.runInContext(code.slice(start,end),scope);
 test(label+' keeps owner/tenant boundaries before provider IO',async()=>{for(const actor of [{mode:'user'},{mode:'admin',caller:'walo'},{mode:'admin',connectionId:'tenant'}]){assert.ok((await scope.runApiaryRepair({action:'status'},{},actor)).error);assert.ok((await scope.runApiaryReadTool('apiary_worker_deployments',{}, {},actor)).error);}});
 test(label+' retains the reviewed cache patch and revision',()=>{const patched=scope.arPatch(fixture);assert.equal(patched.edits,7);assert.ok(patched.code.includes('new Request(request, { method: "GET" })'));assert.ok(patched.code.includes('20261011-reviewed-guides-final'));});
 test(label+' routes Apiary before default-account setup',()=>{const route=code.slice(code.indexOf('async function runTool('));assert.ok(route.indexOf('runApiaryRepair(')<route.indexOf('getOAuthAccessToken('));assert.ok(route.indexOf('runApiaryReadTool(')<route.indexOf('getOAuthAccessToken('));});
}
test('release retains the existing OAuth wrapper',()=>{const code=fs.readFileSync(new URL('worker/live/index.js',root),'utf8');assert.ok(code.includes('createOAuthWorker(index_default, authorizeConnector)'));});

test('recovered baseline preserves existing WALO and inbox behavior',()=>{assert.ok(base.includes('env.WALO_BOARD_KEY'));assert.ok(base.includes('details_removed_at'));assert.ok(base.includes('wakeCloudAgent'));assert.ok(base.includes('Tokens are optional'));assert.ok(!base.includes('function createOAuthWorker('));});
