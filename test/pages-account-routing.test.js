import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
for (const runtime of ['worker/live/index.js','worker/mcp-oauth/base-live.mjs']) {
const test=(name,fn)=>nodeTest(runtime+': '+name,fn);
const source=readFileSync(new URL('../'+runtime,import.meta.url),'utf8');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,start);return source.slice(a,b);}
const fragments=[
 section('var PAGES_ACCOUNT_ALIASES =','var PAGES_PROTECTED'),
 section('function pagesAccount(','function pagesPath('),
 section('function pagesOwnerAccountClient(','async function runTool('),
 section('async function runTool(','__name(runTool,'),
 section('async function runPagesDeployTool(','var SERVER ='),
 section('async function siteSetupTool(','__name(siteSetupTool,')
].join('\n');
const NEW='a08783a0d3715df907ed5ccad38f0dcf',AMH='0ebf6d65d7a9ddccd41cba0b8bd1414c',DOORS='1d5fae607a857fc56cd575763bf8f3bc';
function fixture(envChanges={}){
 const calls=[];
 const env={CLOUDFLARE_API_TOKEN:'existing-base-fixture',CLOUDFLARE_API_TOKEN_DOORS:'doors-fixture',CLOUDFLARE_API_TOKEN_ARTIFICIALMINDHIVE:'new-fixture',...envChanges};
 const result=(c,a)=>({selected:c.token,account:a.account,project:a.project,branch:a.branch});
 const ctx=vm.createContext({
  __name:()=>{},APIARY_READ_TOOLS:new Set(),HARNESS_TOOLS:new Set(),SITE_SETUP_TOOLS:new Set(['pages_create_project','pages_add_domain','worker_deploy','d1_create','d1_query','d1_exec']),
  PAGES_DEPLOY_TOOLS:new Set(['pages_deploy','pages_list_deployments','pages_get_deployment','pages_rollback']),
  getOAuthAccessToken:async(e,auth)=>auth.mode==='admin'?e.CLOUDFLARE_API_TOKEN:'tenant-fixture',
  CloudflareClient:class{constructor({token}){this.token=token}},
  pagesDeploy:result,pagesListDeployments:result,pagesGetDeployment:result,pagesRollback:result,
  pagesPatch:result,pagesReadFile:result,pagesSaveSpecial:result,
  fetch:async(url,init)=>{calls.push({url,init});return {json:async()=>({success:true,result:{name:'ari1of1',subdomain:'ari1of1.pages.dev',production_branch:'main'}})}}
 });
 vm.runInContext(fragments,ctx);
 return {ctx,env,calls,run:(name,args,mode='admin')=>ctx.runTool(name,args,env,{mode})};
}
test('existing aliases remain exact and new alias/id normalize',()=>{
 const {ctx}=fixture();assert.equal(ctx.pagesAccount('amh'),AMH);assert.equal(ctx.pagesAccount('doors'),DOORS);
 assert.equal(ctx.pagesAccount(' ArtificialMindHive '),NEW);assert.equal(ctx.pagesAccount(NEW),NEW);
 assert.throws(()=>ctx.pagesAccount('not-an-account'));
});
for(const account of ['artificialmindhive',NEW]){
 for(const name of ['pages_deploy','pages_list_deployments','pages_get_deployment','pages_rollback','pages_patch','pages_read_file','pages_special_files']){
  test(name+' routes '+account+' to new owner credential',async()=>{
   const {run,calls}=fixture();const r=await run(name,{account,project:'ari1of1',branch:'main'});
   assert.equal(r.selected,'new-fixture');assert.equal(r.project,'ari1of1');assert.equal(calls.length,0);
  });
 }
}
test('existing owner routes retain previous tokens',async()=>{
 const {run}=fixture();assert.equal((await run('pages_deploy',{account:'amh'})).selected,'existing-base-fixture');
 assert.equal((await run('pages_deploy',{account:'doors'})).selected,'doors-fixture');
});
test('OAuth callers cannot acquire shared account credential',async()=>{
 const {run}=fixture();for(const account of ['artificialmindhive',NEW,'doors']){
  assert.equal((await run('pages_deploy',{account},'oauth')).selected,'tenant-fixture');
  assert.equal((await run('pages_patch',{account},'oauth')).selected,'tenant-fixture');
 }
 assert.match((await run('pages_create_project',{account:NEW,name:'ari1of1'},'oauth')).error,/owner/);
});
test('missing additional secret fails closed without fallback',async()=>{
 const {run,calls}=fixture({CLOUDFLARE_API_TOKEN_ARTIFICIALMINDHIVE:undefined});
 for(const name of ['pages_deploy','pages_patch','pages_create_project']){
  const r=await run(name,{account:NEW,name:'ari1of1',project:'ari1of1',apply:true});assert.ok(r.error);
 }
 assert.equal(calls.length,0);
});
test('create dry-run performs zero writes; apply targets exact account and project',async()=>{
 const {run,calls}=fixture();const a={account:NEW,name:'ari1of1',production_branch:'main'};
 const dry=await run('pages_create_project',a);assert.equal(dry.dry_run,true);assert.equal(calls.length,0);
 const r=await run('pages_create_project',{...a,apply:true});assert.equal(r.created,true);
 assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api.cloudflare.com/client/v4/accounts/'+NEW+'/pages/projects');
 assert.equal(calls[0].init.headers.Authorization,'Bearer new-fixture');
 assert.deepEqual(JSON.parse(calls[0].init.body),{name:'ari1of1',production_branch:'main'});
});
test('additional shared credential is refused for Worker/D1 setup',async()=>{
 const {run,calls}=fixture();for(const name of ['worker_deploy','d1_create','d1_query','d1_exec']){
  assert.match((await run(name,{account:NEW,apply:true})).error,/only for Pages/);
 }assert.equal(calls.length,0);
});
test('original production protection and dry-run checks remain present',()=>{
 assert.match(source,/PAGES_PROTECTED/);assert.match(source,/artificialmindhive/);
 assert.match(source,/args\.apply !== true/);
});
}
