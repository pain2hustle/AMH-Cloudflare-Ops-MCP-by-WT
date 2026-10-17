import fs from 'node:fs';
import { build } from 'esbuild';
const original=fs.readFileSync(new URL('./base-live.mjs',import.meta.url),'utf8');
if(!original.includes('async function authorizeConnector('))throw Error('Live auth helper missing');
fs.writeFileSync(new URL('./legacy.mjs',import.meta.url),original+'\nexport { authorizeConnector };\n');
fs.writeFileSync(new URL('./entry.mjs',import.meta.url),`import legacy, { authorizeConnector } from './legacy.mjs';\nimport { createOAuthWorker } from './mcp-oauth.mjs';\nexport { RateLimiterDO } from './legacy.mjs';\nexport default createOAuthWorker(legacy, authorizeConnector);\n`);
await build({entryPoints:['entry.mjs'],outfile:'../live/index.js',bundle:true,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers'],legalComments:'inline'});
console.log('Built OAuth wrapper from recovered live Worker.');
