import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
let s=fs.readFileSync(new URL('index.js',import.meta.url),'utf8');
const changes=[];
function replace(a,b){if(!s.includes(a)&&s.includes(a.replaceAll('\n','\r\n'))){a=a.replaceAll('\n','\r\n');b=b.replaceAll('\n','\r\n');}assert.equal(s.split(a).length-1,1,'Unique live anchor required');s=s.replace(a,b);changes.push({before:a,after:b});}
replace('artificialmindhive: "a08783a0d3715df907ed5ccad38f0dcf" };','artificialmindhive: "a08783a0d3715df907ed5ccad38f0dcf", servicepricer: "068a8123b10b7a9fcdcb49e6763969e9" };');
replace('  if (authContext?.mode !== "admin") return null;\n  if (accountId === "a08783a0d3715df907ed5ccad38f0dcf") {','  if (authContext?.mode !== "admin") return null;\n  if (accountId === "068a8123b10b7a9fcdcb49e6763969e9") {\n    const token = env.CLOUDFLARE_API_TOKEN_SERVICEPRICER;\n    if (!token) throw new Error("Servicepricer Pages credential is not configured");\n    return new CloudflareClient({ token });\n  }\n  if (accountId === "a08783a0d3715df907ed5ccad38f0dcf") {');
replace('  // Additional owner credential is intentionally limited to dedicated Pages actions.','  // Additional owner credentials are intentionally limited to dedicated Pages actions.\n  if (accountId === "068a8123b10b7a9fcdcb49e6763969e9" && !["pages_create_project", "pages_add_domain"].includes(name))\n    return { error: "Servicepricer shared credential is available only for Pages tools" };');
replace('  const token = accountId === "a08783a0d3715df907ed5ccad38f0dcf"','  const token = accountId === "068a8123b10b7a9fcdcb49e6763969e9"\n    ? env.CLOUDFLARE_API_TOKEN_SERVICEPRICER\n    : accountId === "a08783a0d3715df907ed5ccad38f0dcf"');
replace('return await accountDoctor(client, { expected_account_id: args.expected_account_id });','return await accountDoctor(pagesOwnerAccountClient(env, authContext, args.expected_account_id) || client, { expected_account_id: args.expected_account_id });');
replace('return await pagesBranchCheck(client, {','return await pagesBranchCheck(pagesOwnerAccountClient(env, authContext, args.account_id) || client, {');
// Public schema exposes the alias, never credentials.
s=s.replaceAll('artificialmindhive, or an account id','artificialmindhive, servicepricer, or an account id').replaceAll('or artificialmindhive"','artificialmindhive, or servicepricer"').replace('account must be amh, doors, artificialmindhive, or a 32-hex account id','account must be amh, doors, artificialmindhive, servicepricer, or a 32-hex account id');
const helper=s.slice(s.indexOf('function pagesOwnerAccountClient('),s.indexOf('\nasync function runTool(',s.indexOf('function pagesOwnerAccountClient(')));
const ctx=vm.createContext({CloudflareClient:class{constructor(o){this.token=o.token;}}});vm.runInContext(helper,ctx);
const env={CLOUDFLARE_API_TOKEN_SERVICEPRICER:'test-new',CLOUDFLARE_API_TOKEN_DOORS:'test-doors',CLOUDFLARE_API_TOKEN_ARTIFICIALMINDHIVE:'test-third'};
assert.equal(ctx.pagesOwnerAccountClient(env,{mode:'admin'},'068a8123b10b7a9fcdcb49e6763969e9').token,'test-new');
assert.equal(ctx.pagesOwnerAccountClient(env,{mode:'oauth'},'068a8123b10b7a9fcdcb49e6763969e9'),null);
assert.equal(ctx.pagesOwnerAccountClient(env,{mode:'admin'},'1d5fae607a857fc56cd575763bf8f3bc').token,'test-doors');
assert.equal(ctx.pagesOwnerAccountClient(env,{mode:'admin'},'a08783a0d3715df907ed5ccad38f0dcf').token,'test-third');
assert.throws(()=>ctx.pagesOwnerAccountClient({},{mode:'admin'},'068a8123b10b7a9fcdcb49e6763969e9'),/not configured/);
fs.writeFileSync(new URL('candidate.js',import.meta.url),s);fs.writeFileSync(new URL('patch-receipt.json',import.meta.url),JSON.stringify({changes,tests:{ownerRouting:true,tenantIsolation:true,oldAccountsPreserved:true,missingSecretFailsClosed:true}},null,2));console.log('Six account-routing changes; owner/tenant isolation tests passed.');
