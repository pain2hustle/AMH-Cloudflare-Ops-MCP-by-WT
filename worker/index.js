// cloudflare-ops-mcp-mcp — a remote MCP server (Cloudflare Worker) that exposes the
// cloudflare-ops-mcp engine as MCP tools over a URL. Any MCP client (Claude, Cursor,
// an agent) can point at it and scan / plan / fix a Cloudflare zone.
//
// HARDENED vs a naive version, on purpose:
//   • The Cloudflare API token is a WORKER SECRET (env.CLOUDFLARE_API_TOKEN).
//     It is NEVER a tool parameter, so it never travels through an MCP client's
//     logs or an agent's transcript. Set it once:  wrangler secret put CLOUDFLARE_API_TOKEN
//   • Every mutating tool is DRY-RUN by default. It returns the planned diff and
//     writes NOTHING unless the caller passes { apply: true }. See the diff first.
//   • BIMI inherits the engine's hard DMARC precondition. DNS delete requires
//     exact record id + expected name + confirm=true after a fresh lookup.
//   • No external dependencies, no Durable Object — a plain Worker that speaks
//     JSON-RPC 2.0 (MCP). Deploys clean on the Workers free tier.
//
// Import the engine modules directly (NOT ../src/index.js — that barrel pulls in
// audit.js which uses node:fs, unavailable in a Worker isolate).
import { CloudflareClient, redactToken } from "../src/client.js";
import { scanZone } from "../src/zone.js";
import { applyDnsRecord, deleteDnsRecord } from "../src/dns.js";
import { setDmarcPolicy } from "../src/dmarc.js";
import { setupBimi } from "../src/bimi.js";
import { setupEmailRouting } from "../src/email.js";
import { planEmailAuth } from "../src/plan.js";
import { purgeCache } from "../src/cache.js";
import { planPagesCutover } from "../src/pages.js";
import { createTurnstileWidget } from "../src/turnstile.js";
import { mintScopedToken, listTokens, revokeToken, TOKEN_PRESETS } from "../src/tokens.js";
import { whoServesDomain, accountDoctor, pagesBranchCheck } from "../src/doctor.js";
import { addUpstream, removeUpstream, listUpstreams, federatedTools, isFederated, callFederated } from "../src/federation.js";
import { setPolicy, listPolicy, checkPolicy } from "../src/policy.js";
import {
  authorizeConnector,
  checkRateLimit,
  getOAuthAccessToken,
  getOAuthConfigStatus,
  handleOAuthCallback,
  handleOAuthRevoke,
  handleOAuthStart,
  handleOAuthStatus,
} from "./oauth.js";

const SERVER = {
  name: "cloudflare-ops-mcp",
  title: "AMH Walrus Tusk Cloudflare Ops MCP — SafeTry Agent Harness",
  version: "0.5.3",
};
const INDEXNOW_KEY = "d4f02a51e05cfee056bc027685262a64";

// ── Federation + policy management tools (front-door over a fleet of MCPs) ──
// These are handled directly in tools/call (they bypass the CF client + the
// policy gate) so cfops can register/govern OTHER MCP servers under one endpoint.
const MGMT_TOOL_DEFS = [
  {
    name: "federation_add",
    description: "Register an upstream MCP server so its tools appear in THIS catalog under a namespace (namespace__tool) and calls proxy to it. Args: namespace (a-z0-9_-), url (https MCP endpoint), auth (optional Bearer token/connector key).",
    inputSchema: { type: "object", properties: { namespace: { type: "string" }, url: { type: "string" }, auth: { type: "string" } }, required: ["namespace", "url"] },
  },
  { name: "federation_list", description: "List registered upstream MCP servers (namespace, url, whether authed).", inputSchema: { type: "object", properties: {} } },
  { name: "federation_remove", description: "Unregister an upstream MCP server by namespace.", inputSchema: { type: "object", properties: { namespace: { type: "string" } }, required: ["namespace"] } },
  {
    name: "policy_set",
    description: "Set governance policy for any tool (native or federated namespace__tool): allow | approve | block. Default is allow. 'approve' refuses the call unless it carries \"_approved\": true.",
    inputSchema: { type: "object", properties: { tool: { type: "string" }, mode: { type: "string", enum: ["allow", "approve", "block"] } }, required: ["tool", "mode"] },
  },
  { name: "policy_list", description: "List all non-default tool policies.", inputSchema: { type: "object", properties: {} } },
];
const MGMT_TOOLS = new Set(MGMT_TOOL_DEFS.map((t) => t.name));

async function runMgmtTool(name, args, env) {
  switch (name) {
    case "federation_add": return addUpstream(env, args);
    case "federation_list": return { upstreams: await listUpstreams(env) };
    case "federation_remove": return removeUpstream(env, args.namespace);
    case "policy_set": return setPolicy(env, args.tool, args.mode);
    case "policy_list": return { policies: await listPolicy(env) };
    default: return { error: true, message: `unknown mgmt tool: ${name}` };
  }
}
const PROTOCOL_FALLBACK = "2025-06-18";

// ── Tool catalog (inputSchema = JSON Schema; NOTE: no token field anywhere) ──
const TOOLS = [
  {
    name: "scan_zone",
    description:
      "Read-only snapshot of a domain's Cloudflare zone: all DNS records plus parsed SPF, DMARC, BIMI, and Email Routing status. Never writes.",
    inputSchema: {
      type: "object",
      properties: { domain: { type: "string", description: "Domain to scan, e.g. example.com" } },
      required: ["domain"],
    },
  },
  {
    name: "plan_email_auth",
    description:
      "Analyze a domain's email authentication (SPF/DKIM/DMARC/BIMI/routing) and report what is missing or misconfigured, with the exact records to add. Never writes.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Domain to analyze" },
        inbox: { type: "string", description: "Where DMARC aggregate reports should go, e.g. you@gmail.com" },
      },
      required: ["domain"],
    },
  },
  {
    name: "verify_domain",
    description:
      "Re-scan a domain and return a pass/fail checklist: SPF, DMARC present + enforced, MX, Email Routing, BIMI, DKIM count. Never writes.",
    inputSchema: {
      type: "object",
      properties: { domain: { type: "string" } },
      required: ["domain"],
    },
  },
  {
    name: "apply_dns_record",
    description:
      "Upsert a single DNS record (create if absent, update if content differs, no-op if identical). DRY-RUN by default — returns the planned diff and writes nothing unless apply=true. Never deletes.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string" },
        type: { type: "string", description: "TXT, CNAME, MX, A, AAAA…" },
        name: { type: "string", description: "Record name, e.g. @, _dmarc, default._bimi" },
        content: { type: "string", description: "Record value" },
        priority: { type: "number", description: "MX priority (MX only)" },
        proxied: { type: "boolean" },
        apply: { type: "boolean", description: "Set true to actually write. Default false = dry-run." },
      },
      required: ["domain", "type", "name", "content"],
    },
  },
  {
    name: "delete_dns_record",
    description:
      "Delete exactly one DNS record after a fresh lookup. Requires domain, exact record_id, matching expected_name, and confirm=true. Refuses by default and never deletes by name alone.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Zone name, e.g. example.com" },
        record_id: { type: "string", description: "Exact DNS record id returned by scan_zone" },
        expected_name: { type: "string", description: "Exact hostname expected for that record id" },
        confirm: { type: "boolean", description: "Must be true to perform the deletion" },
      },
      required: ["domain", "record_id", "expected_name", "confirm"],
    },
  },
  {
    name: "set_dmarc_policy",
    description:
      "Change the _dmarc policy (none|quarantine|reject), preserving other tags. DRY-RUN by default — returns the before/after diff and writes nothing unless apply=true.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string" },
        policy: { type: "string", enum: ["none", "quarantine", "reject"] },
        rua: { type: "string", description: "Optional aggregate-report mailbox, e.g. mailto:you@gmail.com" },
        pct: { type: "number", description: "Optional rollout percentage 1-100" },
        apply: { type: "boolean", description: "Default false = dry-run." },
      },
      required: ["domain", "policy"],
    },
  },
  {
    name: "setup_bimi",
    description:
      "Create/update the default._bimi TXT record pointing at a logo SVG. REFUSES to write when DMARC is p=none (unless force=true) because BIMI won't be honored without enforced DMARC. DRY-RUN by default.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string" },
        logo: { type: "string", description: "HTTPS URL to an SVG Tiny-PS logo" },
        vmc: { type: "string", description: "Optional Verified Mark Certificate PEM URL" },
        apply: { type: "boolean", description: "Default false = dry-run." },
        force: { type: "boolean", description: "Override the DMARC precondition (not recommended)." },
      },
      required: ["domain", "logo"],
    },
  },
  {
    name: "setup_email_routing",
    description:
      "Enable Cloudflare Email Routing and create forward rules (+ optional catch-all). Cloudflare auto-adds the MX/SPF records. DRY-RUN by default. Destination addresses must be verified by their owner via Cloudflare's email.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string" },
        forwards: {
          type: "array",
          description: "Rules: { address, to } forwards to an email address, or { address, worker } routes to a Cloudflare Email Worker (no destination verification needed). e.g. { address: 'hello@example.com', to: 'you@gmail.com' } or { address: 'bot@example.com', worker: 'my-email-worker' }",
          items: {
            type: "object",
            properties: { address: { type: "string" }, to: { type: "string" }, worker: { type: "string" } },
            required: ["address"],
          },
        },
        catch_all: { type: "string", description: "Optional catch-all destination address" },
        apply: { type: "boolean", description: "Default false = dry-run." },
        force: { type: "boolean", description: "Create rules even to unverified destinations (not recommended — they stay disabled)." },
      },
      required: ["domain"],
    },
  },
  {
    name: "pages_cutover",
    description:
      "Plan or apply a Cloudflare Pages DNS cutover. Deletes only conflicting apex/www A/AAAA/CNAME records and www NS delegations, then creates proxied CNAMEs to the Pages target. DRY-RUN by default; writes only when apply=true.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Root zone, e.g. example.com" },
        target: { type: "string", description: "Pages hostname, normally project.pages.dev" },
        include_www: { type: "boolean", description: "Also cut over www. Default true." },
        include_wildcard: { type: "boolean", description: "Also remove conflicting wildcard records. Default false." },
        apply: { type: "boolean", description: "Default false = dry-run." },
      },
      required: ["domain", "target"],
    },
  },
  {
    name: "purge_cache",
    description:
      "Purge Cloudflare's cache for a zone — the whole zone (default) or specific URLs. DRY-RUN by default: returns the scope and purges NOTHING unless apply=true. Needs a token with Zone > Cache Purge.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Zone, e.g. example.com" },
        everything: { type: "boolean", description: "Purge the whole zone cache (default when no urls given)." },
        urls: { type: "array", items: { type: "string" }, description: "Specific absolute URLs to purge (max 30)." },
        apply: { type: "boolean", description: "Default false = dry-run." },
      },
      required: ["domain"],
    },
  },
  {
    name: "create_turnstile_widget",
    description:
      "Plan or create a Cloudflare Turnstile widget for a domain. DRY-RUN by default; creates the widget only when apply=true. Returns the public sitekey and one-time secret when applied.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Primary zone/domain, e.g. example.com" },
        name: { type: "string", description: "Optional widget display name." },
        mode: {
          type: "string",
          enum: ["managed", "non-interactive", "invisible"],
          description: "Turnstile mode. Default managed.",
        },
        extra_domains: {
          type: "array",
          items: { type: "string" },
          description: "Additional hostnames allowed to use this widget.",
        },
        apply: { type: "boolean", description: "Default false = dry-run." },
      },
      required: ["domain"],
    },
  },
  {
    name: "mint_scoped_token",
    description:
      "Mint a narrow, auto-expiring Cloudflare API token for ONE zone (presets: zone-read, dns-zone, cache-purge; default 1h TTL). The vending machine for least-privilege agent work: hand a cheap agent a key that can't hurt anything and dies on its own. DRY-RUN by default — returns the exact policy JSON; mints nothing unless apply=true. Needs a bootstrap token with 'API Tokens Write'. There is deliberately NO super/account-wide preset.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Zone the token is confined to, e.g. example.com" },
        preset: { type: "string", enum: ["zone-read", "dns-zone", "cache-purge"], description: "Permission preset. Default dns-zone." },
        extra_groups: { type: "array", items: { type: "string" }, description: "Additional Cloudflare permission-group NAMES (still zone-scoped)." },
        ttl_seconds: { type: "number", description: "Lifetime in seconds. Default 3600; capped at 86400 unless confirm_long=true." },
        confirm_long: { type: "boolean", description: "Required to exceed the 24h TTL cap." },
        name: { type: "string", description: "Optional token label for the CF dashboard." },
        apply: { type: "boolean", description: "Default false = dry-run." },
      },
      required: ["domain"],
    },
  },
  {
    name: "list_tokens",
    description:
      "List API tokens on the connected user: id, name, status, expiry, and whether cfops minted them. NEVER returns token values (Cloudflare only shows those once, at mint). Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "revoke_token",
    description:
      "Revoke an API token by id (e.g. a minted task-token you're done with early). DRY-RUN by default; deletes nothing unless apply=true.",
    inputSchema: {
      type: "object",
      properties: {
        token_id: { type: "string", description: "Token id from list_tokens." },
        apply: { type: "boolean", description: "Default false = dry-run." },
      },
      required: ["token_id"],
    },
  },
  {
    name: "who_serves_domain",
    description:
      "Answer 'what is ACTUALLY serving this domain?': zone → Worker routes, Worker custom domains, and Pages projects that claim it, with a warning when multiple products fight over it. Read-only.",
    inputSchema: {
      type: "object",
      properties: { domain: { type: "string", description: "Hostname or zone, e.g. app.example.com" } },
      required: ["domain"],
    },
  },
  {
    name: "account_doctor",
    description:
      "Diagnose the token/account situation: accounts visible to this token, whether the expected account is among them (wrong-token detection), and SAME-NAME Pages projects across accounts — the decoy that silently eats deploys. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        expected_account_id: { type: "string", description: "Account id deploys are SUPPOSED to target." },
      },
    },
  },
  {
    name: "pages_branch_check",
    description:
      "Compare a Pages project's production branch against the branch you're about to deploy — catches the silent 'git says master, project says main, every deploy lands on a preview' failure. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string", description: "Account that owns the Pages project." },
        project: { type: "string", description: "Pages project name." },
        git_branch: { type: "string", description: "Branch you intend to deploy; enables the match/mismatch verdict." },
      },
      required: ["account_id", "project"],
    },
  },
  {
    name: "agent_research_start",
    description: "Delegate a bounded research, verification, zero-AI site-health, UI, Cloudflare diagnosis, inventory, data review, missed-items, or revision-proposal job to the private AMH WT coordinator. Returns immediately with job and memory hashes; the configured free lane or explicitly enabled paid K2 lane runs durably in the background.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string", description: "Friendly reusable name shown in the console, terminal, logs, and handoffs." },
        template_id: { type: "string", enum: ["web_research", "secondary_dive", "citation_verify", "ui_playwright", "site_health", "cloudflare_diagnose", "cloudflare_inventory", "data_query_review", "config_compare", "missed_items", "revision_proposal", "security_review"] },
        objective: { type: "string", description: "Exact bounded task and evidence required." },
        allowed_domains: { type: "array", items: { type: "string" }, description: "Explicit domains the crawler may access." },
        urls: { type: "array", items: { type: "string" }, description: "HTTPS seed URLs inside the allowlist." },
        context: { type: "string", description: "Only compact relevant context; never secrets." },
        expected_text: { type: "string", description: "Optional short marker required by the zero-AI site-health check to catch a 200 response serving the wrong page." },
        schedule: { type: "object", properties: { enabled: { type: "boolean" }, every_minutes: { type: "number" } } },
      },
      required: ["template_id", "objective"],
    },
  },
  {
    name: "agent_research_status",
    description: "Read one delegated job, including its redacted timeline, sources, primary result, independent verifier result, gaps, and candidate revisions.",
    inputSchema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] },
  },
  {
    name: "agent_research_list",
    description: "List recent delegated jobs for this authenticated user. Read-only and tenant-isolated.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "agent_briefing",
    description: "Return the Continuity Keeper's current compact project briefing and memory hash: active platform, target, blocker, keep/archive/drop guidance, and next safe step.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "agent_control",
    description: "Safely pause or resume new agent work, cancel a queued/running job at its next phase boundary, force read-only mode, or run retention cleanup. Models cannot disable read-only mode.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["pause", "resume", "cancel_job", "readonly_on", "retention_sweep"] },
        job_id: { type: "string", description: "Required for cancel_job." },
      },
      required: ["action"],
    },
  },
];

// ── Tool implementations (each returns a plain object; serialized as text) ──
const HARNESS_TOOLS = new Set(["agent_research_start", "agent_research_status", "agent_research_list", "agent_briefing", "agent_control"]);

async function runHarnessTool(name, args, env, authContext) {
  if (!env.AGENT_HARNESS || !env.HARNESS_INTERNAL_KEY) return { error: "The private AMH WT agent harness is not configured on this deployment." };
  const actor = authContext?.connectionId || (authContext?.mode === "admin" ? "private-admin" : "unknown");
  const routes = {
    agent_research_start: { method: "POST", path: "/internal/jobs", body: args },
    agent_research_status: { method: "GET", path: `/internal/jobs/${encodeURIComponent(String(args.job_id || ""))}` },
    agent_research_list: { method: "GET", path: "/internal/jobs" },
    agent_briefing: { method: "GET", path: "/internal/briefing" },
    agent_control: { method: "POST", path: "/internal/control", body: args },
  };
  const route = routes[name];
  if (name === "agent_research_status" && !String(args.job_id || "").trim()) return { error: "job_id is required" };
  const response = await env.AGENT_HARNESS.fetch(`https://amh-wt.internal${route.path}`, {
    method: route.method,
    headers: {
      "content-type": "application/json",
      "x-amh-internal-key": env.HARNESS_INTERNAL_KEY,
      "x-amh-actor": actor,
    },
    body: route.body ? JSON.stringify(route.body) : undefined,
  });
  const output = await response.json().catch(() => ({ error: `Harness returned HTTP ${response.status}` }));
  return response.ok ? output : { error: output.error || `Harness returned HTTP ${response.status}` };
}

async function runTool(name, args, env, authContext) {
  if (HARNESS_TOOLS.has(name)) return runHarnessTool(name, args, env, authContext);
  // OAuth callers are bound to their authenticated connection. Only the private
  // legacy admin key may select a legacy tenant or use the fallback Worker token.
  const legacyTenant = authContext?.mode === "admin" ? String(args.tenant || "default").trim() || "default" : "default";
  const token = await getOAuthAccessToken(env, authContext, legacyTenant);
  if (!token) {
    return {
      error:
        "No Cloudflare connection is available. Connect at /oauth/cloudflare/start, or configure the private admin fallback token.",
    };
  }
  const client = new CloudflareClient({ token });
  const domain = String(args.domain || "").trim();
  // Account-level tools have no zone; everything else still requires one.
  const DOMAINLESS = new Set(["list_tokens", "revoke_token", "account_doctor", "pages_branch_check"]);
  if (!domain && !DOMAINLESS.has(name)) return { error: "domain is required" };

  switch (name) {
    case "mint_scoped_token":
      return await mintScopedToken(client, {
        domain,
        preset: args.preset || "dns-zone",
        extra_groups: Array.isArray(args.extra_groups) ? args.extra_groups : [],
        ttl_seconds: args.ttl_seconds,
        confirm_long: args.confirm_long === true,
        name: args.name,
        apply: args.apply === true,
      });

    case "list_tokens":
      return { tokens: await listTokens(client), presets: Object.keys(TOKEN_PRESETS) };

    case "revoke_token":
      return await revokeToken(client, String(args.token_id || "").trim(), { apply: args.apply === true });

    case "who_serves_domain":
      return await whoServesDomain(client, domain);

    case "account_doctor":
      return await accountDoctor(client, { expected_account_id: args.expected_account_id });

    case "pages_branch_check":
      return await pagesBranchCheck(client, {
        account_id: args.account_id,
        project: args.project,
        git_branch: args.git_branch,
      });

    case "scan_zone":
      return await scanZone(client, domain);

    case "plan_email_auth":
      return await planEmailAuth(client, domain, { inbox: args.inbox });

    case "verify_domain": {
      const s = await scanZone(client, domain);
      const p = s.dmarc && s.dmarc.parsed ? String(s.dmarc.parsed.tags?.p || "").toLowerCase() : "";
      const enforced = p === "quarantine" || p === "reject";
      const dkim = (s.dns || []).filter(
        (r) => r.type === "TXT" && /_domainkey/i.test(r.name)
      ).length;
      const mx = (s.dns || []).some((r) => r.type === "MX");
      const routing = !!(s.email_routing && (s.email_routing.enabled || s.email_routing.status === "ready"));
      const checks = {
        spf: !!s.spf,
        dmarc: !!s.dmarc,
        dmarc_enforced: enforced,
        mx,
        email_routing: routing,
        bimi: !!s.bimi,
        dkim_records: dkim,
      };
      // 2026-08-21: all_pass used to REQUIRE bimi (cosmetic, rarely deployed)
      // and IGNORE dkim_records — which it had already computed. So a properly
      // authenticated domain with no BIMI logo reported all_pass:false, while a
      // domain with ZERO DKIM keys reported all_pass:true. Email authentication
      // is SPF + DKIM + enforced DMARC; BIMI is a logo that rides on top of it.
      const all_pass = checks.spf && dkim > 0 && checks.dmarc && enforced && mx;
      return {
        domain,
        checks,
        all_pass,
        // BIMI is reported, never required.
        bimi_ready: all_pass && checks.bimi,
      };
    }

    case "apply_dns_record":
      return await applyDnsRecord(
        client,
        domain,
        { type: args.type, name: args.name, content: args.content, priority: args.priority, proxied: args.proxied },
        { apply: args.apply === true }
      );

    case "delete_dns_record": {
      const recordId = String(args.record_id || "").trim();
      const expectedName = String(args.expected_name || "").trim().toLowerCase().replace(/\.$/, "");
      if (!recordId || !expectedName) return { error: true, message: "record_id and expected_name are required" };
      if (args.confirm !== true) return await deleteDnsRecord(client, domain, recordId, { confirm: false });
      const snapshot = await scanZone(client, domain);
      const record = (snapshot.dns || []).find((item) => item.id === recordId);
      if (!record) return { error: true, message: "DNS record id was not found during the confirmation lookup" };
      const actualName = String(record.name || "").trim().toLowerCase().replace(/\.$/, "");
      if (actualName !== expectedName) {
        return { error: true, message: "DNS record name changed or does not match expected_name", actual_name: record.name };
      }
      const deletion = await deleteDnsRecord(client, domain, recordId, { confirm: true, zoneId: snapshot.zone_id });
      return { ...deletion, deleted_record: { id: record.id, type: record.type, name: record.name, content: record.content } };
    }

    case "set_dmarc_policy":
      return await setDmarcPolicy(
        client,
        domain,
        String(args.policy),
        { rua: args.rua, pct: args.pct },
        { apply: args.apply === true }
      );

    case "setup_bimi":
      return await setupBimi(
        client,
        domain,
        { logo: args.logo, vmc: args.vmc },
        { apply: args.apply === true, force: args.force === true }
      );

    case "setup_email_routing":
      return await setupEmailRouting(
        client,
        domain,
        { forwards: args.forwards || [], catchAll: args.catch_all },
        { apply: args.apply === true, force: args.force === true }
      );

    case "pages_cutover":
      return await planPagesCutover(client, domain, {
        target: args.target,
        includeWww: args.include_www !== false,
        includeWildcard: args.include_wildcard === true,
        apply: args.apply === true,
      });

    case "purge_cache":
      return await purgeCache(client, domain, {
        everything: args.everything === true,
        files: args.urls,
        apply: args.apply === true,
      });


    case "create_turnstile_widget":
      return await createTurnstileWidget(client, domain, {
        name: args.name,
        mode: args.mode || "managed",
        extraDomains: args.extra_domains || [],
        apply: args.apply === true,
      });
    default:
      return { error: `unknown tool: ${name}` };
  }
}

// ── JSON-RPC 2.0 / MCP dispatch ──
function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleRpc(msg, env, authContext) {
  const { id, method, params } = msg || {};
  // Notifications (no id) — acknowledge with nothing.
  if (id === undefined || id === null) return null;

  if (method === "initialize") {
    const requested = params && params.protocolVersion;
    return rpcResult(id, {
      protocolVersion: typeof requested === "string" ? requested : PROTOCOL_FALLBACK,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER,
      instructions:
        "Cloudflare Ops MCP audits and safely changes common Cloudflare work across DNS, email authentication, Pages cutovers, cache purge, Turnstile widgets, and Email Routing. " +
        "Use it to scan a Cloudflare zone, diagnose email deliverability and spoofing gaps, apply targeted DNS/DMARC/BIMI/Email Routing fixes, cut a hostname to Cloudflare Pages, purge cache, or create a Turnstile widget. " +
        "Safety: every write is DRY-RUN by default and returns a diff; nothing changes unless you pass apply=true. Each hosted user is bound to their own server-side Cloudflare OAuth connection; Cloudflare tokens are never tool arguments or shared through Git. " +
        "Cloudflare Ops MCP / cloudflare-ops-mcp is an independent, third-party open-source tool - not affiliated with, endorsed by, or sponsored by Cloudflare, Inc.; Cloudflare is used nominatively to name the service this tool works with.",
    });
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") {
    // Native + management tools + (best-effort) federated upstream tools. A dead
    // upstream never breaks the catalog — federatedTools swallows its own errors.
    let fed = [];
    try { fed = await federatedTools(env); } catch { fed = []; }
    // 2026-08-21: management tools are ADMIN-ONLY. Their state (fed:*, policy:*)
    // is GLOBAL, not per-connection, so a public connector user could previously
    // register a hostile federated upstream — injecting attacker-authored tool
    // names/descriptions into EVERY other user's tools/list — or policy_set a
    // core tool to "block" and DoS everyone. Neither was undoable by the victim.
    const isAdmin = authContext && authContext.mode === "admin";
    return rpcResult(id, { tools: [...TOOLS, ...(isAdmin ? MGMT_TOOL_DEFS : []), ...fed] });
  }
  if (method === "tools/call") {
    const toolName = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      // 1) Management tools (federation/policy admin) bypass the policy gate and
      //    the CF client — so you can never lock yourself out of governance.
      if (MGMT_TOOLS.has(toolName)) {
        // ADMIN ONLY — see the note in tools/list. runMgmtTool writes global
        // federation/policy state and deliberately bypasses the policy gate, so
        // it must never be reachable with a per-user cfops_ connector key.
        if (!authContext || authContext.mode !== "admin") {
          return rpcResult(id, { content: [{ type: "text", text: JSON.stringify({ error: "forbidden: " + toolName + " is an owner/admin tool. Federation and policy are global settings; per-user connector keys cannot change them." }, null, 2) }], isError: true });
        }
        const out = await runMgmtTool(toolName, args, env);
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], isError: !!(out && out.error) });
      }
      // 2) Policy gate — applies to every native + federated tool.
      const gate = await checkPolicy(env, toolName, args);
      if (!gate.allowed) {
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify({ error: gate.reason, policy: gate.mode }, null, 2) }], isError: true });
      }
      // 3) Federated tool (namespace__tool) → proxy to its upstream MCP.
      const namespaces = (await listUpstreams(env)).map((u) => u.namespace);
      const fed = isFederated(toolName, namespaces);
      if (fed) {
        const out = await callFederated(env, fed.ns, fed.tool, args);
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], isError: !!(out && out.error) });
      }
      // 4) Native cfops tool.
      const tool = TOOLS.find((t) => t.name === toolName);
      if (!tool) return rpcError(id, -32602, `unknown tool: ${toolName}`);
      const out = await runTool(toolName, args, env, authContext);
      const isError = !!(out && out.error);
      // Best-effort audit to observability (redacted; never the token).
      if ((args.apply === true || (toolName === "delete_dns_record" && args.confirm === true)) && !isError) {
        console.log(JSON.stringify({
          event: "tool_apply",
          tool: toolName,
          domain: String(args.domain || ""),
          auth_mode: authContext?.mode || "unknown",
        }));
      }
      return rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        isError,
      });
    } catch (e) {
      const safe = redactToken(String((e && e.message) || e));
      return rpcResult(id, { content: [{ type: "text", text: `Error: ${safe}` }], isError: true });
    }
  }
  return rpcError(id, -32601, `method not found: ${method}`);
}

// Baseline hardening applied to every response (2026-08-21).
// ACAO stays "*" ON PURPOSE: this is a bearer-token API, not a cookie session,
// so there is no ambient authority for a hostile origin to ride — and MCP
// clients connect from many origins (claude.ai, Cursor, localhost, CLIs).
// Access-Control-Allow-Credentials is deliberately NEVER set, which is what
// makes the wildcard safe: browsers refuse to send credentials to a wildcard
// origin, so a page cannot silently replay a user's key.
const SECURITY_HEADERS = {
  // Force HTTPS for a year. The Worker is only ever reachable over TLS.
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  // Nothing here is meant to be framed — kills clickjacking of the OAuth
  // connect page, which is the one page a user clicks a real button on.
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=()",
};

// The supplied WT landing is a self-contained bundle. It uses inline bootstrap
// scripts and blob URLs to unpack its embedded fonts and images. Only the
// landing asset receives this CSP; API and OAuth responses keep the stricter
// default policy above.
const WT_LANDING_CSP = [
  "default-src 'self' blob: data:",
  "script-src 'self' 'unsafe-inline' blob:",
  "style-src 'self' 'unsafe-inline' blob:",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, X-MCP-Key, Mcp-Session-Id, Mcp-Protocol-Version",
  "Cache-Control": "no-store",
  ...SECURITY_HEADERS,
};

function renderLogoSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img" aria-label="Cloudflare Ops MCP"><rect width="512" height="512" rx="96" fill="#07140d"/><path d="M138 294c0-90 73-163 163-163 35 0 68 11 94 30l-46 56c-14-9-30-14-48-14-50 0-91 41-91 91s41 91 91 91c18 0 34-5 48-14l46 56c-26 19-59 30-94 30-90 0-163-73-163-163Z" fill="#6ee7a3"/><path d="M107 158h93v72h-93v-72Zm0 124h93v72h-93v-72Z" fill="#f5f1e8"/><circle cx="347" cy="294" r="42" fill="#f5f1e8"/></svg>`;
}
function discoveryUrls(origin) {
  return [
    origin + "/",
    origin + "/?format=json",
    origin + "/llms.txt",
    origin + "/walrus-tusk.md",
  ];
}
function renderRobots(origin) {
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /mcp",
    "Disallow: /oauth/cloudflare/callback",
    "Disallow: /oauth/cloudflare/status",
    "Disallow: /oauth/cloudflare/revoke",
    "Sitemap: " + origin + "/sitemap.xml",
    "",
  ].join("\n");
}
function renderSitemap(origin) {
  const stamp = new Date().toISOString().slice(0, 10);
  const nodes = discoveryUrls(origin).map((url) => "<url><loc>" + url.replace(/&/g, "&amp;") + "</loc><lastmod>" + stamp + "</lastmod></url>").join("");
  return '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + nodes + "</urlset>";
}
function renderLlmsText(origin) {
  return [
    "# AMH Walrus Tusk Cloudflare Ops MCP",
    "",
    "> OAuth-first, approval-gated Cloudflare operations software by Artificial Mind Hive / Service Pricer LLC.",
    "",
    "Canonical landing: " + origin + "/",
    "Machine status: " + origin + "/?format=json",
    "MCP endpoint: " + origin + "/mcp",
    "Connect Cloudflare: " + origin + "/oauth/cloudflare/start",
    "Agent Console: https://console.artificialmindhive.com/console",
    "Project and examples: https://github.com/pain2hustle/AMH-Cloudflare-Ops-MCP-by-WT",
    "Walrus Tusk landing (legacy route name): https://artificialmindhive.com/WalrusTooth",
    "",
    "Capabilities: DNS inspection and guarded changes; SPF, DKIM, DMARC, BIMI; Email Routing; Pages cutovers; cache purge; Turnstile; scoped tokens; account diagnostics; MCP federation; SafeTry agent harness.",
    "Safety: per-user Cloudflare OAuth; connector keys are hashed; Cloudflare access tokens stay server-side; writes are dry-run or approval-gated; no owner API key is distributed.",
    "",
  ].join("\n");
}
function renderWalrusTuskMarkdown(origin) {
  return [
    "# Walrus Tusk (WT)",
    "",
    "Walrus Tusk is the Artificial Mind Hive operator-safety and continuity layer for Cloudflare Ops MCP.",
    "",
    "- Hosted MCP: " + origin + "/mcp",
    "- Connect with Cloudflare OAuth: " + origin + "/oauth/cloudflare/start",
    "- Live Agent Console: https://console.artificialmindhive.com/console",
    "- Source, setup, examples, privacy, terms, and security: https://github.com/pain2hustle/AMH-Cloudflare-Ops-MCP-by-WT",
    "- Public brand landing (legacy route name): https://artificialmindhive.com/WalrusTooth",
    "",
    "Users authorize their own Cloudflare account. Walrus Tusk does not give users the owner's Cloudflare API token.",
    "",
  ].join("\n");
}
function renderStatusHtml(info) {
  const tools = info.tools.map((tool) => `<span class="chip">${tool}</span>`).join("");
  const oauthState = info.oauth.configured ? "OAuth ready" : "OAuth setup needed";
  const oauthClass = info.oauth.configured ? "ok" : "warn";
  const start = info.oauth.routes.start;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${info.server.title}</title>
<meta name="description" content="AMH Walrus Tusk Cloudflare Ops MCP with per-user OAuth, approval-gated DNS, Email, Pages, Cache, Turnstile, and a private Agent Console.">
<link rel="canonical" href="${info.canonical}">
<meta name="robots" content="index,follow,max-image-preview:large">
<meta property="og:title" content="${info.server.title}">
<meta property="og:description" content="Per-user Cloudflare OAuth and guarded operational tools without sharing the owner's API token.">
<meta property="og:url" content="${info.canonical}">
<meta property="og:type" content="website">
<meta name="theme-color" content="#6ee7a3">
<style>
:root{--green:#6ee7a3;--green-2:#16a34a;--ink:#102118;--muted:#587064;--cream:#f5f1e8;--panel:#fffaf0;--line:#d9eadc;--dark:#07140d}
*{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;color:var(--ink);background:radial-gradient(circle at 20% 0%,rgba(110,231,163,.42),transparent 32%),linear-gradient(135deg,#f8f4ea 0%,#edf8ee 48%,#f5f1e8 100%)}
.wrap{width:min(1080px,100%);margin:0 auto;padding:38px 18px 54px}.top{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-bottom:42px}.brand{display:flex;align-items:center;gap:12px;font-weight:900;letter-spacing:.02em}.mark{width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,var(--green),#d7ffd9);box-shadow:0 0 0 1px rgba(7,20,13,.12),0 12px 28px rgba(22,163,74,.22)}.pill{border:1px solid rgba(16,33,24,.12);background:rgba(255,250,240,.72);padding:8px 11px;border-radius:999px;font-size:12px;font-weight:800;color:var(--muted)}
.hero{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(280px,.9fr);gap:26px;align-items:stretch}.copy{padding:8px 0 0}.eyebrow{font-size:12px;font-weight:900;text-transform:uppercase;color:var(--green-2);letter-spacing:.08em;margin-bottom:12px}h1{font-size:clamp(38px,6vw,72px);line-height:.95;margin:0 0 18px;letter-spacing:0;color:var(--dark)}p{font-size:16px;line-height:1.65;color:var(--muted);max-width:680px;margin:0 0 22px}.actions{display:flex;flex-wrap:wrap;gap:10px}.btn{appearance:none;border:1px solid rgba(16,33,24,.14);border-radius:12px;padding:12px 15px;font-weight:900;text-decoration:none;color:var(--ink);background:rgba(255,250,240,.76);box-shadow:0 12px 28px rgba(16,33,24,.08)}.btn.primary{background:var(--green);color:#062012;border-color:rgba(6,32,18,.2)}.btn:hover{transform:translateY(-1px)}
.panel{background:rgba(255,250,240,.78);border:1px solid var(--line);border-radius:18px;padding:18px;box-shadow:0 24px 70px rgba(16,33,24,.12);backdrop-filter:blur(12px)}.status{display:grid;gap:12px}.row{display:flex;align-items:center;justify-content:space-between;gap:14px;border-bottom:1px solid var(--line);padding:0 0 11px}.row:last-child{border-bottom:0;padding-bottom:0}.label{font-size:12px;font-weight:900;color:var(--muted);text-transform:uppercase}.value{font-size:13px;font-weight:900;text-align:right}.value.ok{color:#15803d}.value.warn{color:#9a5b00}.tools{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}.chip{font-size:12px;font-weight:800;border:1px solid rgba(22,163,74,.22);background:rgba(110,231,163,.18);color:#14532d;border-radius:999px;padding:7px 9px}.note{margin-top:18px;font-size:12px;color:var(--muted);line-height:1.55}
@media (max-width:760px){.top{margin-bottom:26px}.hero{grid-template-columns:1fr}h1{font-size:42px}.actions{display:grid}.btn{text-align:center}.panel{border-radius:14px}}
</style>
</head>
<body>
<main class="wrap">
  <div class="top"><div class="brand"><span class="mark"></span><span>-/\\-\\ M H // WT</span></div><div class="pill">Per-user OAuth · no shared API token</div></div>
  <section class="hero">
    <div class="copy">
      <div class="eyebrow">OAuth-first Cloudflare control</div>
      <h1>Your Cloudflare. Your connection.</h1>
      <p>DNS, Email Routing, DMARC, BIMI, Pages cutovers, cache purge, and Turnstile tools stay approval-gated. Every user connects through Cloudflare OAuth and receives a separate MCP connector key—never the owner's API token.</p>
      <div class="actions">
        <a class="btn primary" href="${start}">Connect Cloudflare</a>
        <a class="btn" href="https://github.com/pain2hustle/AMH-Cloudflare-Ops-MCP-by-WT">Setup &amp; examples</a>
        <a class="btn" href="?format=json">View JSON</a>
      </div>
    </div>
    <div class="panel">
      <div class="status">
        <div class="row"><span class="label">Worker</span><span class="value ok">Live</span></div>
        <div class="row"><span class="label">OAuth</span><span class="value ${oauthClass}">${oauthState}</span></div>
        <div class="row"><span class="label">User Isolation</span><span class="value ${info.oauth.configured ? "ok" : "warn"}">${info.oauth.configured ? "Per-user keys" : "Setup needed"}</span></div>
        <div class="row"><span class="label">Fallback Token</span><span class="value ${info.token_configured ? "ok" : "warn"}">${info.token_configured ? "Configured" : "OAuth only"}</span></div>
      </div>
      <div class="tools">${tools}</div>
      <div class="note">Git ships code, never the owner's secrets. Connector keys are stored only as hashes and cannot switch to another user's OAuth grant.</div>
    </div>
  </section>
</main>
</body>
</html>`;
}

async function renderWtLanding(request, env) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") return null;
  const assetUrl = new URL("/WT-MCP-Root.html", request.url);
  const assetRequest = new Request(assetUrl.toString(), { method: "GET", headers: request.headers });
  const assetResponse = await env.ASSETS.fetch(assetRequest);
  if (!assetResponse.ok || !assetResponse.body) return null;

  const headers = new Headers(assetResponse.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "public, max-age=300");
  headers.set("content-security-policy", WT_LANDING_CSP);
  return new Response(assetResponse.body, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers,
  });
}

async function fetchInner(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/robots.txt") return new Response(renderRobots(url.origin), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
    if (request.method === "GET" && url.pathname === "/sitemap.xml") return new Response(renderSitemap(url.origin), { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" } });
    if (request.method === "GET" && url.pathname === "/llms.txt") return new Response(renderLlmsText(url.origin), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
    if (request.method === "GET" && url.pathname === "/walrus-tusk.md") return new Response(renderWalrusTuskMarkdown(url.origin), { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=3600" } });
    if (request.method === "GET" && url.pathname === "/" + INDEXNOW_KEY + ".txt") return new Response(INDEXNOW_KEY, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=86400" } });
    if (url.pathname === "/logo.svg") return new Response(renderLogoSvg(), { headers: { "content-type": "image/svg+xml", ...CORS } });
    if (url.pathname === "/oauth/cloudflare/start") return handleOAuthStart(request, env);
    if (url.pathname === "/oauth/cloudflare/callback") return handleOAuthCallback(request, env);
    if (url.pathname === "/oauth/cloudflare/status") return handleOAuthStatus(request, env);
    if (url.pathname === "/oauth/cloudflare/revoke") return handleOAuthRevoke(request, env);
    // Health/info on GET. Browsers get a small green connect page; API clients get JSON.
    if (request.method === "GET") {
      const info = {
        ok: true,
        server: SERVER,
        tools: TOOLS.map((t) => t.name),
        auth_required: true,
        admin_fallback_configured: !!env.MCP_ACCESS_KEY,
        token_configured: !!env.CLOUDFLARE_API_TOKEN,
        oauth: getOAuthConfigStatus(env, url.origin),
        canonical: url.origin + "/",
        discovery: { robots: url.origin + "/robots.txt", sitemap: url.origin + "/sitemap.xml", llms: url.origin + "/llms.txt", walrus_tusk_markdown: url.origin + "/walrus-tusk.md" },
        note: "Connect at /oauth/cloudflare/start, then POST MCP JSON-RPC to /mcp with your one-user connector key. Cloudflare tokens remain server-side.",
      };
      const wantsJson = url.searchParams.get("format") === "json" || /application\/json/i.test(request.headers.get("accept") || "");
      if (url.pathname === "/" && !wantsJson && /text\/html/i.test(request.headers.get("accept") || "")) {
        const landing = await renderWtLanding(request, env);
        if (landing) return landing;
      }
      if (!wantsJson && /text\/html/i.test(request.headers.get("accept") || "")) {
        return new Response(renderStatusHtml(info), { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...CORS } });
      }
      return new Response(JSON.stringify(info, null, 2), { status: 200, headers: { "content-type": "application/json", ...CORS } });
    }
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: CORS });
    }

    // Every MCP request fails closed unless its opaque connector key resolves to
    // one OAuth connection, or it uses the private legacy admin key.
    const auth = request.headers.get("authorization") || "";
    const provided = (/^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "") : "").trim()
      || (request.headers.get("x-mcp-key") || "").trim();
    const authContext = await authorizeConnector(env, provided);
    if (!authContext.ok) {
      return new Response(JSON.stringify(rpcError(null, -32001, "unauthorized")), {
        status: 401,
        headers: { "content-type": "application/json", "www-authenticate": "Bearer", ...CORS },
      });
    }

    // Rate limit AFTER auth so an unauthenticated flood can't burn KV writes,
    // and BEFORE parsing the body so a throttled caller costs us almost nothing.
    const rl = await checkRateLimit(env, authContext);
    if (!rl.allowed) {
      return new Response(JSON.stringify(rpcError(null, -32000, `rate limited: over ${rl.limit} requests/minute for this key. Retry in ${rl.retryAfter}s.`)), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": String(rl.retryAfter), ...CORS },
      });
    }

    let body;
    try { body = await request.json(); } catch {
      return new Response(JSON.stringify(rpcError(null, -32700, "parse error")), { status: 400, headers: { "content-type": "application/json", ...CORS } });
    }

    // Support a single message or a batch.
    const single = !Array.isArray(body);
    const messages = single ? [body] : body;
    const out = [];
    for (const m of messages) {
      const r = await handleRpc(m, env, authContext);
      if (r) out.push(r);
    }

    // Notifications only → 202 with no body.
    if (out.length === 0) return new Response(null, { status: 202, headers: CORS });

    const payload = single ? out[0] : out;
    const wantsSse = /text\/event-stream/i.test(request.headers.get("accept") || "");
    if (wantsSse) {
      const sse = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", ...CORS } });
    }
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json", ...CORS } });
}

// Stamp the security headers onto EVERY response on the way out. Several
// routes (robots.txt, sitemap.xml, llms.txt, walrus-tusk.md, the HTML pages)
// build their own header objects and would otherwise miss them; doing it here
// means a future route cannot forget. Never overwrites a header a handler set.
function harden(res) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!h.has(k)) h.set(k, v);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}


// ── RATE LIMITER DURABLE OBJECT (2026-08-22) ─────────────────────────────────
// Why a DO and not the two simpler things I tried first:
//   1. KV counter — KV is EVENTUALLY CONSISTENT. 100 concurrent requests each
//      read a stale 0, wrote 1, counter never climbed. 800/800 allowed. Useless.
//   2. Native `ratelimit` binding — attaches fine, limit() is called, but this
//      account returns { success: true } every time (verified 900 req vs limit
//      600, and 18 req vs limit 10, on two hostnames, fresh namespace). It stays
//      wired as the preferred path for when the account supports it.
// A Durable Object is the only option here that is actually strongly consistent:
// every request for one key routes to ONE object, so the counter is exact.
//
// Cost shape: one DO instance per connector key, holding a few numbers. State
// lives in memory with a storage-backed fallback so a hibernated object does not
// forget mid-window. An alarm evicts idle state so nothing accumulates.
export class RateLimiterDO {
  constructor(state) {
    this.state = state;
    this.hits = null;      // { window: number, count: number }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit")) || 120;
    const period = Number(url.searchParams.get("period")) || 60;
    const now = Date.now();
    const window = Math.floor(now / (period * 1000));

    if (!this.hits) {
      // Cold start / post-hibernation: recover the window we were in.
      this.hits = (await this.state.storage.get("hits")) || { window, count: 0 };
    }
    if (this.hits.window !== window) {
      this.hits = { window, count: 0 };
    }

    this.hits.count += 1;
    const over = this.hits.count > limit;

    // Persist so a hibernation mid-window cannot reset the count to zero, and
    // set an alarm to drop the row once the window is well past.
    await this.state.storage.put("hits", this.hits);
    await this.state.storage.setAlarm(now + period * 2000);

    const resetIn = period - Math.floor((now % (period * 1000)) / 1000);
    return new Response(JSON.stringify({
      allowed: !over,
      count: this.hits.count,
      limit,
      retryAfter: resetIn,
    }), { headers: { "content-type": "application/json" } });
  }

  async alarm() {
    // Idle long enough that the window is irrelevant — forget it.
    await this.state.storage.deleteAll();
    this.hits = null;
  }
}

export default {
  async fetch(request, env) {
    try {
      return harden(await fetchInner(request, env));
    } catch (e) {
      const safe = redactToken(String((e && e.stack) || (e && e.message) || e));
      return new Response(JSON.stringify({ ok: false, error: "worker_exception", detail: safe.split("\n").slice(0, 3).join(" | ") }, null, 2), { status: 500, headers: { "content-type": "application/json", ...CORS } });
    }
  },
};
