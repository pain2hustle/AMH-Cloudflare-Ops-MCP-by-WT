// Uploads worker/live/index.js to the live hub Worker (pain2hustle1) with the Workers API, keeping every
// existing binding and ADDING the service binding AGENT_MAIL -> agent-mail (needed by email_austin).
// Token: ~/.amh-secrets/cf-token-cfops-full.txt (Workers Scripts edit). Backs up the live script first.
import fs from "node:fs";
import path from "node:path";
const A = "0ebf6d65d7a9ddccd41cba0b8bd1414c", NAME = "cloudflare-ops-mcp";
const T = fs.readFileSync(path.join(process.env.USERPROFILE, ".amh-secrets", "cf-token-cfops-full.txt"), "utf8").trim();
const H = { authorization: "Bearer " + T };
const api = (p, init = {}) => fetch(`https://api.cloudflare.com/client/v4/accounts/${A}/workers/scripts/${NAME}${p}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const settings = (await (await api("/settings")).json()).result;
const live = await (await api("/content/v2")).text();
fs.writeFileSync(path.join(here, "index.js.live-before-0.15.0"), live);
const services = settings.bindings.filter((b) => b.type === "service").map((b) => ({ type: "service", name: b.name, service: b.service, environment: b.environment || "production" }));
if (!services.some((b) => b.name === "AGENT_MAIL")) services.push({ type: "service", name: "AGENT_MAIL", service: "agent-mail", environment: "production" });
const keep = [...new Set(settings.bindings.map((b) => b.type).filter((t) => t !== "service"))];
const metadata = { main_module: "index.js", compatibility_date: settings.compatibility_date, compatibility_flags: settings.compatibility_flags, bindings: services, keep_bindings: keep, keep_assets: true };
console.log("bindings before:", settings.bindings.length, "| sending services:", services.map((s) => s.name), "| keep types:", keep);
if (process.argv[2] !== "--apply") { console.log("dry run; pass --apply"); process.exit(0); }

const form = new FormData();
form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
form.append("index.js", new Blob([fs.readFileSync(path.join(here, "index.js"), "utf8")], { type: "application/javascript+module" }), "index.js");
const r = await api("", { method: "PUT", body: form });
const j = await r.json();
console.log("PUT", r.status, j.success ? "ok" : JSON.stringify(j.errors));
if (!j.success) process.exit(1);
const after = (await (await api("/settings")).json()).result;
console.log("bindings after:", after.bindings.length, after.bindings.map((b) => b.type + ":" + b.name).join(", "));
const missing = settings.bindings.filter((b) => !after.bindings.some((x) => x.name === b.name && x.type === b.type)).map((b) => b.name);
console.log(missing.length ? "MISSING BINDINGS: " + missing.join(",") : "all previous bindings kept", "| AGENT_MAIL:", after.bindings.some((b) => b.name === "AGENT_MAIL"));
