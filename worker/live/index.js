// legacy.mjs
var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var CF_BASE = "https://api.cloudflare.com/client/v4";
function redactToken(str, known) {
  if (str == null) return str;
  let out = String(str);
  if (known && known.length >= 8) {
    const esc = known.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(esc, "g"), "[REDACTED]");
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, "Bearer [REDACTED]");
  out = out.replace(/[A-Za-z0-9_-]{30,}/g, "[REDACTED]");
  return out;
}
__name(redactToken, "redactToken");
var CloudflareError = class extends Error {
  static {
    __name(this, "CloudflareError");
  }
  /**
   * @param {string} message already-redacted human message
   * @param {object} [opts]
   * @param {number} [opts.code] Cloudflare error code
   * @param {number} [opts.status] HTTP status
   * @param {Array}  [opts.errors] raw CF errors array (redacted)
   */
  constructor(message, { code, status, errors } = {}) {
    super(message);
    this.name = "CloudflareError";
    this.code = code;
    this.status = status;
    this.errors = errors;
  }
};
var CloudflareClient = class {
  static {
    __name(this, "CloudflareClient");
  }
  /**
   * @param {object} [opts]
   * @param {string} [opts.token] defaults to process.env.CLOUDFLARE_API_TOKEN
   * @param {Function} [opts.fetch] injectable fetch (defaults to global fetch)
   * @param {string} [opts.baseUrl]
   */
  constructor({ token, fetch: fetchImpl, baseUrl } = {}) {
    this._token = token !== void 0 ? token : process.env.CLOUDFLARE_API_TOKEN;
    this._fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this.baseUrl = baseUrl || CF_BASE;
    if (typeof this._fetch !== "function") {
      throw new Error(
        "No fetch implementation available. Use Node >=18 or inject { fetch }."
      );
    }
  }
  /** Whether a token is present (does not reveal its value). */
  hasToken() {
    return typeof this._token === "string" && this._token.length > 0;
  }
  /**
   * Perform a request against the Cloudflare API and unwrap the envelope.
   * @param {string} method
   * @param {string} path path beginning with '/', may include query string
   * @param {object|null} [body]
   * @returns {Promise<{result:any, result_info:any, messages:any}>}
   */
  async request(method, path, body) {
    if (!this.hasToken()) {
      throw new CloudflareError(
        "Missing Cloudflare API token. Set CLOUDFLARE_API_TOKEN in the environment."
      );
    }
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
    const headers = { Authorization: `Bearer ${this._token}` };
    const init = { method, headers };
    if (body !== void 0 && body !== null) {
      headers["Content-Type"] = "application/json";
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    let res;
    try {
      const doFetch = this._fetch;
      res = await doFetch(url, init);
    } catch (err2) {
      throw new CloudflareError(
        redactToken(
          `Network error calling Cloudflare API: ${err2 && err2.message}`,
          this._token
        )
      );
    }
    let payload;
    const text = await res.text();
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new CloudflareError(
        redactToken(
          `Non-JSON response from Cloudflare API (HTTP ${res.status}).`,
          this._token
        ),
        { status: res.status }
      );
    }
    if (!payload || payload.success !== true) {
      const errs = Array.isArray(payload && payload.errors) ? payload.errors : [];
      const first = errs[0] || {};
      const codePart = first.code != null ? ` (code ${first.code})` : "";
      const msg = redactToken(
        `Cloudflare API error${codePart}: ${first.message || `HTTP ${res.status}`}`,
        this._token
      );
      const safeErrors = errs.map((e) => ({
        code: e.code,
        message: redactToken(e.message, this._token)
      }));
      throw new CloudflareError(msg, {
        code: first.code,
        status: res.status,
        errors: safeErrors
      });
    }
    return {
      result: payload.result,
      result_info: payload.result_info,
      messages: payload.messages
    };
  }
  /**
   * Fetch every page of a paginated list endpoint, following result_info.
   * @param {string} path base path (may already contain query params)
   * @param {object} [opts]
   * @param {number} [opts.perPage=100]
   * @returns {Promise<Array>} concatenated results
   */
  async paginate(path, { perPage = 100 } = {}) {
    const out = [];
    let page2 = 1;
    for (let guard = 0; guard < 1e3; guard++) {
      const sep = path.includes("?") ? "&" : "?";
      const { result, result_info } = await this.request(
        "GET",
        `${path}${sep}page=${page2}&per_page=${perPage}`
      );
      if (Array.isArray(result)) out.push(...result);
      const info = result_info || {};
      const totalPages = info.total_pages || 1;
      if (!info.page || page2 >= totalPages) break;
      page2 += 1;
    }
    return out;
  }
  /**
   * Validate the token at startup. Returns { status } on success.
   * Never echoes the token.
   * @returns {Promise<{status:string, id?:string}>}
   */
  async verifyToken() {
    const { result } = await this.request("GET", "/user/tokens/verify");
    return result || {};
  }
};
async function listRecords(client, domain, { zoneId } = {}) {
  const zone_id = zoneId || await resolveZoneId(client, domain);
  return client.paginate(`/zones/${zone_id}/dns_records`);
}
__name(listRecords, "listRecords");
function normName(n) {
  return String(n).toLowerCase().replace(/\.$/, "");
}
__name(normName, "normName");
function bareTxt(content) {
  return String(content == null ? "" : content).replace(/^"(.*)"$/s, "$1").trim();
}
__name(bareTxt, "bareTxt");
function txtKind(content) {
  const c = bareTxt(content).toLowerCase();
  if (/^v=spf1\b/.test(c)) return "spf";
  if (/^v=dmarc1\b/.test(c)) return "dmarc";
  if (/^v=bimi1\b/.test(c)) return "bimi";
  if (/^v=dkim1\b/.test(c)) return "dkim";
  return "other";
}
__name(txtKind, "txtKind");
function findRecords(records, type, name) {
  if (!Array.isArray(records)) return [];
  const wantType = String(type).toUpperCase();
  const wantName = normName(name);
  return records.filter(
    (r) => String(r.type).toUpperCase() === wantType && normName(r.name) === wantName
  );
}
__name(findRecords, "findRecords");
function selectUpsertTarget(records, desired, opts = {}) {
  const type = String(desired.type).toUpperCase();
  let candidates = findRecords(records, type, desired.name);
  if (opts.recordId) {
    const byId = candidates.find((r) => r.id === opts.recordId);
    return { match: byId, candidates, ambiguous: false, targetedById: !byId ? false : true };
  }
  if (type === "TXT") {
    const kind = txtKind(desired.content);
    if (kind === "other") {
      const exact = candidates.filter((r) => bareTxt(r.content) === bareTxt(desired.content));
      candidates = exact;
    } else {
      candidates = candidates.filter((r) => txtKind(r.content) === kind);
    }
  }
  if (candidates.length === 0) return { match: void 0, candidates: [], ambiguous: false };
  if (candidates.length === 1) return { match: candidates[0], candidates, ambiguous: false };
  return { match: void 0, candidates, ambiguous: true };
}
__name(selectUpsertTarget, "selectUpsertTarget");
function buildRecordBody(desired, existing = null) {
  const type = String(desired.type).toUpperCase();
  const body = {
    type,
    name: desired.name,
    content: desired.content
  };
  const proxiableTypes = /* @__PURE__ */ new Set(["A", "AAAA", "CNAME"]);
  const inherit = existing || null;
  let proxied;
  if (!proxiableTypes.has(type)) {
    proxied = false;
  } else if (desired.proxied === true || desired.proxied === false) {
    proxied = desired.proxied;
  } else if (inherit && typeof inherit.proxied === "boolean") {
    proxied = inherit.proxied;
  } else {
    proxied = false;
  }
  if (proxiableTypes.has(type)) {
    body.proxied = proxied;
  }
  if (proxied) {
    body.ttl = 1;
  } else if (desired.ttl != null) {
    body.ttl = desired.ttl;
  } else if (inherit && inherit.ttl != null) {
    body.ttl = inherit.ttl;
  } else {
    body.ttl = 1;
  }
  if (type === "MX" && desired.priority != null) {
    body.priority = desired.priority;
  }
  if (desired.comment != null) body.comment = desired.comment;
  if (desired.tags != null) body.tags = desired.tags;
  return body;
}
__name(buildRecordBody, "buildRecordBody");
function diffRecord(current, desiredBody) {
  const fields = [];
  const compareKeys = ["content", "ttl", "proxied", "priority"];
  const isTxt = String(desiredBody.type).toUpperCase() === "TXT";
  for (const k of compareKeys) {
    if (!(k in desiredBody)) continue;
    let cur = current ? current[k] : void 0;
    let want = desiredBody[k];
    if (k === "content" && isTxt) {
      cur = bareTxt(cur);
      want = bareTxt(want);
    }
    if (cur !== want) fields.push(k);
  }
  return { changed: fields.length > 0, fields };
}
__name(diffRecord, "diffRecord");
async function applyDnsRecord(client, domain, desired, opts = {}) {
  const { apply = false } = opts;
  const zone_id = opts.zoneId || await resolveZoneId(client, domain);
  const records = opts.records || await client.paginate(`/zones/${zone_id}/dns_records`);
  const { match: existing, candidates, ambiguous } = selectUpsertTarget(records, desired, opts);
  const desiredBody = buildRecordBody(desired, existing);
  if (ambiguous) {
    return {
      action: "ambiguous",
      apply: Boolean(apply),
      domain,
      zone_id,
      record: { type: desiredBody.type, name: desiredBody.name },
      candidates: candidates.map((r) => ({ id: r.id, content: r.content, ttl: r.ttl, priority: r.priority })),
      before: null,
      after: desiredBody,
      diff: { changed: false, fields: [] },
      warning: `${candidates.length} records share ${desiredBody.type} ${desiredBody.name}. Refusing to update blindly \u2014 pass an explicit recordId (CLI: --record-id <id>) to target one.`
    };
  }
  const diff = diffRecord(existing, desiredBody);
  let action;
  if (!existing) action = "create";
  else if (diff.changed) action = "update";
  else action = "noop";
  const before = existing ? {
    id: existing.id,
    type: existing.type,
    name: existing.name,
    content: existing.content,
    ttl: existing.ttl,
    proxied: existing.proxied,
    priority: existing.priority,
    comment: existing.comment
  } : null;
  const plan = {
    action,
    apply: Boolean(apply),
    domain,
    zone_id,
    record: { type: desiredBody.type, name: desiredBody.name },
    before,
    after: desiredBody,
    diff
  };
  if (!apply || action === "noop") {
    if (action === "noop") plan.after = before;
    return plan;
  }
  if (action === "create") {
    const { result } = await client.request(
      "POST",
      `/zones/${zone_id}/dns_records`,
      desiredBody
    );
    plan.after = result;
    plan.record.id = result && result.id;
  } else if (action === "update") {
    const patch = {};
    for (const f of diff.fields) patch[f] = desiredBody[f];
    const { result } = await client.request(
      "PATCH",
      `/zones/${zone_id}/dns_records/${existing.id}`,
      patch
    );
    plan.after = result;
    plan.record.id = existing.id;
  }
  return plan;
}
__name(applyDnsRecord, "applyDnsRecord");
async function deleteDnsRecord(client, domain, id, opts = {}) {
  const { confirm = false } = opts;
  if (!confirm) {
    return {
      action: "refused",
      confirmed: false,
      id,
      reason: "Refusing to delete without { confirm: true } (CLI requires --force)."
    };
  }
  const zone_id = opts.zoneId || await resolveZoneId(client, domain);
  const { result } = await client.request(
    "DELETE",
    `/zones/${zone_id}/dns_records/${id}`
  );
  return { action: "delete", confirmed: true, id, result };
}
__name(deleteDnsRecord, "deleteDnsRecord");
function unquoteTxt(raw) {
  if (raw == null) return "";
  let s = String(raw).trim();
  const chunks = s.match(/"((?:[^"\\]|\\.)*)"/g);
  if (chunks && chunks.length) {
    return chunks.map((c) => c.slice(1, -1).replace(/\\"/g, '"')).join("");
  }
  return s.replace(/^"|"$/g, "");
}
__name(unquoteTxt, "unquoteTxt");
function parseDmarc(txt) {
  const raw = unquoteTxt(txt);
  const tags = {};
  const order = [];
  for (const part of raw.split(";")) {
    const seg = part.trim();
    if (!seg) continue;
    const eq = seg.indexOf("=");
    if (eq === -1) continue;
    const key2 = seg.slice(0, eq).trim().toLowerCase();
    const val = seg.slice(eq + 1).trim();
    if (!(key2 in tags)) order.push(key2);
    tags[key2] = val;
  }
  const valid = (tags.v || "").toUpperCase() === "DMARC1";
  return { valid, tags, order, raw };
}
__name(parseDmarc, "parseDmarc");
function buildDmarc(tags, order) {
  const merged = { v: "DMARC1", ...tags };
  const keys = [];
  keys.push("v");
  const rest = order && order.length ? order : Object.keys(merged);
  for (const k of rest) {
    if (k === "v") continue;
    if (merged[k] === void 0 || merged[k] === null) continue;
    if (!keys.includes(k)) keys.push(k);
  }
  for (const k of Object.keys(merged)) {
    if (merged[k] === void 0 || merged[k] === null) continue;
    if (!keys.includes(k)) keys.push(k);
  }
  return keys.map((k) => `${k}=${merged[k]}`).join("; ");
}
__name(buildDmarc, "buildDmarc");
function parseSpf(txt) {
  const raw = unquoteTxt(txt);
  const valid = /^v=spf1\b/i.test(raw.trim());
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const mechanisms = tokens.slice(1);
  let lookupCount = 0;
  let all = null;
  for (const t of mechanisms) {
    const bare = t.replace(/^[+\-~?]/, "");
    const mech = bare.split(":")[0].split("=")[0].toLowerCase();
    if (["include", "a", "mx", "ptr", "exists", "redirect"].includes(mech)) {
      lookupCount += 1;
    }
    if (mech === "all") all = t;
  }
  return { valid, mechanisms, all, lookupCount, raw };
}
__name(parseSpf, "parseSpf");
async function getDmarc(client, domain, opts = {}) {
  const zone_id = opts.zoneId || await resolveZoneId(client, domain);
  const name = `_dmarc.${domain}`;
  const records = opts.records || await listRecords(client, domain, { zoneId: zone_id });
  const dmarcRecords = findRecords(records, "TXT", name).filter((r) => txtKind(r.content) === "dmarc");
  if (dmarcRecords.length > 1) {
    throw new Error(
      `Refusing to act: ${dmarcRecords.length} DMARC records exist at ${name}. RFC 7489 requires exactly one \u2014 receivers ignore DMARC entirely when there are several. Delete the extras in the Cloudflare dashboard first.`
    );
  }
  const record = dmarcRecords[0] || null;
  const parsed = record ? parseDmarc(record.content) : null;
  return { record, parsed, name, zone_id, records };
}
__name(getDmarc, "getDmarc");
async function setDmarcPolicy(client, domain, policy, extra = {}, opts = {}) {
  const valid = /* @__PURE__ */ new Set(["none", "quarantine", "reject"]);
  if (!valid.has(policy)) {
    throw new Error(
      `Invalid DMARC policy '${policy}'. Use 'none', 'quarantine', or 'reject'.`
    );
  }
  const { record, parsed, name, zone_id, records } = await getDmarc(client, domain, opts);
  const baseTags = parsed && parsed.valid ? { ...parsed.tags } : { v: "DMARC1" };
  const order = parsed && parsed.valid && parsed.order.length ? [...parsed.order] : ["v", "p"];
  const policyBefore = baseTags.p || null;
  const RANK = { none: 0, quarantine: 1, reject: 2 };
  const force = extra.force === true || opts.force === true;
  if (!force && policyBefore && RANK[policy] < RANK[policyBefore]) {
    throw new Error(
      `Refusing to WEAKEN DMARC for ${domain}: p=${policyBefore} -> p=${policy}. This reduces protection an operator deliberately enabled. Pass force:true if that is genuinely intended.`
    );
  }
  if (!force && RANK[policy] >= RANK.quarantine) {
    const ruaAfter = extra.rua != null ? extra.rua : baseTags.rua;
    if (!ruaAfter) {
      throw new Error(
        `Refusing to set p=${policy} for ${domain} with no rua= reporting address. Enforcement without reports hides the mail it starts blocking. Supply rua (e.g. rua=mailto:dmarc@${domain}), or pass force:true.`
      );
    }
    if (RANK[policy] === RANK.reject && RANK[policyBefore || "none"] < RANK.quarantine) {
      throw new Error(
        `Refusing to jump ${domain} straight to p=reject from p=${policyBefore || "none"}. Move to p=quarantine first, watch the rua reports until aligned mail is clean, then escalate. Pass force:true to override.`
      );
    }
  }
  baseTags.p = policy;
  if (!order.includes("p")) order.push("p");
  if (extra.rua != null) {
    baseTags.rua = extra.rua;
    if (!order.includes("rua")) order.push("rua");
  }
  if (extra.pct != null) {
    baseTags.pct = String(extra.pct);
    if (!order.includes("pct")) order.push("pct");
  }
  if (extra.fo != null) {
    baseTags.fo = String(extra.fo);
    if (!order.includes("fo")) order.push("fo");
  }
  if (extra.ruf != null) {
    baseTags.ruf = extra.ruf;
    if (!order.includes("ruf")) order.push("ruf");
  }
  if (extra.sp != null) {
    baseTags.sp = extra.sp;
    if (!order.includes("sp")) order.push("sp");
  }
  const dmarcString = buildDmarc(baseTags, order);
  const content = dmarcString;
  const plan = await applyDnsRecord(
    client,
    domain,
    { type: "TXT", name, content, comment: "DMARC policy (cloudflare-ops-mcp)" },
    { apply: opts.apply, zoneId: zone_id, records }
  );
  return {
    ...plan,
    policyBefore,
    policyAfter: policy,
    dmarc: dmarcString
  };
}
__name(setDmarcPolicy, "setDmarcPolicy");
function parseBimi(txt) {
  const raw = unquoteTxt(txt);
  const tags = {};
  for (const part of raw.split(";")) {
    const seg = part.trim();
    if (!seg) continue;
    const eq = seg.indexOf("=");
    if (eq === -1) continue;
    const key2 = seg.slice(0, eq).trim().toLowerCase();
    tags[key2] = seg.slice(eq + 1).trim();
  }
  const valid = (tags.v || "").toUpperCase() === "BIMI1";
  const declined = valid && (tags.l === void 0 || tags.l === "");
  return { valid, tags, raw, declined };
}
__name(parseBimi, "parseBimi");
function buildBimi({ logo, vmc } = {}) {
  const parts = ["v=BIMI1"];
  parts.push(`l=${logo == null ? "" : logo}`);
  if (vmc != null) parts.push(`a=${vmc}`);
  return parts.join("; ");
}
__name(buildBimi, "buildBimi");
async function validateBimiSvgUrl(url, fetchImpl) {
  const warnings = [];
  const https = typeof url === "string" && /^https:\/\//i.test(url);
  if (!https) warnings.push("Logo URL must be HTTPS (l= cannot be http).");
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function" || !https) {
    return { ok: https && warnings.length === 0, https, warnings };
  }
  try {
    const res = await doFetch(url, { method: "GET" });
    const ctype = res.headers && res.headers.get && res.headers.get("content-type") || "";
    let body = "";
    try {
      body = await res.text();
    } catch {
    }
    if (!/svg/i.test(ctype) && !/<svg[\s>]/i.test(body)) {
      warnings.push("Response does not look like an SVG (no svg content-type or <svg> tag).");
    }
    if (body) {
      if (!/baseProfile\s*=\s*["']tiny-ps["']/i.test(body)) {
        warnings.push('SVG is missing baseProfile="tiny-ps" (required by BIMI).');
      }
      if (!/<title[\s>]/i.test(body)) {
        warnings.push("SVG is missing a <title> element (brand name).");
      }
      const bytes = Buffer.byteLength(body, "utf8");
      if (bytes > 32 * 1024) {
        warnings.push(`SVG exceeds 32KB (${bytes} bytes).`);
      }
    }
    return { ok: warnings.length === 0, https, warnings };
  } catch (err2) {
    warnings.push(`Could not fetch logo URL: ${err2 && err2.message}`);
    return { ok: false, https, warnings };
  }
}
__name(validateBimiSvgUrl, "validateBimiSvgUrl");
async function setupBimi(client, domain, arg = {}, opts = {}) {
  const { apply = false, force = false } = opts;
  const zone_id = opts.zoneId || await resolveZoneId(client, domain);
  const records = opts.records || await listRecords(client, domain, { zoneId: zone_id });
  const { parsed: dmarc } = await getDmarc(client, domain, { zoneId: zone_id, records });
  const policy = dmarc && dmarc.valid ? (dmarc.tags.p || "").toLowerCase() : null;
  const dmarcEnforced = policy === "quarantine" || policy === "reject";
  const warnings = [];
  if (!dmarcEnforced) {
    const reason = policy === "none" ? "DMARC policy is p=none. BIMI is not honored until DMARC is at p=quarantine or p=reject." : "No enforcing DMARC record found. BIMI requires DMARC at p=quarantine or p=reject.";
    warnings.push(reason);
    if (apply && !force) {
      return {
        action: "blocked",
        apply: true,
        blocked: true,
        domain,
        zone_id,
        dmarcPolicy: policy,
        dmarcOk: false,
        error: `${reason} Fix DMARC first, or pass { force: true } to override.`,
        warnings
      };
    }
  }
  if (arg.logo) {
    const svg = await validateBimiSvgUrl(arg.logo, opts.fetch);
    for (const w of svg.warnings) warnings.push(w);
  } else {
    warnings.push("No logo URL supplied (l=). BIMI needs a hosted SVG Tiny-PS logo.");
  }
  if (arg.vmc == null) {
    warnings.push(
      "No VMC/CMC supplied (a=). Gmail and Apple Mail require a VMC/CMC to display the logo; Yahoo/AOL do not."
    );
  }
  const name = `default._bimi.${domain}`;
  const bimiString = buildBimi(arg);
  const content = bimiString;
  const plan = await applyDnsRecord(
    client,
    domain,
    { type: "TXT", name, content, comment: "BIMI record (cloudflare-ops-mcp)" },
    { apply, zoneId: zone_id, records }
  );
  return {
    ...plan,
    dmarcPolicy: policy,
    dmarcOk: dmarcEnforced,
    forced: Boolean(force && !dmarcEnforced),
    bimi: bimiString,
    warnings
  };
}
__name(setupBimi, "setupBimi");
async function resolveZoneId(client, domain) {
  const { result } = await client.request(
    "GET",
    `/zones?name=${encodeURIComponent(domain)}`
  );
  if (!Array.isArray(result) || result.length === 0) {
    throw new Error(
      `Zone not found for '${domain}'. The domain may not be in this account, or the API token is not scoped to it.`
    );
  }
  return result[0].id;
}
__name(resolveZoneId, "resolveZoneId");
async function resolveZone(client, domain) {
  const { result } = await client.request(
    "GET",
    `/zones?name=${encodeURIComponent(domain)}`
  );
  if (!Array.isArray(result) || result.length === 0) {
    throw new Error(
      `Zone not found for '${domain}'. The domain may not be in this account, or the API token is not scoped to it.`
    );
  }
  const z = result[0];
  return {
    id: z.id,
    name: z.name,
    status: z.status,
    account_id: z.account && z.account.id ? z.account.id : null
  };
}
__name(resolveZone, "resolveZone");
async function safeRoutingStatus(client, zoneId) {
  try {
    const { result } = await client.request(
      "GET",
      `/zones/${zoneId}/email/routing`
    );
    return result || null;
  } catch {
    return null;
  }
}
__name(safeRoutingStatus, "safeRoutingStatus");
async function scanZone(client, domain) {
  const zone = await resolveZone(client, domain);
  const dns = await client.paginate(`/zones/${zone.id}/dns_records`);
  const norm = /* @__PURE__ */ __name((n) => String(n).toLowerCase().replace(/\.$/, ""), "norm");
  const bare = norm(domain);
  const dmarcRec = dns.find(
    (r) => r.type === "TXT" && norm(r.name) === `_dmarc.${bare}`
  );
  const spfRec = dns.find(
    (r) => r.type === "TXT" && norm(r.name) === bare && /^v=spf1\b/i.test(unquoteTxt(r.content))
  );
  const bimiRec = dns.find(
    (r) => r.type === "TXT" && norm(r.name) === `default._bimi.${bare}`
  );
  const email_routing = await safeRoutingStatus(client, zone.id);
  return {
    zone_id: zone.id,
    name: zone.name,
    status: zone.status,
    account_id: zone.account_id,
    dns,
    email_routing,
    dmarc: dmarcRec ? { record: dmarcRec, parsed: parseDmarc(dmarcRec.content) } : null,
    spf: spfRec ? { record: spfRec, parsed: parseSpf(spfRec.content) } : null,
    bimi: bimiRec ? { record: bimiRec, parsed: parseBimi(bimiRec.content) } : null
  };
}
__name(scanZone, "scanZone");
async function getRoutingStatus(client, zoneId) {
  const { result } = await client.request(
    "GET",
    `/zones/${zoneId}/email/routing`
  );
  return result || {};
}
__name(getRoutingStatus, "getRoutingStatus");
async function enableRouting(client, zoneId, { apply = false } = {}) {
  if (!apply) {
    return { action: "enable", apply: false, zone_id: zoneId, planned: true };
  }
  const { result } = await client.request(
    "POST",
    `/zones/${zoneId}/email/routing/enable`,
    {}
  );
  return { action: "enable", apply: true, zone_id: zoneId, result };
}
__name(enableRouting, "enableRouting");
async function listDestinations(client, accountId) {
  return client.paginate(`/accounts/${accountId}/email/routing/addresses`);
}
__name(listDestinations, "listDestinations");
async function listRules(client, zoneId) {
  return client.paginate(`/zones/${zoneId}/email/routing/rules`);
}
__name(listRules, "listRules");
async function getCatchAll(client, zoneId) {
  const { result } = await client.request(
    "GET",
    `/zones/${zoneId}/email/routing/rules/catch_all`
  );
  return result || {};
}
__name(getCatchAll, "getCatchAll");
function ruleMatches(rule, sourceAddr) {
  if (!rule || !Array.isArray(rule.matchers)) return false;
  return rule.matchers.some(
    (m) => m.type === "literal" && m.field === "to" && String(m.value).toLowerCase() === String(sourceAddr).toLowerCase()
  );
}
__name(ruleMatches, "ruleMatches");
async function setupEmailRouting(client, domain, cfg = {}, opts = {}) {
  const { apply = false, force = false } = opts;
  let zone_id = opts.zoneId;
  let account_id = opts.accountId || null;
  if (!zone_id || !account_id) {
    const z = await resolveZone(client, domain);
    zone_id = zone_id || z.id;
    account_id = account_id || z.account_id;
  }
  const verifiedSet = /* @__PURE__ */ new Set();
  let destKnown = false;
  if (account_id) {
    try {
      const dests = await listDestinations(client, account_id);
      for (const d of dests) if (d && d.email && d.verified) verifiedSet.add(String(d.email).toLowerCase());
      destKnown = true;
    } catch {
      destKnown = false;
    }
  }
  const isVerified = /* @__PURE__ */ __name((email) => verifiedSet.has(String(email || "").toLowerCase()), "isVerified");
  const warnings = [];
  let routing_enabled = null;
  try {
    const status = await getRoutingStatus(client, zone_id);
    routing_enabled = !!(status && (status.enabled === true || status.status === "ready"));
  } catch {
    routing_enabled = null;
  }
  if (apply && routing_enabled !== true) {
    try {
      await enableRouting(client, zone_id, { apply: true });
      routing_enabled = true;
    } catch (e) {
      const msg = e && e.message || String(e);
      return {
        error: `Email Routing could not be enabled on ${domain}: ${msg}. No forward rules were created \u2014 without routing enabled they would never deliver. Check the token has Account > Email Routing Addresses and Zone > Email Routing Rules.`,
        domain,
        zone_id,
        routing_enabled: false,
        rules_created: 0,
        warnings
      };
    }
  } else if (!apply && routing_enabled !== true) {
    warnings.push("Email Routing is NOT enabled on this zone \u2014 applying will enable it (adds MX/SPF) before creating rules.");
  }
  const existingRules = await listRules(client, zone_id);
  const forwards = Array.isArray(cfg.forwards) ? cfg.forwards : [];
  const plan = [];
  for (const fwd of forwards) {
    const existing = existingRules.find((r) => ruleMatches(r, fwd.address));
    const workerTarget = fwd.worker || (typeof fwd.to === "string" && /^worker:/i.test(fwd.to) ? fwd.to.replace(/^worker:/i, "").trim() : null);
    const target = workerTarget || fwd.to;
    const desiredAction = workerTarget ? [{ type: "worker", value: [workerTarget] }] : [{ type: "forward", value: [fwd.to] }];
    const desiredMatchers = [
      { type: "literal", field: "to", value: fwd.address }
    ];
    const body = {
      name: workerTarget ? `Route ${fwd.address} to worker ${workerTarget}` : `Forward ${fwd.address} to ${fwd.to}`,
      enabled: true,
      matchers: desiredMatchers,
      actions: desiredAction
    };
    let action = "create";
    if (existing) {
      const curAction = existing.actions && existing.actions[0] || {};
      const curVal = Array.isArray(curAction.value) && curAction.value.length === 1 ? curAction.value[0] : null;
      const same = curAction.type === desiredAction[0].type && curVal === desiredAction[0].value[0];
      action = same ? "noop" : "update";
    }
    const verified = workerTarget ? true : isVerified(fwd.to);
    const item = {
      action,
      address: fwd.address,
      to: target,
      target_type: workerTarget ? "worker" : "forward",
      destinationVerified: verified,
      before: existing || null,
      after: body
    };
    if (!verified && action !== "noop") {
      const w = destKnown ? `Destination ${fwd.to} is NOT verified \u2014 Cloudflare keeps the rule disabled until its owner clicks the verification email. Add it with add_email_destination, then have them verify.` : `Could not confirm ${fwd.to} is a verified destination (destination list unavailable).`;
      item.warning = w;
      warnings.push(w);
    }
    if (apply && action !== "noop") {
      if (!force && (!destKnown || !verified)) {
        item.action = "blocked-unverified";
      } else if (action === "create") {
        const { result } = await client.request(
          "POST",
          `/zones/${zone_id}/email/routing/rules`,
          body
        );
        item.result = result;
      } else {
        const { result } = await client.request(
          "PUT",
          `/zones/${zone_id}/email/routing/rules/${existing.id}`,
          body
        );
        item.result = result;
      }
    }
    plan.push(item);
  }
  let catchAll = null;
  if (cfg.catchAll) {
    const current = await getCatchAll(client, zone_id).catch(() => null);
    const curTo = current && current.actions && current.actions[0] && Array.isArray(current.actions[0].value) ? current.actions[0].value : [];
    const same = current && current.enabled && curTo.length === 1 && curTo[0] === cfg.catchAll;
    const body = {
      name: `Catch-all to ${cfg.catchAll}`,
      enabled: true,
      matchers: [{ type: "all" }],
      actions: [{ type: "forward", value: [cfg.catchAll] }]
    };
    const caVerified = isVerified(cfg.catchAll);
    catchAll = {
      action: same ? "noop" : "update",
      to: cfg.catchAll,
      destinationVerified: caVerified,
      before: current || null,
      after: body
    };
    if (!caVerified && !same) {
      const w = destKnown ? `Catch-all destination ${cfg.catchAll} is NOT verified \u2014 Cloudflare keeps it disabled until verified.` : `Could not confirm catch-all ${cfg.catchAll} is a verified destination.`;
      catchAll.warning = w;
      warnings.push(w);
    }
    if (apply && !same) {
      if (!force && (!destKnown || !caVerified)) {
        catchAll.action = "blocked-unverified";
      } else {
        const { result } = await client.request(
          "PUT",
          `/zones/${zone_id}/email/routing/rules/catch_all`,
          body
        );
        catchAll.result = result;
      }
    }
  }
  const changes = plan.filter((p) => p.action !== "noop" && p.action !== "blocked-unverified").length + (catchAll && catchAll.action !== "noop" && catchAll.action !== "blocked-unverified" ? 1 : 0);
  return {
    apply: Boolean(apply),
    domain,
    zone_id,
    account_id,
    routing_enabled,
    plan,
    catchAll,
    warnings,
    diff: { changes }
  };
}
__name(setupEmailRouting, "setupEmailRouting");
async function planEmailAuth(client, domain, cfg = {}) {
  const snap = await scanZone(client, domain);
  const findings = [];
  if (!snap.spf) {
    findings.push({
      area: "SPF",
      severity: "warn",
      status: "missing",
      message: "No SPF record at the apex. Add one TXT: v=spf1 <includes> ~all (exactly one SPF record)."
    });
  } else {
    const spf = snap.spf.parsed;
    if (spf.lookupCount >= 10) {
      findings.push({
        area: "SPF",
        severity: "error",
        status: "too-many-lookups",
        message: `SPF has ${spf.lookupCount} DNS-lookup mechanisms (limit is 10; permerror = SPF fail).`
      });
    } else if (spf.lookupCount >= 8) {
      findings.push({
        area: "SPF",
        severity: "warn",
        status: "near-lookup-limit",
        message: `SPF has ${spf.lookupCount} DNS-lookup mechanisms; approaching the 10-lookup limit.`
      });
    } else {
      findings.push({
        area: "SPF",
        severity: "ok",
        status: "present",
        message: `SPF present with ${spf.lookupCount} DNS-lookup mechanisms (all=${spf.all || "none"}).`
      });
    }
  }
  const dkimRecords = snap.dns.filter(
    (r) => /_domainkey\./i.test(String(r.name))
  );
  if (dkimRecords.length === 0) {
    findings.push({
      area: "DKIM",
      severity: "warn",
      status: "missing",
      message: "No *_domainkey records found. Add the ESP's DKIM selector (CNAME or TXT) so DKIM signs with d=<your domain> (alignment)."
    });
  } else {
    findings.push({
      area: "DKIM",
      severity: "ok",
      status: "present",
      message: `${dkimRecords.length} DKIM selector record(s) found: ${dkimRecords.map((r) => r.name).join(", ")}.`
    });
  }
  if (!snap.dmarc) {
    findings.push({
      area: "DMARC",
      severity: "warn",
      status: "missing",
      message: "No DMARC record at _dmarc. Start with v=DMARC1; p=none; rua=mailto:dmarc@<domain> to collect reports."
    });
  } else {
    const p = (snap.dmarc.parsed.tags.p || "").toLowerCase();
    const hasRua = Boolean(snap.dmarc.parsed.tags.rua);
    if (p === "none") {
      findings.push({
        area: "DMARC",
        severity: hasRua ? "ok" : "warn",
        status: "monitoring",
        message: hasRua ? "DMARC at p=none with rua (monitoring). Once reports show all mail aligned, ramp to p=quarantine." : "DMARC at p=none WITHOUT rua \u2014 no visibility. Add rua=mailto:... to collect aggregate reports."
      });
    } else if (p === "quarantine" || p === "reject") {
      findings.push({
        area: "DMARC",
        severity: "ok",
        status: "enforcing",
        message: `DMARC enforcing (p=${p}). BIMI precondition satisfied.`
      });
    } else {
      findings.push({
        area: "DMARC",
        severity: "warn",
        status: "unknown-policy",
        message: `DMARC present but policy is '${p || "unset"}'.`
      });
    }
  }
  if (snap.bimi) {
    const dmarcP = snap.dmarc ? (snap.dmarc.parsed.tags.p || "").toLowerCase() : null;
    const enforced = dmarcP === "quarantine" || dmarcP === "reject";
    findings.push({
      area: "BIMI",
      severity: enforced ? "ok" : "error",
      status: enforced ? "present" : "present-but-inert",
      message: enforced ? "BIMI record present and DMARC is enforcing." : "BIMI record present but DMARC is NOT enforcing (p must be quarantine/reject) \u2014 the logo will not display."
    });
  }
  let routing = null;
  try {
    routing = await getRoutingStatus(client, snap.zone_id);
  } catch {
    routing = snap.email_routing;
  }
  if (routing) {
    findings.push({
      area: "EmailRouting",
      severity: routing.enabled ? "ok" : "warn",
      status: routing.enabled ? "enabled" : "disabled",
      message: `Email Routing status: ${routing.status || (routing.enabled ? "enabled" : "disabled")}.`
    });
  }
  if (cfg.inbox) {
    findings.push({
      area: "EmailRouting",
      severity: "info",
      status: "desired-inbox",
      message: `Desired forwarding inbox noted: ${cfg.inbox}. Use the 'email' command to create a forward rule.`
    });
  }
  const ok2 = !findings.some((f) => f.severity === "error");
  return { domain, zone_id: snap.zone_id, ok: ok2, findings, snapshot: snap };
}
__name(planEmailAuth, "planEmailAuth");
async function resolveCacheZoneId(client, domain) {
  const { result } = await client.request(
    "GET",
    `/zones?name=${encodeURIComponent(String(domain).toLowerCase())}`
  );
  return Array.isArray(result) && result[0] && result[0].id ? result[0].id : null;
}
__name(resolveCacheZoneId, "resolveCacheZoneId");
async function purgeCache(client, domain, opts = {}) {
  const { everything, files, prefixes, tags, apply = false } = opts;
  if (!domain) throw new Error("purgeCache: domain is required");
  const hasFiles = Array.isArray(files) && files.length > 0;
  const hasPrefixes = Array.isArray(prefixes) && prefixes.length > 0;
  const hasTags = Array.isArray(tags) && tags.length > 0;
  const targeted = hasFiles || hasPrefixes || hasTags;
  const purgeAll = everything === true || !targeted;
  if (hasFiles && files.length > 30) {
    throw new Error("purgeCache: Cloudflare allows at most 30 files per purge call.");
  }
  const zoneId = await resolveCacheZoneId(client, domain);
  if (!zoneId) {
    return { action: "not-found", apply, domain, zoneId: null, scope: "", blocked: true };
  }
  const body = purgeAll ? { purge_everything: true } : {
    ...hasFiles ? { files } : {},
    ...hasPrefixes ? { prefixes } : {},
    ...hasTags ? { tags } : {}
  };
  const scope = purgeAll ? "everything (whole zone)" : Object.keys(body).map((k) => `${k} (${body[k].length})`).join(", ");
  if (apply !== true) {
    return { action: "purge", apply: false, domain, zoneId, scope, body };
  }
  const { result } = await client.request("POST", `/zones/${zoneId}/purge_cache`, body);
  return { action: "purge", apply: true, domain, zoneId, scope, body, result };
}
__name(purgeCache, "purgeCache");
var DIRECT_CONFLICT_TYPES = /* @__PURE__ */ new Set(["A", "AAAA", "CNAME"]);
var WWW_CONFLICT_TYPES = /* @__PURE__ */ new Set(["A", "AAAA", "CNAME", "NS"]);
function normName2(value) {
  return String(value || "").toLowerCase().replace(/\.$/, "");
}
__name(normName2, "normName");
function cleanTarget(value) {
  return String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/\.$/, "");
}
__name(cleanTarget, "cleanTarget");
function sameHost(a, b) {
  return normName2(a) === normName2(b);
}
__name(sameHost, "sameHost");
function publicRecord(record) {
  return {
    id: record.id,
    type: record.type,
    name: record.name,
    content: record.content,
    proxied: record.proxied,
    ttl: record.ttl
  };
}
__name(publicRecord, "publicRecord");
function isConflictRecord(record, domain, target, opts) {
  const name = normName2(record.name);
  const type = String(record.type || "").toUpperCase();
  const root = normName2(domain);
  const www = `www.${root}`;
  const wildcard = `*.${root}`;
  if (name === root) {
    if (!DIRECT_CONFLICT_TYPES.has(type)) return false;
    if (type === "CNAME") return !sameHost(record.content, target);
    return true;
  }
  if (opts.includeWww !== false && name === www) {
    if (!WWW_CONFLICT_TYPES.has(type)) return false;
    if (type === "CNAME") return !sameHost(record.content, target);
    return true;
  }
  if (opts.includeWildcard === true && name === wildcard) {
    if (!DIRECT_CONFLICT_TYPES.has(type)) return false;
    if (type === "CNAME") return !sameHost(record.content, target);
    return true;
  }
  return false;
}
__name(isConflictRecord, "isConflictRecord");
function desiredRecords(domain, target, includeWww) {
  const root = normName2(domain);
  const names = includeWww === false ? [root] : [root, `www.${root}`];
  return names.map((name) => ({
    type: "CNAME",
    name,
    content: target,
    ttl: 1,
    proxied: true
  }));
}
__name(desiredRecords, "desiredRecords");
async function planPagesCutover(client, domain, opts = {}) {
  const target = cleanTarget(opts.target);
  if (!target) throw new Error("pages cutover requires --target <project.pages.dev>");
  const root = normName2(domain);
  const includeWww = opts.includeWww !== false;
  const includeWildcard = opts.includeWildcard === true;
  const apply = opts.apply === true;
  const zone_id = opts.zoneId || await resolveZoneId(client, root);
  const current = opts.records || await listRecords(client, root, { zoneId: zone_id });
  const warnings = [];
  if (!/\.pages\.dev$/i.test(target)) {
    warnings.push(
      `Target '${target}' is not a *.pages.dev hostname; continuing because custom CNAME targets are allowed.`
    );
  }
  if (!includeWildcard) {
    const hasWildcardConflict = current.some(
      (r) => isConflictRecord(r, root, target, { includeWww, includeWildcard: true }) && normName2(r.name) === `*.${root}`
    );
    if (hasWildcardConflict) {
      warnings.push("Wildcard A/AAAA/CNAME records exist and were left untouched. Add --wildcard to remove them too.");
    }
  }
  const deletePlan = current.filter((r) => isConflictRecord(r, root, target, { includeWww, includeWildcard })).map(publicRecord);
  let recordsForUpsert = current.filter((r) => !deletePlan.some((d) => d.id === r.id));
  const deleted = [];
  const snapshot = current.filter((r) => deletePlan.some((d) => d.id === r.id)).map((r) => ({ type: r.type, name: r.name, content: r.content, ttl: r.ttl, proxied: r.proxied, priority: r.priority, comment: r.comment }));
  const upserts = [];
  let restored = null;
  try {
    if (apply) {
      for (const record of deletePlan) {
        deleted.push(await deleteDnsRecord(client, root, record.id, { zoneId: zone_id, confirm: true }));
      }
      recordsForUpsert = await listRecords(client, root, { zoneId: zone_id });
    }
    for (const desired of desiredRecords(root, target, includeWww)) {
      const result = await applyDnsRecord(client, root, desired, {
        zoneId: zone_id,
        records: recordsForUpsert,
        apply
      });
      upserts.push(result);
      if (apply && result.after && result.after.id) {
        recordsForUpsert = recordsForUpsert.filter((r) => r.id !== result.after.id);
        recordsForUpsert.push(result.after);
      }
    }
  } catch (e) {
    if (!apply || deleted.length === 0) throw e;
    restored = { attempted: snapshot.length, ok: 0, failed: [] };
    for (const rec of snapshot) {
      try {
        await applyDnsRecord(client, root, rec, { zoneId: zone_id, apply: true });
        restored.ok += 1;
      } catch (re) {
        restored.failed.push({ record: rec, error: re && re.message || String(re) });
      }
    }
    const err2 = new Error(
      `pages_cutover FAILED after deleting ${deleted.length} record(s): ${e && e.message || e}. Rollback restored ${restored.ok}/${restored.attempted}.` + (restored.failed.length ? ` ${restored.failed.length} could NOT be restored \u2014 see .restore for the exact records to re-create by hand.` : ` The zone is back to its previous state.`)
    );
    err2.restore = { snapshot, restored, deleted };
    throw err2;
  }
  return {
    action: "pages_cutover",
    // Everything needed to undo this cutover by hand, always returned.
    undo: { restore_records: snapshot },
    apply,
    domain: root,
    target,
    zone_id,
    include_www: includeWww,
    include_wildcard: includeWildcard,
    delete: deletePlan,
    deleted,
    upserts,
    warnings,
    has_changes: deletePlan.length > 0 || upserts.some((p) => p.action !== "noop")
  };
}
__name(planPagesCutover, "planPagesCutover");
var VALID_MODES = /* @__PURE__ */ new Set(["managed", "non-interactive", "invisible"]);
async function createTurnstileWidget(client, domain, opts = {}) {
  const { name, mode = "managed", extraDomains = [], apply = false } = opts;
  if (!VALID_MODES.has(mode)) {
    throw new Error(`Invalid Turnstile mode '${mode}'. Use: ${[...VALID_MODES].join(", ")}.`);
  }
  const zone = await resolveZone(client, domain);
  const accountId = zone.account_id;
  if (!accountId) {
    throw new Error(`Could not resolve the Cloudflare account for '${domain}' (token may lack Account access).`);
  }
  const widgetName = (name || `${domain} widget`).slice(0, 254);
  const domains = [...new Set([domain, ...extraDomains].filter(Boolean))];
  const plan = {
    action: "create",
    apply,
    account_id: accountId,
    widget: { name: widgetName, domains, mode }
  };
  if (!apply) return { ...plan, applied: false };
  const { result } = await client.request(
    "POST",
    `/accounts/${accountId}/challenges/widgets`,
    { name: widgetName, domains, mode }
  );
  return {
    ...plan,
    applied: true,
    sitekey: result && result.sitekey ? result.sitekey : null,
    // PUBLIC — put in the HTML widget
    secret: result && result.secret ? result.secret : null,
    // SECRET — server-side verify only
    created: result || null
  };
}
__name(createTurnstileWidget, "createTurnstileWidget");
var DEFAULT_TTL_SECONDS = 3600;
var MAX_TTL_SECONDS = 86400;
var TOKEN_PRESETS = {
  "zone-read": {
    description: "Read-only: inspect zone settings and DNS records.",
    groups: ["Zone Read", "DNS Read"]
  },
  "dns-zone": {
    description: "DNS fixer: read the zone, write DNS records. The bread-and-butter scope for SPF/DMARC/BIMI fixes.",
    groups: ["Zone Read", "DNS Read", "DNS Write"]
  },
  "cache-purge": {
    description: "Cache buster: read the zone, purge its cache.",
    groups: ["Zone Read", "Cache Purge"]
  }
};
async function listPermissionGroups(client) {
  const { result } = await client.request("GET", "/user/tokens/permission_groups");
  const map = /* @__PURE__ */ new Map();
  for (const g of Array.isArray(result) ? result : []) {
    if (g && g.name && g.id) map.set(String(g.name).toLowerCase(), { id: g.id, name: g.name });
  }
  return map;
}
__name(listPermissionGroups, "listPermissionGroups");
function resolveGroups(catalog, names) {
  const resolved = [];
  const missing = [];
  for (const name of names) {
    const hit = catalog.get(String(name).toLowerCase());
    if (hit) resolved.push({ id: hit.id });
    else missing.push(name);
  }
  return { resolved, missing };
}
__name(resolveGroups, "resolveGroups");
async function resolveZone2(client, domain) {
  const { result } = await client.request(
    "GET",
    `/zones?name=${encodeURIComponent(String(domain).toLowerCase())}`
  );
  const zone = Array.isArray(result) && result[0] ? result[0] : null;
  return zone ? { id: zone.id, name: zone.name } : null;
}
__name(resolveZone2, "resolveZone");
async function mintScopedToken(client, opts = {}) {
  const {
    domain,
    preset = "dns-zone",
    extra_groups = [],
    ttl_seconds = DEFAULT_TTL_SECONDS,
    confirm_long = false,
    name,
    apply = false
  } = opts;
  if (!domain) throw new Error("mintScopedToken: domain is required \u2014 every minted token is confined to one zone.");
  const presetDef = TOKEN_PRESETS[preset];
  if (!presetDef) {
    throw new Error(
      `mintScopedToken: unknown preset "${preset}". Available: ${Object.keys(TOKEN_PRESETS).join(", ")}. There is deliberately no account-wide or super preset \u2014 mint down, never up.`
    );
  }
  let ttl = Number(ttl_seconds) > 0 ? Math.floor(Number(ttl_seconds)) : DEFAULT_TTL_SECONDS;
  if (ttl > MAX_TTL_SECONDS && confirm_long !== true) {
    return {
      action: "mint",
      apply: false,
      blocked: true,
      reason: `ttl_seconds ${ttl} exceeds the ${MAX_TTL_SECONDS}s (24h) cap. Pass confirm_long=true if a long-lived token is truly intended.`
    };
  }
  const zone = await resolveZone2(client, domain);
  if (!zone) {
    return { action: "mint", apply: false, blocked: true, reason: `Zone "${domain}" is not visible to the bootstrap token.` };
  }
  const catalog = await listPermissionGroups(client);
  const wanted = [...presetDef.groups, ...extra_groups];
  const { resolved, missing } = resolveGroups(catalog, wanted);
  if (missing.length) {
    return {
      action: "mint",
      apply: false,
      blocked: true,
      reason: `Permission group(s) not found by name: ${missing.join(", ")}.`,
      available_groups: [...catalog.values()].map((g) => g.name).sort()
    };
  }
  const expiresOn = new Date(Date.now() + ttl * 1e3).toISOString().replace(/\.\d{3}Z$/, "Z");
  const body = {
    name: "cfops " + (name ? String(name).replace(/^cfops\s*/i, "").slice(0, 80) : `${preset} ${zone.name} (auto-expires)`),
    policies: [
      {
        effect: "allow",
        resources: { [`com.cloudflare.api.account.zone.${zone.id}`]: "*" },
        permission_groups: resolved
      }
    ],
    expires_on: expiresOn
  };
  if (apply !== true) {
    return { action: "mint", apply: false, domain: zone.name, preset, ttl_seconds: ttl, expires_on: expiresOn, policy: body };
  }
  const { result } = await client.request("POST", "/user/tokens", body);
  return {
    action: "mint",
    apply: true,
    domain: zone.name,
    preset,
    id: result && result.id,
    expires_on: expiresOn,
    // Cloudflare returns the secret exactly once, here. It is NOT logged and
    // NOT audited — hand it to the agent that needed it and let it expire.
    token_value: result && result.value,
    secret: true,
    warning: "This value is shown ONCE. Do not log it. It expires automatically at expires_on."
  };
}
__name(mintScopedToken, "mintScopedToken");
async function listTokens(client) {
  const { result } = await client.request("GET", "/user/tokens?per_page=50");
  return (Array.isArray(result) ? result : []).map((t) => ({
    id: t.id,
    name: t.name,
    status: t.status,
    expires_on: t.expires_on || null,
    issued_by_cfops: /^cfops /.test(String(t.name || ""))
  }));
}
__name(listTokens, "listTokens");
async function revokeToken(client, tokenId, opts = {}) {
  const { apply = false } = opts;
  if (!tokenId) throw new Error("revokeToken: tokenId is required");
  if (apply !== true) {
    return { action: "revoke", apply: false, id: tokenId };
  }
  const { result } = await client.request("DELETE", `/user/tokens/${encodeURIComponent(tokenId)}`);
  return { action: "revoke", apply: true, id: tokenId, result };
}
__name(revokeToken, "revokeToken");
async function safeRequest(client, method, path) {
  try {
    return await client.request(method, path);
  } catch (err2) {
    return { result: null, error: err2 && err2.message || String(err2) };
  }
}
__name(safeRequest, "safeRequest");
async function whoServesDomain(client, domain) {
  if (!domain) throw new Error("whoServesDomain: domain is required");
  const host = String(domain).toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const labels = host.split(".");
  let zone = null;
  for (let i = 0; i < labels.length - 1 && !zone; i++) {
    const candidate = labels.slice(i).join(".");
    const { result } = await safeRequest(client, "GET", `/zones?name=${encodeURIComponent(candidate)}`);
    if (Array.isArray(result) && result[0]) zone = result[0];
  }
  if (!zone) {
    return { domain: host, zone: null, note: "No zone visible to this token matches this domain." };
  }
  const accountId = zone.account && zone.account.id;
  const report = {
    domain: host,
    zone: { id: zone.id, name: zone.name, status: zone.status, account: zone.account || null },
    worker_routes: [],
    worker_custom_domains: [],
    pages_projects: [],
    warnings: []
  };
  const routes = await safeRequest(client, "GET", `/zones/${zone.id}/workers/routes`);
  if (Array.isArray(routes.result)) {
    report.worker_routes = routes.result.map((r) => ({ pattern: r.pattern, script: r.script || null }));
  } else if (routes.error) {
    report.warnings.push(`workers/routes unreadable: ${routes.error}`);
  }
  if (accountId) {
    const domains = await safeRequest(client, "GET", `/accounts/${accountId}/workers/domains`);
    if (Array.isArray(domains.result)) {
      report.worker_custom_domains = domains.result.filter((d) => d.hostname === host || String(d.hostname || "").endsWith(`.${zone.name}`) || d.hostname === zone.name).map((d) => ({ hostname: d.hostname, service: d.service, environment: d.environment }));
    } else if (domains.error) {
      report.warnings.push(`workers/domains unreadable: ${domains.error}`);
    }
    const pages = await safeRequest(client, "GET", `/accounts/${accountId}/pages/projects`);
    if (Array.isArray(pages.result)) {
      report.pages_projects = pages.result.filter((p) => (p.domains || []).some((d) => d === host || d === zone.name || String(d).endsWith(`.${zone.name}`))).map((p) => ({ name: p.name, production_branch: p.production_branch, domains: p.domains || [] }));
    } else if (pages.error) {
      report.warnings.push(`pages/projects unreadable: ${pages.error}`);
    }
  }
  const claimants = report.worker_routes.length + report.worker_custom_domains.length + report.pages_projects.length;
  if (claimants === 0) report.warnings.push("Nothing claims this domain \u2014 it is served by DNS/origin only, or by products this token cannot read.");
  if (claimants > 1) report.warnings.push("MULTIPLE products claim this domain \u2014 the winner depends on Cloudflare precedence (custom domains beat routes). Verify which one you meant.");
  return report;
}
__name(whoServesDomain, "whoServesDomain");
async function accountDoctor(client, opts = {}) {
  const { expected_account_id } = opts;
  const verify = await safeRequest(client, "GET", "/user/tokens/verify");
  const accounts = await safeRequest(client, "GET", "/accounts?per_page=50");
  const zones = await safeRequest(client, "GET", "/zones?per_page=50");
  const accountMap = /* @__PURE__ */ new Map();
  if (Array.isArray(accounts.result)) {
    for (const a of accounts.result) accountMap.set(a.id, { id: a.id, name: a.name });
  }
  if (Array.isArray(zones.result)) {
    for (const z of zones.result) {
      const a = z && z.account;
      if (a && a.id && !accountMap.has(a.id)) accountMap.set(a.id, { id: a.id, name: a.name });
    }
  }
  const accountList = [...accountMap.values()];
  const tokenLive = verify.result && verify.result.status === "active" || Array.isArray(zones.result) || Array.isArray(accounts.result);
  const report = {
    token_status: tokenLive ? verify.result && verify.result.status ? verify.result.status : "active (oauth scope)" : verify.error || accounts.error || zones.error || "unknown",
    accounts_visible: accountList,
    expected_account_id: expected_account_id || null,
    expected_account_visible: expected_account_id ? accountList.some((a) => a.id === expected_account_id) : null,
    duplicate_pages_projects: [],
    warnings: []
  };
  if (expected_account_id && !report.expected_account_visible) {
    report.warnings.push(
      "The expected account is NOT visible to this token \u2014 deploys and API calls are going somewhere else. This is the classic wrong-token failure."
    );
  }
  if (accountList.length > 1) {
    const seen = /* @__PURE__ */ new Map();
    for (const a of accountList) {
      const pages = await safeRequest(client, "GET", `/accounts/${a.id}/pages/projects`);
      for (const p of Array.isArray(pages.result) ? pages.result : []) {
        const key2 = String(p.name).toLowerCase();
        if (!seen.has(key2)) seen.set(key2, []);
        seen.get(key2).push({ account: a.name, account_id: a.id, production_branch: p.production_branch });
      }
    }
    for (const [name, where] of seen) {
      if (where.length > 1) report.duplicate_pages_projects.push({ project: name, accounts: where });
    }
    if (report.duplicate_pages_projects.length) {
      report.warnings.push(
        "Same-name Pages project(s) exist in MORE THAN ONE account. A deploy with the wrong token lands on the decoy and reports success while production never updates."
      );
    }
  }
  return report;
}
__name(accountDoctor, "accountDoctor");
async function pagesBranchCheck(client, opts = {}) {
  const { account_id, project, git_branch } = opts;
  if (!account_id || !project) throw new Error("pagesBranchCheck: account_id and project are required");
  const { result } = await client.request(
    "GET",
    `/accounts/${encodeURIComponent(account_id)}/pages/projects/${encodeURIComponent(project)}`
  );
  const production_branch = result && result.production_branch;
  const report = {
    project,
    production_branch: production_branch || null,
    domains: result && result.domains || [],
    git_branch: git_branch || null,
    verdict: null
  };
  if (git_branch && production_branch) {
    report.verdict = git_branch === production_branch ? "match \u2014 this deploy will be PRODUCTION" : `MISMATCH \u2014 deploying "${git_branch}" lands on a PREVIEW; production only builds from "${production_branch}". Pass --branch=${production_branch} or change the project setting.`;
  }
  return report;
}
__name(pagesBranchCheck, "pagesBranchCheck");
var IDX_KEY = "fed:index";
var up = /* @__PURE__ */ __name((ns) => `fed:upstream:${ns}`, "up");
var NS_SEP = "__";
function cleanNs(ns) {
  return String(ns || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
}
__name(cleanNs, "cleanNs");
async function readIndex(env) {
  try {
    return JSON.parse(await env.CLOUDFLARE_OPS_OAUTH.get(IDX_KEY) || "[]");
  } catch {
    return [];
  }
}
__name(readIndex, "readIndex");
async function writeIndex(env, list) {
  await env.CLOUDFLARE_OPS_OAUTH.put(IDX_KEY, JSON.stringify([...new Set(list)]));
}
__name(writeIndex, "writeIndex");
async function getUpstream(env, ns) {
  try {
    return JSON.parse(await env.CLOUDFLARE_OPS_OAUTH.get(up(ns)));
  } catch {
    return null;
  }
}
__name(getUpstream, "getUpstream");
function validateUpstreamUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || ""));
  } catch {
    return "url must be a valid absolute URL";
  }
  if (u.protocol !== "https:") return "url must be https://";
  if (u.username || u.password) return "url must not embed credentials";
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    return `refusing non-public host: ${host}`;
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 169 && b === 254 || // link-local incl. 169.254.169.254 metadata
    a === 100 && b >= 64 && b <= 127) {
      return `refusing non-public address: ${host}`;
    }
  }
  if (host.includes(":")) {
    if (host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe80/.test(host) || host.includes("::ffff:")) {
      return `refusing non-public address: ${host}`;
    }
  }
  return null;
}
__name(validateUpstreamUrl, "validateUpstreamUrl");
async function addUpstream(env, { namespace, url, auth } = {}) {
  const ns = cleanNs(namespace);
  if (!ns) return { error: true, message: "namespace required (a-z0-9_-)" };
  const urlErr = validateUpstreamUrl(url);
  if (urlErr) return { error: true, message: urlErr };
  const record = { namespace: ns, url: String(url), auth: auth ? String(auth) : null, added_at: Date.now() };
  await env.CLOUDFLARE_OPS_OAUTH.put(up(ns), JSON.stringify(record));
  const idx = await readIndex(env);
  idx.push(ns);
  await writeIndex(env, idx);
  return { ok: true, namespace: ns, url: record.url, authed: !!record.auth };
}
__name(addUpstream, "addUpstream");
async function removeUpstream(env, namespace) {
  const ns = cleanNs(namespace);
  await env.CLOUDFLARE_OPS_OAUTH.delete(up(ns));
  await writeIndex(env, (await readIndex(env)).filter((x) => x !== ns));
  return { ok: true, removed: ns };
}
__name(removeUpstream, "removeUpstream");
async function listUpstreams(env) {
  const idx = await readIndex(env);
  const out = [];
  for (const ns of idx) {
    const r = await getUpstream(env, ns);
    if (r) out.push({ namespace: r.namespace, url: r.url, authed: !!r.auth });
  }
  return out;
}
__name(listUpstreams, "listUpstreams");
async function upstreamRpc(record, method, params) {
  try {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (record.auth) headers.authorization = /^Bearer\s/i.test(record.auth) ? record.auth : `Bearer ${record.auth}`;
    const res = await fetch(record.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params || {} })
    });
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    return JSON.parse(line ? line.slice(5).trim() : text);
  } catch {
    return null;
  }
}
__name(upstreamRpc, "upstreamRpc");
async function federatedTools(env) {
  const idx = await readIndex(env);
  const tools = [];
  for (const ns of idx) {
    const record = await getUpstream(env, ns);
    if (!record) continue;
    const resp = await upstreamRpc(record, "tools/list", {});
    const upstreamTools = resp && resp.result && resp.result.tools || [];
    for (const t of upstreamTools) {
      tools.push({
        ...t,
        name: `${ns}${NS_SEP}${t.name}`,
        description: `[${ns}] ${t.description || ""}`.slice(0, 1024)
      });
    }
  }
  return tools;
}
__name(federatedTools, "federatedTools");
function isFederated(name, namespaces) {
  const i = String(name).indexOf(NS_SEP);
  if (i < 0) return null;
  const ns = String(name).slice(0, i);
  return namespaces.includes(ns) ? { ns, tool: String(name).slice(i + NS_SEP.length) } : null;
}
__name(isFederated, "isFederated");
async function callFederated(env, ns, toolName, args) {
  const record = await getUpstream(env, ns);
  if (!record) return { error: `unknown federated namespace: ${ns}` };
  const resp = await upstreamRpc(record, "tools/call", { name: toolName, arguments: args || {} });
  if (!resp) return { error: `no/invalid response from upstream "${ns}"` };
  if (resp.error) return { error: `upstream "${ns}" error: ${resp.error.message || JSON.stringify(resp.error)}` };
  const content = resp.result && resp.result.content;
  if (Array.isArray(content) && content[0] && typeof content[0].text === "string") {
    try {
      return JSON.parse(content[0].text);
    } catch {
      return { text: content[0].text };
    }
  }
  return resp.result || {};
}
__name(callFederated, "callFederated");
var IDX_KEY2 = "policy:index";
var key = /* @__PURE__ */ __name((tool) => `policy:${tool}`, "key");
var VALID = /* @__PURE__ */ new Set(["allow", "approve", "block"]);
async function setPolicy(env, tool, mode) {
  const t = String(tool || "").trim();
  const m = String(mode || "").trim().toLowerCase();
  if (!t) return { error: true, message: "tool required" };
  if (!VALID.has(m)) return { error: true, message: "mode must be allow | approve | block" };
  await env.CLOUDFLARE_OPS_OAUTH.put(key(t), m);
  let idx = [];
  try {
    idx = JSON.parse(await env.CLOUDFLARE_OPS_OAUTH.get(IDX_KEY2) || "[]");
  } catch {
  }
  idx.push(t);
  await env.CLOUDFLARE_OPS_OAUTH.put(IDX_KEY2, JSON.stringify([...new Set(idx)]));
  return { ok: true, tool: t, mode: m };
}
__name(setPolicy, "setPolicy");
async function listPolicy(env) {
  let idx = [];
  try {
    idx = JSON.parse(await env.CLOUDFLARE_OPS_OAUTH.get(IDX_KEY2) || "[]");
  } catch {
  }
  const out = {};
  for (const t of idx) {
    const m = await env.CLOUDFLARE_OPS_OAUTH.get(key(t));
    if (m) out[t] = m;
  }
  return out;
}
__name(listPolicy, "listPolicy");
async function checkPolicy(env, tool, args) {
  let mode = "allow";
  try {
    mode = await env.CLOUDFLARE_OPS_OAUTH.get(key(tool)) || "allow";
  } catch {
  }
  if (mode === "block") return { allowed: false, mode, reason: `Tool "${tool}" is BLOCKED by policy.` };
  if (mode === "approve" && !(args && args._approved === true)) {
    return { allowed: false, mode, reason: `Tool "${tool}" requires approval \u2014 re-call with "_approved": true to proceed.` };
  }
  return { allowed: true, mode };
}
__name(checkPolicy, "checkPolicy");
var AUTH_URL = "https://dash.cloudflare.com/oauth2/auth";
var TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
var REVOKE_URL = "https://dash.cloudflare.com/oauth2/revoke";
var DEFAULT_SCOPES = ["zone.read", "dns.write", "email-routing-address.write", "email-routing-rule.write", "cache.purge", "challenge-widgets.write", "workers-scripts.write", "workers-routes.write", "workers-tail.read", "account-settings.read", "offline_access"];
var STATE_TTL_SECONDS = 600;
var REFRESH_SKEW_MS = 6e4;
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extraHeaders }
  });
}
__name(json, "json");
function requireOAuthEnv(env) {
  const missing = [];
  if (!env.CLOUDFLARE_OAUTH_CLIENT_ID) missing.push("CLOUDFLARE_OAUTH_CLIENT_ID");
  if (!env.CLOUDFLARE_OAUTH_CLIENT_SECRET) missing.push("CLOUDFLARE_OAUTH_CLIENT_SECRET");
  if (!env.CLOUDFLARE_OAUTH_REDIRECT_URI) missing.push("CLOUDFLARE_OAUTH_REDIRECT_URI");
  if (!env.CLOUDFLARE_OPS_OAUTH) missing.push("CLOUDFLARE_OPS_OAUTH KV binding");
  return missing;
}
__name(requireOAuthEnv, "requireOAuthEnv");
function cleanTenant(value) {
  return String(value || "default").trim().replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "default";
}
__name(cleanTenant, "cleanTenant");
function b64url(bytes) {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
__name(b64url, "b64url");
function randomToken(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}
__name(randomToken, "randomToken");
async function sha256Hex(value) {
  const digest2 = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value))));
  return Array.from(digest2, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex, "sha256Hex");
async function timingSafeEqual(left, right) {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(String(left))),
    crypto.subtle.digest("SHA-256", encoder.encode(String(right)))
  ]);
  if (typeof crypto.subtle.timingSafeEqual === "function") return crypto.subtle.timingSafeEqual(leftHash, rightHash);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}
__name(timingSafeEqual, "timingSafeEqual");
function bearerFromRequest(request) {
  const auth = request.headers.get("authorization") || "";
  const bearer = /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : "";
  let urlKey = "";
  try {
    urlKey = (new URL(request.url).searchParams.get("key") || "").trim();
  } catch {
  }
  return bearer || (request.headers.get("x-mcp-key") || "").trim() || urlKey;
}
__name(bearerFromRequest, "bearerFromRequest");
async function renderConnectedHtmlExact(origin, connectorKey, env) {
  if (!env.ASSETS) throw new Error("WT Connected UI asset binding is unavailable.");
  const assetResponse = await env.ASSETS.fetch(new Request(new URL("/WT-Connected.html", origin)));
  if (!assetResponse.ok) throw new Error("WT Connected UI asset could not be loaded.");
  let bundle = await assetResponse.text();
  const templatePattern = /(<script type="__bundler\/template">)([\s\S]*?)(<\/script>)/;
  if (!templatePattern.test(bundle)) throw new Error("WT Connected UI template payload is missing.");
  bundle = bundle.replace(templatePattern, (_match, open, encoded, close) => {
    let page2 = JSON.parse(encoded);
    page2 = page2.replace("<html><head>", '<html lang="en"><head>\n<title>Connected \u2014 Walrus Tusk // AMH</title>').replace(/\s*<a\s+href="https:\/\/cfops\.nothingunseen\.com"[\s\S]*?<\/a>/gi, "").replace(/\s*<a\s+href="https:\/\/nothingunseen\.com"[\s\S]*?<\/a>/gi, "").replaceAll('href="WT Landing.dc.html"', 'href="https://artificialmindhive.com/WalrusTooth"').replaceAll('href="WT Docs.dc.html"', 'href="https://artificialmindhive.com/wtdocs"').replaceAll('href="WT Agents.dc.html"', 'href="https://console.artificialmindhive.com/console"').replaceAll('href="WT FAQ.dc.html"', 'href="https://artificialmindhive.com/wtfaq"').replaceAll('href="AMH Agent Console.dc.html"', 'href="https://console.artificialmindhive.com/console"').replaceAll('href="WT Console Unlock.dc.html"', 'href="https://console.artificialmindhive.com/console"').replaceAll('href="/docs"', 'href="https://artificialmindhive.com/wtdocs"').replaceAll('href="/agents"', 'href="https://console.artificialmindhive.com/console"').replaceAll('href="/faq"', 'href="https://artificialmindhive.com/wtfaq"').replaceAll('href="/console"', 'href="https://console.artificialmindhive.com/console"').replaceAll('href="/"', 'href="https://artificialmindhive.com/WalrusTooth"').replace(/https:\/\/mcp\.artificialmindhive\.com\/mcp/gi, `${origin}/mcp`).replace(/https:\/\/cfops\.nothingunseen\.com\/mcp/gi, `${origin}/mcp`).replace(/https:\/\/cfops\.nothingunseen\.com/gi, origin).replace(/cfops_[A-Za-z0-9_-]+/g, connectorKey);
    return open + JSON.stringify(page2).replace(/</g, "\\u003c") + close;
  });
  return bundle.replace(/https:\/\/mcp\.artificialmindhive\.com\/mcp/gi, `${origin}/mcp`).replace(/https:\/\/cfops\.nothingunseen\.com\/mcp/gi, `${origin}/mcp`).replace(/https:\/\/cfops\.nothingunseen\.com/gi, origin).replace(/https:\/\/nothingunseen\.com/gi, "https://artificialmindhive.com").replace(/cfops_[A-Za-z0-9_-]+/g, connectorKey);
}
__name(renderConnectedHtmlExact, "renderConnectedHtmlExact");
function getOAuthScopes(env) {
  return String(env.CLOUDFLARE_OAUTH_SCOPES || DEFAULT_SCOPES.join(" ")).split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean);
}
__name(getOAuthScopes, "getOAuthScopes");
async function authorizeConnector(env, provided) {
  if (!provided) return { ok: false, reason: "missing_connector_key" };
  if (provided.startsWith(WTU_PREFIX)) return await wtuAuthorize(env, provided);
  if (env.MCP_ACCESS_KEY && await timingSafeEqual(provided, env.MCP_ACCESS_KEY)) {
    return { ok: true, mode: "admin", connectionId: null };
  }
  if (env.MCP_EXTRA_ADMIN_KEYS) {
    for (const k of String(env.MCP_EXTRA_ADMIN_KEYS).split(",").map((x) => x.trim()).filter(Boolean)) {
      if (await timingSafeEqual(provided, k)) return { ok: true, mode: "admin", connectionId: null };
    }
  }
  if (env.WALO_BOARD_KEY && await timingSafeEqual(provided, env.WALO_BOARD_KEY)) return { ok: true, mode: "admin", caller: "walo", connectionId: null };
  if (!env.CLOUDFLARE_OPS_OAUTH) return { ok: false, reason: "oauth_storage_unavailable" };
  const keyHash = await sha256Hex(provided);
  const raw = await env.CLOUDFLARE_OPS_OAUTH.get(`session:${keyHash}`);
  if (!raw) return { ok: false, reason: "invalid_connector_key" };
  const session = JSON.parse(raw);
  if (!session.connection_id) return { ok: false, reason: "invalid_connector_session" };
  const connection = await env.CLOUDFLARE_OPS_OAUTH.get(`connection:${session.connection_id}`);
  if (!connection) return { ok: false, reason: "connection_revoked" };
  return { ok: true, mode: "oauth", connectionId: session.connection_id, keyHash };
}
__name(authorizeConnector, "authorizeConnector");
async function checkRateLimit(env, authContext) {
  const limiter = env.RATE_LIMITER;
  if (!limiter || typeof limiter.limit !== "function") return { allowed: true };
  const isAdmin = authContext.mode === "admin";
  const who = authContext.keyHash || (isAdmin ? "admin" : "anon");
  const chosen = isAdmin && env.RATE_LIMITER_ADMIN && typeof env.RATE_LIMITER_ADMIN.limit === "function" ? env.RATE_LIMITER_ADMIN : limiter;
  try {
    const { success } = await chosen.limit({ key: who });
    if (!success) {
      return { allowed: false, limit: isAdmin ? "admin" : "per-key", retryAfter: 60, by: "binding" };
    }
  } catch {
  }
  return checkRateLimitDO(env, who, isAdmin);
}
__name(checkRateLimit, "checkRateLimit");
async function checkRateLimitDO(env, who, isAdmin) {
  const ns = env.RATE_LIMITER_DO;
  if (!ns || typeof ns.idFromName !== "function") return { allowed: true };
  const limit = Number(
    isAdmin ? env.RATE_LIMIT_ADMIN_PER_MIN || 600 : env.RATE_LIMIT_PER_MIN || 120
  );
  if (!Number.isFinite(limit) || limit <= 0) return { allowed: true };
  try {
    const stub = ns.get(ns.idFromName(who));
    const res = await stub.fetch(`https://rl.local/?limit=${limit}&period=60`);
    const out = await res.json();
    if (out && out.allowed === false) {
      return { allowed: false, limit, retryAfter: out.retryAfter || 60, by: "durable-object" };
    }
    return { allowed: true };
  } catch {
    return { allowed: true };
  }
}
__name(checkRateLimitDO, "checkRateLimitDO");
async function handleOAuthStart(request, env) {
  const missing = requireOAuthEnv(env);
  if (missing.length) return json({ ok: false, error: "oauth_not_configured", missing }, 503);
  const state = randomToken();
  const connectionId = randomToken(18);
  await env.CLOUDFLARE_OPS_OAUTH.put(`state:${state}`, JSON.stringify({
    connection_id: connectionId,
    created_at: Date.now()
  }), { expirationTtl: STATE_TTL_SECONDS });
  const auth = new URL(AUTH_URL);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("client_id", env.CLOUDFLARE_OAUTH_CLIENT_ID);
  auth.searchParams.set("redirect_uri", env.CLOUDFLARE_OAUTH_REDIRECT_URI);
  auth.searchParams.set("scope", getOAuthScopes(env).join(" "));
  auth.searchParams.set("state", state);
  return Response.redirect(auth.toString(), 302);
}
__name(handleOAuthStart, "handleOAuthStart");
async function handleOAuthCallback(request, env) {
  const missing = requireOAuthEnv(env);
  if (missing.length) return json({ ok: false, error: "oauth_not_configured", missing }, 503);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");
  if (oauthError) return json({ ok: false, error: "cloudflare_oauth_error", detail: oauthError }, 400);
  if (!code || !state) return json({ ok: false, error: "missing_code_or_state" }, 400);
  const raw = await env.CLOUDFLARE_OPS_OAUTH.get(`state:${state}`);
  if (!raw) return json({ ok: false, error: "bad_or_expired_state" }, 400);
  await env.CLOUDFLARE_OPS_OAUTH.delete(`state:${state}`);
  const pending = JSON.parse(raw);
  if (!pending.connection_id) return json({ ok: false, error: "invalid_oauth_state" }, 400);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: env.CLOUDFLARE_OAUTH_REDIRECT_URI,
    client_id: env.CLOUDFLARE_OAUTH_CLIENT_ID,
    client_secret: env.CLOUDFLARE_OAUTH_CLIENT_SECRET
  });
  const tokenResponse = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const tokenJson = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenJson.access_token) {
    return json({
      ok: false,
      error: "token_exchange_failed",
      status: tokenResponse.status,
      detail: tokenJson.error || tokenJson.error_description || "unknown"
    }, 502);
  }
  const now = Date.now();
  const record = {
    provider: "cloudflare",
    access_token: tokenJson.access_token,
    refresh_token: tokenJson.refresh_token || null,
    token_type: tokenJson.token_type || "bearer",
    scope: tokenJson.scope || getOAuthScopes(env).join(" "),
    expires_at: tokenJson.expires_in ? now + Number(tokenJson.expires_in) * 1e3 : null,
    connected_at: now,
    updated_at: now
  };
  await env.CLOUDFLARE_OPS_OAUTH.put(`connection:${pending.connection_id}`, JSON.stringify(record));
  const connectorKey = `cfops_${randomToken()}`;
  const keyHash = await sha256Hex(connectorKey);
  await env.CLOUDFLARE_OPS_OAUTH.put(`session:${keyHash}`, JSON.stringify({
    connection_id: pending.connection_id,
    provider: "cloudflare",
    created_at: now
  }));
  return new Response(await renderConnectedHtmlExact(url.origin, connectorKey, env), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, private",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com blob:; script-src 'unsafe-inline' 'unsafe-eval' blob:; img-src data: blob:; font-src data: blob: https://fonts.gstatic.com; frame-src blob:; worker-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "permissions-policy": "camera=(), microphone=(), geolocation=()"
    }
  });
}
__name(handleOAuthCallback, "handleOAuthCallback");
async function refreshConnection(env, connectionId, record) {
  if (!record.refresh_token) throw new Error("Cloudflare OAuth connection expired. Reconnect Cloudflare to continue.");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: record.refresh_token,
    client_id: env.CLOUDFLARE_OAUTH_CLIENT_ID,
    client_secret: env.CLOUDFLARE_OAUTH_CLIENT_SECRET
  });
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw new Error("Cloudflare OAuth refresh failed. Reconnect Cloudflare to continue.");
  }
  const now = Date.now();
  const updated = {
    ...record,
    access_token: payload.access_token,
    refresh_token: payload.refresh_token || record.refresh_token,
    token_type: payload.token_type || record.token_type || "bearer",
    scope: payload.scope || record.scope,
    expires_at: payload.expires_in ? now + Number(payload.expires_in) * 1e3 : null,
    updated_at: now
  };
  await env.CLOUDFLARE_OPS_OAUTH.put(`connection:${connectionId}`, JSON.stringify(updated));
  return updated;
}
__name(refreshConnection, "refreshConnection");
async function getOAuthAccessToken(env, authContext, legacyTenant = "default") {
  if (!authContext?.ok) return null;
  if (authContext.mode === "admin") {
    if (env.CLOUDFLARE_OPS_OAUTH) {
      const legacy = await env.CLOUDFLARE_OPS_OAUTH.get(`token:${cleanTenant(legacyTenant)}`);
      if (legacy) return JSON.parse(legacy).access_token || env.CLOUDFLARE_API_TOKEN || null;
    }
    return env.CLOUDFLARE_API_TOKEN || null;
  }
  if (!env.CLOUDFLARE_OPS_OAUTH || !authContext.connectionId) return null;
  const raw = await env.CLOUDFLARE_OPS_OAUTH.get(`connection:${authContext.connectionId}`);
  if (!raw) return null;
  let record = JSON.parse(raw);
  if (record.expires_at && record.expires_at <= Date.now() + REFRESH_SKEW_MS) {
    record = await refreshConnection(env, authContext.connectionId, record);
  }
  return record.access_token || null;
}
__name(getOAuthAccessToken, "getOAuthAccessToken");
async function handleOAuthStatus(request, env) {
  const authContext = await authorizeConnector(env, bearerFromRequest(request));
  if (!authContext.ok) {
    return json({ ok: false, connected: false, error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
  }
  if (authContext.mode === "admin") {
    return json({ ok: true, connected: !!env.CLOUDFLARE_API_TOKEN, mode: "admin" });
  }
  const raw = await env.CLOUDFLARE_OPS_OAUTH.get(`connection:${authContext.connectionId}`);
  if (!raw) return json({ ok: true, connected: false });
  const record = JSON.parse(raw);
  return json({
    ok: true,
    connected: true,
    provider: "cloudflare",
    scope: record.scope,
    expires_at: record.expires_at,
    connected_at: record.connected_at
  });
}
__name(handleOAuthStatus, "handleOAuthStatus");
async function handleOAuthRevoke(request, env) {
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const authContext = await authorizeConnector(env, bearerFromRequest(request));
  if (!authContext.ok || authContext.mode !== "oauth") {
    return json({ ok: false, error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
  }
  let raw = null;
  try {
    raw = await env.CLOUDFLARE_OPS_OAUTH.get(`connection:${authContext.connectionId}`);
  } catch {
  }
  let upstream = "skipped";
  if (raw) {
    try {
      const rec = JSON.parse(raw);
      const targets = [rec.refresh_token, rec.access_token].filter(Boolean);
      const results = await Promise.all(targets.map(
        (token) => fetch(REVOKE_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token,
            client_id: env.CLOUDFLARE_OAUTH_CLIENT_ID || "",
            client_secret: env.CLOUDFLARE_OAUTH_CLIENT_SECRET || ""
          })
        }).then((r) => r.ok).catch(() => false)
      ));
      upstream = results.length && results.every(Boolean) ? "revoked" : results.some(Boolean) ? "partial" : "failed";
    } catch {
      upstream = "failed";
    }
  }
  await Promise.all([
    env.CLOUDFLARE_OPS_OAUTH.delete(`session:${authContext.keyHash}`),
    env.CLOUDFLARE_OPS_OAUTH.delete(`connection:${authContext.connectionId}`)
  ]);
  return json({
    ok: true,
    disconnected: true,
    // Told honestly: if this is not "revoked", the grant may still exist at
    // Cloudflare and the user should also remove it in
    // Profile > Access Management > Connected Applications.
    cloudflare_grant: upstream,
    ...upstream === "revoked" ? {} : {
      note: "The Cloudflare-side grant could not be confirmed revoked. Remove it at https://dash.cloudflare.com/profile/access-management/authorization to be certain."
    }
  });
}
__name(handleOAuthRevoke, "handleOAuthRevoke");
function getOAuthConfigStatus(env, origin = "") {
  const missing = requireOAuthEnv(env);
  return {
    configured: missing.length === 0,
    missing,
    scopes: getOAuthScopes(env),
    routes: {
      start: `${origin}/oauth/cloudflare/start`,
      callback: `${origin}/oauth/cloudflare/callback`,
      status: `${origin}/oauth/cloudflare/status`,
      revoke: `${origin}/oauth/cloudflare/revoke`,
      mcp: `${origin}/mcp`
    }
  };
}
__name(getOAuthConfigStatus, "getOAuthConfigStatus");
var PAGES_ACCOUNT_ALIASES = { amh: "0ebf6d65d7a9ddccd41cba0b8bd1414c", doors: "1d5fae607a857fc56cd575763bf8f3bc", artificialmindhive: "a08783a0d3715df907ed5ccad38f0dcf" };
var PAGES_PROTECTED = /* @__PURE__ */ new Set(["artificialmindhive"]);
var PAGES_MAX_FILES = 2e3;
var PAGES_MAX_BYTES = 60 * 1024 * 1024;
var PAGES_MAX_FILE = 25 * 1024 * 1024;
var PAGES_TYPES = { html: "text/html", htm: "text/html", css: "text/css", js: "application/javascript", mjs: "application/javascript", json: "application/json", txt: "text/plain", xml: "application/xml", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", pdf: "application/pdf", webmanifest: "application/manifest+json", wasm: "application/wasm", glb: "model/gltf-binary" };
function pagesAccount(a) {
  const s = String(a || "").trim().toLowerCase();
  const id = PAGES_ACCOUNT_ALIASES[s] || s;
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("account must be amh, doors, artificialmindhive, or a 32-hex account id");
  return id;
}
function pagesProject(p) {
  const s = String(p || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,57}$/.test(s)) throw new Error("project must be a Pages project name");
  return s;
}
function pagesPath(p) {
  let s = String(p || "").replace(/\\/g, "/").replace(/^\.?\/+/, "");
  const parts = s.split("/");
  if (!s || s.includes("\0") || parts.some((x) => x === ".." || x === "." || x === "")) throw new Error(`bad file path: ${p}`);
  return "/" + parts.join("/");
}
function b64ToBytes(b64) {
  const bin = atob(String(b64 || "").replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  return btoa(s);
}
async function pagesHash(b64, ext) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(b64 + ext));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
async function pagesGetProject(client, account, project) {
  const { result } = await client.request("GET", `/accounts/${account}/pages/projects/${project}`);
  return result;
}
async function pagesListDeployments(client, args) {
  const account = pagesAccount(args.account), project = pagesProject(args.project);
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25);
  const p = await pagesGetProject(client, account, project);
  const { result } = await client.request("GET", `/accounts/${account}/pages/projects/${project}/deployments?per_page=${limit}`);
  const liveId = p.canonical_deployment && p.canonical_deployment.id;
  return {
    project,
    production_branch: p.production_branch,
    domains: p.domains,
    deployments: (result || []).map((d) => ({ id: d.id, short_id: d.short_id, environment: d.environment, branch: d.deployment_trigger && d.deployment_trigger.metadata && d.deployment_trigger.metadata.branch, url: d.url, created_on: d.created_on, status: d.latest_stage && d.latest_stage.status, serving_production: d.id === liveId }))
  };
}
async function pagesGetDeployment(client, args) {
  const account = pagesAccount(args.account), project = pagesProject(args.project);
  const id = String(args.deployment_id || "").trim();
  if (!/^[a-f0-9-]{8,40}$/.test(id)) throw new Error("deployment_id required");
  const { result: d } = await client.request("GET", `/accounts/${account}/pages/projects/${project}/deployments/${id}`);
  return { id: d.id, short_id: d.short_id, environment: d.environment, url: d.url, aliases: d.aliases, created_on: d.created_on, branch: d.deployment_trigger && d.deployment_trigger.metadata && d.deployment_trigger.metadata.branch, commit_message: d.deployment_trigger && d.deployment_trigger.metadata && d.deployment_trigger.metadata.commit_message, stages: (d.stages || []).map((s) => ({ name: s.name, status: s.status })), is_skipped: d.is_skipped };
}
async function pagesRollback(client, args) {
  const account = pagesAccount(args.account), project = pagesProject(args.project);
  const id = String(args.deployment_id || "").trim();
  if (!/^[a-f0-9-]{8,40}$/.test(id)) throw new Error("deployment_id required");
  const p = await pagesGetProject(client, account, project);
  const { result: d } = await client.request("GET", `/accounts/${account}/pages/projects/${project}/deployments/${id}`);
  const plan = { project, domains: p.domains, current_production: p.canonical_deployment && p.canonical_deployment.id, rollback_to: { id: d.id, url: d.url, created_on: d.created_on, environment: d.environment } };
  if (d.environment !== "production") return { error: "only a past PRODUCTION deployment can be rolled back to", ...plan };
  if (PAGES_PROTECTED.has(project) && !(args.force === true && String(args.note || "").trim())) return { error: `${project} is protected: pass force=true and a note saying why`, ...plan };
  if (args.apply !== true) return { dry_run: true, ...plan, next: "call again with apply=true" };
  const { result } = await client.request("POST", `/accounts/${account}/pages/projects/${project}/deployments/${id}/rollback`);
  return { applied: true, ...plan, new_deployment: result && { id: result.id, url: result.url } };
}
async function pagesDeploy(client, args) {
  const account = pagesAccount(args.account), project = pagesProject(args.project);
  const p = await pagesGetProject(client, account, project);
  const branch = String(args.branch || p.production_branch || "main").trim();
  if (!/^[A-Za-z0-9._/-]{1,80}$/.test(branch)) throw new Error("bad branch");
  const production = branch === p.production_branch;
  if (PAGES_PROTECTED.has(project) && production) return { error: `${project} production only ships through the amh-hive build (build-hive-dist + guard). Deploy to a preview branch here, or ask Austin/Claude.` };
  const files = Array.isArray(args.files) ? args.files : [];
  if (!files.length) throw new Error("files: give the COMPLETE built site as [{path, content}] or [{path, content_base64}] (a deploy replaces the whole site)");
  if (files.length > PAGES_MAX_FILES) throw new Error(`too many files (max ${PAGES_MAX_FILES})`);
  const entries = [];
  let total = 0;
  const special = {};
  for (const f of files) {
    const path = pagesPath(f.path);
    const bytes = f.content_base64 != null ? b64ToBytes(f.content_base64) : new TextEncoder().encode(String(f.content ?? ""));
    if (bytes.length > PAGES_MAX_FILE) throw new Error(`${path} is over 25 MiB`);
    total += bytes.length;
    if (path === "/_headers" || path === "/_redirects" || path === "/_routes.json") {
      special[path.slice(1)] = new TextDecoder().decode(bytes);
      continue;
    }
    if (path.startsWith("/functions/")) throw new Error("functions/ needs a build step; this tool uploads static files only");
    const ext = (path.match(/\.([a-z0-9]+)$/i) || [])[1] || "";
    const b64 = bytesToB64(bytes);
    entries.push({ path, b64, ext, size: bytes.length, type: PAGES_TYPES[ext.toLowerCase()] || "application/octet-stream" });
  }
  if (total > PAGES_MAX_BYTES) throw new Error("upload over 60 MiB; deploy big sites from a PC with wrangler");
  if (!entries.some((e) => e.path === "/index.html")) return { error: "no /index.html in files. A deploy replaces the WHOLE site, so send every file of the built site." };
  for (const e of entries) e.hash = await pagesHash(e.b64, e.ext);
  const plan = { project, account, branch, production, domains_affected: production ? p.domains : [], files: entries.length + Object.keys(special).length, bytes: total, special_files: Object.keys(special) };
  if (args.apply !== true) return { dry_run: true, ...plan, warning: production ? "PRODUCTION: this replaces the live site on " + (p.domains || []).join(", ") : "preview branch only", next: "call again with apply=true" };
  const { result: up2 } = await client.request("GET", `/accounts/${account}/pages/projects/${project}/upload-token`);
  const jwt = up2 && up2.jwt;
  if (!jwt) throw new Error("no upload token from Cloudflare");
  const assets = async (path, body) => {
    const r2 = await fetch(`https://api.cloudflare.com/client/v4/pages/assets/${path}`, { method: "POST", headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const j2 = await r2.json().catch(() => ({}));
    if (!j2.success) throw new Error(`pages assets/${path} failed: ${j2.errors && j2.errors[0] && j2.errors[0].message || r2.status}`);
    return j2.result;
  };
  const unique = [...new Map(entries.map((e) => [e.hash, e])).values()];
  const missing = new Set(await assets("check-missing", { hashes: unique.map((e) => e.hash) }));
  let batch = [], size = 0;
  const flush = async () => {
    if (batch.length) await assets("upload", batch);
    batch = [];
    size = 0;
  };
  for (const e of unique) {
    if (!missing.has(e.hash)) continue;
    if (batch.length >= 1e3 || size + e.b64.length > 40 * 1024 * 1024) await flush();
    batch.push({ key: e.hash, value: e.b64, metadata: { contentType: e.type }, base64: true });
    size += e.b64.length;
  }
  await flush();
  await assets("upsert-hashes", { hashes: unique.map((e) => e.hash) });
  const form = new FormData();
  form.append("manifest", JSON.stringify(Object.fromEntries(entries.map((e) => [e.path, e.hash]))));
  form.append("branch", branch);
  if (args.commit_message) form.append("commit_message", String(args.commit_message).slice(0, 380));
  if (args.commit_hash) form.append("commit_hash", String(args.commit_hash).slice(0, 64));
  form.append("commit_dirty", "true");
  for (const [name, text] of Object.entries(special)) form.append(name, new File([text], name, { type: "text/plain" }));
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/${project}/deployments`, { method: "POST", headers: { authorization: `Bearer ${client._token}` }, body: form });
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error(`create deployment failed: ${j.errors && j.errors[0] && j.errors[0].message || r.status}`);
  return { applied: true, ...plan, uploaded: missing.size, deployment: { id: j.result.id, url: j.result.url, environment: j.result.environment } };
}
async function wranglerDoctor(client, args, altClient) {
  const out = { accounts: {} };
  const base = client;
  for (const [alias, id] of Object.entries(PAGES_ACCOUNT_ALIASES)) {
    client = altClient && altClient(id) || base;
    try {
      const all = [];
      for (let page2 = 1; page2 <= 10; page2++) {
        const { result } = await client.request("GET", `/accounts/${id}/pages/projects?per_page=10&page=${page2}`);
        all.push(...result || []);
        if (!result || result.length < 10) break;
      }
      let workers = null;
      try {
        const { result } = await client.request("GET", `/accounts/${id}/workers/scripts`);
        workers = (result || []).map((w) => w.id);
      } catch (e) {
        workers = "unreadable: " + String(e.message || e).slice(0, 80);
      }
      out.accounts[alias] = { id, pages_projects: all.map((p) => ({ name: p.name, production_branch: p.production_branch, domains: p.domains })), workers };
    } catch (e) {
      out.accounts[alias] = { id, error: String(e.message || e).slice(0, 200) };
    }
  }
  if (args.project) {
    client = altClient && altClient(pagesAccount(args.account || "amh")) || base;
    try {
      const account = pagesAccount(args.account || "amh"), project = pagesProject(args.project);
      const p = await pagesGetProject(client, account, project);
      out.project = { name: project, production_branch: p.production_branch, domains: p.domains, live_deployment: p.canonical_deployment && { id: p.canonical_deployment.id, url: p.canonical_deployment.url, created_on: p.canonical_deployment.created_on }, latest: p.latest_deployment && { id: p.latest_deployment.id, env: p.latest_deployment.environment, created_on: p.latest_deployment.created_on } };
    } catch (e) {
      out.project = { error: String(e.message || e).slice(0, 200) };
    }
  }
  return out;
}
var PAGES_DEPLOY_TOOL_DEFS = [
  {
    name: "pages_deploy",
    description: "Deploy a COMPLETE built static site to a Cloudflare Pages project through the API (like `wrangler pages deploy`, no PC needed). Dry-run by default; apply=true uploads and deploys. branch = production branch goes LIVE; any other branch is a preview URL. A deploy replaces the whole site, so send every file. To change only a few files on a live site use pages_patch (or pass patch=true with edits [{path,find,replace}] here). Static only (no functions/). artificialmindhive production is refused.",
    inputSchema: { type: "object", properties: {
      account: { type: "string", description: "amh (pain2hustle1), doors (austinsdoors1), artificialmindhive, or an account id" },
      project: { type: "string" },
      branch: { type: "string", description: "default = production branch" },
      files: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string", description: "text file contents" }, content_base64: { type: "string", description: "binary file contents" } }, required: ["path"] } },
      commit_message: { type: "string" },
      commit_hash: { type: "string" },
      apply: { type: "boolean" }
    }, required: ["account", "project", "files"] }
  },
  {
    name: "pages_list_deployments",
    description: "List recent deployments of a Pages project, marking the one serving production. Read-only.",
    inputSchema: { type: "object", properties: { account: { type: "string" }, project: { type: "string" }, limit: { type: "number" } }, required: ["account", "project"] }
  },
  {
    name: "pages_get_deployment",
    description: "Details of one Pages deployment: url, branch, stages, commit message. Pass path (+ optional find) to read that file's RAW live text instead. Read-only.",
    inputSchema: { type: "object", properties: { account: { type: "string" }, project: { type: "string" }, deployment_id: { type: "string" } }, required: ["account", "project", "deployment_id"] }
  },
  {
    name: "pages_rollback",
    description: "Put a past production deployment back live. Dry-run by default; apply=true rolls back. artificialmindhive needs force=true plus a note.",
    inputSchema: { type: "object", properties: { account: { type: "string" }, project: { type: "string" }, deployment_id: { type: "string" }, apply: { type: "boolean" }, force: { type: "boolean" }, note: { type: "string" } }, required: ["account", "project", "deployment_id"] }
  },
  {
    name: "wrangler_doctor",
    description: "One-call health check: Pages projects (with production branch + domains) and Workers on both accounts, plus live vs latest deployment for one project. Read-only.",
    inputSchema: { type: "object", properties: { account: { type: "string" }, project: { type: "string" } } }
  }
];
var PATCH_MAX_FILES = 200;
async function pagesSpecialGet(env, account, project) {
  if (!env || !env.CLOUDFLARE_OPS_OAUTH) return null;
  return await env.CLOUDFLARE_OPS_OAUTH.get(`pages:special:${account}:${project}`, "json");
}
async function pagesSpecialPut(env, account, project, special) {
  if (!env || !env.CLOUDFLARE_OPS_OAUTH || !special || !Object.keys(special).length) return;
  await env.CLOUDFLARE_OPS_OAUTH.put(`pages:special:${account}:${project}`, JSON.stringify({ ...special, saved: (/* @__PURE__ */ new Date()).toISOString() }));
}
async function pagesFetchLiveFile(deployUrl, path) {
  const u = new URL(path, deployUrl);
  const res = await fetch(u.toString(), { redirect: "follow" });
  const landed = new URL(res.url || u.toString()).pathname.replace(/\/$/, "");
  const want = path.replace(/\.html$/, "").replace(/\/index$/, "").replace(/\/$/, "");
  if (res.status !== 200) throw new Error(`${path} returned ${res.status} on the live deployment`);
  if (landed !== want && landed !== path) throw new Error(`${path} redirected to ${landed}; read that path instead`);
  return new Uint8Array(await res.arrayBuffer());
}
function pagesJsonBlocks(html) {
  const out = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while (m = re.exec(html)) {
    const body = m[1].trim();
    if (!/^[\[{]/.test(body)) continue;
    try {
      JSON.parse(body);
      out.push({ ok: true });
    } catch (e) {
      out.push({ ok: false, error: String(e.message || e).slice(0, 140) });
    }
  }
  return out;
}
async function pagesHealth(deployUrl, worker) {
  const results = [];
  const checks = [...worker.expect_title ? [{ path: "/", status: 200, contains: `<title>${worker.expect_title}</title>` }] : [], ...worker.checks || []];
  for (const c of checks) {
    let got = null;
    for (let i = 0; i < 6; i++) {
      if (i) await new Promise((r) => setTimeout(r, 3e3));
      try {
        const res = await fetch(new URL(c.path, deployUrl).toString(), { redirect: "follow" });
        const body = await res.text();
        got = { path: c.path, status: res.status, ok: res.status === (c.status || 200) && (!c.contains || body.includes(c.contains)) };
      } catch (e) {
        got = { path: c.path, ok: false, error: String(e.message || e).slice(0, 100) };
      }
      if (got.ok) break;
    }
    results.push(got);
  }
  return { ok: results.length > 0 && results.every((x) => x.ok), results };
}
async function pagesReadFile(client, args) {
  const account = pagesAccount(args.account), project = pagesProject(args.project);
  const path = pagesPath(args.path);
  const p = await pagesGetProject(client, account, project);
  const live = p.canonical_deployment;
  if (!live || !live.url) return { error: "no live production deployment" };
  const text = new TextDecoder().decode(await pagesFetchLiveFile(live.url, path));
  const out = { project, path, live_deployment: live.id, bytes: text.length };
  const find = args.find != null ? String(args.find) : "";
  if (find) {
    const around = Math.min(Math.max(Number(args.around) || 300, 0), 4e3);
    const hits = [];
    let i = text.indexOf(find);
    while (i !== -1 && hits.length < 10) {
      hits.push({ at: i, snippet: text.slice(Math.max(0, i - around), i + find.length + around) });
      i = text.indexOf(find, i + 1);
    }
    let n = 0, j = text.indexOf(find);
    while (j !== -1) {
      n++;
      j = text.indexOf(find, j + 1);
    }
    return { ...out, find, occurrences: n, hits };
  }
  const offset = Math.max(Number(args.offset) || 0, 0), length = Math.min(Math.max(Number(args.length) || 2e4, 1), 6e4);
  return { ...out, offset, length, more: offset + length < text.length, content: text.slice(offset, offset + length) };
}
async function pagesPatch(client, args, env, actor) {
  const account = pagesAccount(args.account), project = pagesProject(args.project);
  const p = await pagesGetProject(client, account, project);
  const branch = String(args.branch || p.production_branch || "main").trim();
  if (!/^[A-Za-z0-9._/-]{1,80}$/.test(branch)) throw new Error("bad branch");
  const production = branch === p.production_branch;
  const live = p.canonical_deployment;
  if (!live || !live.id) return { error: "project has no live production deployment to patch onto" };
  const { result: base } = await client.request("GET", `/accounts/${account}/pages/projects/${project}/deployments/${live.id}`);
  let worker = null;
  if (base.uses_functions || PAGES_PROTECTED.has(project)) {
    worker = env && env.CLOUDFLARE_OPS_OAUTH ? await env.CLOUDFLARE_OPS_OAUTH.get(`pages:worker:${account}:${project}`, "json") : null;
    if (!worker || !worker.bundle_b64) return { error: `${project} runs server code and the hub has no saved worker bundle for it, so it can't be patched in place. On a Walrus Tusk user key, run site_autodeploy once (deploys the site from its GitHub repo on every merge), then change it with repo_commit_push + repo_open_pr + repo_merge_pr.` };
    const known = [worker.for_deployment, ...worker.deployments || []];
    if (!known.includes(live.id)) return { error: `${project} live deployment (${live.id.slice(0, 8)}) is not the one the saved worker bundle belongs to (${String(worker.for_deployment).slice(0, 8)}). Someone deployed outside the hub; the owner must refresh it (npm run deploy in amh-hive). Nothing deployed.` };
  }
  const manifest = { ...base.files || {} };
  if (!Object.keys(manifest).length) return { error: "Cloudflare returned an empty file list for the live deployment; refusing to patch" };
  const files = Array.isArray(args.files) ? args.files.slice() : [];
  const editLog = [];
  const edits = Array.isArray(args.edits) ? args.edits : [];
  if (edits.length) {
    const byPath = /* @__PURE__ */ new Map();
    for (const e of edits) {
      const ep = pagesPath(e.path);
      if (!byPath.has(ep)) byPath.set(ep, []);
      byPath.get(ep).push(e);
    }
    for (const [ep, list] of byPath) {
      if (!manifest[ep]) throw new Error(`${ep} is not in the live site; send it in files to add it`);
      let text = new TextDecoder().decode(await pagesFetchLiveFile(base.url, ep));
      for (const e of list) {
        const find = String(e.find ?? ""), repl = String(e.replace ?? "");
        if (!find) throw new Error("each edit needs find (exact text from the live file)");
        let n = 0, k = text.indexOf(find);
        while (k !== -1) {
          n++;
          k = text.indexOf(find, k + find.length);
        }
        const want = e.count != null ? Number(e.count) : 1;
        if (n !== want) throw new Error(`${ep}: find text occurs ${n} time(s), expected ${want}. Use pages_read_file with find to see the exact live text.`);
        text = text.split(find).join(repl);
        editLog.push({ path: ep, occurrences: n, find_chars: find.length, replace_chars: repl.length });
      }
      if (/\.html?$/i.test(ep)) {
        const before = new TextDecoder().decode(await pagesFetchLiveFile(base.url, ep));
        const broke = pagesJsonBlocks(before).filter((b) => b.ok).length - pagesJsonBlocks(text).filter((b) => b.ok).length;
        if (broke > 0) {
          const bad = pagesJsonBlocks(text).filter((b) => !b.ok).map((b) => b.error).slice(0, 3);
          throw new Error(`${ep}: this edit breaks ${broke} JSON block(s) in <script> tags (e.g. a widget config). Nothing deployed. ${bad.join(" | ")}`);
        }
      }
      files.push({ path: ep, content: text });
    }
  }
  const deletes = (Array.isArray(args.delete) ? args.delete : []).map(pagesPath);
  if (!files.length && !deletes.length) throw new Error("give edits [{path, find, replace}] (best) or files [{path, content}] with ONLY the changed files");
  if (files.length > PATCH_MAX_FILES) throw new Error(`too many files for a patch (max ${PATCH_MAX_FILES}); use pages_deploy for a full site`);
  const stored = await pagesSpecialGet(env, account, project);
  const special = {};
  for (const k of ["_redirects", "_headers", "_routes.json"]) if (stored && typeof stored[k] === "string") special[k] = stored[k];
  let specialFromArgs = false;
  const entries = [];
  let total = 0;
  for (const f of files) {
    const path = pagesPath(f.path);
    const bytes = f.content_base64 != null ? b64ToBytes(f.content_base64) : new TextEncoder().encode(String(f.content ?? ""));
    if (bytes.length > PAGES_MAX_FILE) throw new Error(`${path} is over 25 MiB`);
    total += bytes.length;
    if (path === "/_headers" || path === "/_redirects" || path === "/_routes.json") {
      special[path.slice(1)] = new TextDecoder().decode(bytes);
      specialFromArgs = true;
      continue;
    }
    if (path.startsWith("/functions/") || path.startsWith("/_worker")) throw new Error("functions/_worker need a build step; patch static files only");
    const ext = (path.match(/\.([a-z0-9]+)$/i) || [])[1] || "";
    const b64 = bytesToB64(bytes);
    entries.push({ path, b64, ext, size: bytes.length, type: PAGES_TYPES[ext.toLowerCase()] || "application/octet-stream", hash: await pagesHash(b64, ext) });
  }
  if (total > PAGES_MAX_BYTES) throw new Error("patch over 60 MiB");
  if (!special._redirects && !special._headers && args.no_redirects !== true) {
    return { error: `the hub has no saved _redirects/_headers for ${project}, and Cloudflare doesn't return them. Fix (once per site): if the site's source is on GitHub, read its _redirects and _headers with repo_read and save them with pages_special_files (or include them in files). If you're not sure, ask the user. If the site has neither file, pass no_redirects=true.` };
  }
  const changed = entries.map((e) => ({ path: e.path, action: manifest[e.path] ? manifest[e.path] === e.hash ? "same" : "replace" : "add", bytes: e.size }));
  const missingDeletes = deletes.filter((d) => !manifest[d]);
  const plan = {
    project,
    account,
    branch,
    production,
    domains_affected: production ? p.domains : [],
    base_deployment: live.id,
    live_files: Object.keys(base.files || {}).length,
    changed,
    edits: editLog,
    deleted: deletes.filter((d) => manifest[d]),
    delete_not_found: missingDeletes,
    special_files: Object.keys(special),
    special_source: specialFromArgs ? "sent in this call" : "hub saved copy",
    rollback_hint: { tool: "pages_rollback", deployment_id: live.id }
  };
  if (args.apply !== true) return { dry_run: true, ...plan, warning: production ? "PRODUCTION: only the files above change on " + (p.domains || []).join(", ") : "preview branch only", next: "call again with apply=true" };
  for (const e of entries) manifest[e.path] = e.hash;
  for (const d of deletes) delete manifest[d];
  const { result: up2 } = await client.request("GET", `/accounts/${account}/pages/projects/${project}/upload-token`);
  const jwt = up2 && up2.jwt;
  if (!jwt) throw new Error("no upload token from Cloudflare");
  const assets = async (path, body) => {
    const r2 = await fetch(`https://api.cloudflare.com/client/v4/pages/assets/${path}`, { method: "POST", headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const j2 = await r2.json().catch(() => ({}));
    if (!j2.success) throw new Error(`pages assets/${path} failed: ${j2.errors && j2.errors[0] && j2.errors[0].message || r2.status}`);
    return j2.result;
  };
  if (entries.length) {
    const unique = [...new Map(entries.map((e) => [e.hash, e])).values()];
    const missing = new Set(await assets("check-missing", { hashes: unique.map((e) => e.hash) }));
    const batch = unique.filter((e) => missing.has(e.hash)).map((e) => ({ key: e.hash, value: e.b64, metadata: { contentType: e.type }, base64: true }));
    if (batch.length) await assets("upload", batch);
    await assets("upsert-hashes", { hashes: unique.map((e) => e.hash) });
  }
  const form = new FormData();
  form.append("manifest", JSON.stringify(manifest));
  form.append("branch", branch);
  form.append("commit_message", String(args.commit_message || `patch: ${changed.map((c) => c.path).join(", ")}`).slice(0, 380));
  if (args.commit_hash) form.append("commit_hash", String(args.commit_hash).slice(0, 64));
  form.append("commit_dirty", "true");
  for (const [name, text] of Object.entries(special)) form.append(name, new File([text], name, { type: "text/plain" }));
  if (worker) {
    form.append("_worker.bundle", new File([b64ToBytes(worker.bundle_b64)], "_worker.bundle"));
    if (worker.routes) form.append("_routes.json", new File([worker.routes], "_routes.json"));
    for (const [name, part] of Object.entries(worker.extra || {})) {
      if (part.file) form.append(name, new File([b64ToBytes(part.b64)], name));
      else form.append(name, new TextDecoder().decode(b64ToBytes(part.b64)));
    }
  }
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/${project}/deployments`, { method: "POST", headers: { authorization: `Bearer ${client._token}` }, body: form });
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error(`create deployment failed: ${j.errors && j.errors[0] && j.errors[0].message || r.status}`);
  if (specialFromArgs) await pagesSpecialPut(env, account, project, special);
  if (worker && production) {
    const health = await pagesHealth(j.result.url, worker);
    if (!health.ok) {
      let rolled = null;
      try {
        await client.request("POST", `/accounts/${account}/pages/projects/${project}/deployments/${live.id}/rollback`);
        rolled = live.id;
      } catch (e) {
        rolled = "ROLLBACK FAILED: " + String(e.message || e).slice(0, 120);
      }
      return { error: "health check failed after deploy; rolled back automatically", rolled_back_to: rolled, health, deployment: { id: j.result.id, url: j.result.url } };
    }
    worker.deployments = [.../* @__PURE__ */ new Set([...worker.deployments || [], worker.for_deployment, j.result.id])].slice(-50);
    worker.for_deployment = j.result.id;
    worker.updated_by_patch = (/* @__PURE__ */ new Date()).toISOString();
    await env.CLOUDFLARE_OPS_OAUTH.put(`pages:worker:${account}:${project}`, JSON.stringify(worker));
    plan.health = health;
  }
  const checks = [];
  for (const e of entries.slice(0, 10)) {
    try {
      const u = new URL(e.path, j.result.url);
      let res, ok2 = false;
      for (let i = 0; i < 5 && !ok2; i++) {
        if (i) await new Promise((r2) => setTimeout(r2, 3e3));
        res = await fetch(u.toString(), { redirect: "follow" });
        ok2 = res.status === 200 && await pagesHash(bytesToB64(new Uint8Array(await res.arrayBuffer())), e.ext) === e.hash;
      }
      checks.push({ path: e.path, status: res.status, matches: ok2 });
    } catch (err2) {
      checks.push({ path: e.path, error: String(err2.message || err2).slice(0, 120) });
    }
  }
  if (env && env.CLOUDFLARE_OPS_OAUTH) {
    await env.CLOUDFLARE_OPS_OAUTH.put(`patchlog:${project}:${Date.now()}`, JSON.stringify({ account, project, branch, base: live.id, deployment: j.result.id, changed, deleted: plan.deleted, actor: actor || "unknown", at: (/* @__PURE__ */ new Date()).toISOString() }), { expirationTtl: 60 * 60 * 24 * 90 });
  }
  return { applied: true, ...plan, deployment: { id: j.result.id, url: j.result.url, environment: j.result.environment }, checks, note: "Checks hit the deployment URL. The custom domain can take ~30s to show it." };
}
async function pagesSaveSpecial(client, args, env) {
  const account = pagesAccount(args.account), project = pagesProject(args.project);
  await pagesGetProject(client, account, project);
  const special = {};
  for (const k of ["_redirects", "_headers", "_routes.json"]) if (typeof args[k] === "string") special[k] = args[k];
  if (!Object.keys(special).length) {
    const cur = await pagesSpecialGet(env, account, project);
    return { project, saved: cur ? Object.keys(cur).filter((k) => k !== "saved") : [], saved_at: cur && cur.saved, ...cur || {} };
  }
  await pagesSpecialPut(env, account, project, special);
  return { ok: true, project, saved: Object.keys(special) };
}
var PAGES_PATCH_TOOL_DEFS = [
  {
    name: "pages_read_file",
    description: "Read the RAW text of one file exactly as the live production deployment serves it (no summarizer, no proxy). Use find to get the exact snippet(s) around a string; else returns content in chunks (offset/length). Read-only.",
    inputSchema: { type: "object", properties: { account: { type: "string" }, project: { type: "string" }, path: { type: "string", description: "e.g. insights.html" }, find: { type: "string" }, around: { type: "number", description: "chars of context each side (default 300)" }, offset: { type: "number" }, length: { type: "number" } }, required: ["account", "project", "path"] }
  },
  {
    name: "pages_patch",
    description: "Change ONLY a few files on a live Pages site (no PC, no full file set). Best: edits [{path, find, replace}] \u2014 the hub fetches the live file, replaces the exact text (must match once), and deploys. Or files [{path, content}] for whole changed files. The hub copies the live deployment's file list, swaps in the changes (and removes any in delete), keeps _redirects/_headers, and deploys. Every other file stays exactly as live. Dry-run by default; apply=true deploys. branch = production branch goes LIVE, any other = preview. Returns rollback_hint. Sites with server code (artificialmindhive) re-attach the owner-saved worker bundle and get a title + API health check after deploy, with automatic rollback on failure.",
    inputSchema: { type: "object", properties: {
      account: { type: "string", description: "amh (pain2hustle1), doors (austinsdoors1), or artificialmindhive" },
      project: { type: "string" },
      branch: { type: "string", description: "default = production branch (LIVE)" },
      edits: { type: "array", description: "exact find/replace on live files", items: { type: "object", properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" }, count: { type: "number", description: "expected matches, default 1" } }, required: ["path", "find", "replace"] } },
      files: { type: "array", description: "ONLY the changed/new files", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, content_base64: { type: "string" } }, required: ["path"] } },
      delete: { type: "array", items: { type: "string" }, description: "paths to remove from the site" },
      commit_message: { type: "string" },
      apply: { type: "boolean" },
      no_redirects: { type: "boolean" }
    }, required: ["account", "project"] }
  },
  {
    name: "pages_special_files",
    description: "Read (no args besides account/project) or save the hub's copy of a project's _redirects/_headers, which pages_patch re-sends on every patch.",
    inputSchema: { type: "object", properties: { account: { type: "string" }, project: { type: "string" }, _redirects: { type: "string" }, _headers: { type: "string" } }, required: ["account", "project"] }
  }
];
var GH_OWNERS = ["pain2hustle", "pain2hustle1"];
var GH_BRANCH_RE = /^(grok|agent)\/[A-Za-z0-9._-]{1,60}$/;
var GH_MAX_FILES = 100;
var GH_MAX_BYTES = 20 * 1024 * 1024;
async function gh(env, method, path, body, accept) {
  if (!env.GITHUB_TOKEN) throw new Error("no GitHub token: add one at /setup");
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: accept || "application/vnd.github+json", "user-agent": "amh-cfops-hub", "x-github-api-version": "2022-11-28", ...body ? { "content-type": "application/json" } : {} },
    body: body ? JSON.stringify(body) : void 0
  });
  if (accept && accept.includes("raw") && r.ok) return await r.arrayBuffer();
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(`GitHub ${method} ${path.split("?")[0]}: ${r.status} ${j.message || ""}`.trim());
    e.status = r.status;
    throw e;
  }
  return j;
}
function ghOwners(env) {
  return env && env.GH_OWNERS_OVERRIDE || GH_OWNERS;
}
function ghRepo(repo, env) {
  const OWNERS = ghOwners(env);
  const s = String(repo || "").trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  const name = s.includes("/") ? s.split("/") : [OWNERS[0], s];
  const owner = OWNERS.find((o) => o.toLowerCase() === name[0].toLowerCase());
  if (!owner || !/^[A-Za-z0-9._-]{1,100}$/.test(name[1])) throw new Error(`repo must be ${OWNERS.join(" or ")}/<name>`);
  return `${owner}/${name[1]}`;
}
function ghPath(p) {
  const s = String(p || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (s.split("/").some((x) => x === ".." || x === ".")) throw new Error(`bad path: ${p}`);
  return s;
}
function ghWritable(path) {
  if (/^\.github(\/|$)/i.test(path)) throw new Error(`${path}: .github/ is off-limits (workflows run with secrets)`);
  return path;
}
var ghEnc = (s) => s.split("/").map(encodeURIComponent).join("/");
async function ghRepoList(env, args) {
  const out = [];
  for (let page2 = 1; page2 <= 5; page2++) {
    const r = await gh(env, "GET", `/user/repos?per_page=100&page=${page2}&affiliation=owner,collaborator&sort=pushed`);
    out.push(...r);
    if (r.length < 100) break;
  }
  const q = String(args.q || "").toLowerCase();
  const OWNERS = ghOwners(env).map((o) => o.toLowerCase());
  return { owners: ghOwners(env), repos: out.filter((r) => OWNERS.includes(r.owner.login.toLowerCase()) && (!q || (r.name + " " + (r.description || "")).toLowerCase().includes(q))).map((r) => ({ repo: r.full_name, private: r.private, default_branch: r.default_branch, pushed_at: r.pushed_at, description: r.description, url: r.html_url })) };
}
async function ghRead(env, args) {
  const repo = ghRepo(args.repo, env), path = ghPath(args.path || "");
  const ref = args.ref ? `?ref=${encodeURIComponent(String(args.ref))}` : "";
  const meta = await gh(env, "GET", `/repos/${repo}/contents/${ghEnc(path)}${ref}`);
  if (Array.isArray(meta)) return { repo, path: path || "/", ref: args.ref || "default", entries: meta.map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size })) };
  const buf = await gh(env, "GET", `/repos/${repo}/contents/${ghEnc(path)}${ref}`, null, "application/vnd.github.raw");
  const text = new TextDecoder().decode(buf);
  const out = { repo, path, ref: args.ref || "default", sha: meta.sha, bytes: buf.byteLength };
  const find = args.find != null ? String(args.find) : "";
  if (find) {
    const around = Math.min(Math.max(Number(args.around) || 300, 0), 4e3), hits = [];
    let i = text.indexOf(find), n = 0;
    while (i !== -1) {
      n++;
      if (hits.length < 10) hits.push({ at: i, snippet: text.slice(Math.max(0, i - around), i + find.length + around) });
      i = text.indexOf(find, i + 1);
    }
    return { ...out, find, occurrences: n, hits };
  }
  const offset = Math.max(Number(args.offset) || 0, 0), length = Math.min(Math.max(Number(args.length) || 2e4, 1), 6e4);
  return { ...out, offset, length, more: offset + length < text.length, content: text.slice(offset, offset + length) };
}
async function ghSearch(env, args) {
  const repo = ghRepo(args.repo, env), q = String(args.query || "").trim();
  if (!q) throw new Error("query required");
  const r = await gh(env, "GET", `/search/code?per_page=20&q=${encodeURIComponent(q + " repo:" + repo)}`);
  return { repo, query: q, total: r.total_count, results: (r.items || []).map((x) => ({ path: x.path, url: x.html_url })) };
}
async function ghCommitPush(env, args, actor) {
  const repo = ghRepo(args.repo, env), branch = String(args.branch || "").trim();
  if (!GH_BRANCH_RE.test(branch)) throw new Error("branch must be grok/<name> or agent/<name>");
  const message = String(args.message || "").trim();
  if (!message) throw new Error("message required");
  const files = Array.isArray(args.files) ? args.files : [];
  const edits = Array.isArray(args.edits) ? args.edits : [];
  if (!files.length && !edits.length) throw new Error("files [{path, content}] and/or edits [{path, find, replace}] required");
  if (files.length + edits.length > GH_MAX_FILES) throw new Error(`max ${GH_MAX_FILES} files per commit`);
  const info = await gh(env, "GET", `/repos/${repo}`);
  if (branch === info.default_branch) throw new Error("refused: that is the default branch");
  let created = false, headSha;
  try {
    headSha = (await gh(env, "GET", `/repos/${repo}/git/ref/heads/${ghEnc(branch)}`)).object.sha;
  } catch (e) {
    if (e.status !== 404) throw e;
    headSha = (await gh(env, "GET", `/repos/${repo}/git/ref/heads/${ghEnc(info.default_branch)}`)).object.sha;
    created = true;
  }
  const headCommit = await gh(env, "GET", `/repos/${repo}/git/commits/${headSha}`);
  const tree = [], log = [];
  let total = 0;
  const readAt = async (p) => new TextDecoder().decode(await gh(env, "GET", `/repos/${repo}/contents/${ghEnc(p)}?ref=${headSha}`, null, "application/vnd.github.raw"));
  const byPath = /* @__PURE__ */ new Map();
  for (const e of edits) {
    const p = ghWritable(ghPath(e.path));
    if (!byPath.has(p)) byPath.set(p, []);
    byPath.get(p).push(e);
  }
  for (const [p, list] of byPath) {
    let text = await readAt(p);
    for (const e of list) {
      const find = String(e.find ?? ""), repl = String(e.replace ?? "");
      if (!find) throw new Error("each edit needs find");
      let n = 0, k = text.indexOf(find);
      while (k !== -1) {
        n++;
        k = text.indexOf(find, k + find.length);
      }
      const want = e.count != null ? Number(e.count) : 1;
      if (n !== want) throw new Error(`${p}: find occurs ${n} time(s), expected ${want}. Use repo_read with find to see the exact text.`);
      text = text.split(find).join(repl);
    }
    files.push({ path: p, content: text });
  }
  for (const f of files) {
    const p = ghWritable(ghPath(f.path));
    if (!p) throw new Error("empty path");
    if (f.delete === true) {
      tree.push({ path: p, mode: "100644", type: "blob", sha: null });
      log.push({ path: p, action: "delete" });
      continue;
    }
    const b64 = f.encoding === "base64" || f.content_base64 != null;
    const content = String(f.content_base64 ?? f.content ?? "");
    total += content.length;
    if (total > GH_MAX_BYTES) throw new Error("commit over 20 MB");
    const blob = await gh(env, "POST", `/repos/${repo}/git/blobs`, { content, encoding: b64 ? "base64" : "utf-8" });
    tree.push({ path: p, mode: "100644", type: "blob", sha: blob.sha });
    log.push({ path: p, action: "write", bytes: content.length });
  }
  const newTree = await gh(env, "POST", `/repos/${repo}/git/trees`, { base_tree: headCommit.tree.sha, tree });
  const author = { name: String(args.author || "AMH agent").slice(0, 80), email: "agents@artificialmindhive.com", date: (/* @__PURE__ */ new Date()).toISOString() };
  const commit = await gh(env, "POST", `/repos/${repo}/git/commits`, { message: `${message}

via cfops hub (${actor || "agent"})`, tree: newTree.sha, parents: [headSha], author });
  if (created) await gh(env, "POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
  else await gh(env, "PATCH", `/repos/${repo}/git/refs/heads/${ghEnc(branch)}`, { sha: commit.sha, force: false });
  return { ok: true, repo, branch, created_branch: created, commit: commit.sha.slice(0, 7), files: log, url: `https://github.com/${repo}/tree/${branch}`, compare: `https://github.com/${repo}/compare/${info.default_branch}...${branch}` };
}
async function ghOpenPr(env, args) {
  const repo = ghRepo(args.repo, env), branch = String(args.branch || "").trim();
  if (!GH_BRANCH_RE.test(branch)) throw new Error("branch must be grok/<name> or agent/<name>");
  const info = await gh(env, "GET", `/repos/${repo}`);
  const open = await gh(env, "GET", `/repos/${repo}/pulls?state=open&head=${repo.split("/")[0]}:${encodeURIComponent(branch)}`);
  if (open.length) return { ok: true, existing: true, number: open[0].number, url: open[0].html_url };
  const pr = await gh(env, "POST", `/repos/${repo}/pulls`, { title: String(args.title || branch).slice(0, 200), head: branch, base: info.default_branch, body: String(args.body || "Opened by an agent through the Walrus Tusk MCP hub. Review and merge.").slice(0, 2e4) });
  return { ok: true, number: pr.number, url: pr.html_url };
}
async function ghMergePr(env, args) {
  const repo = ghRepo(args.repo, env);
  let num = Number(args.number) || 0;
  if (!num && args.branch) {
    const open = await gh(env, "GET", `/repos/${repo}/pulls?state=open&head=${repo.split("/")[0]}:${encodeURIComponent(String(args.branch))}`);
    if (!open.length) throw new Error("no open PR for that branch; repo_open_pr first");
    num = open[0].number;
  }
  if (!num) throw new Error("number or branch required");
  const pr = await gh(env, "GET", `/repos/${repo}/pulls/${num}`);
  if (!GH_BRANCH_RE.test(pr.head.ref) || pr.head.repo.full_name !== repo) throw new Error("only grok/* or agent/* PRs from this repo can be merged here");
  const files = await gh(env, "GET", `/repos/${repo}/pulls/${num}/files?per_page=100`);
  const wf = files.filter((x) => /^\.github(\/|$)/i.test(x.filename));
  if (wf.length) throw new Error("PR touches .github/; Austin must merge it himself");
  const m = await gh(env, "PUT", `/repos/${repo}/pulls/${num}/merge`, { merge_method: "merge", commit_title: `Merge #${num}: ${pr.title}`.slice(0, 200) });
  return { ok: true, repo, number: num, merged: m.merged, sha: (m.sha || "").slice(0, 7), into: pr.base.ref, files: files.map((x) => x.filename).slice(0, 50) };
}
var GITHUB_TOOL_DEFS = [
  {
    name: "repo_list",
    description: "List Austin's GitHub repos (pain2hustle/* and pain2hustle1/*): default branch, last push, private flag. Optional q filters by name/description. No PC needed.",
    inputSchema: { type: "object", properties: { q: { type: "string" } } }
  },
  {
    name: "repo_read",
    description: "Read a file (raw text) or list a folder from a pain2hustle repo at a branch/ref. Use find (+around) to get exact snippets, or offset/length for big files. No PC needed.",
    inputSchema: { type: "object", properties: { repo: { type: "string", description: "pain2hustle/<name>, pain2hustle1/<name>, or <name> (= pain2hustle)" }, path: { type: "string" }, ref: { type: "string" }, find: { type: "string" }, around: { type: "number" }, offset: { type: "number" }, length: { type: "number" } }, required: ["repo"] }
  },
  {
    name: "repo_search",
    description: "Search code inside one pain2hustle repo (GitHub code search). Returns matching file paths.",
    inputSchema: { type: "object", properties: { repo: { type: "string" }, query: { type: "string" } }, required: ["repo", "query"] }
  },
  {
    name: "repo_commit_push",
    description: "Commit to a grok/<name> (or agent/<name>) branch on GitHub in ONE commit, no PC. Branch is created from the default branch if new. files [{path, content, encoding?:'base64', delete?:true}] and/or edits [{path, find, replace}] applied to the branch's current file. Never touches the default branch, never force-pushes, never writes .github/.",
    inputSchema: { type: "object", properties: {
      repo: { type: "string" },
      branch: { type: "string", description: "grok/<short-name>" },
      message: { type: "string" },
      files: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, encoding: { type: "string", enum: ["utf8", "base64"] }, delete: { type: "boolean" } }, required: ["path"] } },
      edits: { type: "array", items: { type: "object", properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" }, count: { type: "number" } }, required: ["path", "find", "replace"] } },
      author: { type: "string" }
    }, required: ["repo", "branch", "message"] }
  },
  {
    name: "repo_open_pr",
    description: "Open (or find) a pull request from a grok/<name> branch into the default branch so Austin can review and merge.",
    inputSchema: { type: "object", properties: { repo: { type: "string" }, branch: { type: "string" }, title: { type: "string" }, body: { type: "string" } }, required: ["repo", "branch", "title"] }
  }
];
GITHUB_TOOL_DEFS.push({
  name: "repo_merge_pr",
  description: "Merge an open grok/* or agent/* pull request into the default branch (normal merge commit, history kept, no force). Refused if the PR touches .github/.",
  inputSchema: { type: "object", properties: { repo: { type: "string" }, number: { type: "number" }, branch: { type: "string", description: "or give the PR's branch" } }, required: ["repo"] }
});
var GITHUB_TOOLS = new Set(GITHUB_TOOL_DEFS.map((t) => t.name));
async function runGithubTool(name, args, env, actor) {
  try {
    if (name === "repo_list") return await ghRepoList(env, args);
    if (name === "repo_read") return await ghRead(env, args);
    if (name === "repo_search") return await ghSearch(env, args);
    if (name === "repo_commit_push") return await ghCommitPush(env, args, actor);
    if (name === "repo_open_pr") return await ghOpenPr(env, args);
    if (name === "repo_merge_pr") return await ghMergePr(env, args);
  } catch (e) {
    return { error: String(e && e.message || e).slice(0, 600) };
  }
  return { error: "unknown repo tool" };
}
var __wtNacl = (function() {
  var module = { exports: {} };
  var exports = module.exports;
  var require2 = void 0;
  (function(nacl) {
    "use strict";
    var gf = function(init) {
      var i, r = new Float64Array(16);
      if (init) for (i = 0; i < init.length; i++) r[i] = init[i];
      return r;
    };
    var randombytes = function() {
      throw new Error("no PRNG");
    };
    var _0 = new Uint8Array(16);
    var _9 = new Uint8Array(32);
    _9[0] = 9;
    var gf0 = gf(), gf1 = gf([1]), _121665 = gf([56129, 1]), D = gf([30883, 4953, 19914, 30187, 55467, 16705, 2637, 112, 59544, 30585, 16505, 36039, 65139, 11119, 27886, 20995]), D2 = gf([61785, 9906, 39828, 60374, 45398, 33411, 5274, 224, 53552, 61171, 33010, 6542, 64743, 22239, 55772, 9222]), X = gf([54554, 36645, 11616, 51542, 42930, 38181, 51040, 26924, 56412, 64982, 57905, 49316, 21502, 52590, 14035, 8553]), Y = gf([26200, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214]), I = gf([41136, 18958, 6951, 50414, 58488, 44335, 6150, 12099, 55207, 15867, 153, 11085, 57099, 20417, 9344, 11139]);
    function ts64(x, i, h, l) {
      x[i] = h >> 24 & 255;
      x[i + 1] = h >> 16 & 255;
      x[i + 2] = h >> 8 & 255;
      x[i + 3] = h & 255;
      x[i + 4] = l >> 24 & 255;
      x[i + 5] = l >> 16 & 255;
      x[i + 6] = l >> 8 & 255;
      x[i + 7] = l & 255;
    }
    function vn(x, xi, y, yi, n) {
      var i, d = 0;
      for (i = 0; i < n; i++) d |= x[xi + i] ^ y[yi + i];
      return (1 & d - 1 >>> 8) - 1;
    }
    function crypto_verify_16(x, xi, y, yi) {
      return vn(x, xi, y, yi, 16);
    }
    function crypto_verify_32(x, xi, y, yi) {
      return vn(x, xi, y, yi, 32);
    }
    function core_salsa20(o, p, k, c) {
      var j0 = c[0] & 255 | (c[1] & 255) << 8 | (c[2] & 255) << 16 | (c[3] & 255) << 24, j1 = k[0] & 255 | (k[1] & 255) << 8 | (k[2] & 255) << 16 | (k[3] & 255) << 24, j2 = k[4] & 255 | (k[5] & 255) << 8 | (k[6] & 255) << 16 | (k[7] & 255) << 24, j3 = k[8] & 255 | (k[9] & 255) << 8 | (k[10] & 255) << 16 | (k[11] & 255) << 24, j4 = k[12] & 255 | (k[13] & 255) << 8 | (k[14] & 255) << 16 | (k[15] & 255) << 24, j5 = c[4] & 255 | (c[5] & 255) << 8 | (c[6] & 255) << 16 | (c[7] & 255) << 24, j6 = p[0] & 255 | (p[1] & 255) << 8 | (p[2] & 255) << 16 | (p[3] & 255) << 24, j7 = p[4] & 255 | (p[5] & 255) << 8 | (p[6] & 255) << 16 | (p[7] & 255) << 24, j8 = p[8] & 255 | (p[9] & 255) << 8 | (p[10] & 255) << 16 | (p[11] & 255) << 24, j9 = p[12] & 255 | (p[13] & 255) << 8 | (p[14] & 255) << 16 | (p[15] & 255) << 24, j10 = c[8] & 255 | (c[9] & 255) << 8 | (c[10] & 255) << 16 | (c[11] & 255) << 24, j11 = k[16] & 255 | (k[17] & 255) << 8 | (k[18] & 255) << 16 | (k[19] & 255) << 24, j12 = k[20] & 255 | (k[21] & 255) << 8 | (k[22] & 255) << 16 | (k[23] & 255) << 24, j13 = k[24] & 255 | (k[25] & 255) << 8 | (k[26] & 255) << 16 | (k[27] & 255) << 24, j14 = k[28] & 255 | (k[29] & 255) << 8 | (k[30] & 255) << 16 | (k[31] & 255) << 24, j15 = c[12] & 255 | (c[13] & 255) << 8 | (c[14] & 255) << 16 | (c[15] & 255) << 24;
      var x0 = j0, x1 = j1, x2 = j2, x3 = j3, x4 = j4, x5 = j5, x6 = j6, x7 = j7, x8 = j8, x9 = j9, x10 = j10, x11 = j11, x12 = j12, x13 = j13, x14 = j14, x15 = j15, u;
      for (var i = 0; i < 20; i += 2) {
        u = x0 + x12 | 0;
        x4 ^= u << 7 | u >>> 32 - 7;
        u = x4 + x0 | 0;
        x8 ^= u << 9 | u >>> 32 - 9;
        u = x8 + x4 | 0;
        x12 ^= u << 13 | u >>> 32 - 13;
        u = x12 + x8 | 0;
        x0 ^= u << 18 | u >>> 32 - 18;
        u = x5 + x1 | 0;
        x9 ^= u << 7 | u >>> 32 - 7;
        u = x9 + x5 | 0;
        x13 ^= u << 9 | u >>> 32 - 9;
        u = x13 + x9 | 0;
        x1 ^= u << 13 | u >>> 32 - 13;
        u = x1 + x13 | 0;
        x5 ^= u << 18 | u >>> 32 - 18;
        u = x10 + x6 | 0;
        x14 ^= u << 7 | u >>> 32 - 7;
        u = x14 + x10 | 0;
        x2 ^= u << 9 | u >>> 32 - 9;
        u = x2 + x14 | 0;
        x6 ^= u << 13 | u >>> 32 - 13;
        u = x6 + x2 | 0;
        x10 ^= u << 18 | u >>> 32 - 18;
        u = x15 + x11 | 0;
        x3 ^= u << 7 | u >>> 32 - 7;
        u = x3 + x15 | 0;
        x7 ^= u << 9 | u >>> 32 - 9;
        u = x7 + x3 | 0;
        x11 ^= u << 13 | u >>> 32 - 13;
        u = x11 + x7 | 0;
        x15 ^= u << 18 | u >>> 32 - 18;
        u = x0 + x3 | 0;
        x1 ^= u << 7 | u >>> 32 - 7;
        u = x1 + x0 | 0;
        x2 ^= u << 9 | u >>> 32 - 9;
        u = x2 + x1 | 0;
        x3 ^= u << 13 | u >>> 32 - 13;
        u = x3 + x2 | 0;
        x0 ^= u << 18 | u >>> 32 - 18;
        u = x5 + x4 | 0;
        x6 ^= u << 7 | u >>> 32 - 7;
        u = x6 + x5 | 0;
        x7 ^= u << 9 | u >>> 32 - 9;
        u = x7 + x6 | 0;
        x4 ^= u << 13 | u >>> 32 - 13;
        u = x4 + x7 | 0;
        x5 ^= u << 18 | u >>> 32 - 18;
        u = x10 + x9 | 0;
        x11 ^= u << 7 | u >>> 32 - 7;
        u = x11 + x10 | 0;
        x8 ^= u << 9 | u >>> 32 - 9;
        u = x8 + x11 | 0;
        x9 ^= u << 13 | u >>> 32 - 13;
        u = x9 + x8 | 0;
        x10 ^= u << 18 | u >>> 32 - 18;
        u = x15 + x14 | 0;
        x12 ^= u << 7 | u >>> 32 - 7;
        u = x12 + x15 | 0;
        x13 ^= u << 9 | u >>> 32 - 9;
        u = x13 + x12 | 0;
        x14 ^= u << 13 | u >>> 32 - 13;
        u = x14 + x13 | 0;
        x15 ^= u << 18 | u >>> 32 - 18;
      }
      x0 = x0 + j0 | 0;
      x1 = x1 + j1 | 0;
      x2 = x2 + j2 | 0;
      x3 = x3 + j3 | 0;
      x4 = x4 + j4 | 0;
      x5 = x5 + j5 | 0;
      x6 = x6 + j6 | 0;
      x7 = x7 + j7 | 0;
      x8 = x8 + j8 | 0;
      x9 = x9 + j9 | 0;
      x10 = x10 + j10 | 0;
      x11 = x11 + j11 | 0;
      x12 = x12 + j12 | 0;
      x13 = x13 + j13 | 0;
      x14 = x14 + j14 | 0;
      x15 = x15 + j15 | 0;
      o[0] = x0 >>> 0 & 255;
      o[1] = x0 >>> 8 & 255;
      o[2] = x0 >>> 16 & 255;
      o[3] = x0 >>> 24 & 255;
      o[4] = x1 >>> 0 & 255;
      o[5] = x1 >>> 8 & 255;
      o[6] = x1 >>> 16 & 255;
      o[7] = x1 >>> 24 & 255;
      o[8] = x2 >>> 0 & 255;
      o[9] = x2 >>> 8 & 255;
      o[10] = x2 >>> 16 & 255;
      o[11] = x2 >>> 24 & 255;
      o[12] = x3 >>> 0 & 255;
      o[13] = x3 >>> 8 & 255;
      o[14] = x3 >>> 16 & 255;
      o[15] = x3 >>> 24 & 255;
      o[16] = x4 >>> 0 & 255;
      o[17] = x4 >>> 8 & 255;
      o[18] = x4 >>> 16 & 255;
      o[19] = x4 >>> 24 & 255;
      o[20] = x5 >>> 0 & 255;
      o[21] = x5 >>> 8 & 255;
      o[22] = x5 >>> 16 & 255;
      o[23] = x5 >>> 24 & 255;
      o[24] = x6 >>> 0 & 255;
      o[25] = x6 >>> 8 & 255;
      o[26] = x6 >>> 16 & 255;
      o[27] = x6 >>> 24 & 255;
      o[28] = x7 >>> 0 & 255;
      o[29] = x7 >>> 8 & 255;
      o[30] = x7 >>> 16 & 255;
      o[31] = x7 >>> 24 & 255;
      o[32] = x8 >>> 0 & 255;
      o[33] = x8 >>> 8 & 255;
      o[34] = x8 >>> 16 & 255;
      o[35] = x8 >>> 24 & 255;
      o[36] = x9 >>> 0 & 255;
      o[37] = x9 >>> 8 & 255;
      o[38] = x9 >>> 16 & 255;
      o[39] = x9 >>> 24 & 255;
      o[40] = x10 >>> 0 & 255;
      o[41] = x10 >>> 8 & 255;
      o[42] = x10 >>> 16 & 255;
      o[43] = x10 >>> 24 & 255;
      o[44] = x11 >>> 0 & 255;
      o[45] = x11 >>> 8 & 255;
      o[46] = x11 >>> 16 & 255;
      o[47] = x11 >>> 24 & 255;
      o[48] = x12 >>> 0 & 255;
      o[49] = x12 >>> 8 & 255;
      o[50] = x12 >>> 16 & 255;
      o[51] = x12 >>> 24 & 255;
      o[52] = x13 >>> 0 & 255;
      o[53] = x13 >>> 8 & 255;
      o[54] = x13 >>> 16 & 255;
      o[55] = x13 >>> 24 & 255;
      o[56] = x14 >>> 0 & 255;
      o[57] = x14 >>> 8 & 255;
      o[58] = x14 >>> 16 & 255;
      o[59] = x14 >>> 24 & 255;
      o[60] = x15 >>> 0 & 255;
      o[61] = x15 >>> 8 & 255;
      o[62] = x15 >>> 16 & 255;
      o[63] = x15 >>> 24 & 255;
    }
    function core_hsalsa20(o, p, k, c) {
      var j0 = c[0] & 255 | (c[1] & 255) << 8 | (c[2] & 255) << 16 | (c[3] & 255) << 24, j1 = k[0] & 255 | (k[1] & 255) << 8 | (k[2] & 255) << 16 | (k[3] & 255) << 24, j2 = k[4] & 255 | (k[5] & 255) << 8 | (k[6] & 255) << 16 | (k[7] & 255) << 24, j3 = k[8] & 255 | (k[9] & 255) << 8 | (k[10] & 255) << 16 | (k[11] & 255) << 24, j4 = k[12] & 255 | (k[13] & 255) << 8 | (k[14] & 255) << 16 | (k[15] & 255) << 24, j5 = c[4] & 255 | (c[5] & 255) << 8 | (c[6] & 255) << 16 | (c[7] & 255) << 24, j6 = p[0] & 255 | (p[1] & 255) << 8 | (p[2] & 255) << 16 | (p[3] & 255) << 24, j7 = p[4] & 255 | (p[5] & 255) << 8 | (p[6] & 255) << 16 | (p[7] & 255) << 24, j8 = p[8] & 255 | (p[9] & 255) << 8 | (p[10] & 255) << 16 | (p[11] & 255) << 24, j9 = p[12] & 255 | (p[13] & 255) << 8 | (p[14] & 255) << 16 | (p[15] & 255) << 24, j10 = c[8] & 255 | (c[9] & 255) << 8 | (c[10] & 255) << 16 | (c[11] & 255) << 24, j11 = k[16] & 255 | (k[17] & 255) << 8 | (k[18] & 255) << 16 | (k[19] & 255) << 24, j12 = k[20] & 255 | (k[21] & 255) << 8 | (k[22] & 255) << 16 | (k[23] & 255) << 24, j13 = k[24] & 255 | (k[25] & 255) << 8 | (k[26] & 255) << 16 | (k[27] & 255) << 24, j14 = k[28] & 255 | (k[29] & 255) << 8 | (k[30] & 255) << 16 | (k[31] & 255) << 24, j15 = c[12] & 255 | (c[13] & 255) << 8 | (c[14] & 255) << 16 | (c[15] & 255) << 24;
      var x0 = j0, x1 = j1, x2 = j2, x3 = j3, x4 = j4, x5 = j5, x6 = j6, x7 = j7, x8 = j8, x9 = j9, x10 = j10, x11 = j11, x12 = j12, x13 = j13, x14 = j14, x15 = j15, u;
      for (var i = 0; i < 20; i += 2) {
        u = x0 + x12 | 0;
        x4 ^= u << 7 | u >>> 32 - 7;
        u = x4 + x0 | 0;
        x8 ^= u << 9 | u >>> 32 - 9;
        u = x8 + x4 | 0;
        x12 ^= u << 13 | u >>> 32 - 13;
        u = x12 + x8 | 0;
        x0 ^= u << 18 | u >>> 32 - 18;
        u = x5 + x1 | 0;
        x9 ^= u << 7 | u >>> 32 - 7;
        u = x9 + x5 | 0;
        x13 ^= u << 9 | u >>> 32 - 9;
        u = x13 + x9 | 0;
        x1 ^= u << 13 | u >>> 32 - 13;
        u = x1 + x13 | 0;
        x5 ^= u << 18 | u >>> 32 - 18;
        u = x10 + x6 | 0;
        x14 ^= u << 7 | u >>> 32 - 7;
        u = x14 + x10 | 0;
        x2 ^= u << 9 | u >>> 32 - 9;
        u = x2 + x14 | 0;
        x6 ^= u << 13 | u >>> 32 - 13;
        u = x6 + x2 | 0;
        x10 ^= u << 18 | u >>> 32 - 18;
        u = x15 + x11 | 0;
        x3 ^= u << 7 | u >>> 32 - 7;
        u = x3 + x15 | 0;
        x7 ^= u << 9 | u >>> 32 - 9;
        u = x7 + x3 | 0;
        x11 ^= u << 13 | u >>> 32 - 13;
        u = x11 + x7 | 0;
        x15 ^= u << 18 | u >>> 32 - 18;
        u = x0 + x3 | 0;
        x1 ^= u << 7 | u >>> 32 - 7;
        u = x1 + x0 | 0;
        x2 ^= u << 9 | u >>> 32 - 9;
        u = x2 + x1 | 0;
        x3 ^= u << 13 | u >>> 32 - 13;
        u = x3 + x2 | 0;
        x0 ^= u << 18 | u >>> 32 - 18;
        u = x5 + x4 | 0;
        x6 ^= u << 7 | u >>> 32 - 7;
        u = x6 + x5 | 0;
        x7 ^= u << 9 | u >>> 32 - 9;
        u = x7 + x6 | 0;
        x4 ^= u << 13 | u >>> 32 - 13;
        u = x4 + x7 | 0;
        x5 ^= u << 18 | u >>> 32 - 18;
        u = x10 + x9 | 0;
        x11 ^= u << 7 | u >>> 32 - 7;
        u = x11 + x10 | 0;
        x8 ^= u << 9 | u >>> 32 - 9;
        u = x8 + x11 | 0;
        x9 ^= u << 13 | u >>> 32 - 13;
        u = x9 + x8 | 0;
        x10 ^= u << 18 | u >>> 32 - 18;
        u = x15 + x14 | 0;
        x12 ^= u << 7 | u >>> 32 - 7;
        u = x12 + x15 | 0;
        x13 ^= u << 9 | u >>> 32 - 9;
        u = x13 + x12 | 0;
        x14 ^= u << 13 | u >>> 32 - 13;
        u = x14 + x13 | 0;
        x15 ^= u << 18 | u >>> 32 - 18;
      }
      o[0] = x0 >>> 0 & 255;
      o[1] = x0 >>> 8 & 255;
      o[2] = x0 >>> 16 & 255;
      o[3] = x0 >>> 24 & 255;
      o[4] = x5 >>> 0 & 255;
      o[5] = x5 >>> 8 & 255;
      o[6] = x5 >>> 16 & 255;
      o[7] = x5 >>> 24 & 255;
      o[8] = x10 >>> 0 & 255;
      o[9] = x10 >>> 8 & 255;
      o[10] = x10 >>> 16 & 255;
      o[11] = x10 >>> 24 & 255;
      o[12] = x15 >>> 0 & 255;
      o[13] = x15 >>> 8 & 255;
      o[14] = x15 >>> 16 & 255;
      o[15] = x15 >>> 24 & 255;
      o[16] = x6 >>> 0 & 255;
      o[17] = x6 >>> 8 & 255;
      o[18] = x6 >>> 16 & 255;
      o[19] = x6 >>> 24 & 255;
      o[20] = x7 >>> 0 & 255;
      o[21] = x7 >>> 8 & 255;
      o[22] = x7 >>> 16 & 255;
      o[23] = x7 >>> 24 & 255;
      o[24] = x8 >>> 0 & 255;
      o[25] = x8 >>> 8 & 255;
      o[26] = x8 >>> 16 & 255;
      o[27] = x8 >>> 24 & 255;
      o[28] = x9 >>> 0 & 255;
      o[29] = x9 >>> 8 & 255;
      o[30] = x9 >>> 16 & 255;
      o[31] = x9 >>> 24 & 255;
    }
    function crypto_core_salsa20(out, inp, k, c) {
      core_salsa20(out, inp, k, c);
    }
    function crypto_core_hsalsa20(out, inp, k, c) {
      core_hsalsa20(out, inp, k, c);
    }
    var sigma = new Uint8Array([101, 120, 112, 97, 110, 100, 32, 51, 50, 45, 98, 121, 116, 101, 32, 107]);
    function crypto_stream_salsa20_xor(c, cpos, m, mpos, b, n, k) {
      var z = new Uint8Array(16), x = new Uint8Array(64);
      var u, i;
      for (i = 0; i < 16; i++) z[i] = 0;
      for (i = 0; i < 8; i++) z[i] = n[i];
      while (b >= 64) {
        crypto_core_salsa20(x, z, k, sigma);
        for (i = 0; i < 64; i++) c[cpos + i] = m[mpos + i] ^ x[i];
        u = 1;
        for (i = 8; i < 16; i++) {
          u = u + (z[i] & 255) | 0;
          z[i] = u & 255;
          u >>>= 8;
        }
        b -= 64;
        cpos += 64;
        mpos += 64;
      }
      if (b > 0) {
        crypto_core_salsa20(x, z, k, sigma);
        for (i = 0; i < b; i++) c[cpos + i] = m[mpos + i] ^ x[i];
      }
      return 0;
    }
    function crypto_stream_salsa20(c, cpos, b, n, k) {
      var z = new Uint8Array(16), x = new Uint8Array(64);
      var u, i;
      for (i = 0; i < 16; i++) z[i] = 0;
      for (i = 0; i < 8; i++) z[i] = n[i];
      while (b >= 64) {
        crypto_core_salsa20(x, z, k, sigma);
        for (i = 0; i < 64; i++) c[cpos + i] = x[i];
        u = 1;
        for (i = 8; i < 16; i++) {
          u = u + (z[i] & 255) | 0;
          z[i] = u & 255;
          u >>>= 8;
        }
        b -= 64;
        cpos += 64;
      }
      if (b > 0) {
        crypto_core_salsa20(x, z, k, sigma);
        for (i = 0; i < b; i++) c[cpos + i] = x[i];
      }
      return 0;
    }
    function crypto_stream(c, cpos, d, n, k) {
      var s = new Uint8Array(32);
      crypto_core_hsalsa20(s, n, k, sigma);
      var sn = new Uint8Array(8);
      for (var i = 0; i < 8; i++) sn[i] = n[i + 16];
      return crypto_stream_salsa20(c, cpos, d, sn, s);
    }
    function crypto_stream_xor(c, cpos, m, mpos, d, n, k) {
      var s = new Uint8Array(32);
      crypto_core_hsalsa20(s, n, k, sigma);
      var sn = new Uint8Array(8);
      for (var i = 0; i < 8; i++) sn[i] = n[i + 16];
      return crypto_stream_salsa20_xor(c, cpos, m, mpos, d, sn, s);
    }
    var poly1305 = function(key2) {
      this.buffer = new Uint8Array(16);
      this.r = new Uint16Array(10);
      this.h = new Uint16Array(10);
      this.pad = new Uint16Array(8);
      this.leftover = 0;
      this.fin = 0;
      var t0, t1, t2, t3, t4, t5, t6, t7;
      t0 = key2[0] & 255 | (key2[1] & 255) << 8;
      this.r[0] = t0 & 8191;
      t1 = key2[2] & 255 | (key2[3] & 255) << 8;
      this.r[1] = (t0 >>> 13 | t1 << 3) & 8191;
      t2 = key2[4] & 255 | (key2[5] & 255) << 8;
      this.r[2] = (t1 >>> 10 | t2 << 6) & 7939;
      t3 = key2[6] & 255 | (key2[7] & 255) << 8;
      this.r[3] = (t2 >>> 7 | t3 << 9) & 8191;
      t4 = key2[8] & 255 | (key2[9] & 255) << 8;
      this.r[4] = (t3 >>> 4 | t4 << 12) & 255;
      this.r[5] = t4 >>> 1 & 8190;
      t5 = key2[10] & 255 | (key2[11] & 255) << 8;
      this.r[6] = (t4 >>> 14 | t5 << 2) & 8191;
      t6 = key2[12] & 255 | (key2[13] & 255) << 8;
      this.r[7] = (t5 >>> 11 | t6 << 5) & 8065;
      t7 = key2[14] & 255 | (key2[15] & 255) << 8;
      this.r[8] = (t6 >>> 8 | t7 << 8) & 8191;
      this.r[9] = t7 >>> 5 & 127;
      this.pad[0] = key2[16] & 255 | (key2[17] & 255) << 8;
      this.pad[1] = key2[18] & 255 | (key2[19] & 255) << 8;
      this.pad[2] = key2[20] & 255 | (key2[21] & 255) << 8;
      this.pad[3] = key2[22] & 255 | (key2[23] & 255) << 8;
      this.pad[4] = key2[24] & 255 | (key2[25] & 255) << 8;
      this.pad[5] = key2[26] & 255 | (key2[27] & 255) << 8;
      this.pad[6] = key2[28] & 255 | (key2[29] & 255) << 8;
      this.pad[7] = key2[30] & 255 | (key2[31] & 255) << 8;
    };
    poly1305.prototype.blocks = function(m, mpos, bytes) {
      var hibit = this.fin ? 0 : 1 << 11;
      var t0, t1, t2, t3, t4, t5, t6, t7, c;
      var d0, d1, d2, d3, d4, d5, d6, d7, d8, d9;
      var h0 = this.h[0], h1 = this.h[1], h2 = this.h[2], h3 = this.h[3], h4 = this.h[4], h5 = this.h[5], h6 = this.h[6], h7 = this.h[7], h8 = this.h[8], h9 = this.h[9];
      var r0 = this.r[0], r1 = this.r[1], r2 = this.r[2], r3 = this.r[3], r4 = this.r[4], r5 = this.r[5], r6 = this.r[6], r7 = this.r[7], r8 = this.r[8], r9 = this.r[9];
      while (bytes >= 16) {
        t0 = m[mpos + 0] & 255 | (m[mpos + 1] & 255) << 8;
        h0 += t0 & 8191;
        t1 = m[mpos + 2] & 255 | (m[mpos + 3] & 255) << 8;
        h1 += (t0 >>> 13 | t1 << 3) & 8191;
        t2 = m[mpos + 4] & 255 | (m[mpos + 5] & 255) << 8;
        h2 += (t1 >>> 10 | t2 << 6) & 8191;
        t3 = m[mpos + 6] & 255 | (m[mpos + 7] & 255) << 8;
        h3 += (t2 >>> 7 | t3 << 9) & 8191;
        t4 = m[mpos + 8] & 255 | (m[mpos + 9] & 255) << 8;
        h4 += (t3 >>> 4 | t4 << 12) & 8191;
        h5 += t4 >>> 1 & 8191;
        t5 = m[mpos + 10] & 255 | (m[mpos + 11] & 255) << 8;
        h6 += (t4 >>> 14 | t5 << 2) & 8191;
        t6 = m[mpos + 12] & 255 | (m[mpos + 13] & 255) << 8;
        h7 += (t5 >>> 11 | t6 << 5) & 8191;
        t7 = m[mpos + 14] & 255 | (m[mpos + 15] & 255) << 8;
        h8 += (t6 >>> 8 | t7 << 8) & 8191;
        h9 += t7 >>> 5 | hibit;
        c = 0;
        d0 = c;
        d0 += h0 * r0;
        d0 += h1 * (5 * r9);
        d0 += h2 * (5 * r8);
        d0 += h3 * (5 * r7);
        d0 += h4 * (5 * r6);
        c = d0 >>> 13;
        d0 &= 8191;
        d0 += h5 * (5 * r5);
        d0 += h6 * (5 * r4);
        d0 += h7 * (5 * r3);
        d0 += h8 * (5 * r2);
        d0 += h9 * (5 * r1);
        c += d0 >>> 13;
        d0 &= 8191;
        d1 = c;
        d1 += h0 * r1;
        d1 += h1 * r0;
        d1 += h2 * (5 * r9);
        d1 += h3 * (5 * r8);
        d1 += h4 * (5 * r7);
        c = d1 >>> 13;
        d1 &= 8191;
        d1 += h5 * (5 * r6);
        d1 += h6 * (5 * r5);
        d1 += h7 * (5 * r4);
        d1 += h8 * (5 * r3);
        d1 += h9 * (5 * r2);
        c += d1 >>> 13;
        d1 &= 8191;
        d2 = c;
        d2 += h0 * r2;
        d2 += h1 * r1;
        d2 += h2 * r0;
        d2 += h3 * (5 * r9);
        d2 += h4 * (5 * r8);
        c = d2 >>> 13;
        d2 &= 8191;
        d2 += h5 * (5 * r7);
        d2 += h6 * (5 * r6);
        d2 += h7 * (5 * r5);
        d2 += h8 * (5 * r4);
        d2 += h9 * (5 * r3);
        c += d2 >>> 13;
        d2 &= 8191;
        d3 = c;
        d3 += h0 * r3;
        d3 += h1 * r2;
        d3 += h2 * r1;
        d3 += h3 * r0;
        d3 += h4 * (5 * r9);
        c = d3 >>> 13;
        d3 &= 8191;
        d3 += h5 * (5 * r8);
        d3 += h6 * (5 * r7);
        d3 += h7 * (5 * r6);
        d3 += h8 * (5 * r5);
        d3 += h9 * (5 * r4);
        c += d3 >>> 13;
        d3 &= 8191;
        d4 = c;
        d4 += h0 * r4;
        d4 += h1 * r3;
        d4 += h2 * r2;
        d4 += h3 * r1;
        d4 += h4 * r0;
        c = d4 >>> 13;
        d4 &= 8191;
        d4 += h5 * (5 * r9);
        d4 += h6 * (5 * r8);
        d4 += h7 * (5 * r7);
        d4 += h8 * (5 * r6);
        d4 += h9 * (5 * r5);
        c += d4 >>> 13;
        d4 &= 8191;
        d5 = c;
        d5 += h0 * r5;
        d5 += h1 * r4;
        d5 += h2 * r3;
        d5 += h3 * r2;
        d5 += h4 * r1;
        c = d5 >>> 13;
        d5 &= 8191;
        d5 += h5 * r0;
        d5 += h6 * (5 * r9);
        d5 += h7 * (5 * r8);
        d5 += h8 * (5 * r7);
        d5 += h9 * (5 * r6);
        c += d5 >>> 13;
        d5 &= 8191;
        d6 = c;
        d6 += h0 * r6;
        d6 += h1 * r5;
        d6 += h2 * r4;
        d6 += h3 * r3;
        d6 += h4 * r2;
        c = d6 >>> 13;
        d6 &= 8191;
        d6 += h5 * r1;
        d6 += h6 * r0;
        d6 += h7 * (5 * r9);
        d6 += h8 * (5 * r8);
        d6 += h9 * (5 * r7);
        c += d6 >>> 13;
        d6 &= 8191;
        d7 = c;
        d7 += h0 * r7;
        d7 += h1 * r6;
        d7 += h2 * r5;
        d7 += h3 * r4;
        d7 += h4 * r3;
        c = d7 >>> 13;
        d7 &= 8191;
        d7 += h5 * r2;
        d7 += h6 * r1;
        d7 += h7 * r0;
        d7 += h8 * (5 * r9);
        d7 += h9 * (5 * r8);
        c += d7 >>> 13;
        d7 &= 8191;
        d8 = c;
        d8 += h0 * r8;
        d8 += h1 * r7;
        d8 += h2 * r6;
        d8 += h3 * r5;
        d8 += h4 * r4;
        c = d8 >>> 13;
        d8 &= 8191;
        d8 += h5 * r3;
        d8 += h6 * r2;
        d8 += h7 * r1;
        d8 += h8 * r0;
        d8 += h9 * (5 * r9);
        c += d8 >>> 13;
        d8 &= 8191;
        d9 = c;
        d9 += h0 * r9;
        d9 += h1 * r8;
        d9 += h2 * r7;
        d9 += h3 * r6;
        d9 += h4 * r5;
        c = d9 >>> 13;
        d9 &= 8191;
        d9 += h5 * r4;
        d9 += h6 * r3;
        d9 += h7 * r2;
        d9 += h8 * r1;
        d9 += h9 * r0;
        c += d9 >>> 13;
        d9 &= 8191;
        c = (c << 2) + c | 0;
        c = c + d0 | 0;
        d0 = c & 8191;
        c = c >>> 13;
        d1 += c;
        h0 = d0;
        h1 = d1;
        h2 = d2;
        h3 = d3;
        h4 = d4;
        h5 = d5;
        h6 = d6;
        h7 = d7;
        h8 = d8;
        h9 = d9;
        mpos += 16;
        bytes -= 16;
      }
      this.h[0] = h0;
      this.h[1] = h1;
      this.h[2] = h2;
      this.h[3] = h3;
      this.h[4] = h4;
      this.h[5] = h5;
      this.h[6] = h6;
      this.h[7] = h7;
      this.h[8] = h8;
      this.h[9] = h9;
    };
    poly1305.prototype.finish = function(mac, macpos) {
      var g = new Uint16Array(10);
      var c, mask, f, i;
      if (this.leftover) {
        i = this.leftover;
        this.buffer[i++] = 1;
        for (; i < 16; i++) this.buffer[i] = 0;
        this.fin = 1;
        this.blocks(this.buffer, 0, 16);
      }
      c = this.h[1] >>> 13;
      this.h[1] &= 8191;
      for (i = 2; i < 10; i++) {
        this.h[i] += c;
        c = this.h[i] >>> 13;
        this.h[i] &= 8191;
      }
      this.h[0] += c * 5;
      c = this.h[0] >>> 13;
      this.h[0] &= 8191;
      this.h[1] += c;
      c = this.h[1] >>> 13;
      this.h[1] &= 8191;
      this.h[2] += c;
      g[0] = this.h[0] + 5;
      c = g[0] >>> 13;
      g[0] &= 8191;
      for (i = 1; i < 10; i++) {
        g[i] = this.h[i] + c;
        c = g[i] >>> 13;
        g[i] &= 8191;
      }
      g[9] -= 1 << 13;
      mask = (c ^ 1) - 1;
      for (i = 0; i < 10; i++) g[i] &= mask;
      mask = ~mask;
      for (i = 0; i < 10; i++) this.h[i] = this.h[i] & mask | g[i];
      this.h[0] = (this.h[0] | this.h[1] << 13) & 65535;
      this.h[1] = (this.h[1] >>> 3 | this.h[2] << 10) & 65535;
      this.h[2] = (this.h[2] >>> 6 | this.h[3] << 7) & 65535;
      this.h[3] = (this.h[3] >>> 9 | this.h[4] << 4) & 65535;
      this.h[4] = (this.h[4] >>> 12 | this.h[5] << 1 | this.h[6] << 14) & 65535;
      this.h[5] = (this.h[6] >>> 2 | this.h[7] << 11) & 65535;
      this.h[6] = (this.h[7] >>> 5 | this.h[8] << 8) & 65535;
      this.h[7] = (this.h[8] >>> 8 | this.h[9] << 5) & 65535;
      f = this.h[0] + this.pad[0];
      this.h[0] = f & 65535;
      for (i = 1; i < 8; i++) {
        f = (this.h[i] + this.pad[i] | 0) + (f >>> 16) | 0;
        this.h[i] = f & 65535;
      }
      mac[macpos + 0] = this.h[0] >>> 0 & 255;
      mac[macpos + 1] = this.h[0] >>> 8 & 255;
      mac[macpos + 2] = this.h[1] >>> 0 & 255;
      mac[macpos + 3] = this.h[1] >>> 8 & 255;
      mac[macpos + 4] = this.h[2] >>> 0 & 255;
      mac[macpos + 5] = this.h[2] >>> 8 & 255;
      mac[macpos + 6] = this.h[3] >>> 0 & 255;
      mac[macpos + 7] = this.h[3] >>> 8 & 255;
      mac[macpos + 8] = this.h[4] >>> 0 & 255;
      mac[macpos + 9] = this.h[4] >>> 8 & 255;
      mac[macpos + 10] = this.h[5] >>> 0 & 255;
      mac[macpos + 11] = this.h[5] >>> 8 & 255;
      mac[macpos + 12] = this.h[6] >>> 0 & 255;
      mac[macpos + 13] = this.h[6] >>> 8 & 255;
      mac[macpos + 14] = this.h[7] >>> 0 & 255;
      mac[macpos + 15] = this.h[7] >>> 8 & 255;
    };
    poly1305.prototype.update = function(m, mpos, bytes) {
      var i, want;
      if (this.leftover) {
        want = 16 - this.leftover;
        if (want > bytes)
          want = bytes;
        for (i = 0; i < want; i++)
          this.buffer[this.leftover + i] = m[mpos + i];
        bytes -= want;
        mpos += want;
        this.leftover += want;
        if (this.leftover < 16)
          return;
        this.blocks(this.buffer, 0, 16);
        this.leftover = 0;
      }
      if (bytes >= 16) {
        want = bytes - bytes % 16;
        this.blocks(m, mpos, want);
        mpos += want;
        bytes -= want;
      }
      if (bytes) {
        for (i = 0; i < bytes; i++)
          this.buffer[this.leftover + i] = m[mpos + i];
        this.leftover += bytes;
      }
    };
    function crypto_onetimeauth(out, outpos, m, mpos, n, k) {
      var s = new poly1305(k);
      s.update(m, mpos, n);
      s.finish(out, outpos);
      return 0;
    }
    function crypto_onetimeauth_verify(h, hpos, m, mpos, n, k) {
      var x = new Uint8Array(16);
      crypto_onetimeauth(x, 0, m, mpos, n, k);
      return crypto_verify_16(h, hpos, x, 0);
    }
    function crypto_secretbox(c, m, d, n, k) {
      var i;
      if (d < 32) return -1;
      crypto_stream_xor(c, 0, m, 0, d, n, k);
      crypto_onetimeauth(c, 16, c, 32, d - 32, c);
      for (i = 0; i < 16; i++) c[i] = 0;
      return 0;
    }
    function crypto_secretbox_open(m, c, d, n, k) {
      var i;
      var x = new Uint8Array(32);
      if (d < 32) return -1;
      crypto_stream(x, 0, 32, n, k);
      if (crypto_onetimeauth_verify(c, 16, c, 32, d - 32, x) !== 0) return -1;
      crypto_stream_xor(m, 0, c, 0, d, n, k);
      for (i = 0; i < 32; i++) m[i] = 0;
      return 0;
    }
    function set25519(r, a) {
      var i;
      for (i = 0; i < 16; i++) r[i] = a[i] | 0;
    }
    function car25519(o) {
      var i, v, c = 1;
      for (i = 0; i < 16; i++) {
        v = o[i] + c + 65535;
        c = Math.floor(v / 65536);
        o[i] = v - c * 65536;
      }
      o[0] += c - 1 + 37 * (c - 1);
    }
    function sel25519(p, q, b) {
      var t, c = ~(b - 1);
      for (var i = 0; i < 16; i++) {
        t = c & (p[i] ^ q[i]);
        p[i] ^= t;
        q[i] ^= t;
      }
    }
    function pack25519(o, n) {
      var i, j, b;
      var m = gf(), t = gf();
      for (i = 0; i < 16; i++) t[i] = n[i];
      car25519(t);
      car25519(t);
      car25519(t);
      for (j = 0; j < 2; j++) {
        m[0] = t[0] - 65517;
        for (i = 1; i < 15; i++) {
          m[i] = t[i] - 65535 - (m[i - 1] >> 16 & 1);
          m[i - 1] &= 65535;
        }
        m[15] = t[15] - 32767 - (m[14] >> 16 & 1);
        b = m[15] >> 16 & 1;
        m[14] &= 65535;
        sel25519(t, m, 1 - b);
      }
      for (i = 0; i < 16; i++) {
        o[2 * i] = t[i] & 255;
        o[2 * i + 1] = t[i] >> 8;
      }
    }
    function neq25519(a, b) {
      var c = new Uint8Array(32), d = new Uint8Array(32);
      pack25519(c, a);
      pack25519(d, b);
      return crypto_verify_32(c, 0, d, 0);
    }
    function par25519(a) {
      var d = new Uint8Array(32);
      pack25519(d, a);
      return d[0] & 1;
    }
    function unpack25519(o, n) {
      var i;
      for (i = 0; i < 16; i++) o[i] = n[2 * i] + (n[2 * i + 1] << 8);
      o[15] &= 32767;
    }
    function A(o, a, b) {
      for (var i = 0; i < 16; i++) o[i] = a[i] + b[i];
    }
    function Z(o, a, b) {
      for (var i = 0; i < 16; i++) o[i] = a[i] - b[i];
    }
    function M(o, a, b) {
      var v, c, t0 = 0, t1 = 0, t2 = 0, t3 = 0, t4 = 0, t5 = 0, t6 = 0, t7 = 0, t8 = 0, t9 = 0, t10 = 0, t11 = 0, t12 = 0, t13 = 0, t14 = 0, t15 = 0, t16 = 0, t17 = 0, t18 = 0, t19 = 0, t20 = 0, t21 = 0, t22 = 0, t23 = 0, t24 = 0, t25 = 0, t26 = 0, t27 = 0, t28 = 0, t29 = 0, t30 = 0, b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3], b4 = b[4], b5 = b[5], b6 = b[6], b7 = b[7], b8 = b[8], b9 = b[9], b10 = b[10], b11 = b[11], b12 = b[12], b13 = b[13], b14 = b[14], b15 = b[15];
      v = a[0];
      t0 += v * b0;
      t1 += v * b1;
      t2 += v * b2;
      t3 += v * b3;
      t4 += v * b4;
      t5 += v * b5;
      t6 += v * b6;
      t7 += v * b7;
      t8 += v * b8;
      t9 += v * b9;
      t10 += v * b10;
      t11 += v * b11;
      t12 += v * b12;
      t13 += v * b13;
      t14 += v * b14;
      t15 += v * b15;
      v = a[1];
      t1 += v * b0;
      t2 += v * b1;
      t3 += v * b2;
      t4 += v * b3;
      t5 += v * b4;
      t6 += v * b5;
      t7 += v * b6;
      t8 += v * b7;
      t9 += v * b8;
      t10 += v * b9;
      t11 += v * b10;
      t12 += v * b11;
      t13 += v * b12;
      t14 += v * b13;
      t15 += v * b14;
      t16 += v * b15;
      v = a[2];
      t2 += v * b0;
      t3 += v * b1;
      t4 += v * b2;
      t5 += v * b3;
      t6 += v * b4;
      t7 += v * b5;
      t8 += v * b6;
      t9 += v * b7;
      t10 += v * b8;
      t11 += v * b9;
      t12 += v * b10;
      t13 += v * b11;
      t14 += v * b12;
      t15 += v * b13;
      t16 += v * b14;
      t17 += v * b15;
      v = a[3];
      t3 += v * b0;
      t4 += v * b1;
      t5 += v * b2;
      t6 += v * b3;
      t7 += v * b4;
      t8 += v * b5;
      t9 += v * b6;
      t10 += v * b7;
      t11 += v * b8;
      t12 += v * b9;
      t13 += v * b10;
      t14 += v * b11;
      t15 += v * b12;
      t16 += v * b13;
      t17 += v * b14;
      t18 += v * b15;
      v = a[4];
      t4 += v * b0;
      t5 += v * b1;
      t6 += v * b2;
      t7 += v * b3;
      t8 += v * b4;
      t9 += v * b5;
      t10 += v * b6;
      t11 += v * b7;
      t12 += v * b8;
      t13 += v * b9;
      t14 += v * b10;
      t15 += v * b11;
      t16 += v * b12;
      t17 += v * b13;
      t18 += v * b14;
      t19 += v * b15;
      v = a[5];
      t5 += v * b0;
      t6 += v * b1;
      t7 += v * b2;
      t8 += v * b3;
      t9 += v * b4;
      t10 += v * b5;
      t11 += v * b6;
      t12 += v * b7;
      t13 += v * b8;
      t14 += v * b9;
      t15 += v * b10;
      t16 += v * b11;
      t17 += v * b12;
      t18 += v * b13;
      t19 += v * b14;
      t20 += v * b15;
      v = a[6];
      t6 += v * b0;
      t7 += v * b1;
      t8 += v * b2;
      t9 += v * b3;
      t10 += v * b4;
      t11 += v * b5;
      t12 += v * b6;
      t13 += v * b7;
      t14 += v * b8;
      t15 += v * b9;
      t16 += v * b10;
      t17 += v * b11;
      t18 += v * b12;
      t19 += v * b13;
      t20 += v * b14;
      t21 += v * b15;
      v = a[7];
      t7 += v * b0;
      t8 += v * b1;
      t9 += v * b2;
      t10 += v * b3;
      t11 += v * b4;
      t12 += v * b5;
      t13 += v * b6;
      t14 += v * b7;
      t15 += v * b8;
      t16 += v * b9;
      t17 += v * b10;
      t18 += v * b11;
      t19 += v * b12;
      t20 += v * b13;
      t21 += v * b14;
      t22 += v * b15;
      v = a[8];
      t8 += v * b0;
      t9 += v * b1;
      t10 += v * b2;
      t11 += v * b3;
      t12 += v * b4;
      t13 += v * b5;
      t14 += v * b6;
      t15 += v * b7;
      t16 += v * b8;
      t17 += v * b9;
      t18 += v * b10;
      t19 += v * b11;
      t20 += v * b12;
      t21 += v * b13;
      t22 += v * b14;
      t23 += v * b15;
      v = a[9];
      t9 += v * b0;
      t10 += v * b1;
      t11 += v * b2;
      t12 += v * b3;
      t13 += v * b4;
      t14 += v * b5;
      t15 += v * b6;
      t16 += v * b7;
      t17 += v * b8;
      t18 += v * b9;
      t19 += v * b10;
      t20 += v * b11;
      t21 += v * b12;
      t22 += v * b13;
      t23 += v * b14;
      t24 += v * b15;
      v = a[10];
      t10 += v * b0;
      t11 += v * b1;
      t12 += v * b2;
      t13 += v * b3;
      t14 += v * b4;
      t15 += v * b5;
      t16 += v * b6;
      t17 += v * b7;
      t18 += v * b8;
      t19 += v * b9;
      t20 += v * b10;
      t21 += v * b11;
      t22 += v * b12;
      t23 += v * b13;
      t24 += v * b14;
      t25 += v * b15;
      v = a[11];
      t11 += v * b0;
      t12 += v * b1;
      t13 += v * b2;
      t14 += v * b3;
      t15 += v * b4;
      t16 += v * b5;
      t17 += v * b6;
      t18 += v * b7;
      t19 += v * b8;
      t20 += v * b9;
      t21 += v * b10;
      t22 += v * b11;
      t23 += v * b12;
      t24 += v * b13;
      t25 += v * b14;
      t26 += v * b15;
      v = a[12];
      t12 += v * b0;
      t13 += v * b1;
      t14 += v * b2;
      t15 += v * b3;
      t16 += v * b4;
      t17 += v * b5;
      t18 += v * b6;
      t19 += v * b7;
      t20 += v * b8;
      t21 += v * b9;
      t22 += v * b10;
      t23 += v * b11;
      t24 += v * b12;
      t25 += v * b13;
      t26 += v * b14;
      t27 += v * b15;
      v = a[13];
      t13 += v * b0;
      t14 += v * b1;
      t15 += v * b2;
      t16 += v * b3;
      t17 += v * b4;
      t18 += v * b5;
      t19 += v * b6;
      t20 += v * b7;
      t21 += v * b8;
      t22 += v * b9;
      t23 += v * b10;
      t24 += v * b11;
      t25 += v * b12;
      t26 += v * b13;
      t27 += v * b14;
      t28 += v * b15;
      v = a[14];
      t14 += v * b0;
      t15 += v * b1;
      t16 += v * b2;
      t17 += v * b3;
      t18 += v * b4;
      t19 += v * b5;
      t20 += v * b6;
      t21 += v * b7;
      t22 += v * b8;
      t23 += v * b9;
      t24 += v * b10;
      t25 += v * b11;
      t26 += v * b12;
      t27 += v * b13;
      t28 += v * b14;
      t29 += v * b15;
      v = a[15];
      t15 += v * b0;
      t16 += v * b1;
      t17 += v * b2;
      t18 += v * b3;
      t19 += v * b4;
      t20 += v * b5;
      t21 += v * b6;
      t22 += v * b7;
      t23 += v * b8;
      t24 += v * b9;
      t25 += v * b10;
      t26 += v * b11;
      t27 += v * b12;
      t28 += v * b13;
      t29 += v * b14;
      t30 += v * b15;
      t0 += 38 * t16;
      t1 += 38 * t17;
      t2 += 38 * t18;
      t3 += 38 * t19;
      t4 += 38 * t20;
      t5 += 38 * t21;
      t6 += 38 * t22;
      t7 += 38 * t23;
      t8 += 38 * t24;
      t9 += 38 * t25;
      t10 += 38 * t26;
      t11 += 38 * t27;
      t12 += 38 * t28;
      t13 += 38 * t29;
      t14 += 38 * t30;
      c = 1;
      v = t0 + c + 65535;
      c = Math.floor(v / 65536);
      t0 = v - c * 65536;
      v = t1 + c + 65535;
      c = Math.floor(v / 65536);
      t1 = v - c * 65536;
      v = t2 + c + 65535;
      c = Math.floor(v / 65536);
      t2 = v - c * 65536;
      v = t3 + c + 65535;
      c = Math.floor(v / 65536);
      t3 = v - c * 65536;
      v = t4 + c + 65535;
      c = Math.floor(v / 65536);
      t4 = v - c * 65536;
      v = t5 + c + 65535;
      c = Math.floor(v / 65536);
      t5 = v - c * 65536;
      v = t6 + c + 65535;
      c = Math.floor(v / 65536);
      t6 = v - c * 65536;
      v = t7 + c + 65535;
      c = Math.floor(v / 65536);
      t7 = v - c * 65536;
      v = t8 + c + 65535;
      c = Math.floor(v / 65536);
      t8 = v - c * 65536;
      v = t9 + c + 65535;
      c = Math.floor(v / 65536);
      t9 = v - c * 65536;
      v = t10 + c + 65535;
      c = Math.floor(v / 65536);
      t10 = v - c * 65536;
      v = t11 + c + 65535;
      c = Math.floor(v / 65536);
      t11 = v - c * 65536;
      v = t12 + c + 65535;
      c = Math.floor(v / 65536);
      t12 = v - c * 65536;
      v = t13 + c + 65535;
      c = Math.floor(v / 65536);
      t13 = v - c * 65536;
      v = t14 + c + 65535;
      c = Math.floor(v / 65536);
      t14 = v - c * 65536;
      v = t15 + c + 65535;
      c = Math.floor(v / 65536);
      t15 = v - c * 65536;
      t0 += c - 1 + 37 * (c - 1);
      c = 1;
      v = t0 + c + 65535;
      c = Math.floor(v / 65536);
      t0 = v - c * 65536;
      v = t1 + c + 65535;
      c = Math.floor(v / 65536);
      t1 = v - c * 65536;
      v = t2 + c + 65535;
      c = Math.floor(v / 65536);
      t2 = v - c * 65536;
      v = t3 + c + 65535;
      c = Math.floor(v / 65536);
      t3 = v - c * 65536;
      v = t4 + c + 65535;
      c = Math.floor(v / 65536);
      t4 = v - c * 65536;
      v = t5 + c + 65535;
      c = Math.floor(v / 65536);
      t5 = v - c * 65536;
      v = t6 + c + 65535;
      c = Math.floor(v / 65536);
      t6 = v - c * 65536;
      v = t7 + c + 65535;
      c = Math.floor(v / 65536);
      t7 = v - c * 65536;
      v = t8 + c + 65535;
      c = Math.floor(v / 65536);
      t8 = v - c * 65536;
      v = t9 + c + 65535;
      c = Math.floor(v / 65536);
      t9 = v - c * 65536;
      v = t10 + c + 65535;
      c = Math.floor(v / 65536);
      t10 = v - c * 65536;
      v = t11 + c + 65535;
      c = Math.floor(v / 65536);
      t11 = v - c * 65536;
      v = t12 + c + 65535;
      c = Math.floor(v / 65536);
      t12 = v - c * 65536;
      v = t13 + c + 65535;
      c = Math.floor(v / 65536);
      t13 = v - c * 65536;
      v = t14 + c + 65535;
      c = Math.floor(v / 65536);
      t14 = v - c * 65536;
      v = t15 + c + 65535;
      c = Math.floor(v / 65536);
      t15 = v - c * 65536;
      t0 += c - 1 + 37 * (c - 1);
      o[0] = t0;
      o[1] = t1;
      o[2] = t2;
      o[3] = t3;
      o[4] = t4;
      o[5] = t5;
      o[6] = t6;
      o[7] = t7;
      o[8] = t8;
      o[9] = t9;
      o[10] = t10;
      o[11] = t11;
      o[12] = t12;
      o[13] = t13;
      o[14] = t14;
      o[15] = t15;
    }
    function S(o, a) {
      M(o, a, a);
    }
    function inv25519(o, i) {
      var c = gf();
      var a;
      for (a = 0; a < 16; a++) c[a] = i[a];
      for (a = 253; a >= 0; a--) {
        S(c, c);
        if (a !== 2 && a !== 4) M(c, c, i);
      }
      for (a = 0; a < 16; a++) o[a] = c[a];
    }
    function pow2523(o, i) {
      var c = gf();
      var a;
      for (a = 0; a < 16; a++) c[a] = i[a];
      for (a = 250; a >= 0; a--) {
        S(c, c);
        if (a !== 1) M(c, c, i);
      }
      for (a = 0; a < 16; a++) o[a] = c[a];
    }
    function crypto_scalarmult(q, n, p) {
      var z = new Uint8Array(32);
      var x = new Float64Array(80), r, i;
      var a = gf(), b = gf(), c = gf(), d = gf(), e = gf(), f = gf();
      for (i = 0; i < 31; i++) z[i] = n[i];
      z[31] = n[31] & 127 | 64;
      z[0] &= 248;
      unpack25519(x, p);
      for (i = 0; i < 16; i++) {
        b[i] = x[i];
        d[i] = a[i] = c[i] = 0;
      }
      a[0] = d[0] = 1;
      for (i = 254; i >= 0; --i) {
        r = z[i >>> 3] >>> (i & 7) & 1;
        sel25519(a, b, r);
        sel25519(c, d, r);
        A(e, a, c);
        Z(a, a, c);
        A(c, b, d);
        Z(b, b, d);
        S(d, e);
        S(f, a);
        M(a, c, a);
        M(c, b, e);
        A(e, a, c);
        Z(a, a, c);
        S(b, a);
        Z(c, d, f);
        M(a, c, _121665);
        A(a, a, d);
        M(c, c, a);
        M(a, d, f);
        M(d, b, x);
        S(b, e);
        sel25519(a, b, r);
        sel25519(c, d, r);
      }
      for (i = 0; i < 16; i++) {
        x[i + 16] = a[i];
        x[i + 32] = c[i];
        x[i + 48] = b[i];
        x[i + 64] = d[i];
      }
      var x32 = x.subarray(32);
      var x16 = x.subarray(16);
      inv25519(x32, x32);
      M(x16, x16, x32);
      pack25519(q, x16);
      return 0;
    }
    function crypto_scalarmult_base(q, n) {
      return crypto_scalarmult(q, n, _9);
    }
    function crypto_box_keypair(y, x) {
      randombytes(x, 32);
      return crypto_scalarmult_base(y, x);
    }
    function crypto_box_beforenm(k, y, x) {
      var s = new Uint8Array(32);
      crypto_scalarmult(s, x, y);
      return crypto_core_hsalsa20(k, _0, s, sigma);
    }
    var crypto_box_afternm = crypto_secretbox;
    var crypto_box_open_afternm = crypto_secretbox_open;
    function crypto_box(c, m, d, n, y, x) {
      var k = new Uint8Array(32);
      crypto_box_beforenm(k, y, x);
      return crypto_box_afternm(c, m, d, n, k);
    }
    function crypto_box_open(m, c, d, n, y, x) {
      var k = new Uint8Array(32);
      crypto_box_beforenm(k, y, x);
      return crypto_box_open_afternm(m, c, d, n, k);
    }
    var K = [
      1116352408,
      3609767458,
      1899447441,
      602891725,
      3049323471,
      3964484399,
      3921009573,
      2173295548,
      961987163,
      4081628472,
      1508970993,
      3053834265,
      2453635748,
      2937671579,
      2870763221,
      3664609560,
      3624381080,
      2734883394,
      310598401,
      1164996542,
      607225278,
      1323610764,
      1426881987,
      3590304994,
      1925078388,
      4068182383,
      2162078206,
      991336113,
      2614888103,
      633803317,
      3248222580,
      3479774868,
      3835390401,
      2666613458,
      4022224774,
      944711139,
      264347078,
      2341262773,
      604807628,
      2007800933,
      770255983,
      1495990901,
      1249150122,
      1856431235,
      1555081692,
      3175218132,
      1996064986,
      2198950837,
      2554220882,
      3999719339,
      2821834349,
      766784016,
      2952996808,
      2566594879,
      3210313671,
      3203337956,
      3336571891,
      1034457026,
      3584528711,
      2466948901,
      113926993,
      3758326383,
      338241895,
      168717936,
      666307205,
      1188179964,
      773529912,
      1546045734,
      1294757372,
      1522805485,
      1396182291,
      2643833823,
      1695183700,
      2343527390,
      1986661051,
      1014477480,
      2177026350,
      1206759142,
      2456956037,
      344077627,
      2730485921,
      1290863460,
      2820302411,
      3158454273,
      3259730800,
      3505952657,
      3345764771,
      106217008,
      3516065817,
      3606008344,
      3600352804,
      1432725776,
      4094571909,
      1467031594,
      275423344,
      851169720,
      430227734,
      3100823752,
      506948616,
      1363258195,
      659060556,
      3750685593,
      883997877,
      3785050280,
      958139571,
      3318307427,
      1322822218,
      3812723403,
      1537002063,
      2003034995,
      1747873779,
      3602036899,
      1955562222,
      1575990012,
      2024104815,
      1125592928,
      2227730452,
      2716904306,
      2361852424,
      442776044,
      2428436474,
      593698344,
      2756734187,
      3733110249,
      3204031479,
      2999351573,
      3329325298,
      3815920427,
      3391569614,
      3928383900,
      3515267271,
      566280711,
      3940187606,
      3454069534,
      4118630271,
      4000239992,
      116418474,
      1914138554,
      174292421,
      2731055270,
      289380356,
      3203993006,
      460393269,
      320620315,
      685471733,
      587496836,
      852142971,
      1086792851,
      1017036298,
      365543100,
      1126000580,
      2618297676,
      1288033470,
      3409855158,
      1501505948,
      4234509866,
      1607167915,
      987167468,
      1816402316,
      1246189591
    ];
    function crypto_hashblocks_hl(hh, hl, m, n) {
      var wh = new Int32Array(16), wl = new Int32Array(16), bh0, bh1, bh2, bh3, bh4, bh5, bh6, bh7, bl0, bl1, bl2, bl3, bl4, bl5, bl6, bl7, th, tl, i, j, h, l, a, b, c, d;
      var ah0 = hh[0], ah1 = hh[1], ah2 = hh[2], ah3 = hh[3], ah4 = hh[4], ah5 = hh[5], ah6 = hh[6], ah7 = hh[7], al0 = hl[0], al1 = hl[1], al2 = hl[2], al3 = hl[3], al4 = hl[4], al5 = hl[5], al6 = hl[6], al7 = hl[7];
      var pos = 0;
      while (n >= 128) {
        for (i = 0; i < 16; i++) {
          j = 8 * i + pos;
          wh[i] = m[j + 0] << 24 | m[j + 1] << 16 | m[j + 2] << 8 | m[j + 3];
          wl[i] = m[j + 4] << 24 | m[j + 5] << 16 | m[j + 6] << 8 | m[j + 7];
        }
        for (i = 0; i < 80; i++) {
          bh0 = ah0;
          bh1 = ah1;
          bh2 = ah2;
          bh3 = ah3;
          bh4 = ah4;
          bh5 = ah5;
          bh6 = ah6;
          bh7 = ah7;
          bl0 = al0;
          bl1 = al1;
          bl2 = al2;
          bl3 = al3;
          bl4 = al4;
          bl5 = al5;
          bl6 = al6;
          bl7 = al7;
          h = ah7;
          l = al7;
          a = l & 65535;
          b = l >>> 16;
          c = h & 65535;
          d = h >>> 16;
          h = (ah4 >>> 14 | al4 << 32 - 14) ^ (ah4 >>> 18 | al4 << 32 - 18) ^ (al4 >>> 41 - 32 | ah4 << 32 - (41 - 32));
          l = (al4 >>> 14 | ah4 << 32 - 14) ^ (al4 >>> 18 | ah4 << 32 - 18) ^ (ah4 >>> 41 - 32 | al4 << 32 - (41 - 32));
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          h = ah4 & ah5 ^ ~ah4 & ah6;
          l = al4 & al5 ^ ~al4 & al6;
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          h = K[i * 2];
          l = K[i * 2 + 1];
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          h = wh[i % 16];
          l = wl[i % 16];
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;
          th = c & 65535 | d << 16;
          tl = a & 65535 | b << 16;
          h = th;
          l = tl;
          a = l & 65535;
          b = l >>> 16;
          c = h & 65535;
          d = h >>> 16;
          h = (ah0 >>> 28 | al0 << 32 - 28) ^ (al0 >>> 34 - 32 | ah0 << 32 - (34 - 32)) ^ (al0 >>> 39 - 32 | ah0 << 32 - (39 - 32));
          l = (al0 >>> 28 | ah0 << 32 - 28) ^ (ah0 >>> 34 - 32 | al0 << 32 - (34 - 32)) ^ (ah0 >>> 39 - 32 | al0 << 32 - (39 - 32));
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          h = ah0 & ah1 ^ ah0 & ah2 ^ ah1 & ah2;
          l = al0 & al1 ^ al0 & al2 ^ al1 & al2;
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;
          bh7 = c & 65535 | d << 16;
          bl7 = a & 65535 | b << 16;
          h = bh3;
          l = bl3;
          a = l & 65535;
          b = l >>> 16;
          c = h & 65535;
          d = h >>> 16;
          h = th;
          l = tl;
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;
          bh3 = c & 65535 | d << 16;
          bl3 = a & 65535 | b << 16;
          ah1 = bh0;
          ah2 = bh1;
          ah3 = bh2;
          ah4 = bh3;
          ah5 = bh4;
          ah6 = bh5;
          ah7 = bh6;
          ah0 = bh7;
          al1 = bl0;
          al2 = bl1;
          al3 = bl2;
          al4 = bl3;
          al5 = bl4;
          al6 = bl5;
          al7 = bl6;
          al0 = bl7;
          if (i % 16 === 15) {
            for (j = 0; j < 16; j++) {
              h = wh[j];
              l = wl[j];
              a = l & 65535;
              b = l >>> 16;
              c = h & 65535;
              d = h >>> 16;
              h = wh[(j + 9) % 16];
              l = wl[(j + 9) % 16];
              a += l & 65535;
              b += l >>> 16;
              c += h & 65535;
              d += h >>> 16;
              th = wh[(j + 1) % 16];
              tl = wl[(j + 1) % 16];
              h = (th >>> 1 | tl << 32 - 1) ^ (th >>> 8 | tl << 32 - 8) ^ th >>> 7;
              l = (tl >>> 1 | th << 32 - 1) ^ (tl >>> 8 | th << 32 - 8) ^ (tl >>> 7 | th << 32 - 7);
              a += l & 65535;
              b += l >>> 16;
              c += h & 65535;
              d += h >>> 16;
              th = wh[(j + 14) % 16];
              tl = wl[(j + 14) % 16];
              h = (th >>> 19 | tl << 32 - 19) ^ (tl >>> 61 - 32 | th << 32 - (61 - 32)) ^ th >>> 6;
              l = (tl >>> 19 | th << 32 - 19) ^ (th >>> 61 - 32 | tl << 32 - (61 - 32)) ^ (tl >>> 6 | th << 32 - 6);
              a += l & 65535;
              b += l >>> 16;
              c += h & 65535;
              d += h >>> 16;
              b += a >>> 16;
              c += b >>> 16;
              d += c >>> 16;
              wh[j] = c & 65535 | d << 16;
              wl[j] = a & 65535 | b << 16;
            }
          }
        }
        h = ah0;
        l = al0;
        a = l & 65535;
        b = l >>> 16;
        c = h & 65535;
        d = h >>> 16;
        h = hh[0];
        l = hl[0];
        a += l & 65535;
        b += l >>> 16;
        c += h & 65535;
        d += h >>> 16;
        b += a >>> 16;
        c += b >>> 16;
        d += c >>> 16;
        hh[0] = ah0 = c & 65535 | d << 16;
        hl[0] = al0 = a & 65535 | b << 16;
        h = ah1;
        l = al1;
        a = l & 65535;
        b = l >>> 16;
        c = h & 65535;
        d = h >>> 16;
        h = hh[1];
        l = hl[1];
        a += l & 65535;
        b += l >>> 16;
        c += h & 65535;
        d += h >>> 16;
        b += a >>> 16;
        c += b >>> 16;
        d += c >>> 16;
        hh[1] = ah1 = c & 65535 | d << 16;
        hl[1] = al1 = a & 65535 | b << 16;
        h = ah2;
        l = al2;
        a = l & 65535;
        b = l >>> 16;
        c = h & 65535;
        d = h >>> 16;
        h = hh[2];
        l = hl[2];
        a += l & 65535;
        b += l >>> 16;
        c += h & 65535;
        d += h >>> 16;
        b += a >>> 16;
        c += b >>> 16;
        d += c >>> 16;
        hh[2] = ah2 = c & 65535 | d << 16;
        hl[2] = al2 = a & 65535 | b << 16;
        h = ah3;
        l = al3;
        a = l & 65535;
        b = l >>> 16;
        c = h & 65535;
        d = h >>> 16;
        h = hh[3];
        l = hl[3];
        a += l & 65535;
        b += l >>> 16;
        c += h & 65535;
        d += h >>> 16;
        b += a >>> 16;
        c += b >>> 16;
        d += c >>> 16;
        hh[3] = ah3 = c & 65535 | d << 16;
        hl[3] = al3 = a & 65535 | b << 16;
        h = ah4;
        l = al4;
        a = l & 65535;
        b = l >>> 16;
        c = h & 65535;
        d = h >>> 16;
        h = hh[4];
        l = hl[4];
        a += l & 65535;
        b += l >>> 16;
        c += h & 65535;
        d += h >>> 16;
        b += a >>> 16;
        c += b >>> 16;
        d += c >>> 16;
        hh[4] = ah4 = c & 65535 | d << 16;
        hl[4] = al4 = a & 65535 | b << 16;
        h = ah5;
        l = al5;
        a = l & 65535;
        b = l >>> 16;
        c = h & 65535;
        d = h >>> 16;
        h = hh[5];
        l = hl[5];
        a += l & 65535;
        b += l >>> 16;
        c += h & 65535;
        d += h >>> 16;
        b += a >>> 16;
        c += b >>> 16;
        d += c >>> 16;
        hh[5] = ah5 = c & 65535 | d << 16;
        hl[5] = al5 = a & 65535 | b << 16;
        h = ah6;
        l = al6;
        a = l & 65535;
        b = l >>> 16;
        c = h & 65535;
        d = h >>> 16;
        h = hh[6];
        l = hl[6];
        a += l & 65535;
        b += l >>> 16;
        c += h & 65535;
        d += h >>> 16;
        b += a >>> 16;
        c += b >>> 16;
        d += c >>> 16;
        hh[6] = ah6 = c & 65535 | d << 16;
        hl[6] = al6 = a & 65535 | b << 16;
        h = ah7;
        l = al7;
        a = l & 65535;
        b = l >>> 16;
        c = h & 65535;
        d = h >>> 16;
        h = hh[7];
        l = hl[7];
        a += l & 65535;
        b += l >>> 16;
        c += h & 65535;
        d += h >>> 16;
        b += a >>> 16;
        c += b >>> 16;
        d += c >>> 16;
        hh[7] = ah7 = c & 65535 | d << 16;
        hl[7] = al7 = a & 65535 | b << 16;
        pos += 128;
        n -= 128;
      }
      return n;
    }
    function crypto_hash(out, m, n) {
      var hh = new Int32Array(8), hl = new Int32Array(8), x = new Uint8Array(256), i, b = n;
      hh[0] = 1779033703;
      hh[1] = 3144134277;
      hh[2] = 1013904242;
      hh[3] = 2773480762;
      hh[4] = 1359893119;
      hh[5] = 2600822924;
      hh[6] = 528734635;
      hh[7] = 1541459225;
      hl[0] = 4089235720;
      hl[1] = 2227873595;
      hl[2] = 4271175723;
      hl[3] = 1595750129;
      hl[4] = 2917565137;
      hl[5] = 725511199;
      hl[6] = 4215389547;
      hl[7] = 327033209;
      crypto_hashblocks_hl(hh, hl, m, n);
      n %= 128;
      for (i = 0; i < n; i++) x[i] = m[b - n + i];
      x[n] = 128;
      n = 256 - 128 * (n < 112 ? 1 : 0);
      x[n - 9] = 0;
      ts64(x, n - 8, b / 536870912 | 0, b << 3);
      crypto_hashblocks_hl(hh, hl, x, n);
      for (i = 0; i < 8; i++) ts64(out, 8 * i, hh[i], hl[i]);
      return 0;
    }
    function add(p, q) {
      var a = gf(), b = gf(), c = gf(), d = gf(), e = gf(), f = gf(), g = gf(), h = gf(), t = gf();
      Z(a, p[1], p[0]);
      Z(t, q[1], q[0]);
      M(a, a, t);
      A(b, p[0], p[1]);
      A(t, q[0], q[1]);
      M(b, b, t);
      M(c, p[3], q[3]);
      M(c, c, D2);
      M(d, p[2], q[2]);
      A(d, d, d);
      Z(e, b, a);
      Z(f, d, c);
      A(g, d, c);
      A(h, b, a);
      M(p[0], e, f);
      M(p[1], h, g);
      M(p[2], g, f);
      M(p[3], e, h);
    }
    function cswap(p, q, b) {
      var i;
      for (i = 0; i < 4; i++) {
        sel25519(p[i], q[i], b);
      }
    }
    function pack(r, p) {
      var tx = gf(), ty = gf(), zi = gf();
      inv25519(zi, p[2]);
      M(tx, p[0], zi);
      M(ty, p[1], zi);
      pack25519(r, ty);
      r[31] ^= par25519(tx) << 7;
    }
    function scalarmult(p, q, s) {
      var b, i;
      set25519(p[0], gf0);
      set25519(p[1], gf1);
      set25519(p[2], gf1);
      set25519(p[3], gf0);
      for (i = 255; i >= 0; --i) {
        b = s[i / 8 | 0] >> (i & 7) & 1;
        cswap(p, q, b);
        add(q, p);
        add(p, p);
        cswap(p, q, b);
      }
    }
    function scalarbase(p, s) {
      var q = [gf(), gf(), gf(), gf()];
      set25519(q[0], X);
      set25519(q[1], Y);
      set25519(q[2], gf1);
      M(q[3], X, Y);
      scalarmult(p, q, s);
    }
    function crypto_sign_keypair(pk, sk, seeded) {
      var d = new Uint8Array(64);
      var p = [gf(), gf(), gf(), gf()];
      var i;
      if (!seeded) randombytes(sk, 32);
      crypto_hash(d, sk, 32);
      d[0] &= 248;
      d[31] &= 127;
      d[31] |= 64;
      scalarbase(p, d);
      pack(pk, p);
      for (i = 0; i < 32; i++) sk[i + 32] = pk[i];
      return 0;
    }
    var L = new Float64Array([237, 211, 245, 92, 26, 99, 18, 88, 214, 156, 247, 162, 222, 249, 222, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 16]);
    function modL(r, x) {
      var carry, i, j, k;
      for (i = 63; i >= 32; --i) {
        carry = 0;
        for (j = i - 32, k = i - 12; j < k; ++j) {
          x[j] += carry - 16 * x[i] * L[j - (i - 32)];
          carry = Math.floor((x[j] + 128) / 256);
          x[j] -= carry * 256;
        }
        x[j] += carry;
        x[i] = 0;
      }
      carry = 0;
      for (j = 0; j < 32; j++) {
        x[j] += carry - (x[31] >> 4) * L[j];
        carry = x[j] >> 8;
        x[j] &= 255;
      }
      for (j = 0; j < 32; j++) x[j] -= carry * L[j];
      for (i = 0; i < 32; i++) {
        x[i + 1] += x[i] >> 8;
        r[i] = x[i] & 255;
      }
    }
    function reduce(r) {
      var x = new Float64Array(64), i;
      for (i = 0; i < 64; i++) x[i] = r[i];
      for (i = 0; i < 64; i++) r[i] = 0;
      modL(r, x);
    }
    function crypto_sign(sm, m, n, sk) {
      var d = new Uint8Array(64), h = new Uint8Array(64), r = new Uint8Array(64);
      var i, j, x = new Float64Array(64);
      var p = [gf(), gf(), gf(), gf()];
      crypto_hash(d, sk, 32);
      d[0] &= 248;
      d[31] &= 127;
      d[31] |= 64;
      var smlen = n + 64;
      for (i = 0; i < n; i++) sm[64 + i] = m[i];
      for (i = 0; i < 32; i++) sm[32 + i] = d[32 + i];
      crypto_hash(r, sm.subarray(32), n + 32);
      reduce(r);
      scalarbase(p, r);
      pack(sm, p);
      for (i = 32; i < 64; i++) sm[i] = sk[i];
      crypto_hash(h, sm, n + 64);
      reduce(h);
      for (i = 0; i < 64; i++) x[i] = 0;
      for (i = 0; i < 32; i++) x[i] = r[i];
      for (i = 0; i < 32; i++) {
        for (j = 0; j < 32; j++) {
          x[i + j] += h[i] * d[j];
        }
      }
      modL(sm.subarray(32), x);
      return smlen;
    }
    function unpackneg(r, p) {
      var t = gf(), chk = gf(), num = gf(), den = gf(), den2 = gf(), den4 = gf(), den6 = gf();
      set25519(r[2], gf1);
      unpack25519(r[1], p);
      S(num, r[1]);
      M(den, num, D);
      Z(num, num, r[2]);
      A(den, r[2], den);
      S(den2, den);
      S(den4, den2);
      M(den6, den4, den2);
      M(t, den6, num);
      M(t, t, den);
      pow2523(t, t);
      M(t, t, num);
      M(t, t, den);
      M(t, t, den);
      M(r[0], t, den);
      S(chk, r[0]);
      M(chk, chk, den);
      if (neq25519(chk, num)) M(r[0], r[0], I);
      S(chk, r[0]);
      M(chk, chk, den);
      if (neq25519(chk, num)) return -1;
      if (par25519(r[0]) === p[31] >> 7) Z(r[0], gf0, r[0]);
      M(r[3], r[0], r[1]);
      return 0;
    }
    function crypto_sign_open(m, sm, n, pk) {
      var i;
      var t = new Uint8Array(32), h = new Uint8Array(64);
      var p = [gf(), gf(), gf(), gf()], q = [gf(), gf(), gf(), gf()];
      if (n < 64) return -1;
      if (unpackneg(q, pk)) return -1;
      for (i = 0; i < n; i++) m[i] = sm[i];
      for (i = 0; i < 32; i++) m[i + 32] = pk[i];
      crypto_hash(h, m, n);
      reduce(h);
      scalarmult(p, q, h);
      scalarbase(q, sm.subarray(32));
      add(p, q);
      pack(t, p);
      n -= 64;
      if (crypto_verify_32(sm, 0, t, 0)) {
        for (i = 0; i < n; i++) m[i] = 0;
        return -1;
      }
      for (i = 0; i < n; i++) m[i] = sm[i + 64];
      return n;
    }
    var crypto_secretbox_KEYBYTES = 32, crypto_secretbox_NONCEBYTES = 24, crypto_secretbox_ZEROBYTES = 32, crypto_secretbox_BOXZEROBYTES = 16, crypto_scalarmult_BYTES = 32, crypto_scalarmult_SCALARBYTES = 32, crypto_box_PUBLICKEYBYTES = 32, crypto_box_SECRETKEYBYTES = 32, crypto_box_BEFORENMBYTES = 32, crypto_box_NONCEBYTES = crypto_secretbox_NONCEBYTES, crypto_box_ZEROBYTES = crypto_secretbox_ZEROBYTES, crypto_box_BOXZEROBYTES = crypto_secretbox_BOXZEROBYTES, crypto_sign_BYTES = 64, crypto_sign_PUBLICKEYBYTES = 32, crypto_sign_SECRETKEYBYTES = 64, crypto_sign_SEEDBYTES = 32, crypto_hash_BYTES = 64;
    nacl.lowlevel = {
      crypto_core_hsalsa20,
      crypto_stream_xor,
      crypto_stream,
      crypto_stream_salsa20_xor,
      crypto_stream_salsa20,
      crypto_onetimeauth,
      crypto_onetimeauth_verify,
      crypto_verify_16,
      crypto_verify_32,
      crypto_secretbox,
      crypto_secretbox_open,
      crypto_scalarmult,
      crypto_scalarmult_base,
      crypto_box_beforenm,
      crypto_box_afternm,
      crypto_box,
      crypto_box_open,
      crypto_box_keypair,
      crypto_hash,
      crypto_sign,
      crypto_sign_keypair,
      crypto_sign_open,
      crypto_secretbox_KEYBYTES,
      crypto_secretbox_NONCEBYTES,
      crypto_secretbox_ZEROBYTES,
      crypto_secretbox_BOXZEROBYTES,
      crypto_scalarmult_BYTES,
      crypto_scalarmult_SCALARBYTES,
      crypto_box_PUBLICKEYBYTES,
      crypto_box_SECRETKEYBYTES,
      crypto_box_BEFORENMBYTES,
      crypto_box_NONCEBYTES,
      crypto_box_ZEROBYTES,
      crypto_box_BOXZEROBYTES,
      crypto_sign_BYTES,
      crypto_sign_PUBLICKEYBYTES,
      crypto_sign_SECRETKEYBYTES,
      crypto_sign_SEEDBYTES,
      crypto_hash_BYTES,
      gf,
      D,
      L,
      pack25519,
      unpack25519,
      M,
      A,
      S,
      Z,
      pow2523,
      add,
      set25519,
      modL,
      scalarmult,
      scalarbase
    };
    function checkLengths(k, n) {
      if (k.length !== crypto_secretbox_KEYBYTES) throw new Error("bad key size");
      if (n.length !== crypto_secretbox_NONCEBYTES) throw new Error("bad nonce size");
    }
    function checkBoxLengths(pk, sk) {
      if (pk.length !== crypto_box_PUBLICKEYBYTES) throw new Error("bad public key size");
      if (sk.length !== crypto_box_SECRETKEYBYTES) throw new Error("bad secret key size");
    }
    function checkArrayTypes() {
      for (var i = 0; i < arguments.length; i++) {
        if (!(arguments[i] instanceof Uint8Array))
          throw new TypeError("unexpected type, use Uint8Array");
      }
    }
    function cleanup(arr) {
      for (var i = 0; i < arr.length; i++) arr[i] = 0;
    }
    nacl.randomBytes = function(n) {
      var b = new Uint8Array(n);
      randombytes(b, n);
      return b;
    };
    nacl.secretbox = function(msg, nonce, key2) {
      checkArrayTypes(msg, nonce, key2);
      checkLengths(key2, nonce);
      var m = new Uint8Array(crypto_secretbox_ZEROBYTES + msg.length);
      var c = new Uint8Array(m.length);
      for (var i = 0; i < msg.length; i++) m[i + crypto_secretbox_ZEROBYTES] = msg[i];
      crypto_secretbox(c, m, m.length, nonce, key2);
      return c.subarray(crypto_secretbox_BOXZEROBYTES);
    };
    nacl.secretbox.open = function(box, nonce, key2) {
      checkArrayTypes(box, nonce, key2);
      checkLengths(key2, nonce);
      var c = new Uint8Array(crypto_secretbox_BOXZEROBYTES + box.length);
      var m = new Uint8Array(c.length);
      for (var i = 0; i < box.length; i++) c[i + crypto_secretbox_BOXZEROBYTES] = box[i];
      if (c.length < 32) return null;
      if (crypto_secretbox_open(m, c, c.length, nonce, key2) !== 0) return null;
      return m.subarray(crypto_secretbox_ZEROBYTES);
    };
    nacl.secretbox.keyLength = crypto_secretbox_KEYBYTES;
    nacl.secretbox.nonceLength = crypto_secretbox_NONCEBYTES;
    nacl.secretbox.overheadLength = crypto_secretbox_BOXZEROBYTES;
    nacl.scalarMult = function(n, p) {
      checkArrayTypes(n, p);
      if (n.length !== crypto_scalarmult_SCALARBYTES) throw new Error("bad n size");
      if (p.length !== crypto_scalarmult_BYTES) throw new Error("bad p size");
      var q = new Uint8Array(crypto_scalarmult_BYTES);
      crypto_scalarmult(q, n, p);
      return q;
    };
    nacl.scalarMult.base = function(n) {
      checkArrayTypes(n);
      if (n.length !== crypto_scalarmult_SCALARBYTES) throw new Error("bad n size");
      var q = new Uint8Array(crypto_scalarmult_BYTES);
      crypto_scalarmult_base(q, n);
      return q;
    };
    nacl.scalarMult.scalarLength = crypto_scalarmult_SCALARBYTES;
    nacl.scalarMult.groupElementLength = crypto_scalarmult_BYTES;
    nacl.box = function(msg, nonce, publicKey, secretKey) {
      var k = nacl.box.before(publicKey, secretKey);
      return nacl.secretbox(msg, nonce, k);
    };
    nacl.box.before = function(publicKey, secretKey) {
      checkArrayTypes(publicKey, secretKey);
      checkBoxLengths(publicKey, secretKey);
      var k = new Uint8Array(crypto_box_BEFORENMBYTES);
      crypto_box_beforenm(k, publicKey, secretKey);
      return k;
    };
    nacl.box.after = nacl.secretbox;
    nacl.box.open = function(msg, nonce, publicKey, secretKey) {
      var k = nacl.box.before(publicKey, secretKey);
      return nacl.secretbox.open(msg, nonce, k);
    };
    nacl.box.open.after = nacl.secretbox.open;
    nacl.box.keyPair = function() {
      var pk = new Uint8Array(crypto_box_PUBLICKEYBYTES);
      var sk = new Uint8Array(crypto_box_SECRETKEYBYTES);
      crypto_box_keypair(pk, sk);
      return { publicKey: pk, secretKey: sk };
    };
    nacl.box.keyPair.fromSecretKey = function(secretKey) {
      checkArrayTypes(secretKey);
      if (secretKey.length !== crypto_box_SECRETKEYBYTES)
        throw new Error("bad secret key size");
      var pk = new Uint8Array(crypto_box_PUBLICKEYBYTES);
      crypto_scalarmult_base(pk, secretKey);
      return { publicKey: pk, secretKey: new Uint8Array(secretKey) };
    };
    nacl.box.publicKeyLength = crypto_box_PUBLICKEYBYTES;
    nacl.box.secretKeyLength = crypto_box_SECRETKEYBYTES;
    nacl.box.sharedKeyLength = crypto_box_BEFORENMBYTES;
    nacl.box.nonceLength = crypto_box_NONCEBYTES;
    nacl.box.overheadLength = nacl.secretbox.overheadLength;
    nacl.sign = function(msg, secretKey) {
      checkArrayTypes(msg, secretKey);
      if (secretKey.length !== crypto_sign_SECRETKEYBYTES)
        throw new Error("bad secret key size");
      var signedMsg = new Uint8Array(crypto_sign_BYTES + msg.length);
      crypto_sign(signedMsg, msg, msg.length, secretKey);
      return signedMsg;
    };
    nacl.sign.open = function(signedMsg, publicKey) {
      checkArrayTypes(signedMsg, publicKey);
      if (publicKey.length !== crypto_sign_PUBLICKEYBYTES)
        throw new Error("bad public key size");
      var tmp = new Uint8Array(signedMsg.length);
      var mlen = crypto_sign_open(tmp, signedMsg, signedMsg.length, publicKey);
      if (mlen < 0) return null;
      var m = new Uint8Array(mlen);
      for (var i = 0; i < m.length; i++) m[i] = tmp[i];
      return m;
    };
    nacl.sign.detached = function(msg, secretKey) {
      var signedMsg = nacl.sign(msg, secretKey);
      var sig = new Uint8Array(crypto_sign_BYTES);
      for (var i = 0; i < sig.length; i++) sig[i] = signedMsg[i];
      return sig;
    };
    nacl.sign.detached.verify = function(msg, sig, publicKey) {
      checkArrayTypes(msg, sig, publicKey);
      if (sig.length !== crypto_sign_BYTES)
        throw new Error("bad signature size");
      if (publicKey.length !== crypto_sign_PUBLICKEYBYTES)
        throw new Error("bad public key size");
      var sm = new Uint8Array(crypto_sign_BYTES + msg.length);
      var m = new Uint8Array(crypto_sign_BYTES + msg.length);
      var i;
      for (i = 0; i < crypto_sign_BYTES; i++) sm[i] = sig[i];
      for (i = 0; i < msg.length; i++) sm[i + crypto_sign_BYTES] = msg[i];
      return crypto_sign_open(m, sm, sm.length, publicKey) >= 0;
    };
    nacl.sign.keyPair = function() {
      var pk = new Uint8Array(crypto_sign_PUBLICKEYBYTES);
      var sk = new Uint8Array(crypto_sign_SECRETKEYBYTES);
      crypto_sign_keypair(pk, sk);
      return { publicKey: pk, secretKey: sk };
    };
    nacl.sign.keyPair.fromSecretKey = function(secretKey) {
      checkArrayTypes(secretKey);
      if (secretKey.length !== crypto_sign_SECRETKEYBYTES)
        throw new Error("bad secret key size");
      var pk = new Uint8Array(crypto_sign_PUBLICKEYBYTES);
      for (var i = 0; i < pk.length; i++) pk[i] = secretKey[32 + i];
      return { publicKey: pk, secretKey: new Uint8Array(secretKey) };
    };
    nacl.sign.keyPair.fromSeed = function(seed) {
      checkArrayTypes(seed);
      if (seed.length !== crypto_sign_SEEDBYTES)
        throw new Error("bad seed size");
      var pk = new Uint8Array(crypto_sign_PUBLICKEYBYTES);
      var sk = new Uint8Array(crypto_sign_SECRETKEYBYTES);
      for (var i = 0; i < 32; i++) sk[i] = seed[i];
      crypto_sign_keypair(pk, sk, true);
      return { publicKey: pk, secretKey: sk };
    };
    nacl.sign.publicKeyLength = crypto_sign_PUBLICKEYBYTES;
    nacl.sign.secretKeyLength = crypto_sign_SECRETKEYBYTES;
    nacl.sign.seedLength = crypto_sign_SEEDBYTES;
    nacl.sign.signatureLength = crypto_sign_BYTES;
    nacl.hash = function(msg) {
      checkArrayTypes(msg);
      var h = new Uint8Array(crypto_hash_BYTES);
      crypto_hash(h, msg, msg.length);
      return h;
    };
    nacl.hash.hashLength = crypto_hash_BYTES;
    nacl.verify = function(x, y) {
      checkArrayTypes(x, y);
      if (x.length === 0 || y.length === 0) return false;
      if (x.length !== y.length) return false;
      return vn(x, 0, y, 0, x.length) === 0 ? true : false;
    };
    nacl.setPRNG = function(fn) {
      randombytes = fn;
    };
    (function() {
      var crypto2 = typeof self !== "undefined" ? self.crypto || self.msCrypto : null;
      if (crypto2 && crypto2.getRandomValues) {
        var QUOTA = 65536;
        nacl.setPRNG(function(x, n) {
          var i, v = new Uint8Array(n);
          for (i = 0; i < n; i += QUOTA) {
            crypto2.getRandomValues(v.subarray(i, i + Math.min(n - i, QUOTA)));
          }
          for (i = 0; i < n; i++) x[i] = v[i];
          cleanup(v);
        });
      } else if (typeof require2 !== "undefined") {
        crypto2 = require2("crypto");
        if (crypto2 && crypto2.randomBytes) {
          nacl.setPRNG(function(x, n) {
            var i, v = crypto2.randomBytes(n);
            for (i = 0; i < n; i++) x[i] = v[i];
            cleanup(v);
          });
        }
      }
    })();
  })(typeof module !== "undefined" && module.exports ? module.exports : self.nacl = self.nacl || {});
  return module.exports;
})();
var __wtBlake = (function() {
  var mods = {};
  var req = function(n) {
    return mods[n.replace("./", "")];
  };
  (function(module, exports, require2) {
    const ERROR_MSG_INPUT = "Input must be an string, Buffer or Uint8Array";
    function normalizeInput(input) {
      let ret;
      if (input instanceof Uint8Array) {
        ret = input;
      } else if (typeof input === "string") {
        const encoder = new TextEncoder();
        ret = encoder.encode(input);
      } else {
        throw new Error(ERROR_MSG_INPUT);
      }
      return ret;
    }
    function toHex(bytes) {
      return Array.prototype.map.call(bytes, function(n) {
        return (n < 16 ? "0" : "") + n.toString(16);
      }).join("");
    }
    function uint32ToHex(val) {
      return (4294967296 + val).toString(16).substring(1);
    }
    function debugPrint(label, arr, size) {
      let msg = "\n" + label + " = ";
      for (let i = 0; i < arr.length; i += 2) {
        if (size === 32) {
          msg += uint32ToHex(arr[i]).toUpperCase();
          msg += " ";
          msg += uint32ToHex(arr[i + 1]).toUpperCase();
        } else if (size === 64) {
          msg += uint32ToHex(arr[i + 1]).toUpperCase();
          msg += uint32ToHex(arr[i]).toUpperCase();
        } else throw new Error("Invalid size " + size);
        if (i % 6 === 4) {
          msg += "\n" + new Array(label.length + 4).join(" ");
        } else if (i < arr.length - 2) {
          msg += " ";
        }
      }
      console.log(msg);
    }
    function testSpeed(hashFn, N, M) {
      let startMs = (/* @__PURE__ */ new Date()).getTime();
      const input = new Uint8Array(N);
      for (let i = 0; i < N; i++) {
        input[i] = i % 256;
      }
      const genMs = (/* @__PURE__ */ new Date()).getTime();
      console.log("Generated random input in " + (genMs - startMs) + "ms");
      startMs = genMs;
      for (let i = 0; i < M; i++) {
        const hashHex = hashFn(input);
        const hashMs = (/* @__PURE__ */ new Date()).getTime();
        const ms = hashMs - startMs;
        startMs = hashMs;
        console.log("Hashed in " + ms + "ms: " + hashHex.substring(0, 20) + "...");
        console.log(
          Math.round(N / (1 << 20) / (ms / 1e3) * 100) / 100 + " MB PER SECOND"
        );
      }
    }
    module.exports = {
      normalizeInput,
      toHex,
      debugPrint,
      testSpeed
    };
  })(mods.__u = { exports: {} }, mods.__u.exports, req);
  mods.util = mods.__u.exports;
  var m2 = { exports: {} };
  (function(module, exports, require2) {
    const util = require2("./util");
    function ADD64AA(v2, a, b) {
      const o0 = v2[a] + v2[b];
      let o1 = v2[a + 1] + v2[b + 1];
      if (o0 >= 4294967296) {
        o1++;
      }
      v2[a] = o0;
      v2[a + 1] = o1;
    }
    function ADD64AC(v2, a, b0, b1) {
      let o0 = v2[a] + b0;
      if (b0 < 0) {
        o0 += 4294967296;
      }
      let o1 = v2[a + 1] + b1;
      if (o0 >= 4294967296) {
        o1++;
      }
      v2[a] = o0;
      v2[a + 1] = o1;
    }
    function B2B_GET32(arr, i) {
      return arr[i] ^ arr[i + 1] << 8 ^ arr[i + 2] << 16 ^ arr[i + 3] << 24;
    }
    function B2B_G(a, b, c, d, ix, iy) {
      const x0 = m[ix];
      const x1 = m[ix + 1];
      const y0 = m[iy];
      const y1 = m[iy + 1];
      ADD64AA(v, a, b);
      ADD64AC(v, a, x0, x1);
      let xor0 = v[d] ^ v[a];
      let xor1 = v[d + 1] ^ v[a + 1];
      v[d] = xor1;
      v[d + 1] = xor0;
      ADD64AA(v, c, d);
      xor0 = v[b] ^ v[c];
      xor1 = v[b + 1] ^ v[c + 1];
      v[b] = xor0 >>> 24 ^ xor1 << 8;
      v[b + 1] = xor1 >>> 24 ^ xor0 << 8;
      ADD64AA(v, a, b);
      ADD64AC(v, a, y0, y1);
      xor0 = v[d] ^ v[a];
      xor1 = v[d + 1] ^ v[a + 1];
      v[d] = xor0 >>> 16 ^ xor1 << 16;
      v[d + 1] = xor1 >>> 16 ^ xor0 << 16;
      ADD64AA(v, c, d);
      xor0 = v[b] ^ v[c];
      xor1 = v[b + 1] ^ v[c + 1];
      v[b] = xor1 >>> 31 ^ xor0 << 1;
      v[b + 1] = xor0 >>> 31 ^ xor1 << 1;
    }
    const BLAKE2B_IV32 = new Uint32Array([
      4089235720,
      1779033703,
      2227873595,
      3144134277,
      4271175723,
      1013904242,
      1595750129,
      2773480762,
      2917565137,
      1359893119,
      725511199,
      2600822924,
      4215389547,
      528734635,
      327033209,
      1541459225
    ]);
    const SIGMA8 = [
      0,
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      11,
      12,
      13,
      14,
      15,
      14,
      10,
      4,
      8,
      9,
      15,
      13,
      6,
      1,
      12,
      0,
      2,
      11,
      7,
      5,
      3,
      11,
      8,
      12,
      0,
      5,
      2,
      15,
      13,
      10,
      14,
      3,
      6,
      7,
      1,
      9,
      4,
      7,
      9,
      3,
      1,
      13,
      12,
      11,
      14,
      2,
      6,
      5,
      10,
      4,
      0,
      15,
      8,
      9,
      0,
      5,
      7,
      2,
      4,
      10,
      15,
      14,
      1,
      11,
      12,
      6,
      8,
      3,
      13,
      2,
      12,
      6,
      10,
      0,
      11,
      8,
      3,
      4,
      13,
      7,
      5,
      15,
      14,
      1,
      9,
      12,
      5,
      1,
      15,
      14,
      13,
      4,
      10,
      0,
      7,
      6,
      3,
      9,
      2,
      8,
      11,
      13,
      11,
      7,
      14,
      12,
      1,
      3,
      9,
      5,
      0,
      15,
      4,
      8,
      6,
      2,
      10,
      6,
      15,
      14,
      9,
      11,
      3,
      0,
      8,
      12,
      2,
      13,
      7,
      1,
      4,
      10,
      5,
      10,
      2,
      8,
      4,
      7,
      6,
      1,
      5,
      15,
      11,
      9,
      14,
      3,
      12,
      13,
      0,
      0,
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      11,
      12,
      13,
      14,
      15,
      14,
      10,
      4,
      8,
      9,
      15,
      13,
      6,
      1,
      12,
      0,
      2,
      11,
      7,
      5,
      3
    ];
    const SIGMA82 = new Uint8Array(
      SIGMA8.map(function(x) {
        return x * 2;
      })
    );
    const v = new Uint32Array(32);
    const m = new Uint32Array(32);
    function blake2bCompress(ctx, last) {
      let i = 0;
      for (i = 0; i < 16; i++) {
        v[i] = ctx.h[i];
        v[i + 16] = BLAKE2B_IV32[i];
      }
      v[24] = v[24] ^ ctx.t;
      v[25] = v[25] ^ ctx.t / 4294967296;
      if (last) {
        v[28] = ~v[28];
        v[29] = ~v[29];
      }
      for (i = 0; i < 32; i++) {
        m[i] = B2B_GET32(ctx.b, 4 * i);
      }
      for (i = 0; i < 12; i++) {
        B2B_G(0, 8, 16, 24, SIGMA82[i * 16 + 0], SIGMA82[i * 16 + 1]);
        B2B_G(2, 10, 18, 26, SIGMA82[i * 16 + 2], SIGMA82[i * 16 + 3]);
        B2B_G(4, 12, 20, 28, SIGMA82[i * 16 + 4], SIGMA82[i * 16 + 5]);
        B2B_G(6, 14, 22, 30, SIGMA82[i * 16 + 6], SIGMA82[i * 16 + 7]);
        B2B_G(0, 10, 20, 30, SIGMA82[i * 16 + 8], SIGMA82[i * 16 + 9]);
        B2B_G(2, 12, 22, 24, SIGMA82[i * 16 + 10], SIGMA82[i * 16 + 11]);
        B2B_G(4, 14, 16, 26, SIGMA82[i * 16 + 12], SIGMA82[i * 16 + 13]);
        B2B_G(6, 8, 18, 28, SIGMA82[i * 16 + 14], SIGMA82[i * 16 + 15]);
      }
      for (i = 0; i < 16; i++) {
        ctx.h[i] = ctx.h[i] ^ v[i] ^ v[i + 16];
      }
    }
    const parameterBlock = new Uint8Array([
      0,
      0,
      0,
      0,
      //  0: outlen, keylen, fanout, depth
      0,
      0,
      0,
      0,
      //  4: leaf length, sequential mode
      0,
      0,
      0,
      0,
      //  8: node offset
      0,
      0,
      0,
      0,
      // 12: node offset
      0,
      0,
      0,
      0,
      // 16: node depth, inner length, rfu
      0,
      0,
      0,
      0,
      // 20: rfu
      0,
      0,
      0,
      0,
      // 24: rfu
      0,
      0,
      0,
      0,
      // 28: rfu
      0,
      0,
      0,
      0,
      // 32: salt
      0,
      0,
      0,
      0,
      // 36: salt
      0,
      0,
      0,
      0,
      // 40: salt
      0,
      0,
      0,
      0,
      // 44: salt
      0,
      0,
      0,
      0,
      // 48: personal
      0,
      0,
      0,
      0,
      // 52: personal
      0,
      0,
      0,
      0,
      // 56: personal
      0,
      0,
      0,
      0
      // 60: personal
    ]);
    function blake2bInit(outlen, key2, salt, personal) {
      if (outlen === 0 || outlen > 64) {
        throw new Error("Illegal output length, expected 0 < length <= 64");
      }
      if (key2 && key2.length > 64) {
        throw new Error("Illegal key, expected Uint8Array with 0 < length <= 64");
      }
      if (salt && salt.length !== 16) {
        throw new Error("Illegal salt, expected Uint8Array with length is 16");
      }
      if (personal && personal.length !== 16) {
        throw new Error("Illegal personal, expected Uint8Array with length is 16");
      }
      const ctx = {
        b: new Uint8Array(128),
        h: new Uint32Array(16),
        t: 0,
        // input count
        c: 0,
        // pointer within buffer
        outlen
        // output length in bytes
      };
      parameterBlock.fill(0);
      parameterBlock[0] = outlen;
      if (key2) parameterBlock[1] = key2.length;
      parameterBlock[2] = 1;
      parameterBlock[3] = 1;
      if (salt) parameterBlock.set(salt, 32);
      if (personal) parameterBlock.set(personal, 48);
      for (let i = 0; i < 16; i++) {
        ctx.h[i] = BLAKE2B_IV32[i] ^ B2B_GET32(parameterBlock, i * 4);
      }
      if (key2) {
        blake2bUpdate(ctx, key2);
        ctx.c = 128;
      }
      return ctx;
    }
    function blake2bUpdate(ctx, input) {
      for (let i = 0; i < input.length; i++) {
        if (ctx.c === 128) {
          ctx.t += ctx.c;
          blake2bCompress(ctx, false);
          ctx.c = 0;
        }
        ctx.b[ctx.c++] = input[i];
      }
    }
    function blake2bFinal(ctx) {
      ctx.t += ctx.c;
      while (ctx.c < 128) {
        ctx.b[ctx.c++] = 0;
      }
      blake2bCompress(ctx, true);
      const out = new Uint8Array(ctx.outlen);
      for (let i = 0; i < ctx.outlen; i++) {
        out[i] = ctx.h[i >> 2] >> 8 * (i & 3);
      }
      return out;
    }
    function blake2b(input, key2, outlen, salt, personal) {
      outlen = outlen || 64;
      input = util.normalizeInput(input);
      if (salt) {
        salt = util.normalizeInput(salt);
      }
      if (personal) {
        personal = util.normalizeInput(personal);
      }
      const ctx = blake2bInit(outlen, key2, salt, personal);
      blake2bUpdate(ctx, input);
      return blake2bFinal(ctx);
    }
    function blake2bHex(input, key2, outlen, salt, personal) {
      const output = blake2b(input, key2, outlen, salt, personal);
      return util.toHex(output);
    }
    module.exports = {
      blake2b,
      blake2bHex,
      blake2bInit,
      blake2bUpdate,
      blake2bFinal
    };
  })(m2, m2.exports, req);
  return m2.exports;
})();
function wtSealedBox(messageBytes, recipientPublicKey) {
  var eph = __wtNacl.box.keyPair();
  var both = new Uint8Array(64);
  both.set(eph.publicKey, 0);
  both.set(recipientPublicKey, 32);
  var nonce = __wtBlake.blake2b(both, null, 24);
  var boxed = __wtNacl.box(messageBytes, nonce, recipientPublicKey, eph.secretKey);
  var out = new Uint8Array(32 + boxed.length);
  out.set(eph.publicKey, 0);
  out.set(boxed, 32);
  return out;
}
var AD_WORKFLOW_PATH = ".github/workflows/walrus-tusk-deploy.yml";
var AD_BRANCH = "agent/walrus-tusk-autodeploy";
function adWorkflow({ deployBranch, project, prodBranch, outputDir, buildCommand, rootDir }) {
  const lines = [
    "# Added by Walrus Tusk (mcp.artificialmindhive.com). Deploys this repo to Cloudflare Pages",
    "# on every push to the default branch. Uses the repo secrets CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID.",
    "name: Walrus Tusk deploy",
    "on:",
    "  push:",
    `    branches: [${JSON.stringify(deployBranch)}]`,
    "  workflow_dispatch:",
    "concurrency:",
    "  group: walrus-tusk-deploy",
    "  cancel-in-progress: false",
    "jobs:",
    "  deploy:",
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      contents: read",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: 20"
  ];
  if (buildCommand) lines.push("      - name: Build", `        working-directory: ${JSON.stringify(rootDir)}`, "        run: |", `          ${buildCommand}`);
  lines.push(
    "      - name: Deploy to Cloudflare Pages",
    "        uses: cloudflare/wrangler-action@v3",
    "        with:",
    "          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
    "          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
    `          workingDirectory: ${JSON.stringify(rootDir)}`,
    `          command: pages deploy ${outputDir} --project-name=${project} --branch=${prodBranch} --commit-dirty=true`
  );
  return lines.join("\n") + "\n";
}
function adBytes(s) {
  return new TextEncoder().encode(s);
}
function adB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  return btoa(s);
}
function adUnb64(s) {
  const bin = atob(s);
  const o = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i);
  return o;
}
async function siteAutodeploy(cfClient, cfToken, accountId, ghEnv, args) {
  const repo = ghRepo(args.repo, ghEnv);
  const project = pagesProject(args.project);
  const outputDir = String(args.output_dir || ".").trim() || ".";
  const rootDir = String(args.root_dir || ".").trim() || ".";
  for (const [k, v] of [["output_dir", outputDir], ["root_dir", rootDir]]) if (!/^[A-Za-z0-9._/-]{1,120}$/.test(v) || v.includes("..")) throw new Error(`${k} must be a simple relative folder like "." or "dist"`);
  const buildCommand = String(args.build_command || "").trim();
  if (/[\r\n]/.test(buildCommand) || buildCommand.length > 300) throw new Error("build_command must be one line (e.g. npm ci && npm run build)");
  const info = await gh(ghEnv, "GET", `/repos/${repo}`);
  const deployBranch = String(args.deploy_branch || info.default_branch);
  let proj = null, created = false;
  try {
    proj = await pagesGetProject(cfClient, accountId, project);
  } catch (e) {
    if (!/not found|8000007|404/i.test(String(e.message))) throw e;
  }
  const prodBranch = proj ? proj.production_branch : "main";
  const workflow = adWorkflow({ deployBranch, project, prodBranch, outputDir, buildCommand, rootDir });
  const plan = {
    repo,
    deploys_on_push_to: deployBranch,
    pages_project: project,
    project_exists: !!proj,
    live_domains: proj ? proj.domains : [`${project}.pages.dev (new)`],
    production_branch: prodBranch,
    secrets_to_set: ["CLOUDFLARE_API_TOKEN (your saved Cloudflare token)", "CLOUDFLARE_ACCOUNT_ID"],
    workflow_file: AD_WORKFLOW_PATH,
    workflow,
    after: "A pull request opens in your repo. Tap Merge in the GitHub app: from then on every merge to " + deployBranch + " deploys the whole site, server code included."
  };
  if (args.apply !== true) return { dry_run: true, ...plan, next: "call again with apply=true" };
  if (!proj) {
    const { result } = await cfClient.request("POST", `/accounts/${accountId}/pages/projects`, { name: project, production_branch: "main" });
    proj = result;
    created = true;
  }
  const pk = await gh(ghEnv, "GET", `/repos/${repo}/actions/secrets/public-key`);
  for (const [name, value] of [["CLOUDFLARE_API_TOKEN", cfToken], ["CLOUDFLARE_ACCOUNT_ID", accountId]]) {
    const sealed = wtSealedBox(adBytes(value), adUnb64(pk.key));
    await gh(ghEnv, "PUT", `/repos/${repo}/actions/secrets/${name}`, { encrypted_value: adB64(sealed), key_id: pk.key_id });
  }
  const head = (await gh(ghEnv, "GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(info.default_branch)}`)).object.sha;
  try {
    await gh(ghEnv, "POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${AD_BRANCH}`, sha: head });
  } catch (e) {
    if (e.status !== 422) throw e;
  }
  let existingSha;
  try {
    existingSha = (await gh(ghEnv, "GET", `/repos/${repo}/contents/${AD_WORKFLOW_PATH}?ref=${encodeURIComponent(AD_BRANCH)}`)).sha;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  await gh(ghEnv, "PUT", `/repos/${repo}/contents/${AD_WORKFLOW_PATH}`, { message: "Walrus Tusk: deploy to Cloudflare Pages on push", content: adB64(adBytes(workflow)), branch: AD_BRANCH, ...existingSha ? { sha: existingSha } : {} });
  let pr;
  const open = await gh(ghEnv, "GET", `/repos/${repo}/pulls?state=open&head=${repo.split("/")[0]}:${encodeURIComponent(AD_BRANCH)}`);
  if (open.length) pr = open[0];
  else pr = await gh(ghEnv, "POST", `/repos/${repo}/pulls`, { title: "Walrus Tusk: auto-deploy to Cloudflare Pages", head: AD_BRANCH, base: info.default_branch, body: `Adds \`${AD_WORKFLOW_PATH}\`. After you merge, every push to \`${deployBranch}\` deploys \`${outputDir}\` to the Cloudflare Pages project **${project}** (${(proj.domains || []).join(", ") || project + ".pages.dev"}).

Repo secrets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID were set by Walrus Tusk. Remove them under Settings \u2192 Secrets \u2192 Actions to turn this off.` });
  return { applied: true, ...plan, project_created: created, secrets_set: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"], pull_request: pr.html_url, next: "Tap Merge on that pull request. The first deploy starts right after; check it with site_autodeploy_status." };
}
async function siteAutodeployStatus(ghEnv, args) {
  const repo = ghRepo(args.repo, ghEnv);
  let runs;
  try {
    runs = await gh(ghEnv, "GET", `/repos/${repo}/actions/workflows/walrus-tusk-deploy.yml/runs?per_page=5`);
  } catch (e) {
    if (e.status === 404) return { repo, set_up: false, note: "No Walrus Tusk deploy workflow on the default branch yet. Run site_autodeploy, then merge its PR." };
    throw e;
  }
  return { repo, set_up: true, runs: (runs.workflow_runs || []).map((r) => ({ status: r.status, result: r.conclusion, commit: (r.head_sha || "").slice(0, 7), message: (r.display_title || "").slice(0, 80), started: r.run_started_at, url: r.html_url })) };
}
var AUTODEPLOY_TOOL_DEFS = [
  {
    name: "site_autodeploy",
    description: "One-time setup for sites with server code (Functions/_worker), or any site you keep in GitHub: deploys the repo to a Cloudflare Pages project on every push via GitHub Actions \u2014 no PC. Sets the repo secrets and opens a pull request adding the workflow; the user taps Merge to turn it on. Dry-run by default; apply=true does it. After that, change the site with repo_commit_push + repo_open_pr + repo_merge_pr.",
    inputSchema: { type: "object", properties: {
      repo: { type: "string", description: "owner/name" },
      project: { type: "string", description: "Cloudflare Pages project (created if it doesn't exist)" },
      account: { type: "string" },
      output_dir: { type: "string", description: "folder to deploy, default '.'" },
      build_command: { type: "string", description: "optional, one line, e.g. npm ci && npm run build" },
      root_dir: { type: "string", description: "repo subfolder to work in, default '.'" },
      deploy_branch: { type: "string", description: "default: the repo's default branch" },
      apply: { type: "boolean" }
    }, required: ["repo", "project"] }
  },
  {
    name: "site_autodeploy_status",
    description: "Latest Walrus Tusk deploy runs for a repo (queued / running / success / failure, with links).",
    inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] }
  }
];
var WTU_PREFIX = "wtu_";
var WTU_PAGES_TOOLS = ["pages_list_deployments", "pages_get_deployment", "pages_read_file", "pages_patch", "pages_deploy", "pages_rollback", "pages_special_files"];
var WTU_REPO_TOOLS = ["repo_list", "repo_read", "repo_search", "repo_commit_push", "repo_open_pr", "repo_merge_pr"];
var WTU_JOIN_PER_HOUR = 5;
function wtuB64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function wtuUnb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function wtuSha(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function wtuRandom(n) {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const r = crypto.getRandomValues(new Uint8Array(n));
  return [...r].map((x) => abc[x % abc.length]).join("");
}
async function wtuCryptoKey(env) {
  if (!env.WT_USER_SECRET) throw new Error("hub is missing WT_USER_SECRET");
  return crypto.subtle.importKey("raw", wtuUnb64(env.WT_USER_SECRET), "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function wtuEncrypt(env, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await wtuCryptoKey(env), new TextEncoder().encode(JSON.stringify(obj)));
  return { iv: wtuB64(iv), ct: wtuB64(new Uint8Array(ct)) };
}
async function wtuDecrypt(env, rec) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: wtuUnb64(rec.iv) }, await wtuCryptoKey(env), wtuUnb64(rec.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
async function wtuAuthorize(env, provided) {
  if (!env.CLOUDFLARE_OPS_OAUTH) return { ok: false, reason: "storage_unavailable" };
  const keyHash = await wtuSha(provided);
  const user = await env.CLOUDFLARE_OPS_OAUTH.get(`wtuser:${keyHash}`, "json");
  if (!user || user.disabled) return { ok: false, reason: "invalid_user_key" };
  return { ok: true, mode: "user", userId: user.id, keyHash };
}
async function wtuCreds(env, userId) {
  const rec = await env.CLOUDFLARE_OPS_OAUTH.get(`wtcreds:${userId}`, "json");
  return rec ? await wtuDecrypt(env, rec) : null;
}
async function wtuCheckCloudflare(token) {
  const call = async (p) => {
    const r = await fetch(`https://api.cloudflare.com/client/v4${p}`, { headers: { authorization: `Bearer ${token}` } });
    return r.json().catch(() => ({}));
  };
  const acc = await call("/accounts?per_page=50");
  if (!acc.success || !(acc.result || []).length) return { ok: false, error: "Cloudflare didn't accept that token, or it can't see any account. Make sure it has Account \u2192 Cloudflare Pages \u2192 Edit." };
  const accounts = [];
  for (const a of acc.result) {
    const names = [];
    let pagesOk = false;
    for (let page2 = 1; page2 <= 10; page2++) {
      const p = await call(`/accounts/${a.id}/pages/projects?per_page=10&page=${page2}`);
      if (!p.success) break;
      pagesOk = true;
      names.push(...(p.result || []).map((x) => x.name));
      if ((p.result || []).length < 10) break;
    }
    accounts.push({ id: a.id, name: a.name, pages: pagesOk, projects: names });
  }
  if (!accounts.some((a) => a.pages)) return { ok: false, error: "The token works but has no Pages permission. Edit it and add Account \u2192 Cloudflare Pages \u2192 Edit." };
  return { ok: true, accounts };
}
async function wtuCheckGithub(token) {
  const h = { authorization: `Bearer ${token}`, "user-agent": "walrus-tusk-hub", accept: "application/vnd.github+json" };
  const u = await fetch("https://api.github.com/user", { headers: h });
  if (!u.ok) return { ok: false, error: "GitHub didn't accept that token." };
  const me = await u.json();
  const o = await fetch("https://api.github.com/user/orgs?per_page=100", { headers: h });
  const orgs = o.ok ? (await o.json()).map((x) => x.login) : [];
  return { ok: true, login: me.login, owners: [me.login, ...orgs] };
}
function wtuJson(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" } });
}
async function wtuBody(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await request.json().catch(() => ({}));
  const f = await request.formData().catch(() => null);
  return f ? Object.fromEntries(f) : {};
}
async function wtuHandleHttp(request, env, url) {
  const p = url.pathname.replace(/\/+$/, "") || "/";
  if (p !== "/join" && p !== "/setup") return null;
  if (request.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type" } });
  if (request.method === "GET") return new Response(wtuPage(p, url.origin), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://walohq.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" } });
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const kv = env.CLOUDFLARE_OPS_OAUTH;
  const body = await wtuBody(request);
  if (p === "/join") {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const hourKey = `wtjoin:${await wtuSha(ip)}:${(/* @__PURE__ */ new Date()).toISOString().slice(0, 13)}`;
    const n = Number(await kv.get(hourKey)) || 0;
    if (n >= WTU_JOIN_PER_HOUR) return wtuJson({ error: "too many new keys from this network this hour; try again later" }, 429);
    await kv.put(hourKey, String(n + 1), { expirationTtl: 7200 });
    const key3 = WTU_PREFIX + wtuRandom(40);
    const id = "u_" + wtuRandom(16);
    await kv.put(`wtuser:${await wtuSha(key3)}`, JSON.stringify({ id, created: (/* @__PURE__ */ new Date()).toISOString(), label: String(body.label || "").slice(0, 60) }));
    return wtuJson({ ok: true, key: key3, mcp_url: `${url.origin}/mcp?key=${key3}`, setup_url: `${url.origin}/setup`, note: "Save this key now \u2014 it is shown once. Next: add the MCP link to your AI app. Tokens are optional: add a Cloudflare or GitHub token at /setup only when you want your AI to edit your own sites." });
  }
  const key2 = String(body.key || "").trim();
  const auth = key2.startsWith(WTU_PREFIX) ? await wtuAuthorize(env, key2) : { ok: false };
  if (!auth.ok) return wtuJson({ error: "unknown key \u2014 get one at /join" }, 401);
  const creds = await wtuCreds(env, auth.userId) || {};
  if (body.delete === true || body.delete === "true") {
    await kv.delete(`wtcreds:${auth.userId}`);
    return wtuJson({ ok: true, deleted: true, note: "Your saved tokens are gone from the hub. Also revoke them in Cloudflare/GitHub." });
  }
  const out = { ok: true };
  const cfTok = String(body.cloudflare_token || "").trim();
  const ghTok = String(body.github_token || "").trim();
  if (!cfTok && !ghTok) return wtuJson({ ok: true, saved: false, next: `Your key works. Add it to your AI app as an MCP connector: ${url.origin}/mcp?key=<your key>. Tokens are optional; add one here when you want your AI to edit your sites.` });
  if (cfTok) {
    const c = await wtuCheckCloudflare(cfTok);
    if (!c.ok) return wtuJson({ error: c.error }, 400);
    creds.cf_token = cfTok;
    creds.cf_accounts = c.accounts.map((a) => ({ id: a.id, name: a.name, pages: a.pages }));
    out.cloudflare = c.accounts.map((a) => ({ account: a.name, pages_access: a.pages, sites: a.projects }));
  }
  if (ghTok) {
    const g = await wtuCheckGithub(ghTok);
    if (!g.ok) return wtuJson({ error: g.error }, 400);
    creds.gh_token = ghTok;
    creds.gh_login = g.login;
    creds.gh_owners = g.owners;
    out.github = { login: g.login, owners: g.owners };
  }
  creds.updated = (/* @__PURE__ */ new Date()).toISOString();
  await kv.put(`wtcreds:${auth.userId}`, JSON.stringify(await wtuEncrypt(env, creds)));
  out.next = `Add this to your AI app as an MCP connector: ${url.origin}/mcp?key=<your key>. Then ask it to "list my sites".`;
  return wtuJson(out);
}
var WTU_EXTRA_DEFS = [
  { name: "my_sites", description: "List the Cloudflare Pages sites your token can see (all your accounts): project, production branch, domains, last deploy. Start here.", inputSchema: { type: "object", properties: {} } },
  { name: "wt_whoami", description: "Show what this Walrus Tusk key is connected to (Cloudflare accounts, GitHub login). Tokens are never shown.", inputSchema: { type: "object", properties: {} } }
];
function wtuToolDefs() {
  const all = [...TOOLS, ...GITHUB_TOOL_DEFS];
  const pick = (n) => all.find((t) => t.name === n);
  const fix = (t) => {
    const c = JSON.parse(JSON.stringify(t));
    if (c.inputSchema && c.inputSchema.properties && c.inputSchema.properties.account) {
      c.inputSchema.properties.account = { type: "string", description: "your Cloudflare account id or name (default: your first account)" };
      c.inputSchema.required = (c.inputSchema.required || []).filter((r) => r !== "account");
    }
    if (c.inputSchema && c.inputSchema.properties && c.inputSchema.properties.repo) c.inputSchema.properties.repo = { type: "string", description: "owner/name (your login or one of your orgs), or just name" };
    c.description = c.description.replace(/pain2hustle1?\/\*?(<name>)?/g, "your").replace(/Austin(['’]s)?/g, "your").replace(/amh \(pain2hustle1\) or doors \(austinsdoors1\)/g, "your account");
    return c;
  };
  return [...WTU_EXTRA_DEFS, ...WTU_PAGES_TOOLS.map(pick), ...WTU_REPO_TOOLS.map(pick), ...AUTODEPLOY_TOOL_DEFS].filter(Boolean).map(fix);
}
function wtuAccount(creds, wanted) {
  const list = creds.cf_accounts || [];
  if (!wanted) return (list.find((a) => a.pages) || list[0] || {}).id;
  const w = String(wanted).trim().toLowerCase();
  const hit = list.find((a) => a.id === w || String(a.name || "").toLowerCase() === w);
  if (!hit) throw new Error(`that account isn't on your token. Yours: ${list.map((a) => a.name).join(", ")}`);
  return hit.id;
}
async function wtuCallTool(name, args, env, authContext, origin) {
  try {
    const creds = await wtuCreds(env, authContext.userId);
    const setup = `${origin || "https://mcp.artificialmindhive.com"}/setup`;
    if (name === "wt_whoami") return { cloudflare_accounts: (creds && creds.cf_accounts || []).map((a) => ({ name: a.name, id: a.id, pages: a.pages })), github: creds && creds.gh_login || null, setup_page: setup };
    if (!creds || !creds.cf_token) return { error: `this key has no Cloudflare token yet. Add one at ${setup}` };
    if (name === "my_sites") {
      const client = new CloudflareClient({ token: creds.cf_token });
      const out = [];
      for (const a of creds.cf_accounts.filter((x) => x.pages)) {
        for (let page2 = 1; page2 <= 10; page2++) {
          const { result } = await client.request("GET", `/accounts/${a.id}/pages/projects?per_page=10&page=${page2}`);
          for (const pr of result || []) out.push({ account: a.name, project: pr.name, production_branch: pr.production_branch, domains: pr.domains, last_deploy: pr.canonical_deployment && pr.canonical_deployment.created_on });
          if (!result || result.length < 10) break;
        }
      }
      return { sites: out, tip: "Read a page with pages_read_file, change it with pages_patch (dry-run first, then apply:true)." };
    }
    if (name === "pages_deploy" && (args.patch === true || Array.isArray(args.edits))) name = "pages_patch";
    if (name === "pages_get_deployment" && args.path) name = "pages_read_file";
    if (WTU_PAGES_TOOLS.includes(name) || name === "pages_read_file") {
      const a = { ...args, account: wtuAccount(creds, args.account) };
      const client = new CloudflareClient({ token: creds.cf_token });
      if (name === "pages_patch") return await pagesPatch(client, a, env, `wtu:${authContext.userId}`);
      if (name === "pages_read_file") return await pagesReadFile(client, a);
      if (name === "pages_special_files") return await pagesSaveSpecial(client, a, env);
      return await runPagesDeployTool(name, a, client, null);
    }
    if (WTU_REPO_TOOLS.includes(name)) {
      if (!creds.gh_token) return { error: `this key has no GitHub token yet. Add one at ${setup}` };
      const env2 = { ...env, GITHUB_TOKEN: creds.gh_token, GH_OWNERS_OVERRIDE: creds.gh_owners || [creds.gh_login] };
      return await runGithubTool(name, args, env2, `wtu:${authContext.userId}`);
    }
    if (name === "site_autodeploy" || name === "site_autodeploy_status") {
      if (!creds.gh_token) return { error: `site_autodeploy needs a GitHub token too. Add one at ${setup}` };
      const env2 = { ...env, GITHUB_TOKEN: creds.gh_token, GH_OWNERS_OVERRIDE: creds.gh_owners || [creds.gh_login] };
      if (name === "site_autodeploy_status") return await siteAutodeployStatus(env2, args);
      return await siteAutodeploy(new CloudflareClient({ token: creds.cf_token }), creds.cf_token, wtuAccount(creds, args.account), env2, args);
    }
    return { error: `${name} isn't available on user keys` };
  } catch (e) {
    return { error: String(e && e.message || e).slice(0, 600) };
  }
}
function wtuPage(p, origin) {
  const css = `:root{--bg:#06140d;--card:#0c2117;--line:#4cdc8233;--gold:#4cdc82;--gold2:#8ff0b6;--ink:#f3efe2;--mut:#b6cbbd;--bad:#ff7a7a;--ok:#4cdc82;--amh:#f5a524}
*{box-sizing:border-box}html,body{margin:0}body{background:radial-gradient(800px 420px at 85% -5%,#1d5c3a 0%,transparent 65%),radial-gradient(700px 480px at 0% 0%,#0f2a1c 0%,transparent 60%),var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;min-height:100vh}
.wt-topbar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:10px;padding:10px 16px;background:#06140dcc;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.wt-topbar .back{color:var(--ink);text-decoration:none;font-weight:800;font-size:18px;width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;border-radius:9px;background:#ffffff10}
.wt-brand{display:flex;align-items:center;gap:8px;color:var(--ink);text-decoration:none;font-weight:800;letter-spacing:-.01em}.wt-brand img{width:34px;height:34px;object-fit:contain}
.wt-brand small{color:var(--gold);font-weight:700;font-size:11px;letter-spacing:.12em;text-transform:uppercase}
.amh{margin-left:auto;display:inline-flex;align-items:center;gap:8px;text-decoration:none}
.badge{position:relative;width:30px;height:30px;display:flex;align-items:center;justify-content:center;border:2px solid var(--amh);border-radius:8px;box-shadow:inset 0 0 12px #f5a52414,0 0 18px #f5a52466}
.badge b{font:800 10.5px/1 Syne,system-ui;letter-spacing:-.02em;background:linear-gradient(#ffd089,#f5a524 55%,#c97914);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.ufo{position:absolute;border:1.2px solid var(--amh);border-radius:50%;animation:ufo 4s ease-in-out infinite}.ufo::after{content:"";position:absolute;width:22%;height:40%;left:39%;top:30%;background:var(--amh);border-radius:50%}
.ufo.a{left:5px;top:-6px;width:9px;height:4px}.ufo.b{right:3px;top:-8px;width:10px;height:5px;animation-delay:-2s}@keyframes ufo{50%{transform:translate(2px,-2px)}}
main{max-width:600px;margin:0 auto;padding:26px 16px 40px}
.hero{display:grid;grid-template-columns:110px 1fr;gap:16px;align-items:center;margin:0 0 6px}.hero img{width:110px;height:auto;filter:drop-shadow(0 10px 24px #4cdc8240)}
h1{font-size:30px;margin:0 0 4px;letter-spacing:-.02em;color:var(--ink)}h1 b{color:var(--gold)}
.sub{color:var(--mut);margin:0 0 14px}.what{background:#4cdc8212;border:1px solid var(--line);border-radius:14px;padding:12px 14px;color:var(--mut);font-size:14px;margin:0 0 6px}.what b{color:var(--ink)}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;margin:14px 0}
h2{font-size:13px;margin:0 0 10px;color:var(--gold);text-transform:uppercase;letter-spacing:.12em}ol{padding-left:20px;margin:6px 0}li{margin:5px 0}
label{display:block;font-size:13px;color:var(--mut);margin:12px 0 4px}input{width:100%;padding:12px;border-radius:10px;border:1px solid var(--line);background:#06140d;color:var(--ink);font:14px ui-monospace,Consolas,monospace}
button{width:100%;margin-top:16px;padding:14px;border:0;border-radius:12px;background:linear-gradient(180deg,#8ff0b6,#4cdc82);color:#062614;font-weight:800;font-size:16px;cursor:pointer}
code,.mono{font-family:ui-monospace,Consolas,monospace;font-size:13px;word-break:break-all}.out{white-space:pre-wrap;margin-top:12px;font-size:13px}.bad{color:var(--bad)}.ok{color:var(--ok)}a{color:var(--gold2)}
.key{background:#06140d;border:1px dashed var(--gold);border-radius:10px;padding:12px;margin:8px 0}
.wt-foot{border-top:1px solid var(--line);margin-top:30px;padding:22px 16px 34px;text-align:center;color:var(--mut);font-size:13px}
.wt-foot nav{display:flex;flex-wrap:wrap;justify-content:center;gap:4px 14px;margin:10px 0}.wt-foot a{color:var(--mut);text-decoration:none}.wt-foot a:hover{color:var(--gold2)}
@media (max-width:520px){.hero{grid-template-columns:72px 1fr}.hero img{width:72px}h1{font-size:24px}.amh small{display:none}}`;
  const head = (t) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t} \u2014 Walrus Tusk</title><link rel="icon" href="https://walohq.com/board/walrus-tusk.webp"><style>${css}</style></head><body><div class="wt-topbar"><a class="back" href="https://artificialmindhive.com/WT/" aria-label="Back to Walrus Tusk">\u2039</a><a class="wt-brand" href="https://artificialmindhive.com/WT/"><img src="https://walohq.com/board/walrus-tusk.webp" alt=""><span>Walrus Tusk<br><small>Cloudflare Ops MCP</small></span></a><a class="amh" href="https://artificialmindhive.com" title="Artificial Mind Hive"><span class="badge"><i class="ufo a"></i><i class="ufo b"></i><b>AMH</b></span></a></div><main>`;
  if (p === "/join") return head("Get your key") + `
<div class="hero"><img src="https://walohq.com/board/walrus-tusk.webp" alt="Walrus Tusk"><div><h1>Walrus <b>Tusk</b></h1><p class="sub">Let your AI edit and deploy your Cloudflare sites from your phone.</p></div></div><p class="what"><b>What is this?</b> Walrus Tusk is the hub Austin's own agents use to ship his sites safely: dry run first, a health check after every change, automatic rollback. This page gives <b>your</b> AI (Grok, Claude, ChatGPT) the same tools for <b>your</b> sites. Your tokens are encrypted and only ever used on your own accounts.</p>
<div class="card"><h2>1 \xB7 Get your key</h2><p>One tap. No account, no email.</p><button id="go">Get my key</button><div id="res" class="out"></div></div>
<div class="card"><h2>How it works</h2><ol><li>Get a key here.</li><li>Add the MCP link to Grok, Claude or ChatGPT.</li><li>Optional, when you want your AI to edit your own sites: add a Cloudflare or GitHub token on the <a href="${origin}/setup">setup page</a>.</li><li>Say \u201Clist my sites\u201D, then \u201Cchange \u2026 on my homepage\u201D. It reads the live page, shows a dry run, and deploys only the changed file.</li></ol></div>
<script>document.getElementById('go').onclick=async()=>{const b=document.getElementById('go');b.disabled=true;b.textContent='\u2026';const r=await fetch('/join',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});const j=await r.json();const o=document.getElementById('res');
if(!r.ok){o.innerHTML='<span class=bad>'+(j.error||'failed')+'</span>';b.disabled=false;b.textContent='Get my key';return}
b.style.display='none';o.innerHTML='<b class=ok>Your key (save it now, shown once):</b><div class="key mono">'+j.key+'</div><b>MCP link for your AI app:</b><div class="key mono">'+j.mcp_url+'</div><p class="sub">Paste that link into Grok, Claude or ChatGPT as an MCP connector and you're in. No token needed for this.</p><a href="/setup#'+j.key+'">Later, to let your AI edit your own sites: add a token (optional) \u2192</a>';try{localStorage.setItem('wtu',j.key)}catch(e){}}<\/script></main><footer class="wt-foot"><a class="amh" href="https://artificialmindhive.com" style="margin:0 auto;justify-content:center"><span class="badge"><i class="ufo a"></i><i class="ufo b"></i><b>AMH</b></span></a><nav><a href="https://artificialmindhive.com/WT/">Walrus Tusk</a><a href="https://walohq.com/board/">Agent Board</a><a href="https://walohq.com/">WALO</a><a href="https://amhagentbook.com/">Agent Book</a><a href="https://artificialmindhive.com">Artificial Mind Hive</a></nav><div>Walrus Tusk by Artificial Mind Hive \xB7 your tokens stay encrypted and only touch your own accounts</div></footer></body></html>`;
  return head("Setup") + `
<div class="hero"><img src="https://walohq.com/board/walrus-tusk.webp" alt="Walrus Tusk"><div><h1>Walrus <b>Tusk</b> setup</h1><p class="sub" style="margin:0">Tokens are optional. Your key already connects; a token only lets your AI edit and deploy <b>your own</b> sites.</p></div></div><p class="sub">Your tokens are encrypted and only ever used for your own accounts. You can delete them any time.</p>
<div class="card"><h2>Connect your AI now</h2><p class="sub" style="margin:0 0 6px">Paste this into Grok, Claude or ChatGPT as an MCP connector. No token needed.</p><div id="mcp" class="key mono">Put your key in the box at the bottom.</div></div>
<div class="card"><h2>Cloudflare token <small>(optional \xB7 lets your AI edit your Cloudflare sites)</small></h2><ol><li>Open <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank">Cloudflare \u2192 API Tokens</a> \u2192 <b>Create Token</b> \u2192 <b>Custom token</b>.</li><li>Permissions: <b>Account \u2192 Cloudflare Pages \u2192 Edit</b>. Optional: <b>Zone \u2192 Analytics \u2192 Read</b>.</li><li>Account resources: your account. Create, then copy the token.</li></ol></div>
<div class="card"><h2>GitHub token (optional)</h2><ol><li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank">GitHub \u2192 Fine-grained token</a>.</li><li>Repository access: the repos you want your AI to edit.</li><li>Permissions: <b>Contents</b>, <b>Pull requests</b> \u2192 Read and write. For sites with server code also <b>Secrets</b>, <b>Workflows</b>, <b>Actions</b> \u2192 Read and write (used once, by auto-deploy setup).</li></ol><p class="sub" style="margin:8px 0 0">Your AI can then commit to <code>grok/\u2026</code> or <code>agent/\u2026</code> branches and open/merge PRs. It can't force-push, delete branches, or touch <code>.github/</code>.</p></div>
<div class="card"><h2>Save</h2><label>Your Walrus Tusk key</label><input id="k" placeholder="wtu_\u2026" autocomplete="off"><label>Cloudflare API token (optional)</label><input id="cf" type="password" autocomplete="off"><label>GitHub token (optional)</label><input id="gh" type="password" autocomplete="off"><button id="save">Check &amp; save</button><div id="res" class="out"></div></div>
<script>const k=document.getElementById('k');k.value=(location.hash.slice(1)||(()=>{try{return localStorage.getItem('wtu')||''}catch(e){return''}})());const showMcp=()=>{const v=k.value.trim();document.getElementById('mcp').textContent=v.startsWith('wtu_')?location.origin+'/mcp?key='+v:'Put your key in the box at the bottom.'};k.oninput=showMcp;showMcp();
document.getElementById('save').onclick=async()=>{const b=document.getElementById('save');b.disabled=true;b.textContent='Checking\u2026';const r=await fetch('/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:k.value.trim(),cloudflare_token:document.getElementById('cf').value.trim(),github_token:document.getElementById('gh').value.trim()})});const j=await r.json();const o=document.getElementById('res');b.disabled=false;b.textContent='Check & save';
if(!r.ok){o.innerHTML='<span class=bad>'+(j.error||'failed')+'</span>';return}document.getElementById('cf').value='';document.getElementById('gh').value='';
let h='<b class=ok>'+((j.cloudflare||j.github)?'Saved.':'Your key works. No tokens added, and that is fine.')+'</b>\\n';(j.cloudflare||[]).forEach(a=>h+='Cloudflare: '+a.account+(a.pages_access?' \u2014 '+a.sites.length+' site(s): '+a.sites.join(', '):' \u2014 no Pages access')+'\\n');if(j.github)h+='GitHub: '+j.github.login+'\\n';h+='\\nAdd to your AI app as an MCP connector:\\n<span class=mono>'+location.origin+'/mcp?key='+k.value.trim()+'</span>\\n\\nThen say: \u201Clist my sites\u201D.';o.innerHTML=h}<\/script></main><footer class="wt-foot"><a class="amh" href="https://artificialmindhive.com" style="margin:0 auto;justify-content:center"><span class="badge"><i class="ufo a"></i><i class="ufo b"></i><b>AMH</b></span></a><nav><a href="https://artificialmindhive.com/WT/">Walrus Tusk</a><a href="https://walohq.com/board/">Agent Board</a><a href="https://walohq.com/">WALO</a><a href="https://amhagentbook.com/">Agent Book</a><a href="https://artificialmindhive.com">Artificial Mind Hive</a></nav><div>Walrus Tusk by Artificial Mind Hive \xB7 your tokens stay encrypted and only touch your own accounts</div></footer></body></html>`;
}
var INBOX_AGENTS = ["grok", "claude", "jubber", "codex", "gemini", "owner", "any"];
var CLOUD_WAKE = ["grok", "austinsdoors", "claude", "codex", "gemini"];
async function wakeCloudAgent(env, task) {
  await runGithubTool("repo_commit_push", { repo: "pain2hustle/amhicle", branch: "agent/dispatch", message: "wake for " + task.id, files: [{ path: "wake.txt", content: new Date().toISOString() + " " + task.id }] }, env, "board").catch(() => null);
}
var INBOX_TTL = 60 * 60 * 24 * 90;
function inboxId() {
  const r = crypto.getRandomValues(new Uint8Array(4));
  return Date.now().toString(36) + "-" + [...r].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function inboxAgent(a, field) {
  const s = String(a || "").trim().toLowerCase();
  if (!/^[a-z0-9._-]{1,30}$/.test(s)) throw new Error(`${field} must be an agent name like ${INBOX_AGENTS.join(", ")}`);
  return s;
}
async function inboxAll(env) {
  const kv = env.CLOUDFLARE_OPS_OAUTH;
  const out = [];
  let cursor;
  for (let i = 0; i < 5; i++) {
    const page2 = await kv.list({ prefix: "task:", cursor, limit: 1e3 });
    for (const k of page2.keys) {
      const t = await kv.get(k.name, "json");
      if (t) out.push(t);
    }
    if (page2.list_complete) break;
    cursor = page2.cursor;
  }
  return out.sort((a, b) => a.created < b.created ? 1 : -1);
}
async function inboxPut(env, t) {
  await env.CLOUDFLARE_OPS_OAUTH.put(`task:${t.id}`, JSON.stringify(t), { expirationTtl: INBOX_TTL });
}
async function inboxGet(env, id) {
  if (!/^[a-z0-9]+-[0-9a-f]{8}$/.test(String(id || ""))) throw new Error("bad task id");
  const t = await env.CLOUDFLARE_OPS_OAUTH.get(`task:${id}`, "json");
  if (!t) throw new Error("no such task");
  return t;
}
var inboxView = (t) => ({ id: t.id, to: t.to, from: t.from, status: t.status, text: t.text, created: t.created, claimed_by: t.claimed_by || null, claimed: t.claimed || null, finished: t.finished || null, result: t.result || null, notify: !!t.notify, ...(t.receipt_only ? {receipt_only: true, details_removed_at: t.details_removed_at} : {}) });
async function inboxNotify(env, t) {
  try {
    const out = await callFederated(env, "walo", "walo_notify", { template: "ping", text: `Task ${t.id} ${t.status} by ${t.claimed_by || t.to}: ${String(t.text).slice(0, 80)}` });
    return { whatsapp: out && !out.error ? "pinged" : "not sent", detail: out && (out.error || out.status || null) };
  } catch (e) {
    return { whatsapp: "not sent", detail: String(e.message || e).slice(0, 120) };
  }
}
var INBOX_BOARD_NAME = "agent-task-board-v1";
var INBOX_LEGACY_IDS = ["mv96v15c-41e53ec4", "mv96vynp-1d7c71dc", "mv99xhp2-a3153c61", "mv98rt0s-dfbc684a", "mv98rtff-be6634f2", "mv96b3zy-8829a26a", "mv96cx0i-f256714c"];
var INBOX_MIGRATION_AFTER = Date.parse("2026-10-16T00:02:00Z");
function inboxNextDay() {
  return Math.floor(Date.now() / 864e5) * 864e5 + 8652e4;
}
async function inboxDurableCall(name, args, env, who) {
  const stub = env.RATE_LIMITER_DO.get(env.RATE_LIMITER_DO.idFromName(INBOX_BOARD_NAME));
  const r = await stub.fetch("https://internal/task-board", {
    method: "POST",
    body: JSON.stringify({ name, args, who })
  });
  if (!r.ok) throw new Error("task board unavailable: " + r.status);
  const out = await r.json();
  if (name === "finish_task" && out.ok && out.task.notify) Object.assign(out, await inboxNotify(env, out.task));
  return out;
}
// WALO task detail retention: owner chose seven days on 2026-10-19.
var INBOX_DETAIL_MS = 7 * 86400000;
function inboxCompactTask(t, now = Date.now()) {
  if (t.receipt_only || t.status !== 'done') return t;
  const finished = Date.parse(t.finished);
  if (!Number.isFinite(finished) || now - finished < INBOX_DETAIL_MS) return t;
  const result = String(t.result || '');
  // Legacy runners sometimes called a handoff or approval 'done'. Preserve
  // these until a reviewer explicitly resolves the missing deliverable.
  if (/not done|not complete|needs approval|awaiting approval|still pending|handed (?:off|to)|handoff:|couldn.t|could not|blocked/i.test(result)) return t;
  const report = result.split(/Phone report:\s*/i).pop().replace(/\s+/g, ' ').trim();
  const usage = result.match(/^\[usage\][^\n]{0,160}/m)?.[0] || '';
  const links = [...new Set(result.match(/https?:\/\/[^\s<>"']+/g) || [])]
    .filter(link => !/[?&](?:token|key|signature|sig|code)=/i.test(link)).slice(0, 4).map(link => link.slice(0, 300));
  return {
    id: t.id, to: t.to, from: t.from, status: t.status, created: t.created,
    claimed_by: t.claimed_by || null, claimed: t.claimed || null, finished: t.finished,
    text: String(t.text || '').replace(/\s+/g, ' ').slice(0, 160),
    result: (usage ? usage + '\n' : '') + report.slice(0, 600) + (links.length ? '\nEvidence: ' + links.join(' ') : ''),
    notify: !!t.notify, receipt_only: true, details_removed_at: new Date(now).toISOString()
  };
}
async function inboxRetentionSweep(storage, now = Date.now()) {
  return storage.transaction(async tx => {
    const previous = await tx.get('board:retention') || {};
    if (previous.next > now) return previous;
    const entries = await tx.list({prefix: 'board:task:', limit: 200, ...(previous.cursor ? {startAfter: previous.cursor} : {})});
    let compacted = 0;
    for (const [key, entry] of entries) {
      const task = inboxCompactTask(entry.task, now);
      // Clear the old expiry on every record: unresolved work must not expire.
      if (task !== entry.task || entry.expires != null) await tx.put(key, {task, expires: null});
      if (task !== entry.task) compacted++;
    }
    const cursor = entries.size === 200 ? [...entries.keys()].pop() : null;
    const status = {detail_days: 7, last_sweep: new Date(now).toISOString(), compacted: (previous.compacted || 0) + compacted,
      cursor, next: now + (cursor ? 60000 : 86400000)};
    await tx.put('board:retention', status);
    return status;
  });
}
async function inboxScheduleBoard(state) {
  const retention = await state.storage.get('board:retention');
  const migration = await state.storage.get('board:meta');
  const next = Math.min(retention?.next || Date.now() + 1000,
    migration?.migration === 'pending' ? migration.next : Infinity);
  const alarm = await state.storage.getAlarm();
  if (alarm == null || alarm > next) await state.storage.setAlarm(next);
}
async function inboxBoardAlarm(state, env, meta) {
  try {
    await inboxRetentionSweep(state.storage);
    await inboxBoardMigrationAlarm(state, env, meta);
  } finally {
    await inboxScheduleBoard(state);
  }
}

function inboxBoardKV(storage) {
  return {
    async get(key2) {
      const entry = await storage.get("board:" + key2);
      if (!entry) return null;
      const task = inboxCompactTask(entry.task);
      if (task !== entry.task || entry.expires != null) await storage.put("board:" + key2, {task, expires: null});
      return task;
    },
    async put(key2, value, options) {
      await storage.put("board:" + key2, { task: JSON.parse(value), expires: null });
    },
    async list() {
      const entries = await storage.list({ prefix: "board:task:" });
      const keys = [];
      for (const [key2, entry] of entries) {
        keys.push({ name: key2.slice(6) });
      }
      return { keys, list_complete: true };
    }
  };
}
async function inboxImport(storage, tasks) {
  for (const task of tasks) {
    if (!task || !/^[a-z0-9]+-[0-9a-f]{8}$/.test(task.id)) continue;
    const key2 = "board:task:" + task.id;
    if (await storage.get(key2)) continue;
    await storage.put(key2, { task: inboxCompactTask(task), expires: null });
  }
}
async function inboxBoardInit(state, env) {
  if (await state.storage.get("board:meta")) { await inboxScheduleBoard(state); return; }
  const tasks = await Promise.all(INBOX_LEGACY_IDS.map((id) => env.CLOUDFLARE_OPS_OAUTH.get("task:" + id, "json")));
  await state.storage.transaction(async (tx) => {
    if (await tx.get("board:meta")) return;
    await inboxImport(tx, tasks);
    await tx.put("board:meta", {
      version: 1,
      migration: "pending",
      pages: 0,
      failures: 0,
      next: Math.max(INBOX_MIGRATION_AFTER, Date.now() + 6e4)
    });
  });
  const meta = await state.storage.get("board:meta");
  await inboxScheduleBoard(state);
}
async function inboxBoardFetch(request, state, env) {
  const body = await request.json();
  if (!INBOX_TOOLS.has(body.name)) return Response.json({ error: "unknown inbox tool" }, { status: 400 });
  await inboxBoardInit(state, env);
  const id = body.args && body.args.id;
  if (/^[a-z0-9]+-[0-9a-f]{8}$/.test(id || "") && !await state.storage.get("board:task:" + id)) {
    const old = await env.CLOUDFLARE_OPS_OAUTH.get("task:" + id, "json");
    if (old) await state.storage.transaction((tx) => inboxImport(tx, [old]));
  }
  const out = await state.storage.transaction((tx) => runInboxTool(
    body.name,
    body.args || {},
    { INBOX_BOARD_LOCAL: true, CLOUDFLARE_OPS_OAUTH: inboxBoardKV(tx) },
    body.who
  ));
  if (body.name === "list_tasks" || body.name === "my_tasks") {
    const meta = await state.storage.get("board:meta");
    out.storage = "durable-object";
    out.retention = {detail_days: 7, unresolved_expire: false, receipts: "compact", ...(await state.storage.get("board:retention") || {}), next_alarm: await state.storage.getAlarm()};
    out.legacy_history = { status: meta.migration, pages: meta.pages, next: meta.next || null };
  }
  return Response.json(out);
}
async function inboxBoardMigrationAlarm(state, env, meta) {
  if (meta.migration !== "pending") return;
  if (Date.now() < meta.next) {
    await state.storage.setAlarm(meta.next);
    return;
  }
  try {
    const page2 = await env.CLOUDFLARE_OPS_OAUTH.list({ prefix: "task:", limit: 25, cursor: meta.cursor });
    const tasks = await Promise.all(page2.keys.map((k) => env.CLOUDFLARE_OPS_OAUTH.get(k.name, "json")));
    await state.storage.transaction(async (tx) => {
      await inboxImport(tx, tasks);
      meta = {
        ...meta,
        pages: meta.pages + 1,
        failures: 0,
        cursor: page2.cursor || null,
        migration: page2.list_complete ? "complete" : meta.pages >= 199 ? "paused" : "pending",
        next: page2.list_complete ? null : Date.now() + 6e4
      };
      await tx.put("board:meta", meta);
    });
  } catch (e) {
    meta = {
      ...meta,
      failures: meta.failures + 1,
      migration: meta.failures >= 2 ? "paused" : "pending",
      error: String(e.message || e).slice(0, 160),
      next: inboxNextDay()
    };
    await state.storage.put("board:meta", meta);
  }
  if (meta.migration === "pending") await state.storage.setAlarm(meta.next);
}
async function runInboxTool(name, args, env, who) {
  try {
    if (!env.INBOX_BOARD_LOCAL) return await inboxDurableCall(name, args, env, who);
    if (name === "post_task") {
      const text = String(args.text || "").trim();
      if (!text) throw new Error("text required");
      if (text.length > 4e3) throw new Error("text over 4000 chars; link a Drive doc instead");
      const t = { id: inboxId(), to: inboxAgent(args.to || "any", "to"), from: inboxAgent(args.from || who || "owner", "from"), text, status: "open", created: (/* @__PURE__ */ new Date()).toISOString(), notify: args.notify !== false };
      await inboxPut(env, t);
      return { ok: true, task: inboxView(t), note: `Waiting for ${t.to}. Chat agents pick it up when someone says "check your inbox".` };
    }
    if (name === "my_tasks") {
      const agent = inboxAgent(args.agent || who, "agent");
      const all = await inboxAll(env);
      const mine = all.filter((t) => (t.to === agent || t.to === "any") && (args.include_done ? true : t.status === "open" || t.status === "claimed" && t.claimed_by === agent));
      return { agent, count: mine.length, tasks: mine.slice(0, 25).map(inboxView), how: "claim_task {id, agent} \u2192 do it \u2192 finish_task {id, agent, result}" };
    }
    if (name === "claim_task") {
      const agent = inboxAgent(args.agent || who, "agent");
      const t = await inboxGet(env, args.id);
      if (t.status === "done" || t.status === "failed") throw new Error(`task already ${t.status}`);
      if (t.status === "claimed" && t.claimed_by !== agent) throw new Error(`already claimed by ${t.claimed_by}`);
      const recentClaim = (x) => x.status === "claimed" && !x.finished && (!Number.isFinite(Date.parse(x.claimed || x.created)) || Date.now() - Date.parse(x.claimed || x.created) < 30 * 6e4);
      if (recentClaim(t)) throw new Error(`task already running as ${agent}; wait for its result`);
      const active = (await inboxAll(env)).find((x) => x.id !== t.id && x.claimed_by === agent && recentClaim(x));
      if (active) throw new Error(`${agent} is already running task ${active.id}; this task stays queued`);
      if (t.to !== "any" && t.to !== agent) throw new Error(`task is for ${t.to}, not ${agent}`);
      t.status = "claimed";
      t.claimed_by = agent;
      t.claimed = (/* @__PURE__ */ new Date()).toISOString();
      await inboxPut(env, t);
      return { ok: true, task: inboxView(t) };
    }
    if (name === "finish_task") {
      const agent = inboxAgent(args.agent || who, "agent");
      const t = await inboxGet(env, args.id);
      if (t.status === "done" || t.status === "failed") throw new Error(`task already ${t.status}`);
      if (t.claimed_by && t.claimed_by !== agent) throw new Error(`claimed by ${t.claimed_by}`);
      t.status = args.failed === true ? "failed" : "done";
      t.claimed_by = agent;
      t.finished = (/* @__PURE__ */ new Date()).toISOString();
      t.result = String(args.result || "").slice(0, 8e3);
      await inboxPut(env, t);
      const ping = t.notify && !env.INBOX_BOARD_LOCAL ? await inboxNotify(env, t) : { whatsapp: t.notify ? "pending outer notification" : "off for this task" };
      return { ok: true, task: inboxView(t), ...ping };
    }
    if (name === "list_tasks") {
      const all = await inboxAll(env);
      const f = all.filter((t) => (!args.status || t.status === args.status) && (!args.to || t.to === String(args.to).toLowerCase()));
      return { count: f.length, tasks: f.slice(0, Math.min(Number(args.limit) || 30, 100)).map(inboxView) };
    }
    if (name === "cancel_task") {
      const t = await inboxGet(env, args.id);
      if (t.status === "done") throw new Error("already done");
      t.status = "failed";
      t.result = "cancelled: " + String(args.reason || "").slice(0, 300);
      t.finished = (/* @__PURE__ */ new Date()).toISOString();
      await inboxPut(env, t);
      return { ok: true, task: inboxView(t) };
    }
  } catch (e) {
    return { error: String(e && e.message || e).slice(0, 600) };
  }
  return { error: "unknown inbox tool" };
}
var EMAIL_AUSTIN_TO = ["pain2hustle@gmail.com", "austinsdoors1@gmail.com"];
var EMAIL_AUSTIN_MAX = 2e4;
var EMAIL_TOOL_DEFS = [
  {
    name: "email_austin",
    description: "Email Austin a result: a short note, a link (preview URL, PR, file), or a report. Plain text; keep it short and put links on their own lines. Use it when Austin says 'email me', or to deliver something that does not fit WhatsApp. Owner/agent keys only.",
    inputSchema: { type: "object", properties: {
      subject: { type: "string", description: "short subject, no prefix needed" },
      text: { type: "string", description: "the body, plain text (max 20k chars)" },
      link: { type: "string", description: "optional URL put on its own line at the end" },
      from_agent: { type: "string", description: "your name, e.g. grok, codex, claude, jubber" },
      html: { type: "string", description: "optional HTML body (text is still required)" }
    }, required: ["subject", "text"] }
  }
];
var EMAIL_TOOLS = new Set(EMAIL_TOOL_DEFS.map((t) => t.name));
async function runEmailTool(name, args, env, who) {
  if (name !== "email_austin") return { error: "unknown email tool" };
  if (!env.AGENT_MAIL || typeof env.AGENT_MAIL.fetch !== "function") return { error: "email_austin is not wired on this deployment (service binding AGENT_MAIL -> agent-mail missing)" };
  const subject = String(args.subject || "").trim().slice(0, 200);
  let text = String(args.text || "").trim();
  if (!subject || !text) return { error: "need subject + text" };
  if (text.length > EMAIL_AUSTIN_MAX) text = text.slice(0, EMAIL_AUSTIN_MAX) + "\n[cut at 20k chars]";
  const link = String(args.link || "").trim();
  if (link && !/^https?:\/\/\S+$/i.test(link)) return { error: "link must be a full http(s) URL" };
  const from = String(args.from_agent || who || "an AMH agent").replace(/[^\w .-]/g, "").slice(0, 40) || "an AMH agent";
  const body = text + (link ? "\n\n" + link : "") + "\n\n\u2014 " + from + " via the Walrus Tusk hub";
  let res, j;
  try {
    res = await env.AGENT_MAIL.fetch("https://agent-mail/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "jubber", to: EMAIL_AUSTIN_TO, subject: "[AMH] " + subject, text: body, html: args.html ? String(args.html) : void 0, replyTo: "austin@walohq.com" })
    });
    j = await res.json().catch(() => ({}));
  } catch (e) {
    return { error: "agent-mail unreachable: " + String(e && e.message || e).slice(0, 200) };
  }
  if (!res.ok || !j.sent) return { error: "not sent", status: res.status, detail: j.error || j.detail || null };
  return { ok: true, sent: true, to: EMAIL_AUSTIN_TO, subject: "[AMH] " + subject, from: j.from || "jubber@artificialmindhive.com", providerId: j.providerId || null };
}
// worker_patch (2026-10-21, Austin + dot's brief): land an exact code patch on an allow-listed Worker straight through
// the Cloudflare API, no GitHub runner and no AI in the deploy step.
//   worker_patch_grant  -> a short-lived, single-use grant bound to caller, script, operation, request id and patch hash
//   worker_patch        -> verifies the grant, claims it ONCE (Durable Object = atomic), checks live == latest == repo,
//                          uploads a version, checks it on its preview URL, sends 100% traffic, checks live, rolls back
//                          on failure, syncs the repo file ([skip ci]) and keeps a receipt
//   worker_patch_status -> the receipt for a request id (needs a key like every hub call)
var WP_SCRIPTS = {
  "amh-site-revival-proxy": { account: "0ebf6d65d7a9ddccd41cba0b8bd1414c", subdomain: "pain2hustle1", repo: "pain2hustle1/Amhsitereviver", path: "workers/amh-site-proxy/index.js",
    live: "https://www.amhsiterevival.com", previewChecks: [["/", "<title"], ["/insights", "<title"], ["/fieldscan/", "<title"], ["/api/te?op=quotes&syms=SPY", '"price"']],
    liveChecks: [["/", "<title"], ["/tradingexpert", "<title"], ["/api/public-config", "{"], ["/api/te?op=quotes&syms=SPY", '"price"']] },
  "wp-test": { account: "0ebf6d65d7a9ddccd41cba0b8bd1414c", subdomain: "pain2hustle1", repo: null, path: null,
    live: "https://wp-test.pain2hustle1.workers.dev", previewChecks: [["/", "wp-test"]], liveChecks: [["/", "wp-test"]] },
};
var WP_GRANT_TTL = 600;
var WP_TOOL_DEFS = [
  { name: "worker_patch_grant", description: "Step 1 of landing server code on an allow-listed Worker (" + Object.keys(WP_SCRIPTS).join(", ") + "): get a single-use grant for this exact patch (expires in 10 min). Same script/edits/request_id go to worker_patch.",
    inputSchema: { type: "object", properties: { script: { type: "string" }, request_id: { type: "string", description: "unique, a-z0-9-, 8-80" }, edits: { type: "array", items: { type: "object", properties: { find: { type: "string" }, replace: { type: "string" }, count: { type: "number" } }, required: ["find", "replace"] } } }, required: ["script", "request_id", "edits"] } },
  { name: "worker_patch", description: "Step 2: land the patch. dry_run:true shows what would change and uses nothing. Live code must equal the latest version and the repo file, or it refuses. Checks the new version on its preview URL, goes live, checks live, rolls back by itself on failure, syncs the repo. Same request_id again returns the first receipt.",
    inputSchema: { type: "object", properties: { grant: { type: "string" }, script: { type: "string" }, request_id: { type: "string" }, edits: { type: "array", items: { type: "object" } }, base_version: { type: "string", description: "optional: the live version you read; refuses if it changed" }, dry_run: { type: "boolean" } }, required: ["grant", "script", "request_id", "edits"] } },
  { name: "worker_patch_sync", description: "Owner: put the repo's main file for an allow-listed Worker live exactly as written (preview check, live check, rollback). Needed once, or after someone deployed another way. dry_run defaults to true.",
    inputSchema: { type: "object", properties: { script: { type: "string" }, dry_run: { type: "boolean" } }, required: ["script"] } },
  { name: "worker_patch_status", description: "Receipt for a worker_patch request id (state, versions, checks, rollback, repo commit).",
    inputSchema: { type: "object", properties: { request_id: { type: "string" } }, required: ["request_id"] } },
];
var WP_TOOLS = new Set(WP_TOOL_DEFS.map((t) => t.name));
var wpEnc = new TextEncoder();
var wpB64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
var wpUnb64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
async function wpSha(text) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", wpEnc.encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join(""); }
async function wpKey(env) {
  if (!env.MCP_ACCESS_KEY) throw new Error("hub has no signing secret");
  const base = await crypto.subtle.importKey("raw", wpEnc.encode(env.MCP_ACCESS_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", base, wpEnc.encode("worker-patch-grant-v1"));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
function wpNorm(args) {
  const script = String(args.script || "").trim(), rid = String(args.request_id || "").trim();
  if (!WP_SCRIPTS[script]) throw new Error("script not allowed; allowed: " + Object.keys(WP_SCRIPTS).join(", "));
  if (!/^[a-z0-9][a-z0-9-]{7,79}$/.test(rid)) throw new Error("request_id must be a-z0-9-, 8-80 chars");
  const edits = Array.isArray(args.edits) ? args.edits : [];
  if (!edits.length || edits.length > 20) throw new Error("1-20 edits");
  const clean = edits.map((e) => {
    if (!e || typeof e.find !== "string" || !e.find || typeof e.replace !== "string") throw new Error("each edit needs find + replace text");
    return { find: e.find, replace: e.replace, count: Number(e.count) || 1 };
  });
  return { script, rid, edits: clean };
}
var wpPatchSha = (n) => wpSha(JSON.stringify({ script: n.script, edits: n.edits.map((e) => [e.find, e.replace, e.count]) }));
async function wpLedger(env, body) {
  const stub = env.RATE_LIMITER_DO.get(env.RATE_LIMITER_DO.idFromName("worker-patch-ledger"));
  const r = await stub.fetch("https://ledger/worker-patch", { method: "POST", body: JSON.stringify(body) });
  return r.json();
}
// Runs inside the Durable Object: one request at a time, so a grant can only be claimed once.
async function wpLedgerFetch(request, state) {
  const b = await request.json(), st = state.storage;
  if (b.action === "claim") {
    const old = await st.get("rid:" + b.rid);
    if (old) return Response.json(old.sha === b.sha ? { existing: old } : { error: "request_id was already used for a different patch" });
    if (await st.get("jti:" + b.jti)) return Response.json({ error: "grant already used" });
    const lock = await st.get("lock:" + b.script);
    if (lock && Date.now() - lock.at < 10 * 60e3) return Response.json({ error: "another patch is landing on " + b.script + " (" + lock.rid + "), try again in a few minutes" });
    const rec = { request_id: b.rid, script: b.script, sha: b.sha, actor: b.actor, state: "accepted", accepted_at: new Date().toISOString() };
    await st.put("jti:" + b.jti, { rid: b.rid, at: Date.now() });
    await st.put("rid:" + b.rid, rec);
    await st.put("lock:" + b.script, { rid: b.rid, at: Date.now() });
    return Response.json({ claimed: rec });
  }
  if (b.action === "update") {
    const rec = { ...(await st.get("rid:" + b.rid) || {}), ...b.patch };
    await st.put("rid:" + b.rid, rec);
    if (b.release) await st.delete("lock:" + rec.script);
    return Response.json({ ok: true });
  }
  if (b.action === "get") return Response.json({ record: await st.get("rid:" + b.rid) || null });
  return Response.json({ error: "bad action" }, { status: 400 });
}
async function wpGrant(env, args, actor) {
  const n = wpNorm(args), sha = await wpPatchSha(n), now = Math.floor(Date.now() / 1e3);
  const ttl = Math.min(Math.max(Number(args.ttl_seconds) || WP_GRANT_TTL, 5), WP_GRANT_TTL);
  const claims = { v: 1, aud: "worker_patch", op: "deploy", sub: String(actor || "admin"), script: n.script, rid: n.rid, sha, jti: crypto.randomUUID(), iat: now, exp: now + ttl };
  const body = wpB64u(wpEnc.encode(JSON.stringify(claims)));
  const sig = wpB64u(await crypto.subtle.sign("HMAC", await wpKey(env), wpEnc.encode(body)));
  return { grant: body + "." + sig, patch_sha256: sha, request_id: n.rid, script: n.script, expires_at: new Date(claims.exp * 1e3).toISOString(), next: "call worker_patch with this grant and the SAME script, request_id and edits" };
}
async function wpVerify(env, grant, n, sha, actor) {
  const [body, sig] = String(grant || "").split(".");
  if (!body || !sig) throw new Error("grant missing or malformed");
  if (!await crypto.subtle.verify("HMAC", await wpKey(env), wpUnb64u(sig), wpEnc.encode(body))) throw new Error("grant signature invalid");
  const c = JSON.parse(new TextDecoder().decode(wpUnb64u(body)));
  if (c.v !== 1 || c.aud !== "worker_patch" || c.op !== "deploy") throw new Error("grant is not for worker_patch");
  if (c.exp < Math.floor(Date.now() / 1e3)) throw new Error("grant expired");
  if (c.sub !== String(actor || "admin")) throw new Error("grant belongs to a different caller");
  if (c.script !== n.script) throw new Error("grant is for a different script");
  if (c.rid !== n.rid) throw new Error("grant is for a different request_id");
  if (c.sha !== sha) throw new Error("patch differs from the one the grant was issued for");
  return c;
}
async function wpCf(env, acct, path, init = {}) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/workers/scripts/${path}`, { ...init, headers: { authorization: "Bearer " + env.CLOUDFLARE_API_TOKEN, ...(init.headers || {}) } });
  return r;
}
async function wpCfJson(env, acct, path, init) {
  const r = await wpCf(env, acct, path, init), j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error(`Cloudflare ${path.split("?")[0]}: ${r.status} ${(j.errors || []).map((e) => e.message).join("; ").slice(0, 200)}`);
  return j.result;
}
async function wpChecks(base, checks) {
  const out = [];
  for (const [p, want] of checks) {
    let code = 0, ok = false;
    try { const r = await fetch(base + p, { headers: { "user-agent": "Mozilla/5.0 (amh-worker-patch-check)" }, redirect: "manual" }); code = r.status; ok = code === 200 && (await r.text()).toLowerCase().includes(want.toLowerCase()); } catch {}
    out.push({ path: p, status: code, ok });
  }
  return { ok: out.every((c) => c.ok), checks: out };
}
async function wpLiveState(env, s, name) {
  const dep = await wpCfJson(env, s.account, name + "/deployments");
  const cur = (dep.deployments || [])[0];
  if (!cur || cur.versions.length !== 1 || cur.versions[0].percentage !== 100) throw new Error("live traffic is split across versions; finish that first");
  const active = cur.versions[0].version_id;
  // The code of the version that is actually serving (uploads that never went live don't matter).
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${s.account}/workers/workers/${name}/versions/${active}?include=modules`, { headers: { authorization: "Bearer " + env.CLOUDFLARE_API_TOKEN } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.success) throw new Error("could not read the live version's code: " + r.status);
  const mods = j.result.modules || [], main = j.result.main_module || (mods[0] && mods[0].name);
  if (mods.length !== 1 || !main) throw new Error("live version has " + mods.length + " modules; only single-file Workers are supported");
  const code = new TextDecoder().decode(Uint8Array.from(atob(mods[0].content_base64), (c) => c.charCodeAt(0)));
  return { active, code: code.replace(/\r\n/g, "\n"), mainName: main };
}
function wpApply(code, edits) {
  let out = code;
  for (const e of edits) {
    const n = out.split(e.find).length - 1;
    if (n !== e.count) throw new Error(`find occurs ${n} time(s), expected ${e.count}: ${e.find.slice(0, 80)}`);
    out = out.split(e.find).join(e.replace);
  }
  if (out === code) throw new Error("patch changes nothing");
  if (out.length > 9e5) throw new Error("result too large");
  return out;
}
async function wpRun(env, args, actor) {
  const n = wpNorm(args), s = WP_SCRIPTS[n.script], sha = await wpPatchSha(n);
  const claims = await wpVerify(env, args.grant, n, sha, actor);
  // A repeat of a request that was already accepted gets its receipt back, even after the code changed.
  const seen = (await wpLedger(env, { action: "get", rid: n.rid })).record;
  if (seen) return seen.sha === sha ? { already_handled: true, receipt: seen } : { error: "request_id was already used for a different patch" };
  const live = await wpLiveState(env, s, n.script);
  if (args.base_version && !live.active.startsWith(String(args.base_version))) throw new Error("live version is " + live.active + ", not the base_version you read");
  let repoFile = null;
  if (s.repo) {
    const meta = await gh(env, "GET", `/repos/${s.repo}/contents/${s.path}?ref=main`);
    repoFile = { sha: meta.sha, text: new TextDecoder().decode(await gh(env, "GET", `/repos/${s.repo}/contents/${s.path}?ref=main`, null, "application/vnd.github.raw")).replace(/\r\n/g, "\n") };
    if (repoFile.text.trim() !== live.code.trim()) throw new Error(`live code differs from ${s.repo}/${s.path} on main (someone deployed another way, or the repo moved on). The owner runs worker_patch_sync once, then patch again.`);
  }
  const next = wpApply(live.code, n.edits);
  if (args.dry_run === true) return { dry_run: true, script: n.script, request_id: n.rid, patch_sha256: sha, live_version: live.active, bytes_before: live.code.length, bytes_after: next.length, edits: n.edits.length, grant_used: false, next: "call again without dry_run (same grant) to land it" };
  const claim = await wpLedger(env, { action: "claim", rid: n.rid, jti: claims.jti, sha, script: n.script, actor: String(actor || "admin") });
  if (claim.error) throw new Error(claim.error);
  if (claim.existing) return { already_handled: true, receipt: claim.existing };
  return wpShip(env, s, n.script, n.rid, live, next, { base_version: live.active, patch_sha256: sha }, repoFile);
}
async function wpShip(env, s, script, rid, live, next, base, repoFile) {
  const n = { script, rid };
  const upd = (patch, release) => wpLedger(env, { action: "update", rid, patch, release });
  const rec = { ...base, state: "uploading" };
  await upd(rec);
  try {
    const settings = await wpCfJson(env, s.account, n.script + "/settings");
    const keep = [...new Set((settings.bindings || []).map((b) => b.type))];
    const msg = "worker_patch " + n.rid;
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify({ main_module: live.mainName, compatibility_date: settings.compatibility_date, compatibility_flags: settings.compatibility_flags || [], bindings: [], keep_bindings: keep, annotations: { "workers/message": msg, "workers/tag": n.rid.slice(0, 50) } })], { type: "application/json" }));
    form.append(live.mainName, new Blob([next], { type: "application/javascript+module" }), live.mainName);
    const ver = await wpCfJson(env, s.account, n.script + "/versions", { method: "POST", body: form });
    rec.new_version = ver.id;
    const preview = `https://${ver.id.slice(0, 8)}-${n.script}.${s.subdomain}.workers.dev`;
    rec.preview = await wpChecks(preview, s.previewChecks);
    if (!rec.preview.ok) { Object.assign(rec, { state: "refused_preview_failed", finished_at: new Date().toISOString(), live_changed: false }); await upd(rec, true); return rec; }
    const dep = await wpCfJson(env, s.account, n.script + "/deployments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ strategy: "percentage", versions: [{ version_id: ver.id, percentage: 100 }], annotations: { "workers/message": msg } }) });
    rec.deployment_id = dep.id; rec.rollback_to = live.active; rec.state = "live_checking";
    await upd(rec);
    await new Promise((r) => setTimeout(r, 3e3));
    rec.live = await wpChecks(s.live, s.liveChecks);
    if (!rec.live.ok) {
      const back = await wpCfJson(env, s.account, n.script + "/deployments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ strategy: "percentage", versions: [{ version_id: live.active, percentage: 100 }], annotations: { "workers/message": "worker_patch rollback " + n.rid } }) });
      Object.assign(rec, { state: "rolled_back_live_check_failed", rollback_deployment_id: back.id, finished_at: new Date().toISOString() });
      await upd(rec, true); return rec;
    }
    rec.state = "live";
    if (s.repo && repoFile) {
      try {
        const c = await gh(env, "PUT", `/repos/${s.repo}/contents/${s.path}`, { message: `worker_patch ${n.rid}: synced from live version ${ver.id.slice(0, 8)} [skip ci]`, content: btoa(String.fromCharCode(...wpEnc.encode(next))), sha: repoFile.sha, branch: "main" });
        rec.repo_commit = c.commit && c.commit.sha;
      } catch (e) { rec.repo_sync_error = String(e.message || e).slice(0, 200); rec.state = "live_repo_not_synced"; }
    }
    rec.finished_at = new Date().toISOString();
    await upd(rec, true);
    return rec;
  } catch (e) {
    Object.assign(rec, { state: rec.deployment_id ? "error_after_deploy_check_live" : "error_nothing_live", error: String(e.message || e).slice(0, 300), finished_at: new Date().toISOString() });
    await upd(rec, true);
    return rec;
  }
}
// One-time (or after a deploy made another way): put the repo's main file live verbatim, same checks + rollback.
async function wpSync(env, args, actor) {
  const script = String(args.script || ""), s = WP_SCRIPTS[script];
  if (!s || !s.repo) throw new Error("script not allowed or has no repo");
  const meta = await gh(env, "GET", `/repos/${s.repo}/contents/${s.path}?ref=main`);
  const text = new TextDecoder().decode(await gh(env, "GET", `/repos/${s.repo}/contents/${s.path}?ref=main`, null, "application/vnd.github.raw")).replace(/\r\n/g, "\n");
  const live = await wpLiveState(env, s, script);
  if (live.code.trim() === text.trim()) return { in_sync: true, live_version: live.active };
  const sha = await wpSha(text), rid = "sync-" + sha.slice(0, 12) + "-" + live.active.slice(0, 8);
  if (args.dry_run !== false) return { dry_run: true, script, live_version: live.active, repo_file_sha: meta.sha, bytes_live: live.code.length, bytes_repo: text.length, next: "call again with dry_run:false to put the repo file live" };
  const claim = await wpLedger(env, { action: "claim", rid, jti: "sync-" + crypto.randomUUID(), sha, script, actor: String(actor || "admin") });
  if (claim.error) throw new Error(claim.error);
  if (claim.existing) return { already_handled: true, receipt: claim.existing };
  return wpShip(env, s, script, rid, live, text, { base_version: live.active, repo_file_sha: meta.sha, kind: "sync" }, null);
}
async function runWorkerPatchTool(name, args, env, actor) {
  try {
    if (name === "worker_patch_sync") return await wpSync(env, args, actor);
    if (name === "worker_patch_grant") return await wpGrant(env, args, actor);
    if (name === "worker_patch") return await wpRun(env, args, actor);
    if (name === "worker_patch_status") {
      const rid = String(args.request_id || "");
      if (!/^[a-z0-9][a-z0-9-]{7,79}$/.test(rid)) throw new Error("bad request_id");
      const r = await wpLedger(env, { action: "get", rid });
      return r.record ? { receipt: r.record } : { receipt: null, note: "no such request (never claimed)" };
    }
  } catch (e) { return { error: String(e && e.message || e).slice(0, 400) }; }
}

var INBOX_TOOL_DEFS = [
  {
    name: "my_tasks",
    description: "Check your inbox: open tasks for you (or for 'any'). Run this when Austin says 'check your inbox'. Then claim_task \u2192 do the work \u2192 finish_task.",
    inputSchema: { type: "object", properties: { agent: { type: "string", description: "your name: grok, claude, jubber, codex" }, include_done: { type: "boolean" } }, required: ["agent"] }
  },
  {
    name: "post_task",
    description: "Give a task to another agent (or yourself later) on the shared AMH agent board. to: grok | claude | jubber | codex | owner (Austin) | any.",
    inputSchema: { type: "object", properties: { to: { type: "string" }, text: { type: "string" }, from: { type: "string", description: "your name" }, notify: { type: "boolean", description: "WhatsApp-ping Austin when it's finished (default true)" } }, required: ["to", "text", "from"] }
  },
  {
    name: "claim_task",
    description: "Claim an inbox task before working on it, so no other agent does it twice.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, agent: { type: "string" } }, required: ["id", "agent"] }
  },
  {
    name: "finish_task",
    description: "Mark an inbox task done (or failed=true) with a short result: what you did, links, deployment ids. Pings Austin on WhatsApp if the task asked for it.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, agent: { type: "string" }, result: { type: "string" }, failed: { type: "boolean" } }, required: ["id", "agent", "result"] }
  },
  {
    name: "list_tasks",
    description: "The whole agent board: every task, optionally by status (open/claimed/done/failed) or by who it's for.",
    inputSchema: { type: "object", properties: { status: { type: "string" }, to: { type: "string" }, limit: { type: "number" } } }
  },
  { name: "cancel_task", description: "Cancel an open or claimed task.", inputSchema: { type: "object", properties: { id: { type: "string" }, reason: { type: "string" } }, required: ["id"] } }
];
var INBOX_TOOLS = new Set(INBOX_TOOL_DEFS.map((t) => t.name));
async function inboxHandleHttp(request, env, url) {
  const p = url.pathname.replace(/\/+$/, "");
  if (p !== "/board" && p !== "/board/api") return null;
  const origin = request.headers.get("origin") || "";
  const cors = /^https:\/\/(www\.)?walohq\.com$/.test(origin) ? { "access-control-allow-origin": origin, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "vary": "origin" } : {};
  if (p === "/board/api" && request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (p === "/board" && request.method === "GET") return Response.redirect("https://walohq.com/board/", 302);
  if (p !== "/board/api" || request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const body = await request.json().catch(() => ({}));
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", ...cors } });
  if (body.action === "public") return J(await boardPublicFeed(env));
  const boardKey = String(body.key || "").trim();
  const auth = env.WALO_BOARD_KEY && boardKey && await timingSafeEqual(boardKey, env.WALO_BOARD_KEY) ? { ok: true, mode: "admin", caller: "walo", connectionId: null } : await authorizeConnector(env, boardKey);
  if (!auth.ok || auth.mode !== "admin") return J({ error: "wrong key" }, 401);
  if (body.action === "list") return J(await runInboxTool("list_tasks", { limit: 100 }, env, "owner"));
  if (body.action === "post") {
    const posted = await runInboxTool("post_task", { to: body.to, text: body.text, from: "owner", notify: body.notify !== false }, env, "owner");
    if (posted && posted.task && CLOUD_WAKE.includes(posted.task.to)) {
      await runGithubTool("repo_commit_push", { repo: "pain2hustle/amhicle", branch: "agent/dispatch", message: "wake for " + posted.task.id, files: [{ path: "wake.txt", content: (/* @__PURE__ */ new Date()).toISOString() + " " + posted.task.id }] }, env, "board").catch(() => null);
    }
    return J(posted);
  }
  if (body.action === "cancel") return J(await runInboxTool("cancel_task", { id: body.id, reason: "cancelled on the board" }, env, "owner"));
  return J({ error: "unknown action" }, 400);
}
async function boardPublicFeed(env) {
  const all = await runInboxTool("list_tasks", { limit: 100 }, env, "public");
  if (all.error) return { error: "Task board unavailable", tasks: null, today: null };
  const kind = (t) => {
    const x = String(t.text || "");
    if (/^\[poem\]/.test(x) || t.from === "poem") return "poem line";
    if (/^\[hop \d\]/.test(x)) return "handoff";
    if (/\.(com|app|dev|net|org|io)\b|\b(site|page|deploy|patch|fix|header|footer|button|css|html|repo|commit|pr|roll ?back|landing|ticker|watchlist)\b/i.test(x)) return "site job";
    return "question";
  };
  const tasks = (all.tasks || []).slice(0, 40).map((t) => {
    const m = /\[usage\] tokens=(\d+)/.exec(String(t.result || ""));
    return { agent: t.claimed_by || t.to, status: t.status, kind: kind(t), created: t.created, finished: t.finished || null, tokens: m ? Number(m[1]) : null };
  });
  const day = new Date(Date.now() - 864e5).toISOString();
  return { tasks, today: { jobs: tasks.filter((t) => t.created > day).length, done: tasks.filter((t) => t.created > day && t.status === "done").length, working: tasks.filter((t) => t.status === "claimed").length } };
}
// Proposal only: fixed-resource, GET-only Apiary diagnostics. No deployment/writes.
var APIARY_READ_ACCOUNT = '1d5fae607a857fc56cd575763bf8f3bc';
var APIARY_READ_SCRIPT = 'apiary-bee';
var APIARY_READ_BUCKET = 'apiary-reading-html';
var APIARY_READ_PREFIX = 'community/reading/';
var APIARY_READ_TOOL_DEFS = [
  { name: 'apiary_worker_deployments', description: 'Read active deployment and recent deployment history for apiary-bee on Austin Doors. First item serves traffic. Past versions are rollback candidates, not validated rollbacks.', inputSchema: { type: 'object', additionalProperties: false, properties: { _approved: {type:'boolean'} } } },
  { name: 'apiary_worker_version', description: 'Read only version identity, script etag, runtime compatibility and binding names/types for one apiary-bee version. Never returns values, source code or secrets.', inputSchema: { type: 'object', additionalProperties: false, properties: { version_id: {type:'string',pattern:'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'}, _approved:{type:'boolean'} }, required:['version_id'] } },
  { name: 'apiary_r2_objects_list', description: 'One metadata-only page from apiary-reading-html, fixed community/reading/ prefix. Follow every next_cursor until page_exhausted; this call never proves the entire inventory complete.', inputSchema: { type:'object', additionalProperties:false, properties: {cursor:{type:'string',maxLength:8192},per_page:{type:'integer',minimum:1,maximum:1000,default:1000},_approved:{type:'boolean'}} } }
];
var APIARY_READ_TOOLS = new Set(APIARY_READ_TOOL_DEFS.map(t=>t.name));
function apiaryReadArgs(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('invalid arguments');
  const allowed = name === 'apiary_worker_version' ? ['version_id','_approved'] : name === 'apiary_r2_objects_list' ? ['cursor','per_page','_approved'] : ['_approved'];
  if(Object.keys(args).some(k=>!allowed.includes(k))) throw new Error('unsupported argument');
  if(args._approved !== undefined && typeof args._approved !== 'boolean') throw new Error('invalid approval flag');
  if(name === 'apiary_worker_version' && (typeof args.version_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(args.version_id))) throw new Error('invalid version id');
  if(name === 'apiary_r2_objects_list') {
    if(args.cursor !== undefined && (typeof args.cursor !== 'string' || args.cursor.length > 8192 || /[\u0000-\u001f\u007f]/.test(args.cursor))) throw new Error('invalid cursor');
    if(args.per_page !== undefined && (!Number.isInteger(args.per_page) || args.per_page < 1 || args.per_page > 1000)) throw new Error('invalid per_page');
  }
}
function apiaryReadText(value) { return typeof value === 'string' ? value : null; }
async function runApiaryReadTool(name, args, env, authContext) {
  if(!APIARY_READ_TOOLS.has(name)) return {error:'unknown Apiary read tool'};
  if(authContext?.mode !== 'admin') return {error:'Apiary diagnostics require the existing owner/agent authorization'};
  try { apiaryReadArgs(name, args); } catch { return {error:'Invalid arguments for the fixed Apiary read scope'}; }
  // Deliberately no default-account, Pages-only or federated-execute fallback.
  if(!env.CLOUDFLARE_API_TOKEN_DOORS) return {error:'Existing Doors credential is unavailable; no fallback attempted'};
  const client = new CloudflareClient({token:env.CLOUDFLARE_API_TOKEN_DOORS});
  const root = `/accounts/${APIARY_READ_ACCOUNT}`;
  const identity = {account:APIARY_READ_ACCOUNT,script:APIARY_READ_SCRIPT};
  try {
    if(name === 'apiary_worker_deployments') {
      const {result} = await client.request('GET', `${root}/workers/scripts/${APIARY_READ_SCRIPT}/deployments`);
      if(!Array.isArray(result?.deployments)) return {error:'Unexpected deployments response; active deployment unverified'};
      const deployments = result.deployments.slice(0,50).map(d=>({id:apiaryReadText(d.id),created_on:apiaryReadText(d.created_on),source:apiaryReadText(d.source),strategy:apiaryReadText(d.strategy),versions:Array.isArray(d.versions)?d.versions.map(v=>({version_id:apiaryReadText(v.version_id),percentage:typeof v.percentage==='number'?v.percentage:null})):null}));
      return {...identity,active_deployment:deployments[0]||null,deployments,history_truncated:result.deployments.length>50,rollback_validated:false};
    }
    if(name === 'apiary_worker_version') {
      const {result:v} = await client.request('GET', `${root}/workers/scripts/${APIARY_READ_SCRIPT}/versions/${args.version_id}`);
      if(v?.id !== args.version_id) return {error:'Version identity mismatch; metadata unverified'};
      const b=v.resources?.bindings, rt=v.resources?.script_runtime;
      return {...identity,version_id:v.id,number:typeof v.number==='number'?v.number:null,created_on:apiaryReadText(v.metadata?.created_on),script_etag:apiaryReadText(v.resources?.script?.etag),compatibility_date:apiaryReadText(rt?.compatibility_date),compatibility_flags:Array.isArray(rt?.compatibility_flags)?rt.compatibility_flags.filter(x=>typeof x==='string'):null,bindings:Array.isArray(b)?b.map(x=>({name:apiaryReadText(x.name),type:apiaryReadText(x.type),...(x.type==='r2_bucket'?{bucket_name:apiaryReadText(x.bucket_name)}:{})})):null,rollback_validated:false};
    }
    const q=new URLSearchParams({prefix:APIARY_READ_PREFIX,per_page:String(args.per_page??1000)});
    if(args.cursor) q.set('cursor',args.cursor);
    const {result, result_info:rawInfo} = await client.request('GET', `${root}/r2/buckets/${APIARY_READ_BUCKET}/objects?${q}`);
    let info = rawInfo;
    // The REST API omits optional result_info on its terminal short page.
    // Confirm the boundary with a fixed-prefix start_after probe before ending.
    if (!info && Array.isArray(result) && result.length < (args.per_page ?? 1000)) {
      if(result.some(x=>typeof x.key!=='string' || !x.key.startsWith(APIARY_READ_PREFIX) || !Number.isSafeInteger(x.size) || x.size<0)) return {error:'Unexpected terminal object metadata; inventory unverified'};
      if(result.length) {
        const last = result.map(x=>x.key).sort().at(-1);
        const terminalQuery = new URLSearchParams({prefix:APIARY_READ_PREFIX,per_page:'1',start_after:last});
        const terminal = await client.request('GET', `${root}/r2/buckets/${APIARY_READ_BUCKET}/objects?${terminalQuery}`);
        if(!Array.isArray(terminal.result) || terminal.result.length || (terminal.result_info && (terminal.result_info.is_truncated !== false || terminal.result_info.delimited?.length))) return {error:'Terminal boundary probe did not confirm exhaustion; inventory incomplete'};
      }
      info = {is_truncated:false};
    }
    if(!Array.isArray(result) || typeof info?.is_truncated !== 'boolean' || (info.delimited?.length)) return {error:'Incomplete or grouped pagination metadata; inventory completeness unverified',shape:{result_is_array:Array.isArray(result),object_count:Array.isArray(result)?result.length:null,info_present:!!info,truncated_type:typeof info?.is_truncated,truncated:typeof info?.is_truncated==='boolean'?info.is_truncated:null,cursor_present:typeof info?.cursor==='string'&&!!info.cursor,delimited_type:typeof info?.delimited,delimited_count:Array.isArray(info?.delimited)?info.delimited.length:null}};
    if(info.is_truncated && (typeof info.cursor !== 'string' || !info.cursor || info.cursor===args.cursor)) return {error:'Missing or repeated continuation cursor; inventory incomplete'};
    if(result.some(x=>typeof x.key!=='string' || !x.key.startsWith(APIARY_READ_PREFIX) || !Number.isSafeInteger(x.size) || x.size<0)) return {error:'Unexpected object metadata; inventory unverified'};
    return {account:APIARY_READ_ACCOUNT,bucket:APIARY_READ_BUCKET,prefix:APIARY_READ_PREFIX,objects:result.map(x=>({key:x.key,size:x.size,etag:apiaryReadText(x.etag),last_modified:apiaryReadText(x.last_modified),content_type:apiaryReadText(x.http_metadata?.contentType)})),next_cursor:info.is_truncated?info.cursor:null,page_exhausted:!info.is_truncated,inventory_complete:false};
  } catch(e) {
    // Never echo provider error text, credentials, raw headers, or arbitrary metadata.
    return {error:'Apiary metadata read failed',status:Number.isInteger(e?.status)?e.status:null,code:Number.isInteger(e?.code)?e.code:null};
  }
}

var PAGES_DEPLOY_TOOLS = new Set(PAGES_DEPLOY_TOOL_DEFS.map((t) => t.name));
async function runPagesDeployTool(name, args, client, altClient) {
  try {
    if (altClient && args.account && name !== "wrangler_doctor") {
      const alt = altClient(pagesAccount(args.account));
      if (alt) client = alt;
    }
    if (name === "pages_deploy") return await pagesDeploy(client, args);
    if (name === "pages_list_deployments") return await pagesListDeployments(client, args);
    if (name === "pages_get_deployment") return await pagesGetDeployment(client, args);
    if (name === "pages_rollback") return await pagesRollback(client, args);
    if (name === "wrangler_doctor") return await wranglerDoctor(client, args, altClient);
  } catch (e) {
    return { error: String(e && e.message || e).slice(0, 600) };
  }
  return { error: "unknown pages tool" };
}
var SERVER = {
  name: "cloudflare-ops-mcp",
  title: "AMH Walrus Tusk Cloudflare Ops MCP \u2014 SafeTry Agent Harness",
  version: "0.15.0"
};
var INDEXNOW_KEY = "d4f02a51e05cfee056bc027685262a64";
var MGMT_TOOL_DEFS = [
  {
    name: "federation_add",
    description: "Register an upstream MCP server so its tools appear in THIS catalog under a namespace (namespace__tool) and calls proxy to it. Args: namespace (a-z0-9_-), url (https MCP endpoint), auth (optional Bearer token/connector key).",
    inputSchema: { type: "object", properties: { namespace: { type: "string" }, url: { type: "string" }, auth: { type: "string" } }, required: ["namespace", "url"] }
  },
  { name: "federation_list", description: "List registered upstream MCP servers (namespace, url, whether authed).", inputSchema: { type: "object", properties: {} } },
  { name: "federation_remove", description: "Unregister an upstream MCP server by namespace.", inputSchema: { type: "object", properties: { namespace: { type: "string" } }, required: ["namespace"] } },
  {
    name: "policy_set",
    description: `Set governance policy for any tool (native or federated namespace__tool): allow | approve | block. Default is allow. 'approve' refuses the call unless it carries "_approved": true.`,
    inputSchema: { type: "object", properties: { tool: { type: "string" }, mode: { type: "string", enum: ["allow", "approve", "block"] } }, required: ["tool", "mode"] }
  },
  { name: "policy_list", description: "List all non-default tool policies.", inputSchema: { type: "object", properties: {} } }
];
var MGMT_TOOLS = new Set(MGMT_TOOL_DEFS.map((t) => t.name));
async function runMgmtTool(name, args, env) {
  switch (name) {
    case "federation_add":
      return addUpstream(env, args);
    case "federation_list":
      return { upstreams: await listUpstreams(env) };
    case "federation_remove":
      return removeUpstream(env, args.namespace);
    case "policy_set":
      return setPolicy(env, args.tool, args.mode);
    case "policy_list":
      return { policies: await listPolicy(env) };
    default:
      return { error: true, message: `unknown mgmt tool: ${name}` };
  }
}
__name(runMgmtTool, "runMgmtTool");
var PROTOCOL_FALLBACK = "2025-06-18";
var TOOLS = [
  {
    name: "scan_zone",
    description: "Read-only snapshot of a domain's Cloudflare zone: all DNS records plus parsed SPF, DMARC, BIMI, and Email Routing status. Never writes.",
    inputSchema: {
      type: "object",
      properties: { domain: { type: "string", description: "Domain to scan, e.g. example.com" } },
      required: ["domain"]
    }
  },
  {
    name: "plan_email_auth",
    description: "Analyze a domain's email authentication (SPF/DKIM/DMARC/BIMI/routing) and report what is missing or misconfigured, with the exact records to add. Never writes.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Domain to analyze" },
        inbox: { type: "string", description: "Where DMARC aggregate reports should go, e.g. you@gmail.com" }
      },
      required: ["domain"]
    }
  },
  {
    name: "verify_domain",
    description: "Re-scan a domain and return a pass/fail checklist: SPF, DMARC present + enforced, MX, Email Routing, BIMI, DKIM count. Never writes.",
    inputSchema: {
      type: "object",
      properties: { domain: { type: "string" } },
      required: ["domain"]
    }
  },
  {
    name: "apply_dns_record",
    description: "Upsert a single DNS record (create if absent, update if content differs, no-op if identical). DRY-RUN by default \u2014 returns the planned diff and writes nothing unless apply=true. Never deletes.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string" },
        type: { type: "string", description: "TXT, CNAME, MX, A, AAAA\u2026" },
        name: { type: "string", description: "Record name, e.g. @, _dmarc, default._bimi" },
        content: { type: "string", description: "Record value" },
        priority: { type: "number", description: "MX priority (MX only)" },
        proxied: { type: "boolean" },
        apply: { type: "boolean", description: "Set true to actually write. Default false = dry-run." }
      },
      required: ["domain", "type", "name", "content"]
    }
  },
  {
    name: "delete_dns_record",
    description: "Delete exactly one DNS record after a fresh lookup. Requires domain, exact record_id, matching expected_name, and confirm=true. Refuses by default and never deletes by name alone.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Zone name, e.g. example.com" },
        record_id: { type: "string", description: "Exact DNS record id returned by scan_zone" },
        expected_name: { type: "string", description: "Exact hostname expected for that record id" },
        confirm: { type: "boolean", description: "Must be true to perform the deletion" }
      },
      required: ["domain", "record_id", "expected_name", "confirm"]
    }
  },
  {
    name: "set_dmarc_policy",
    description: "Change the _dmarc policy (none|quarantine|reject), preserving other tags. DRY-RUN by default \u2014 returns the before/after diff and writes nothing unless apply=true.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string" },
        policy: { type: "string", enum: ["none", "quarantine", "reject"] },
        rua: { type: "string", description: "Optional aggregate-report mailbox, e.g. mailto:you@gmail.com" },
        pct: { type: "number", description: "Optional rollout percentage 1-100" },
        apply: { type: "boolean", description: "Default false = dry-run." }
      },
      required: ["domain", "policy"]
    }
  },
  {
    name: "setup_bimi",
    description: "Create/update the default._bimi TXT record pointing at a logo SVG. REFUSES to write when DMARC is p=none (unless force=true) because BIMI won't be honored without enforced DMARC. DRY-RUN by default.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string" },
        logo: { type: "string", description: "HTTPS URL to an SVG Tiny-PS logo" },
        vmc: { type: "string", description: "Optional Verified Mark Certificate PEM URL" },
        apply: { type: "boolean", description: "Default false = dry-run." },
        force: { type: "boolean", description: "Override the DMARC precondition (not recommended)." }
      },
      required: ["domain", "logo"]
    }
  },
  {
    name: "setup_email_routing",
    description: "Enable Cloudflare Email Routing and create forward rules (+ optional catch-all). Cloudflare auto-adds the MX/SPF records. DRY-RUN by default. Destination addresses must be verified by their owner via Cloudflare's email.",
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
            required: ["address"]
          }
        },
        catch_all: { type: "string", description: "Optional catch-all destination address" },
        apply: { type: "boolean", description: "Default false = dry-run." },
        force: { type: "boolean", description: "Create rules even to unverified destinations (not recommended \u2014 they stay disabled)." }
      },
      required: ["domain"]
    }
  },
  {
    name: "pages_cutover",
    description: "Plan or apply a Cloudflare Pages DNS cutover. Deletes only conflicting apex/www A/AAAA/CNAME records and www NS delegations, then creates proxied CNAMEs to the Pages target. DRY-RUN by default; writes only when apply=true.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Root zone, e.g. example.com" },
        target: { type: "string", description: "Pages hostname, normally project.pages.dev" },
        include_www: { type: "boolean", description: "Also cut over www. Default true." },
        include_wildcard: { type: "boolean", description: "Also remove conflicting wildcard records. Default false." },
        apply: { type: "boolean", description: "Default false = dry-run." }
      },
      required: ["domain", "target"]
    }
  },
  {
    name: "purge_cache",
    description: "Purge Cloudflare's cache for a zone \u2014 the whole zone (default) or specific URLs. DRY-RUN by default: returns the scope and purges NOTHING unless apply=true. Needs a token with Zone > Cache Purge.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Zone, e.g. example.com" },
        everything: { type: "boolean", description: "Purge the whole zone cache (default when no urls given)." },
        urls: { type: "array", items: { type: "string" }, description: "Specific absolute URLs to purge (max 30)." },
        apply: { type: "boolean", description: "Default false = dry-run." }
      },
      required: ["domain"]
    }
  },
  {
    name: "create_turnstile_widget",
    description: "Plan or create a Cloudflare Turnstile widget for a domain. DRY-RUN by default; creates the widget only when apply=true. Returns the public sitekey and one-time secret when applied.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Primary zone/domain, e.g. example.com" },
        name: { type: "string", description: "Optional widget display name." },
        mode: {
          type: "string",
          enum: ["managed", "non-interactive", "invisible"],
          description: "Turnstile mode. Default managed."
        },
        extra_domains: {
          type: "array",
          items: { type: "string" },
          description: "Additional hostnames allowed to use this widget."
        },
        apply: { type: "boolean", description: "Default false = dry-run." }
      },
      required: ["domain"]
    }
  },
  {
    name: "mint_scoped_token",
    description: "Mint a narrow, auto-expiring Cloudflare API token for ONE zone (presets: zone-read, dns-zone, cache-purge; default 1h TTL). The vending machine for least-privilege agent work: hand a cheap agent a key that can't hurt anything and dies on its own. DRY-RUN by default \u2014 returns the exact policy JSON; mints nothing unless apply=true. Needs a bootstrap token with 'API Tokens Write'. There is deliberately NO super/account-wide preset.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Zone the token is confined to, e.g. example.com" },
        preset: { type: "string", enum: ["zone-read", "dns-zone", "cache-purge"], description: "Permission preset. Default dns-zone." },
        extra_groups: { type: "array", items: { type: "string" }, description: "Additional Cloudflare permission-group NAMES (still zone-scoped)." },
        ttl_seconds: { type: "number", description: "Lifetime in seconds. Default 3600; capped at 86400 unless confirm_long=true." },
        confirm_long: { type: "boolean", description: "Required to exceed the 24h TTL cap." },
        name: { type: "string", description: "Optional token label for the CF dashboard." },
        keep_days: { type: "number", description: "How many days this token may sit unused before the auditor revokes it (1-365). Default = token_audit_settings unused_days." },
        apply: { type: "boolean", description: "Default false = dry-run." }
      },
      required: ["domain"]
    }
  },
  {
    name: "list_tokens",
    description: "List API tokens on the connected user: id, name, status, expiry, and whether cfops minted them. NEVER returns token values (Cloudflare only shows those once, at mint). Read-only.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "revoke_token",
    description: "Revoke an API token by id (e.g. a minted task-token you're done with early). DRY-RUN by default; deletes nothing unless apply=true.",
    inputSchema: {
      type: "object",
      properties: {
        token_id: { type: "string", description: "Token id from list_tokens." },
        apply: { type: "boolean", description: "Default false = dry-run." }
      },
      required: ["token_id"]
    }
  },
  {
    name: "who_serves_domain",
    description: "Answer 'what is ACTUALLY serving this domain?': zone \u2192 Worker routes, Worker custom domains, and Pages projects that claim it, with a warning when multiple products fight over it. Read-only.",
    inputSchema: {
      type: "object",
      properties: { domain: { type: "string", description: "Hostname or zone, e.g. app.example.com" } },
      required: ["domain"]
    }
  },
  {
    name: "account_doctor",
    description: "Diagnose the token/account situation: accounts visible to this token, whether the expected account is among them (wrong-token detection), and SAME-NAME Pages projects across accounts \u2014 the decoy that silently eats deploys. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        expected_account_id: { type: "string", description: "Account id deploys are SUPPOSED to target." }
      }
    }
  },
  {
    name: "pages_branch_check",
    description: "Compare a Pages project's production branch against the branch you're about to deploy \u2014 catches the silent 'git says master, project says main, every deploy lands on a preview' failure. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string", description: "Account that owns the Pages project." },
        project: { type: "string", description: "Pages project name." },
        git_branch: { type: "string", description: "Branch you intend to deploy; enables the match/mismatch verdict." }
      },
      required: ["account_id", "project"]
    }
  },
  ...APIARY_READ_TOOL_DEFS,
  ...PAGES_DEPLOY_TOOL_DEFS,
  ...PAGES_PATCH_TOOL_DEFS,
  ...GITHUB_TOOL_DEFS,
  {
    name: "site_views",
    description: "READ-ONLY traffic for one of Austin's domains from Cloudflare analytics: requests, page views and unique visitors for today, the last 7 days or the last 30 days, plus the period before it to compare, and a per-day list. Counts include bots unless noted. Use it for 'how many views on X'.",
    inputSchema: { type: "object", properties: { domain: { type: "string", description: "e.g. servicepricer.app or amhagentbook.com" }, period: { type: "string", enum: ["today", "week", "month"], description: "default week" } }, required: ["domain"] }
  },
  {
    name: "pages_create_project",
    description: "Create a NEW Cloudflare Pages project (empty site at <name>.pages.dev). Dry-run unless apply=true. Then use pages_deploy to put files on it and pages_add_domain for a custom domain.",
    inputSchema: { type: "object", properties: { account: { type: "string", description: "amh (pain2hustle1), doors (austinsdoors1), or artificialmindhive" }, name: { type: "string", description: "lowercase letters, digits, dashes" }, production_branch: { type: "string", description: "default main" }, apply: { type: "boolean" } }, required: ["account", "name"] }
  },
  {
    name: "pages_add_domain",
    description: "Attach a custom domain (e.g. tacos.com or www.tacos.com) to a Pages project, or show the status of its domains. If the domain's zone is on the same Cloudflare account, Cloudflare sets up DNS itself; otherwise the result says what record to add. Dry-run unless apply=true.",
    inputSchema: { type: "object", properties: { account: { type: "string", description: "amh (pain2hustle1), doors (austinsdoors1), or artificialmindhive" }, project: { type: "string" }, domain: { type: "string", description: "omit to just list the project's domains" }, apply: { type: "boolean" } }, required: ["account", "project"] }
  },
  {
    name: "worker_deploy",
    description: "Deploy a small Cloudflare Worker (one ES-module file, export default { fetch }) next to a site, e.g. an AI chat endpoint or a form handler. Optional bindings: ai=true gives env.AI (Workers AI, e.g. env.AI.run('@cf/moonshotai/kimi-k2.6', {messages})), d1=[{binding, database_id}] gives env.<binding>, vars={NAME:'value'}. Publishes at <name>.<account>.workers.dev. Refuses to overwrite any Worker the hub didn't create (Austin's existing workers are safe). Dry-run unless apply=true. Remember the account's free AI allowance is shared: add a rate limit to anything public.",
    inputSchema: { type: "object", properties: { account: { type: "string", description: "amh (pain2hustle1), doors (austinsdoors1), or artificialmindhive" }, name: { type: "string" }, code: { type: "string", description: "the module source" }, ai: { type: "boolean" }, d1: { type: "array", items: { type: "object", properties: { binding: { type: "string" }, database_id: { type: "string" } }, required: ["binding", "database_id"] } }, vars: { type: "object" }, compatibility_date: { type: "string" }, apply: { type: "boolean" } }, required: ["account", "name", "code"] }
  },
  {
    name: "d1_create",
    description: "Create a new D1 database (or list existing ones when name is omitted). Dry-run unless apply=true.",
    inputSchema: { type: "object", properties: { account: { type: "string", description: "amh (pain2hustle1), doors (austinsdoors1), or artificialmindhive" }, name: { type: "string" }, apply: { type: "boolean" } }, required: ["account"] }
  },
  {
    name: "d1_query",
    description: "READ-ONLY SQL on a D1 database (SELECT / WITH / PRAGMA / EXPLAIN only). database = name or id. Returns rows.",
    inputSchema: { type: "object", properties: { account: { type: "string", description: "amh (pain2hustle1), doors (austinsdoors1), or artificialmindhive" }, database: { type: "string" }, sql: { type: "string" }, params: { type: "array" } }, required: ["account", "database", "sql"] }
  },
  {
    name: "d1_exec",
    description: "WRITE SQL on a D1 database (CREATE TABLE, INSERT, UPDATE, DELETE...). Dry-run unless apply=true; Austin must approve writes. DROP of a table needs force=true.",
    inputSchema: { type: "object", properties: { account: { type: "string", description: "amh (pain2hustle1), doors (austinsdoors1), or artificialmindhive" }, database: { type: "string" }, sql: { type: "string" }, params: { type: "array" }, apply: { type: "boolean" }, force: { type: "boolean" } }, required: ["account", "database", "sql"] }
  },
  ...INBOX_TOOL_DEFS,
  ...WP_TOOL_DEFS,
  ...EMAIL_TOOL_DEFS,
  {
    name: "token_audit_settings",
    description: "Read or change the token auditor: unused_days = how long a hub-minted (cfops) token may sit unused before it is revoked (default 7). Admin keys can change it.",
    inputSchema: { type: "object", properties: { unused_days: { type: "number", description: "1-365; omit to just read" } } }
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
        schedule: { type: "object", properties: { enabled: { type: "boolean" }, every_minutes: { type: "number" } } }
      },
      required: ["template_id", "objective"]
    }
  },
  {
    name: "agent_research_status",
    description: "Read one delegated job, including its redacted timeline, sources, primary result, independent verifier result, gaps, and candidate revisions.",
    inputSchema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] }
  },
  {
    name: "agent_research_list",
    description: "List recent delegated jobs for this authenticated user. Read-only and tenant-isolated.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "agent_briefing",
    description: "Return the Continuity Keeper's current compact project briefing and memory hash: active platform, target, blocker, keep/archive/drop guidance, and next safe step.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "agent_control",
    description: "Safely pause or resume new agent work, cancel a queued/running job at its next phase boundary, force read-only mode, or run retention cleanup. Models cannot disable read-only mode.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["pause", "resume", "cancel_job", "readonly_on", "retention_sweep"] },
        job_id: { type: "string", description: "Required for cancel_job." }
      },
      required: ["action"]
    }
  }
];
var HARNESS_TOOLS = /* @__PURE__ */ new Set(["agent_research_start", "agent_research_status", "agent_research_list", "agent_briefing", "agent_control"]);
async function runHarnessTool(name, args, env, authContext) {
  if (!env.AGENT_HARNESS || !env.HARNESS_INTERNAL_KEY) return { error: "The private AMH WT agent harness is not configured on this deployment." };
  const actor = authContext?.connectionId || (authContext?.mode === "admin" ? "private-admin" : "unknown");
  const routes = {
    agent_research_start: { method: "POST", path: "/internal/jobs", body: args },
    agent_research_status: { method: "GET", path: `/internal/jobs/${encodeURIComponent(String(args.job_id || ""))}` },
    agent_research_list: { method: "GET", path: "/internal/jobs" },
    agent_briefing: { method: "GET", path: "/internal/briefing" },
    agent_control: { method: "POST", path: "/internal/control", body: args }
  };
  const route = routes[name];
  if (name === "agent_research_status" && !String(args.job_id || "").trim()) return { error: "job_id is required" };
  const response = await env.AGENT_HARNESS.fetch(`https://amh-wt.internal${route.path}`, {
    method: route.method,
    headers: {
      "content-type": "application/json",
      "x-amh-internal-key": env.HARNESS_INTERNAL_KEY,
      "x-amh-actor": actor
    },
    body: route.body ? JSON.stringify(route.body) : void 0
  });
  const output = await response.json().catch(() => ({ error: `Harness returned HTTP ${response.status}` }));
  return response.ok ? output : { error: output.error || `Harness returned HTTP ${response.status}` };
}
__name(runHarnessTool, "runHarnessTool");
// Shared owner/agent Pages credentials stay in Worker secrets, never tool arguments.
function pagesOwnerAccountClient(env, authContext, accountId) {
  if (authContext?.mode !== "admin") return null;
  if (accountId === "a08783a0d3715df907ed5ccad38f0dcf") {
    const token = env.CLOUDFLARE_API_TOKEN_ARTIFICIALMINDHIVE;
    if (!token) throw new Error("Artificialmindhive Pages credential is not configured");
    return new CloudflareClient({ token });
  }
  if (accountId === "1d5fae607a857fc56cd575763bf8f3bc" && env.CLOUDFLARE_API_TOKEN_DOORS)
    return new CloudflareClient({ token: env.CLOUDFLARE_API_TOKEN_DOORS });
  return null;
}

async function runTool(name, args, env, authContext) {
  if (APIARY_READ_TOOLS.has(name)) return runApiaryReadTool(name, args, env, authContext);
  if (HARNESS_TOOLS.has(name)) return runHarnessTool(name, args, env, authContext);
  if (name === "token_audit_settings") {
    const kv = env.CLOUDFLARE_OPS_OAUTH;
    if (!kv) return { error: "no KV" };
    if (args.unused_days !== void 0) {
      if (authContext?.mode !== "admin") return { error: "only an admin key can change this" };
      const d = Math.floor(Number(args.unused_days));
      if (!(d >= 1 && d <= 365)) return { error: "unused_days must be 1-365" };
      await kv.put("cfg:unused_days", String(d));
    }
    return { unused_days: Number(await kv.get("cfg:unused_days")) || 7, last_audit: await kv.get("audit:last", "json") };
  }
  const legacyTenant = authContext?.mode === "admin" ? String(args.tenant || "default").trim() || "default" : "default";
  const token = await getOAuthAccessToken(env, authContext, legacyTenant);
  if (!token) {
    return {
      error: "No Cloudflare connection is available. Connect at /oauth/cloudflare/start, or configure the private admin fallback token."
    };
  }
  const client = new CloudflareClient({ token });
  if (name === "pages_deploy" && (args.patch === true || Array.isArray(args.edits))) name = "pages_patch";
  if (name === "pages_get_deployment" && args.path) name = "pages_read_file";
  if (name === "pages_patch" || name === "pages_special_files" || name === "pages_read_file") {
    try {
      let c = client;
      if (args.account) c = pagesOwnerAccountClient(env, authContext, pagesAccount(args.account)) || c;
      if (name === "pages_read_file") return await pagesReadFile(c, args);
      return name === "pages_patch" ? await pagesPatch(c, args, env, authContext?.connectionId || authContext?.mode) : await pagesSaveSpecial(c, args, env);
    } catch (e) {
      return { error: String(e && e.message || e).slice(0, 600) };
    }
  }
  if (SITE_SETUP_TOOLS.has(name)) {
    if (authContext?.mode !== "admin") return { error: name + " is for the owner and agent keys" };
    try {
      return await siteSetupTool(name, args, env);
    } catch (e) {
      return { error: String(e && e.message || e).slice(0, 500) };
    }
  }
  if (name === "site_views") {
    if (authContext?.mode !== "admin") return { error: "site_views is for the owner and agent keys" };
    try {
      return await siteViews(env, args);
    } catch (e) {
      return { error: String(e && e.message || e).slice(0, 400) };
    }
  }
  if (PAGES_DEPLOY_TOOLS.has(name)) return await runPagesDeployTool(name, args, client, (acct) => pagesOwnerAccountClient(env, authContext, acct));
  const domain = String(args.domain || "").trim();
  const DOMAINLESS = /* @__PURE__ */ new Set(["list_tokens", "revoke_token", "account_doctor", "pages_branch_check"]);
  if (!domain && !DOMAINLESS.has(name)) return { error: "domain is required" };
  switch (name) {
    case "mint_scoped_token": {
      const minted = await mintScopedToken(client, {
        domain,
        preset: args.preset || "dns-zone",
        extra_groups: Array.isArray(args.extra_groups) ? args.extra_groups : [],
        ttl_seconds: args.ttl_seconds,
        confirm_long: args.confirm_long === true,
        name: args.name,
        apply: args.apply === true
      });
      if (minted && minted.apply === true && minted.id && env.CLOUDFLARE_OPS_OAUTH) {
        const zoneId = await resolveZone2(client, domain).then((z) => z && z.id).catch(() => null);
        await env.CLOUDFLARE_OPS_OAUTH.put(`mintlog:${minted.id}`, JSON.stringify({ id: minted.id, domain: minted.domain, zone_id: zoneId, preset: minted.preset, expires_on: minted.expires_on, keep_days: Number(args.keep_days) >= 1 ? Math.min(365, Math.floor(Number(args.keep_days))) : null, at: (/* @__PURE__ */ new Date()).toISOString(), actor: authContext?.connectionId || authContext?.mode || "unknown" }), { expirationTtl: 60 * 60 * 24 * 30 });
      }
      return minted;
    }
    case "list_tokens":
      return { tokens: await listTokens(client), presets: Object.keys(TOKEN_PRESETS), last_audit: env.CLOUDFLARE_OPS_OAUTH ? await env.CLOUDFLARE_OPS_OAUTH.get("audit:last", "json") : null, this_week: env.CLOUDFLARE_OPS_OAUTH ? await env.CLOUDFLARE_OPS_OAUTH.get(`digest:${new Date(Date.now() - ((/* @__PURE__ */ new Date()).getUTCDay() + 6) % 7 * 864e5).toISOString().slice(0, 10)}`, "json") : null };
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
        git_branch: args.git_branch
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
        dkim_records: dkim
      };
      const all_pass = checks.spf && dkim > 0 && checks.dmarc && enforced && mx;
      return {
        domain,
        checks,
        all_pass,
        // BIMI is reported, never required.
        bimi_ready: all_pass && checks.bimi
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
        apply: args.apply === true
      });
    case "purge_cache":
      return await purgeCache(client, domain, {
        everything: args.everything === true,
        files: args.urls,
        apply: args.apply === true
      });
    case "create_turnstile_widget":
      return await createTurnstileWidget(client, domain, {
        name: args.name,
        mode: args.mode || "managed",
        extraDomains: args.extra_domains || [],
        apply: args.apply === true
      });
    default:
      return { error: `unknown tool: ${name}` };
  }
}
__name(runTool, "runTool");
function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
__name(rpcResult, "rpcResult");
function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
__name(rpcError, "rpcError");
async function handleRpc(msg, env, authContext) {
  const { id, method, params } = msg || {};
  if (id === void 0 || id === null) return null;
  if (method === "initialize") {
    const requested = params && params.protocolVersion;
    return rpcResult(id, {
      protocolVersion: typeof requested === "string" ? requested : PROTOCOL_FALLBACK,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER,
      instructions: "Cloudflare Ops MCP audits and safely changes common Cloudflare work across DNS, email authentication, Pages cutovers, cache purge, Turnstile widgets, and Email Routing. Use it to scan a Cloudflare zone, diagnose email deliverability and spoofing gaps, apply targeted DNS/DMARC/BIMI/Email Routing fixes, cut a hostname to Cloudflare Pages, purge cache, or create a Turnstile widget. Safety: every write is DRY-RUN by default and returns a diff; nothing changes unless you pass apply=true. Each hosted user is bound to their own server-side Cloudflare OAuth connection; Cloudflare tokens are never tool arguments or shared through Git. Cloudflare Ops MCP / cloudflare-ops-mcp is an independent, third-party open-source tool - not affiliated with, endorsed by, or sponsored by Cloudflare, Inc.; Cloudflare is used nominatively to name the service this tool works with."
    });
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") {
    if (authContext && authContext.mode === "user") return rpcResult(id, { tools: wtuToolDefs() });
    let fed = [];
    try {
      fed = await federatedTools(env);
    } catch {
      fed = [];
    }
    const isAdmin = authContext && authContext.mode === "admin";
    const FIRST = /^(cf|cfdoors)__/;
    return rpcResult(id, { tools: [...TOOLS, ...fed.filter((t) => FIRST.test(t.name)), ...isAdmin ? MGMT_TOOL_DEFS : [], ...fed.filter((t) => !FIRST.test(t.name))] });
  }
  if (method === "tools/call") {
    const toolName = params && params.name;
    const args = params && params.arguments || {};
    try {
      if (authContext && authContext.mode === "user") {
        const outU = await wtuCallTool(toolName, args, env, authContext);
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(outU, null, 2) }], isError: !!(outU && outU.error) });
      }
      if (MGMT_TOOLS.has(toolName)) {
        if (!authContext || authContext.mode !== "admin") {
          return rpcResult(id, { content: [{ type: "text", text: JSON.stringify({ error: "forbidden: " + toolName + " is an owner/admin tool. Federation and policy are global settings; per-user connector keys cannot change them." }, null, 2) }], isError: true });
        }
        const out2 = await runMgmtTool(toolName, args, env);
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out2, null, 2) }], isError: !!(out2 && out2.error) });
      }
      const gate = await checkPolicy(env, toolName, args);
      if (!gate.allowed) {
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify({ error: gate.reason, policy: gate.mode }, null, 2) }], isError: true });
      }
      if (EMAIL_TOOLS.has(toolName)) {
        if (!authContext || authContext.mode !== "admin") return rpcResult(id, { content: [{ type: "text", text: JSON.stringify({ error: "email_austin is for owner/agent keys" }) }], isError: true });
        const outE = await runEmailTool(toolName, args, env, authContext.connectionId || "agent");
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(outE, null, 2) }], isError: !!(outE && outE.error) });
      }
      if (WP_TOOLS.has(toolName)) {
        if (!authContext || authContext.mode !== "admin") return rpcResult(id, { content: [{ type: "text", text: JSON.stringify({ error: toolName + " is for owner/agent keys" }) }], isError: true });
        const outW = await runWorkerPatchTool(toolName, args, env, authContext.connectionId || "admin");
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(outW, null, 2) }], isError: !!(outW && outW.error) });
      }
      if (INBOX_TOOLS.has(toolName)) {
        if (!authContext || authContext.mode !== "admin") return rpcResult(id, { content: [{ type: "text", text: JSON.stringify({ error: "the agent inbox is for owner/agent keys" }) }], isError: true });
        const outI = await runInboxTool(toolName, args, env, null);
        // an agent's own handoffs ("[hop n]") are woken by the runner itself
        if (toolName === "post_task" && outI && outI.task && CLOUD_WAKE.includes(outI.task.to) && !/^[hop d+]/.test(String(args.text || ""))) await wakeCloudAgent(env, outI.task);
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(outI, null, 2) }], isError: !!(outI && outI.error) });
      }
      if (GITHUB_TOOLS.has(toolName) || /^pc__repo_(list|read|commit_push|open_pr)$/.test(toolName)) {
        if (!authContext || authContext.mode !== "admin") return rpcResult(id, { content: [{ type: "text", text: JSON.stringify({ error: "GitHub tools need an admin/agent key" }) }], isError: true });
        const out2 = await runGithubTool(toolName.replace(/^pc__/, ""), args, env, authContext.connectionId || authContext.mode);
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out2, null, 2) }], isError: !!(out2 && out2.error) });
      }
      const namespaces = (await listUpstreams(env)).map((u) => u.namespace);
      const fed = isFederated(toolName, namespaces);
      if (fed) {
        const out2 = await callFederated(env, fed.ns, fed.tool, args);
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out2, null, 2) }], isError: !!(out2 && out2.error) });
      }
      const tool = TOOLS.find((t) => t.name === toolName);
      if (!tool) return rpcError(id, -32602, `unknown tool: ${toolName}`);
      const out = await runTool(toolName, args, env, authContext);
      const isError = !!(out && out.error);
      if ((args.apply === true || toolName === "delete_dns_record" && args.confirm === true) && !isError) {
        console.log(JSON.stringify({
          event: "tool_apply",
          tool: toolName,
          domain: String(args.domain || ""),
          auth_mode: authContext?.mode || "unknown"
        }));
      }
      return rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        isError
      });
    } catch (e) {
      const safe = redactToken(String(e && e.message || e));
      return rpcResult(id, { content: [{ type: "text", text: `Error: ${safe}` }], isError: true });
    }
  }
  return rpcError(id, -32601, `method not found: ${method}`);
}
__name(handleRpc, "handleRpc");
var SECURITY_HEADERS = {
  // Force HTTPS for a year. The Worker is only ever reachable over TLS.
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  // Nothing here is meant to be framed — kills clickjacking of the OAuth
  // connect page, which is the one page a user clicks a real button on.
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=()"
};
var WT_LANDING_CSP = [
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
  "frame-ancestors 'none'"
].join("; ");
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, X-MCP-Key, Mcp-Session-Id, Mcp-Protocol-Version",
  "Cache-Control": "no-store",
  ...SECURITY_HEADERS
};
function renderLogoSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img" aria-label="Cloudflare Ops MCP"><rect width="512" height="512" rx="96" fill="#07140d"/><path d="M138 294c0-90 73-163 163-163 35 0 68 11 94 30l-46 56c-14-9-30-14-48-14-50 0-91 41-91 91s41 91 91 91c18 0 34-5 48-14l46 56c-26 19-59 30-94 30-90 0-163-73-163-163Z" fill="#6ee7a3"/><path d="M107 158h93v72h-93v-72Zm0 124h93v72h-93v-72Z" fill="#f5f1e8"/><circle cx="347" cy="294" r="42" fill="#f5f1e8"/></svg>`;
}
__name(renderLogoSvg, "renderLogoSvg");
function discoveryUrls(origin) {
  return [
    origin + "/",
    origin + "/?format=json",
    origin + "/llms.txt",
    origin + "/walrus-tusk.md"
  ];
}
__name(discoveryUrls, "discoveryUrls");
function renderRobots(origin) {
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /mcp",
    "Disallow: /oauth/cloudflare/callback",
    "Disallow: /oauth/cloudflare/status",
    "Disallow: /oauth/cloudflare/revoke",
    "Sitemap: " + origin + "/sitemap.xml",
    ""
  ].join("\n");
}
__name(renderRobots, "renderRobots");
function renderSitemap(origin) {
  const stamp = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const nodes = discoveryUrls(origin).map((url) => "<url><loc>" + url.replace(/&/g, "&amp;") + "</loc><lastmod>" + stamp + "</lastmod></url>").join("");
  return '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + nodes + "</urlset>";
}
__name(renderSitemap, "renderSitemap");
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
    ""
  ].join("\n");
}
__name(renderLlmsText, "renderLlmsText");
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
    ""
  ].join("\n");
}
__name(renderWalrusTuskMarkdown, "renderWalrusTuskMarkdown");
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
  <div class="top"><div class="brand"><span class="mark"></span><span>-/\\-\\ M H // WT</span></div><div class="pill">Per-user OAuth \xB7 no shared API token</div></div>
  <section class="hero">
    <div class="copy">
      <div class="eyebrow">OAuth-first Cloudflare control</div>
      <h1>Your Cloudflare. Your connection.</h1>
      <p>DNS, Email Routing, DMARC, BIMI, Pages cutovers, cache purge, and Turnstile tools stay approval-gated. Every user connects through Cloudflare OAuth and receives a separate MCP connector key\u2014never the owner's API token.</p>
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
__name(renderStatusHtml, "renderStatusHtml");
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
    headers
  });
}
__name(renderWtLanding, "renderWtLanding");
async function fetchInner(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/robots.txt") return new Response(renderRobots(url.origin), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
  if (request.method === "GET" && url.pathname === "/sitemap.xml") return new Response(renderSitemap(url.origin), { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" } });
  if (request.method === "GET" && url.pathname === "/llms.txt") return new Response(renderLlmsText(url.origin), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
  if (request.method === "GET" && url.pathname === "/walrus-tusk.md") return new Response(renderWalrusTuskMarkdown(url.origin), { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=3600" } });
  if (request.method === "GET" && url.pathname === "/" + INDEXNOW_KEY + ".txt") return new Response(INDEXNOW_KEY, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=86400" } });
  if (url.pathname === "/logo.svg") return new Response(renderLogoSvg(), { headers: { "content-type": "image/svg+xml", ...CORS } });
  {
    const ibr = await inboxHandleHttp(request, env, url);
    if (ibr) return ibr;
  }
  {
    const wtr = await wtuHandleHttp(request, env, url);
    if (wtr) return wtr;
  }
  if (url.pathname === "/oauth/cloudflare/start") return handleOAuthStart(request, env);
  if (url.pathname === "/oauth/cloudflare/callback") return handleOAuthCallback(request, env);
  if (url.pathname === "/oauth/cloudflare/status") return handleOAuthStatus(request, env);
  if (url.pathname === "/oauth/cloudflare/revoke") return handleOAuthRevoke(request, env);
  if (request.method === "GET" && url.pathname === "/mcp" && /text\/event-stream/i.test(request.headers.get("accept") || "")) {
    return new Response("Method Not Allowed", { status: 405, headers: { ...CORS, "allow": "POST", "cache-control": "public, max-age=3600" } });
  }
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
      note: "Connect at /oauth/cloudflare/start, then POST MCP JSON-RPC to /mcp with your one-user connector key. Cloudflare tokens remain server-side."
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
  const auth = request.headers.get("authorization") || "";
  const provided = (/^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "") : "").trim() || (request.headers.get("x-mcp-key") || "").trim() || (new URL(request.url).searchParams.get("key") || "").trim();
  const authContext = await authorizeConnector(env, provided);
  if (!authContext.ok) {
    return new Response(JSON.stringify(rpcError(null, -32001, "unauthorized")), {
      status: 401,
      headers: { "content-type": "application/json", "www-authenticate": "Bearer", ...CORS }
    });
  }
  const rl = await checkRateLimit(env, authContext);
  if (!rl.allowed) {
    return new Response(JSON.stringify(rpcError(null, -32e3, `rate limited: over ${rl.limit} requests/minute for this key. Retry in ${rl.retryAfter}s.`)), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": String(rl.retryAfter), ...CORS }
    });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify(rpcError(null, -32700, "parse error")), { status: 400, headers: { "content-type": "application/json", ...CORS } });
  }
  const single = !Array.isArray(body);
  const messages = single ? [body] : body;
  const out = [];
  for (const m of messages) {
    const r = await handleRpc(m, env, authContext);
    if (r) out.push(r);
  }
  if (out.length === 0) return new Response(null, { status: 202, headers: CORS });
  const payload = single ? out[0] : out;
  const wantsSse = /text\/event-stream/i.test(request.headers.get("accept") || "");
  if (wantsSse) {
    const sse = `event: message
data: ${JSON.stringify(payload)}

`;
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", ...CORS } });
  }
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json", ...CORS } });
}
__name(fetchInner, "fetchInner");
function harden(res) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!h.has(k)) h.set(k, v);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
__name(harden, "harden");
var RateLimiterDO = class {
  static {
    __name(this, "RateLimiterDO");
  }
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.hits = null;
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/worker-patch") return wpLedgerFetch(request, this.state);
    if (url.pathname === "/task-board") return inboxBoardFetch(request, this.state, this.env);
    if (await this.state.storage.get("board:meta")) return new Response("Wrong instance", { status: 400 });
    const limit = Number(url.searchParams.get("limit")) || 120;
    const period = Number(url.searchParams.get("period")) || 60;
    const now = Date.now();
    const window = Math.floor(now / (period * 1e3));
    if (!this.hits) {
      this.hits = await this.state.storage.get("hits") || { window, count: 0 };
    }
    if (this.hits.window !== window) {
      this.hits = { window, count: 0 };
    }
    this.hits.count += 1;
    const over = this.hits.count > limit;
    await this.state.storage.put("hits", this.hits);
    await this.state.storage.setAlarm(now + period * 2e3);
    const resetIn = period - Math.floor(now % (period * 1e3) / 1e3);
    return new Response(JSON.stringify({
      allowed: !over,
      count: this.hits.count,
      limit,
      retryAfter: resetIn
    }), { headers: { "content-type": "application/json" } });
  }
  async alarm() {
    const board = await this.state.storage.get("board:meta");
    if (board) return inboxBoardAlarm(this.state, this.env, board);
    await this.state.storage.deleteAll();
    this.hits = null;
  }
};
async function auditMintedTokens(env) {
  const report = { at: (/* @__PURE__ */ new Date()).toISOString(), checked: 0, revoked: [], kept: 0, errors: [] };
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    report.errors.push("no CLOUDFLARE_API_TOKEN");
    return report;
  }
  const client = new CloudflareClient({ token });
  const unusedDays = Number(env.CLOUDFLARE_OPS_OAUTH && await env.CLOUDFLARE_OPS_OAUTH.get("cfg:unused_days")) || 7;
  report.unused_days = unusedDays;
  let list = [];
  try {
    for (let page2 = 1; page2 <= 10; page2++) {
      const { result } = await client.request("GET", `/user/tokens?per_page=50&page=${page2}`);
      list.push(...result || []);
      if (!result || result.length < 50) break;
    }
  } catch (e) {
    report.errors.push("list: " + String(e.message || e).slice(0, 160));
  }
  for (const t of list) {
    if (!/^cfops /.test(String(t.name || ""))) continue;
    report.checked++;
    let why = null;
    const log = env.CLOUDFLARE_OPS_OAUTH ? await env.CLOUDFLARE_OPS_OAUTH.get(`mintlog:${t.id}`, "json") : null;
    const keep = log && log.keep_days || unusedDays;
    if (t.status === "expired" || t.expires_on && Date.parse(t.expires_on) < Date.now()) why = "expired";
    else if (!t.expires_on) why = "no expiry";
    else if (Date.now() - Date.parse(t.last_used_on || t.issued_on || 0) > keep * 864e5) why = `unused ${keep} days`;
    else if (!log) why = "no mint log entry";
    else {
      const res = (t.policies || []).flatMap((p) => Object.keys(p.resources || {}));
      if (!log.zone_id || res.some((r) => r !== `com.cloudflare.api.account.zone.${log.zone_id}`)) why = "scope beyond its zone";
    }
    if (!why) {
      report.kept++;
      continue;
    }
    try {
      await client.request("DELETE", `/user/tokens/${encodeURIComponent(t.id)}`);
      report.revoked.push({ id: t.id, name: t.name, why });
    } catch (e) {
      report.errors.push(`revoke ${t.id}: ${String(e.message || e).slice(0, 120)}`);
    }
  }
  if (env.CLOUDFLARE_OPS_OAUTH) {
    await env.CLOUDFLARE_OPS_OAUTH.put("audit:last", JSON.stringify(report), { expirationTtl: 60 * 60 * 24 * 30 });
    const d = /* @__PURE__ */ new Date(), monday = new Date(d.getTime() - (d.getUTCDay() + 6) % 7 * 864e5).toISOString().slice(0, 10);
    const key2 = `digest:${monday}`;
    const dg = await env.CLOUDFLARE_OPS_OAUTH.get(key2, "json") || { week_of: monday, audits: 0, revoked: [], tokens: {} };
    dg.audits++;
    dg.revoked.push(...report.revoked.map((r) => ({ ...r, at: report.at })));
    for (const t of list) if (/^cfops /.test(String(t.name || ""))) dg.tokens[t.id] = { name: t.name, issued_on: t.issued_on, last_used_on: t.last_used_on || null, expires_on: t.expires_on || null };
    dg.revoked = dg.revoked.slice(-200);
    await env.CLOUDFLARE_OPS_OAUTH.put(key2, JSON.stringify(dg), { expirationTtl: 60 * 60 * 24 * 60 });
  }
  console.log(JSON.stringify({ event: "token_audit", ...report }));
  return report;
}
__name(auditMintedTokens, "auditMintedTokens");
async function siteViews(env, args) {
  const domain = String(args.domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  if (!domain) return { error: "domain is required" };
  const days = args.period === "today" ? 1 : args.period === "month" ? 30 : 7;
  const tokens = [["amh", env.CLOUDFLARE_API_TOKEN], ["doors", env.CLOUDFLARE_API_TOKEN_DOORS]].filter((t) => t[1]);
  const cf = (tok2, path, init = {}) => fetch("https://api.cloudflare.com/client/v4" + path, { ...init, headers: { Authorization: "Bearer " + tok2, "content-type": "application/json" } }).then((r) => r.json());
  let zone = null, tok = null, acct = null;
  for (const [name, t] of tokens) {
    const j = await cf(t, "/zones?name=" + encodeURIComponent(domain)).catch(() => null);
    if (j && j.success && j.result && j.result[0]) {
      zone = j.result[0];
      tok = t;
      acct = name;
      break;
    }
  }
  if (!zone) return { error: "Neither hub token can see the zone " + domain + ". It may be on another Cloudflare account." };
  const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const q = "query($z:String!,$a:Date!,$b:Date!){viewer{zones(filter:{zoneTag:$z}){httpRequests1dGroups(limit:100,filter:{date_geq:$a,date_leq:$b},orderBy:[date_ASC]){dimensions{date} sum{requests pageViews} uniq{uniques}}}}}";
  const g = await cf(tok, "/graphql", { method: "POST", body: JSON.stringify({ query: q, variables: { z: zone.id, a: day(2 * days - 1), b: day(0) } }) }).catch((e) => ({ errors: [{ message: String(e) }] }));
  if (g.errors && g.errors.length) {
    const msg = g.errors.map((e) => e.message).join("; ").slice(0, 300);
    return { error: /auth|permission|not authorized/i.test(msg) ? "The hub token for " + acct + " can't read analytics for " + domain + ". It needs Zone > Analytics > Read added in the Cloudflare dashboard." : msg };
  }
  const rows = (((g.data || {}).viewer || {}).zones || [])[0];
  const list = (rows && rows.httpRequests1dGroups || []).map((r) => ({ date: r.dimensions.date, requests: r.sum.requests, pageViews: r.sum.pageViews, uniques: r.uniq.uniques }));
  const cut = day(days - 1);
  const sum = (arr) => arr.reduce((t, r) => ({ requests: t.requests + r.requests, pageViews: t.pageViews + r.pageViews, uniques: t.uniques + r.uniques }), { requests: 0, pageViews: 0, uniques: 0 });
  const now = sum(list.filter((r) => r.date >= cut)), before = sum(list.filter((r) => r.date < cut));
  const pct = (a, b) => b ? Math.round((a - b) / b * 100) + "%" : "n/a";
  return {
    domain,
    account: acct,
    period: args.period || "week",
    since: cut,
    through: day(0),
    totals: now,
    previous_period: before,
    change: { pageViews: pct(now.pageViews, before.pageViews), uniques: pct(now.uniques, before.uniques) },
    per_day: list.filter((r) => r.date >= cut),
    note: "Cloudflare zone analytics count every request, bots included; uniques are unique IPs per day summed across days."
  };
}
__name(siteViews, "siteViews");
var SITE_SETUP_TOOLS = /* @__PURE__ */ new Set(["pages_create_project", "pages_add_domain", "worker_deploy", "d1_create", "d1_query", "d1_exec"]);
async function siteSetupTool(name, args, env) {
  const accountId = pagesAccount(args.account);
  // Additional owner credential is intentionally limited to dedicated Pages actions.
  if (accountId === "a08783a0d3715df907ed5ccad38f0dcf" && !["pages_create_project", "pages_add_domain"].includes(name))
    return { error: "Artificialmindhive shared credential is available only for Pages tools" };
  const token = accountId === "a08783a0d3715df907ed5ccad38f0dcf"
    ? env.CLOUDFLARE_API_TOKEN_ARTIFICIALMINDHIVE
    : accountId === "1d5fae607a857fc56cd575763bf8f3bc" ? env.CLOUDFLARE_API_TOKEN_DOORS : env.CLOUDFLARE_API_TOKEN;
  if (!token) return { error: "no hub token for that account" };
  const base = "https://api.cloudflare.com/client/v4/accounts/" + accountId;
  const cf = async (path, init = {}) => {
    const r = await fetch(base + path, { ...init, headers: { Authorization: "Bearer " + token, ...init.body && typeof init.body === "string" ? { "content-type": "application/json" } : {}, ...init.headers || {} } });
    const j = await r.json().catch(() => ({ success: false, errors: [{ message: "HTTP " + r.status }] }));
    if (!j.success) {
      const msg = (j.errors || []).map((e) => e.message).join("; ").slice(0, 400) || "HTTP " + r.status;
      throw new Error(/auth|permission|10000/i.test(msg) ? "Cloudflare refused (" + msg + "). The hub token for this account may be missing the permission for this kind of change." : msg);
    }
    return j.result;
  };
  const apply = args.apply === true;
  const dbId = async (d) => {
    if (/^[a-f0-9-]{36}$/i.test(String(d))) return String(d);
    const list = await cf("/d1/database?per_page=100");
    const hit = (list || []).find((x) => x.name === d);
    if (!hit) throw new Error("no D1 database named " + d);
    return hit.uuid;
  };
  if (name === "pages_create_project") {
    const proj = pagesProject(args.name);
    const body = { name: proj, production_branch: String(args.production_branch || "main") };
    if (!apply) return { dry_run: true, would_create: body, url: proj + ".pages.dev", next: "apply=true to create" };
    const r = await cf("/pages/projects", { method: "POST", body: JSON.stringify(body) });
    return { created: true, project: r.name, url: "https://" + r.subdomain, production_branch: r.production_branch, next: "pages_deploy files to it, then pages_add_domain" };
  }
  if (name === "pages_add_domain") {
    const proj = pagesProject(args.project);
    if (!args.domain) return { domains: (await cf("/pages/projects/" + proj + "/domains")).map((d) => ({ name: d.name, status: d.status, verification: d.verification_data && d.verification_data.status, validation: d.validation_data && d.validation_data.status })) };
    const domain = String(args.domain).trim().toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return { error: "domain looks wrong" };
    if (!apply) return { dry_run: true, would_attach: domain, to: proj + ".pages.dev", next: "apply=true to attach" };
    const r = await cf("/pages/projects/" + proj + "/domains", { method: "POST", body: JSON.stringify({ name: domain }) });
    return { attached: r.name, status: r.status, note: "If the domain's zone is on this account Cloudflare adds the DNS record; otherwise add a CNAME " + domain + " -> " + proj + ".pages.dev. Re-run without apply to watch status go active." };
  }
  if (name === "worker_deploy") {
    const wname = String(args.name || "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(wname)) return { error: "worker name must be lowercase letters, digits, dashes" };
    const code = String(args.code || "");
    if (!/export\s+default/.test(code)) return { error: "code must be an ES module with export default { fetch }" };
    const existing = (await cf("/workers/scripts")).find((w) => w.id === wname);
    if (existing && !(existing.tags || []).includes("hub-created")) return { error: "A Worker named " + wname + " already exists and was not created by the hub. Refusing to overwrite it; pick another name." };
    const bindings = [];
    if (args.ai) bindings.push({ type: "ai", name: "AI" });
    for (const d of Array.isArray(args.d1) ? args.d1 : []) bindings.push({ type: "d1", name: String(d.binding), id: String(d.database_id) });
    for (const [k, v] of Object.entries(args.vars || {})) bindings.push({ type: "plain_text", name: k, text: String(v) });
    const metadata = { main_module: "worker.js", compatibility_date: args.compatibility_date || "2026-08-17", bindings, tags: ["hub-created"] };
    const url = "https://" + wname + "." + (accountId === "1d5fae607a857fc56cd575763bf8f3bc" ? "austinsdoors" : "pain2hustle1") + ".workers.dev";
    if (!apply) return { dry_run: true, would_deploy: wname, overwrite: !!existing, bindings: bindings.map((b) => b.type + ":" + b.name), bytes: code.length, url };
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("worker.js", new Blob([code], { type: "application/javascript+module" }), "worker.js");
    await cf("/workers/scripts/" + wname, { method: "PUT", body: form });
    await cf("/workers/scripts/" + wname + "/subdomain", { method: "POST", body: JSON.stringify({ enabled: true, previews_enabled: false }) });
    return { deployed: wname, url, bindings: bindings.map((b) => b.type + ":" + b.name), note: "workers.dev can take a few seconds to answer the first time." };
  }
  if (name === "d1_create") {
    if (!args.name) return { databases: (await cf("/d1/database?per_page=100")).map((d) => ({ name: d.name, id: d.uuid, created: d.created_at })) };
    const dname = String(args.name).trim();
    if (!/^[a-z0-9][a-z0-9-_]{1,62}$/i.test(dname)) return { error: "bad database name" };
    if (!apply) return { dry_run: true, would_create: dname, next: "apply=true to create" };
    const r = await cf("/d1/database", { method: "POST", body: JSON.stringify({ name: dname }) });
    return { created: r.name, id: r.uuid, next: "use d1_exec to make tables, then worker_deploy with d1:[{binding:'DB', database_id:'" + r.uuid + "'}]" };
  }
  if (name === "d1_query" || name === "d1_exec") {
    const sql = String(args.sql || "").trim();
    if (!sql) return { error: "sql is required" };
    const readOnly = /^\s*(select|with|pragma|explain)\b/i.test(sql) && !/;\s*\S/.test(sql.replace(/;\s*$/, ""));
    if (name === "d1_query" && !readOnly) return { error: "d1_query is read-only (one SELECT/WITH/PRAGMA/EXPLAIN statement). Use d1_exec for changes." };
    if (name === "d1_exec" && /\bdrop\s+table\b/i.test(sql) && args.force !== true) return { error: "DROP TABLE needs force=true" };
    const id = await dbId(String(args.database || ""));
    if (name === "d1_exec" && !apply) return { dry_run: true, database: id, would_run: sql.slice(0, 500), next: "apply=true to run" };
    const r = await cf("/d1/database/" + id + "/query", { method: "POST", body: JSON.stringify({ sql, params: Array.isArray(args.params) ? args.params : [] }) });
    const first = Array.isArray(r) ? r[0] : r;
    return { database: id, rows: (first && first.results || []).slice(0, 200), meta: first && first.meta ? { changes: first.meta.changes, rows_read: first.meta.rows_read, rows_written: first.meta.rows_written, duration_ms: first.meta.duration } : null };
  }
  return { error: "unknown site setup tool" };
}
__name(siteSetupTool, "siteSetupTool");
var index_default = {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(auditMintedTokens(env).catch((e) => console.log(JSON.stringify({ event: "token_audit_failed", error: String(e && e.message || e).slice(0, 200) }))));
  },
  async fetch(request, env, ctx) {
    if (ctx && env.CLOUDFLARE_OPS_OAUTH) ctx.waitUntil(env.CLOUDFLARE_OPS_OAUTH.get("audit:last", "json").then((r) => !r || Date.now() - Date.parse(r.at) > 36e5 ? auditMintedTokens(env) : null).catch(() => {
    }));
    try {
      return harden(await fetchInner(request, env));
    } catch (e) {
      const safe = redactToken(String(e && e.stack || e && e.message || e));
      return new Response(JSON.stringify({ ok: false, error: "worker_exception", detail: safe.split("\n").slice(0, 3).join(" | ") }, null, 2), { status: 500, headers: { "content-type": "application/json", ...CORS } });
    }
  }
};

// node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.js
import { WorkerEntrypoint } from "cloudflare:workers";
var OAUTH_SCOPE_TOKEN_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
function authorizationErrorRedirect(request, code, description) {
  const redirect = new URL(request.redirectUri);
  for (const key2 of ERROR_RESPONSE_PARAMETERS) redirect.searchParams.delete(key2);
  redirect.searchParams.set("error", code);
  if (description) redirect.searchParams.set("error_description", description);
  if (request.state) redirect.searchParams.set("state", request.state);
  if (request.issuer) redirect.searchParams.set("iss", request.issuer);
  return redirect.href;
}
var ERROR_RESPONSE_PARAMETERS = [
  "error",
  "error_description",
  "error_uri",
  "state",
  "iss"
];
var AuthorizationError = class extends Error {
  constructor(code, options) {
    super(options.description);
    this.name = "AuthorizationError";
    this.code = code;
    this.description = options.description;
    this.redirectUri = options.redirectUri;
    this.state = options.state;
    this.issuer = options.issuer;
    this.redirectTo = options.redirectUri ? safeErrorRedirect(code, options) : void 0;
  }
};
function safeErrorRedirect(code, options) {
  try {
    return authorizationErrorRedirect({
      redirectUri: options.redirectUri,
      state: options.state,
      issuer: options.issuer
    }, code, options.description);
  } catch {
    return;
  }
}
function withAuthorizationRedirect(error, redirectUri, state, issuer) {
  return new AuthorizationError(error.code, {
    description: error.description,
    redirectUri,
    state,
    issuer
  });
}
function buildOAuthServerCapabilities(options) {
  return {
    grantTypes: [
      "authorization_code",
      "refresh_token",
      ...options.allowTokenExchangeGrant ? ["urn:ietf:params:oauth:grant-type:token-exchange"] : [],
      ...options.enterpriseManagedAuthorization ? ["urn:ietf:params:oauth:grant-type:jwt-bearer"] : []
    ],
    responseTypes: ["code"],
    tokenEndpointAuthMethods: [
      "client_secret_basic",
      "client_secret_post",
      "none"
    ],
    codeChallengeMethods: ["S256"],
    allowPrivateUseRedirectUris: options.allowPrivateUseRedirectUris
  };
}
function validateClientCapabilities(server, client) {
  if (!server.tokenEndpointAuthMethods.includes(client.tokenEndpointAuthMethod)) throw new Error(`Unsupported token_endpoint_auth_method: ${client.tokenEndpointAuthMethod}`);
  const unsupportedGrant = client.grantTypes.find((grantType) => !server.grantTypes.includes(grantType));
  if (unsupportedGrant) throw new Error(`Unsupported grant_type: ${unsupportedGrant}`);
  const unsupportedResponse = client.responseTypes.find((responseType) => !server.responseTypes.includes(responseType));
  if (unsupportedResponse) throw new Error(`Unsupported response_type: ${unsupportedResponse}`);
  if (client.grantTypes.includes("authorization_code") !== client.responseTypes.includes("code")) throw new Error("grant_types authorization_code and response_types code must be registered together");
}
var SHARED_SECRET_TOKEN_ENDPOINT_AUTH_METHODS = /* @__PURE__ */ new Set([
  "client_secret_basic",
  "client_secret_post",
  "client_secret_jwt"
]);
function negotiateTokenEndpointAuthMethod(options) {
  const { acceptedMethods, defaultMethod, preferredMethod, supportedMethods, context } = options;
  if (preferredMethod !== void 0 && supportedMethods !== void 0 && !supportedMethods.includes(preferredMethod)) throw new Error("token_endpoint_auth_method must be included in token_endpoint_auth_methods_supported");
  const advertisedMethods = supportedMethods ?? [preferredMethod ?? defaultMethod];
  const effectiveMethod = preferredMethod !== void 0 && acceptedMethods.includes(preferredMethod) ? preferredMethod : acceptedMethods.find((method) => advertisedMethods.includes(method));
  if (effectiveMethod !== void 0) return effectiveMethod;
  const advertised = [.../* @__PURE__ */ new Set([...preferredMethod === void 0 ? [] : [preferredMethod], ...advertisedMethods])];
  throw new Error(`${context} does not support an accepted token endpoint authentication method. Supported methods: ${acceptedMethods.join(", ")}. Client advertised: ${advertised.length > 0 ? advertised.join(", ") : "(none)"}`);
}
var PRIVATE_KEY_JWT = "private_key_jwt";
function negotiateCimdTokenEndpointAuthMethods(server, preferredMethod, supportedMethods, privateKeyJwt) {
  if (preferredMethod !== void 0 && SHARED_SECRET_TOKEN_ENDPOINT_AUTH_METHODS.has(preferredMethod)) throw new Error(`CIMD clients cannot use symmetric token endpoint authentication method: ${preferredMethod}`);
  if (preferredMethod !== void 0 && supportedMethods !== void 0 && !supportedMethods.includes(preferredMethod)) throw new Error("token_endpoint_auth_method must be included in token_endpoint_auth_methods_supported");
  const acceptedMethods = [...server.tokenEndpointAuthMethods.filter((method) => !SHARED_SECRET_TOKEN_ENDPOINT_AUTH_METHODS.has(method)), ...privateKeyJwt ? [PRIVATE_KEY_JWT] : []];
  const advertisedMethods = supportedMethods ?? [preferredMethod ?? "none"];
  const methods = acceptedMethods.filter((method) => advertisedMethods.includes(method));
  if (methods.length > 0) return methods;
  const advertised = [.../* @__PURE__ */ new Set([...preferredMethod === void 0 ? [] : [preferredMethod], ...advertisedMethods])];
  throw new Error(`CIMD client does not support an accepted token endpoint authentication method. Supported methods: ${acceptedMethods.join(", ")}. Client advertised: ${advertised.length > 0 ? advertised.join(", ") : "(none)"}`);
}
function negotiateDynamicClientRegistrationCapabilities(server, client) {
  const effective = {
    grantTypes: [...client.grantTypes],
    responseTypes: [...client.responseTypes],
    tokenEndpointAuthMethod: negotiateTokenEndpointAuthMethod({
      acceptedMethods: server.tokenEndpointAuthMethods,
      defaultMethod: "client_secret_basic",
      preferredMethod: client.tokenEndpointAuthMethod,
      supportedMethods: client.tokenEndpointAuthMethodsSupported,
      context: "Client"
    })
  };
  validateClientCapabilities(server, effective);
  return effective;
}
function negotiateCimdClientCapabilities(server, client, options = { privateKeyJwt: false }) {
  const tokenEndpointAuthMethods = negotiateCimdTokenEndpointAuthMethods(server, client.tokenEndpointAuthMethod, client.tokenEndpointAuthMethodsSupported, options.privateKeyJwt);
  const effective = {
    grantTypes: client.grantTypes.filter((grantType) => server.grantTypes.includes(grantType)),
    responseTypes: client.responseTypes.filter((responseType) => server.responseTypes.includes(responseType)),
    tokenEndpointAuthMethod: tokenEndpointAuthMethods[0],
    tokenEndpointAuthMethods
  };
  validateClientCapabilities({
    ...server,
    tokenEndpointAuthMethods: [...server.tokenEndpointAuthMethods, PRIVATE_KEY_JWT]
  }, effective);
  return effective;
}
function validateAuthorizationResponseType(server, responseType, clientResponseTypes) {
  if (!responseType) throw new AuthorizationError("invalid_request", { description: "response_type is required" });
  if (!server.responseTypes.includes(responseType)) throw new AuthorizationError("unsupported_response_type", { description: `The authorization server does not support response_type ${responseType}` });
  if (!(clientResponseTypes ?? ["code"]).includes(responseType)) throw new AuthorizationError("unauthorized_client", { description: `The client is not registered for response_type ${responseType}` });
}
function normalizePkceCodeChallengeMethod(method) {
  const effectiveMethod = method ?? "plain";
  if (effectiveMethod !== "plain" && effectiveMethod !== "S256") throw new AuthorizationError("invalid_request", { description: `Unsupported PKCE code_challenge_method: ${effectiveMethod}` });
  return effectiveMethod;
}
function validatePkceCodeChallengeMethod(server, method) {
  const effectiveMethod = normalizePkceCodeChallengeMethod(method);
  if (!server.codeChallengeMethods.includes(effectiveMethod)) throw new AuthorizationError("invalid_request", { description: "The plain PKCE method is not allowed. Use S256 instead." });
  return effectiveMethod;
}
function validateAuthorizationPkce(server, request, client) {
  if (request.codeChallenge) {
    validatePkceCodeChallengeMethod(server, request.codeChallengeMethod);
    return;
  }
  if (request.codeChallengeMethod) throw new AuthorizationError("invalid_request", { description: "PKCE code_challenge is required when code_challenge_method is provided." });
  if (request.responseType === "code" && client.tokenEndpointAuthMethod === "none") throw new AuthorizationError("invalid_request", { description: "Public clients must use PKCE with the authorization code flow." });
}
function validateAuthorizationServerScopes(scopes) {
  if (!scopes) return;
  if (scopes.some((scope) => !isValidOAuthScopeToken(scope))) throw new TypeError("scopesSupported must contain valid OAuth scope tokens");
  if (new Set(scopes).size !== scopes.length) throw new TypeError("scopesSupported must not contain duplicate values");
}
function isValidOAuthScopeToken(scopeToken) {
  return OAUTH_SCOPE_TOKEN_PATTERN.test(scopeToken);
}
var version = "1.2.3";
var OUTBOUND_USER_AGENT = `workers-oauth-provider/${version} (+https://github.com/cloudflare/workers-oauth-provider)`;
function withCorsHeaders(response, request) {
  const origin = request.headers.get("Origin");
  if (!origin) return response;
  const cors = new Response(response.body, response);
  const setUnlessPresent = (name, value) => {
    if (!cors.headers.has(name)) cors.headers.set(name, value);
  };
  setUnlessPresent("Access-Control-Allow-Origin", origin);
  setUnlessPresent("Access-Control-Allow-Methods", "*");
  setUnlessPresent("Access-Control-Allow-Headers", "Authorization, *");
  setUnlessPresent("Access-Control-Max-Age", "86400");
  appendHeaderValue(cors.headers, "Vary", "Origin");
  appendHeaderValue(cors.headers, "Access-Control-Expose-Headers", "WWW-Authenticate");
  appendHeaderValue(cors.headers, "Access-Control-Expose-Headers", "Retry-After");
  return cors;
}
function appendHeaderValue(headers, name, value) {
  const values = (headers.get(name) ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!values.some((item) => item.toLowerCase() === value.toLowerCase())) values.push(value);
  headers.set(name, values.join(", "));
}
function resolveRequiredScopes(requiredScopes, deprecatedScopesSupported) {
  if (requiredScopes !== void 0 && deprecatedScopesSupported !== void 0) throw new TypeError("Set requiredScopes only: resourceMetadata.scopes_supported is deprecated in its favour");
  const scopes = requiredScopes ?? deprecatedScopesSupported;
  return scopes === void 0 ? void 0 : [...scopes];
}
function baselineResourceScopes(scopes) {
  return [...new Set(scopes)].filter((scope) => scope !== "offline_access");
}
var OAuthError = class extends Error {
  constructor(code, options) {
    super(options.description);
    this.name = "OAuthError";
    this.code = code;
    this.options = {
      ...options,
      statusCode: options.statusCode ?? 400
    };
    this.description = this.options.description;
    this.statusCode = this.options.statusCode;
    this.headers = this.options.headers;
    this.requiredScopes = this.options.requiredScopes;
  }
};
var EMA_ID_JAG_JWT_TYPE = "oauth-id-jag+jwt";
var EMA_ID_JAG_GRANT_PROFILE = "urn:ietf:params:oauth:grant-profile:id-jag";
var EMA_MAX_JWT_BYTES = 16 * 1024;
var EMA_JWKS_MAX_SIZE_BYTES = 64 * 1024;
var EMA_JWKS_FETCH_TIMEOUT_MS = 1e4;
var EMA_DEFAULT_JWKS_CACHE_TTL_SECONDS = 300;
var EMA_DEFAULT_CLOCK_SKEW_SECONDS = 60;
var EMA_DEFAULT_MAX_ASSERTION_LIFETIME_SECONDS = 300;
var EMA_JWKS_FORCE_REFRESH_COOLDOWN_SECONDS = 30;
var EMA_JTI_MIN_TTL_SECONDS = 60;
var EMA_DEFAULT_JWT_ALGORITHM = "RS256";
var EMA_SUPPORTED_JWT_ALGORITHMS = /* @__PURE__ */ new Set(["RS256", "ES256"]);
var ok = (value) => ({
  ok: true,
  value
});
var err = (error) => ({
  ok: false,
  error
});
function emaErrorToWire(e) {
  switch (e.reason) {
    case "assertion_missing":
      return {
        code: "invalid_request",
        message: "assertion is required"
      };
    case "invalid_scope_param":
      return {
        code: "invalid_request",
        message: "Invalid scope parameter format"
      };
    case "resource_invalid":
    case "resource_mismatch":
      return {
        code: "invalid_target",
        message: "Invalid resource"
      };
    case "mapper_denied":
    case "mapper_threw":
      return {
        code: "invalid_grant",
        message: "Assertion was not authorized"
      };
    case "invalid_mapped_user":
      return {
        code: "invalid_grant",
        message: "Invalid mapped user"
      };
    case "invalid_mapped_scope":
      return {
        code: "invalid_grant",
        message: "Invalid mapped scope"
      };
    case "invalid_mapped_props":
      return {
        code: "invalid_grant",
        message: "Invalid mapped props"
      };
    case "invalid_mapped_ttl":
      return {
        code: "invalid_grant",
        message: "Invalid access token TTL"
      };
    case "assertion_expired_after_processing":
      return {
        code: "invalid_grant",
        message: "Assertion has expired"
      };
    case "assertion_too_large":
    case "assertion_malformed":
    case "invalid_typ":
    case "invalid_alg":
    case "issuer_not_trusted":
    case "no_matching_key":
    case "signature_failed":
    case "jwks_fetch_failed":
    case "invalid_claim":
    case "aud_mismatch":
    case "unsupported_claim":
    case "expired":
    case "iat_in_future":
    case "nbf_in_future":
    case "lifetime_too_long":
    case "replayed":
    case "client_id_mismatch":
      return {
        code: "invalid_grant",
        message: "Invalid assertion"
      };
  }
}
async function sha256Hex$1(input) {
  const data = new TextEncoder().encode(input);
  const buffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
var EMA_JTI_KV_PREFIX = "enterprise-jti:";
function createKvJtiStore(keyPrefix = EMA_JTI_KV_PREFIX) {
  return { async markUsed({ issuer, jti, exp, now, env }) {
    const ttl = Math.max(EMA_JTI_MIN_TTL_SECONDS, exp - now);
    const key2 = `${keyPrefix}${await sha256Hex$1(`${issuer}
${jti}`)}`;
    if (await env.OAUTH_KV.get(key2)) return err({
      reason: "replayed",
      jti
    });
    await env.OAUTH_KV.put(key2, "1", { expirationTtl: ttl });
    return ok(void 0);
  } };
}
function createDefaultJwksProvider(opts = {}) {
  const cache = /* @__PURE__ */ new Map();
  const cacheTtl = opts.cacheTtlSeconds ?? EMA_DEFAULT_JWKS_CACHE_TTL_SECONDS;
  return { async fetch(issuer, { forceRefresh, now }) {
    const cached = cache.get(issuer.issuer);
    if (!forceRefresh && cached && cached.expiresAt > now) return ok(cached.jwks);
    if (forceRefresh && cached && cached.nextForceRefreshAllowedAt > now) return ok(cached.jwks);
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), EMA_JWKS_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(issuer.jwksUri, {
        headers: {
          Accept: "application/json",
          "User-Agent": OUTBOUND_USER_AGENT
        },
        signal: abortController.signal,
        cf: { cacheEverything: true }
      });
      if (!response.ok) return err({
        reason: "jwks_fetch_failed",
        status: response.status
      });
      const contentLength = response.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > EMA_JWKS_MAX_SIZE_BYTES) return err({
        reason: "jwks_fetch_failed",
        status: response.status
      });
      const rawJwks = await readJsonWithSizeLimit$1(response, EMA_JWKS_MAX_SIZE_BYTES);
      if (!rawJwks.ok) return err({ reason: "jwks_fetch_failed" });
      if (!Array.isArray(rawJwks.value.keys)) return err({ reason: "jwks_fetch_failed" });
      const jwks = { keys: rawJwks.value.keys };
      cache.delete(issuer.issuer);
      if (opts.maxEntries !== void 0 && cache.size >= opts.maxEntries) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      cache.set(issuer.issuer, {
        jwks,
        expiresAt: now + cacheTtl,
        nextForceRefreshAllowedAt: now + EMA_JWKS_FORCE_REFRESH_COOLDOWN_SECONDS
      });
      return ok(jwks);
    } catch {
      return err({ reason: "jwks_fetch_failed" });
    } finally {
      clearTimeout(timeoutId);
    }
  } };
}
async function readJsonWithSizeLimit$1(response, maxBytes) {
  if (!response.body) return { ok: false };
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        reader.cancel();
        return { ok: false };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(merged));
    if (typeof parsed !== "object" || parsed === null) return { ok: false };
    return {
      ok: true,
      value: parsed
    };
  } catch {
    return { ok: false };
  }
}
function parseIdJag(assertion, maxBytes) {
  if (typeof assertion !== "string" || assertion.length === 0) return err({ reason: "assertion_missing" });
  if (assertion.length > maxBytes) return err({
    reason: "assertion_too_large",
    size: assertion.length,
    max: maxBytes
  });
  const parts = assertion.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return err({ reason: "assertion_malformed" });
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  let header;
  let rawClaims;
  let signature;
  try {
    header = parseJwtJsonPart(encodedHeader);
    rawClaims = parseJwtJsonPart(encodedClaims);
    signature = base64UrlToBytes(encodedSignature);
  } catch {
    return err({ reason: "assertion_malformed" });
  }
  const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`);
  return ok({
    header,
    rawClaims,
    signingInput,
    signature
  });
}
function base64UrlToBytes(base64Url) {
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, "=");
  const binaryString = atob(padded);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
  return bytes;
}
function parseJwtJsonPart(encoded) {
  try {
    const json3 = new TextDecoder().decode(base64UrlToBytes(encoded));
    const parsed = JSON.parse(json3);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("JWT part must be an object");
    return parsed;
  } catch {
    throw new Error("Malformed JWT part");
  }
}
function selectJwk(jwks, alg, kid) {
  const matching = (jwks.keys ?? []).filter((key2) => {
    if (kid && key2.kid !== kid) return false;
    if (key2.alg && key2.alg !== alg) return false;
    if (key2.use && key2.use !== "sig") return false;
    if (Array.isArray(key2.key_ops) && !key2.key_ops.includes("verify")) return false;
    if (alg.startsWith("RS") && key2.kty !== "RSA") return false;
    if (alg.startsWith("ES") && key2.kty !== "EC") return false;
    return true;
  });
  if (kid) {
    const picked = matching[0];
    if (!picked) return err({
      reason: "no_matching_key",
      kid
    });
    return ok(picked);
  }
  if (matching.length !== 1) return err({ reason: "no_matching_key" });
  return ok(matching[0]);
}
async function verifyIdJagSignature(input) {
  try {
    const { importAlgorithm, verifyAlgorithm } = getJwtCryptoAlgorithms(input.alg);
    const key2 = await crypto.subtle.importKey("jwk", input.jwk, importAlgorithm, false, ["verify"]);
    return await crypto.subtle.verify(verifyAlgorithm, key2, input.signature, input.signingInput);
  } catch {
    return false;
  }
}
function getJwtCryptoAlgorithms(alg) {
  if (alg === "RS256") {
    const algorithm = {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256"
    };
    return {
      importAlgorithm: algorithm,
      verifyAlgorithm: algorithm
    };
  }
  if (alg === "ES256") return {
    importAlgorithm: {
      name: "ECDSA",
      namedCurve: "P-256"
    },
    verifyAlgorithm: {
      name: "ECDSA",
      hash: "SHA-256"
    }
  };
  throw new Error(`Unsupported JWT alg: ${alg}`);
}
var JWT_BEARER_CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
var CLIENT_ASSERTION_ALGORITHMS = ["RS256", "ES256"];
var CLIENT_ASSERTION_MAX_BYTES = 16 * 1024;
var CLIENT_ASSERTION_CLOCK_SKEW_SECONDS = 60;
var CLIENT_ASSERTION_MAX_LIFETIME_SECONDS = 3600;
var CLIENT_JWKS_CACHE_MAX_ENTRIES = 256;
var CLIENT_ASSERTION_JTI_KV_PREFIX = "client-assertion-jti:";
var CLIENT_AUTHENTICATION_JWT_TYPES = /* @__PURE__ */ new Set(["client-authentication+jwt", "application/client-authentication+jwt"]);
function isKeyUsableForAlgorithm(key2, alg) {
  if (key2.use !== void 0 && key2.use !== "sig") return false;
  if (key2.alg !== void 0 && key2.alg !== alg) return false;
  if (Array.isArray(key2.key_ops) && !key2.key_ops.includes("verify")) return false;
  return alg === "RS256" ? key2.kty === "RSA" : key2.kty === "EC" && key2.crv === "P-256";
}
function readClientAssertionIssuer(assertion) {
  if (typeof assertion !== "string") return void 0;
  const parsed = parseIdJag(assertion, CLIENT_ASSERTION_MAX_BYTES);
  if (!parsed.ok) return void 0;
  const iss = parsed.value.rawClaims.iss;
  return typeof iss === "string" && iss.length > 0 ? iss : void 0;
}
function createClientAssertionVerifier() {
  const jwksProvider = createDefaultJwksProvider({ maxEntries: CLIENT_JWKS_CACHE_MAX_ENTRIES });
  const jtiStore = createKvJtiStore(CLIENT_ASSERTION_JTI_KV_PREFIX);
  return { async verify(input) {
    if (typeof input.assertion !== "string") return err({ reason: "assertion_missing" });
    const parsed = parseIdJag(input.assertion, CLIENT_ASSERTION_MAX_BYTES);
    if (!parsed.ok) return parsed;
    const header = validateHeader(parsed.value.header, input.keys.algorithms);
    if (!header.ok) return header;
    const now = Math.floor(Date.now() / 1e3);
    const claims = validateClaims(parsed.value.rawClaims, input, header.value.typed, now);
    if (!claims.ok) return claims;
    const verified = await verifySignature({
      parsed: parsed.value,
      alg: header.value.alg,
      kid: header.value.kid,
      keys: input.keys,
      jwksProvider,
      now
    });
    if (!verified.ok) return verified;
    return jtiStore.markUsed({
      issuer: input.clientId,
      jti: claims.value.jti,
      exp: claims.value.exp + CLIENT_ASSERTION_CLOCK_SKEW_SECONDS,
      now: Math.floor(Date.now() / 1e3),
      env: input.env
    });
  } };
}
function validateHeader(header, algorithms) {
  if (header.crit !== void 0 || header.b64 !== void 0) return err({ reason: "assertion_malformed" });
  const alg = header.alg;
  if (typeof alg !== "string" || !algorithms.includes(alg)) return err({
    reason: "invalid_alg",
    got: alg
  });
  const typ = header.typ;
  let typed = false;
  if (typ !== void 0) {
    const normalized = typeof typ === "string" ? typ.toLowerCase() : "";
    typed = CLIENT_AUTHENTICATION_JWT_TYPES.has(normalized);
    if (!typed && normalized !== "jwt") return err({
      reason: "invalid_typ",
      got: typ
    });
  }
  const kid = header.kid;
  if (kid !== void 0 && (typeof kid !== "string" || kid.length === 0)) return err({ reason: "assertion_malformed" });
  return ok({
    alg,
    kid,
    typed
  });
}
function validateClaims(claims, input, typed, now) {
  if (claims.iss !== input.clientId) return err({
    reason: "client_id_mismatch",
    expected: input.clientId,
    got: String(claims.iss)
  });
  if (claims.sub !== input.clientId) return err({
    reason: "client_id_mismatch",
    expected: input.clientId,
    got: String(claims.sub)
  });
  const aud = claims.aud;
  if (!(typed ? aud === input.issuer : aud === input.issuer || aud === input.tokenEndpoint || Array.isArray(aud) && aud.every((value) => typeof value === "string") && (aud.includes(input.issuer) || aud.includes(input.tokenEndpoint)))) return err({
    reason: "aud_mismatch",
    expected: input.issuer,
    got: Array.isArray(aud) ? aud.map(String) : String(aud)
  });
  const exp = claims.exp;
  if (typeof exp !== "number" || !Number.isInteger(exp)) return err({
    reason: "invalid_claim",
    claim: "exp"
  });
  if (exp + CLIENT_ASSERTION_CLOCK_SKEW_SECONDS <= now) return err({
    reason: "expired",
    exp,
    now
  });
  if (exp - now > CLIENT_ASSERTION_MAX_LIFETIME_SECONDS) return err({
    reason: "lifetime_too_long",
    lifetime: exp - now,
    max: CLIENT_ASSERTION_MAX_LIFETIME_SECONDS
  });
  const nbf = claims.nbf;
  if (nbf !== void 0) {
    if (typeof nbf !== "number" || !Number.isInteger(nbf)) return err({
      reason: "invalid_claim",
      claim: "nbf"
    });
    if (nbf > now + CLIENT_ASSERTION_CLOCK_SKEW_SECONDS) return err({
      reason: "nbf_in_future",
      nbf,
      now,
      skew: CLIENT_ASSERTION_CLOCK_SKEW_SECONDS
    });
  }
  const iat = claims.iat;
  if (iat !== void 0) {
    if (typeof iat !== "number" || !Number.isInteger(iat)) return err({
      reason: "invalid_claim",
      claim: "iat"
    });
    if (iat > now + CLIENT_ASSERTION_CLOCK_SKEW_SECONDS) return err({
      reason: "iat_in_future",
      iat,
      now,
      skew: CLIENT_ASSERTION_CLOCK_SKEW_SECONDS
    });
  }
  const jti = claims.jti;
  if (typeof jti !== "string" || jti.length === 0) return err({
    reason: "invalid_claim",
    claim: "jti"
  });
  return ok({
    jti,
    exp
  });
}
async function verifySignature(args) {
  const { keys, alg, kid, parsed } = args;
  const verifyWith = async (jwks) => {
    const jwk = selectJwk(jwks, alg, kid);
    if (!jwk.ok) return jwk;
    return await verifyIdJagSignature({
      alg,
      jwk: jwk.value,
      signingInput: parsed.signingInput,
      signature: parsed.signature
    }) ? ok(void 0) : err({ reason: "signature_failed" });
  };
  if (keys.jwks) return verifyWith(keys.jwks);
  if (!keys.jwksUri) return err({ reason: "no_matching_key" });
  const source = {
    issuer: keys.jwksUri,
    jwksUri: keys.jwksUri
  };
  const initial = await args.jwksProvider.fetch(source, {
    forceRefresh: false,
    now: args.now
  });
  if (!initial.ok) return initial;
  const result = await verifyWith(initial.value);
  if (result.ok) return result;
  const refreshed = await args.jwksProvider.fetch(source, {
    forceRefresh: true,
    now: args.now
  });
  if (!refreshed.ok) return refreshed;
  return verifyWith(refreshed.value);
}
function isLoopbackHostname(hostname) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  const ipv4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return ipv4 !== null && ipv4.slice(1).every((octet) => Number(octet) <= 255);
}
function hasAcceptedCanonicalScheme(url) {
  return url.protocol === "https:" || url.protocol === "http:" && isLoopbackHostname(url.hostname);
}
function validateResourceUri(uri) {
  if (!uri || typeof uri !== "string") return false;
  if (!/^[\x21-\x7e]+$/.test(uri) || /["\\#]/.test(uri) || !/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]+(?:\/[^?#]*)?(?:\?[^#]*)?$/.test(uri) || /%(?![0-9A-Fa-f]{2})/.test(uri) || !/^[A-Za-z0-9:/?@!$&'()*+,;=._~%\[\]-]+$/.test(uri)) return false;
  try {
    const parsed = new URL(uri);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
function resourceMatches(requested, granted) {
  const foldedRequested = foldResourceSchemeAndHost(requested);
  const foldedGranted = foldResourceSchemeAndHost(granted);
  if (foldedRequested === void 0 || foldedGranted === void 0) return false;
  return normalizeEmptyPath(foldedRequested) === normalizeEmptyPath(foldedGranted);
}
function foldResourceSchemeAndHost(resource) {
  const schemeSeparator = resource.indexOf("://");
  if (schemeSeparator <= 0) return void 0;
  const authorityStart = schemeSeparator + 3;
  const authorityEndOffset = resource.slice(authorityStart).search(/[/?#]/);
  const authorityEnd = authorityEndOffset === -1 ? resource.length : authorityStart + authorityEndOffset;
  const authority = resource.slice(authorityStart, authorityEnd);
  const hostStart = authority.lastIndexOf("@") + 1;
  let hostEnd;
  if (authority[hostStart] === "[") {
    const closingBracket = authority.indexOf("]", hostStart + 1);
    if (closingBracket === -1) return void 0;
    hostEnd = closingBracket + 1;
  } else {
    const portSeparator = authority.indexOf(":", hostStart);
    hostEnd = portSeparator === -1 ? authority.length : portSeparator;
  }
  const asciiLower = (value) => value.replace(/[A-Z]/g, (character) => character.toLowerCase());
  return asciiLower(resource.slice(0, schemeSeparator)) + "://" + authority.slice(0, hostStart) + asciiLower(authority.slice(hostStart, hostEnd)) + authority.slice(hostEnd) + resource.slice(authorityEnd);
}
function normalizeEmptyPath(resource) {
  const authorityStart = resource.indexOf("://") + 3;
  const pathOffset = resource.slice(authorityStart).search(/[/?#]/);
  if (pathOffset === -1) return `${resource}/`;
  const pathStart = authorityStart + pathOffset;
  return resource[pathStart] === "/" ? resource : `${resource.slice(0, pathStart)}/${resource.slice(pathStart)}`;
}
function requestCarriesResourceQuery(requestUrl, resourceUrl) {
  for (const [name, value] of resourceUrl.searchParams) if (!requestUrl.searchParams.getAll(name).includes(value)) return false;
  return true;
}
function findCoveringResource(requested, configured) {
  let url;
  try {
    url = new URL(requested);
  } catch {
    return;
  }
  if (url.search === "") return void 0;
  const covering = configured.map((resource) => ({
    resource,
    url: new URL(resource)
  })).filter((candidate) => candidate.url.origin === url.origin && (candidate.url.pathname || "/") === (url.pathname || "/") && requestCarriesResourceQuery(url, candidate.url)).map(({ resource, url: url$1 }) => ({
    resource,
    specificity: [...url$1.searchParams].length
  })).sort((a, b) => b.specificity - a.specificity);
  if (covering.length === 0) return void 0;
  if (covering.length > 1 && covering[0].specificity === covering[1].specificity) return void 0;
  return covering[0].resource;
}
var CIMD_MAX_SIZE_BYTES = 5 * 1024;
var CIMD_FETCH_TIMEOUT_MS = 1e4;
var CIMD_CACHE_NAME = "workers-oauth-provider:cimd:v1";
var CIMD_CACHE_MAX_TTL_SECONDS = 10080 * 60;
function requireJsonObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Client metadata must be a JSON object");
  return value;
}
function optionalString(value, fieldName) {
  if (value === void 0) return void 0;
  if (typeof value !== "string") throw new Error(`Invalid ${fieldName}: expected string, got ${typeof value}`);
  return value;
}
function optionalStringArray(value, fieldName) {
  if (value === void 0) return void 0;
  if (!Array.isArray(value)) throw new Error(`Invalid ${fieldName}: expected array, got ${typeof value}`);
  if (!value.every((item) => typeof item === "string")) throw new Error(`Invalid ${fieldName}: array must contain only strings`);
  return [...value];
}
function optionalHttpUri(value, fieldName) {
  const uri = optionalString(value, fieldName);
  if (uri === void 0) return void 0;
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`Invalid ${fieldName}: must be an absolute http: or https: URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`Invalid ${fieldName}: must be an absolute http: or https: URL`);
  return uri;
}
var I18N_FIELDS = {
  client_name: "string",
  client_uri: "uri",
  logo_uri: "uri",
  tos_uri: "uri",
  policy_uri: "uri"
};
function extractI18nFields(raw) {
  const result = {};
  for (const key2 of Object.keys(raw)) {
    const hashIndex = key2.indexOf("#");
    if (hashIndex <= 0 || hashIndex === key2.length - 1) continue;
    const kind = I18N_FIELDS[key2.slice(0, hashIndex)];
    if (!kind) continue;
    const value = kind === "uri" ? optionalHttpUri(raw[key2], key2) : optionalString(raw[key2], key2);
    if (value !== void 0) result[key2] = value;
  }
  return Object.keys(result).length > 0 ? result : void 0;
}
function validateChoiceConsistency(preferredName, preferredValue, choicesName, choices) {
  if (preferredValue !== void 0 && choices !== void 0 && !choices.includes(preferredValue)) throw new Error(`${preferredName} must be included in ${choicesName}`);
}
function parseOAuthClientMetadata(raw) {
  const tokenEndpointAuthMethod = optionalString(raw.token_endpoint_auth_method, "token_endpoint_auth_method");
  const tokenEndpointAuthMethodsSupported = optionalStringArray(raw.token_endpoint_auth_methods_supported, "token_endpoint_auth_methods_supported");
  const tokenEndpointAuthSigningAlg = optionalString(raw.token_endpoint_auth_signing_alg, "token_endpoint_auth_signing_alg");
  const tokenEndpointAuthSigningAlgValuesSupported = optionalStringArray(raw.token_endpoint_auth_signing_alg_values_supported, "token_endpoint_auth_signing_alg_values_supported");
  validateChoiceConsistency("token_endpoint_auth_method", tokenEndpointAuthMethod, "token_endpoint_auth_methods_supported", tokenEndpointAuthMethodsSupported);
  validateChoiceConsistency("token_endpoint_auth_signing_alg", tokenEndpointAuthSigningAlg, "token_endpoint_auth_signing_alg_values_supported", tokenEndpointAuthSigningAlgValuesSupported);
  return {
    clientId: optionalString(raw.client_id, "client_id"),
    redirectUris: optionalStringArray(raw.redirect_uris, "redirect_uris"),
    clientName: optionalString(raw.client_name, "client_name"),
    clientUri: optionalHttpUri(raw.client_uri, "client_uri"),
    logoUri: optionalHttpUri(raw.logo_uri, "logo_uri"),
    policyUri: optionalHttpUri(raw.policy_uri, "policy_uri"),
    tosUri: optionalHttpUri(raw.tos_uri, "tos_uri"),
    jwksUri: optionalHttpUri(raw.jwks_uri, "jwks_uri"),
    i18n: extractI18nFields(raw),
    contacts: optionalStringArray(raw.contacts, "contacts"),
    grantTypes: optionalStringArray(raw.grant_types, "grant_types"),
    responseTypes: optionalStringArray(raw.response_types, "response_types"),
    tokenEndpointAuthMethod,
    tokenEndpointAuthMethodsSupported,
    tokenEndpointAuthSigningAlg,
    tokenEndpointAuthSigningAlgValuesSupported
  };
}
function pickDisplayMetadata(metadata) {
  const { clientName, clientUri, logoUri, policyUri, tosUri, jwksUri, i18n, contacts } = metadata;
  return {
    clientName,
    clientUri,
    logoUri,
    policyUri,
    tosUri,
    jwksUri,
    i18n,
    contacts
  };
}
function validateRedirectUriSafety(redirectUri) {
  const dangerousSchemes = [
    "javascript:",
    "data:",
    "vbscript:",
    "file:",
    "mailto:",
    "blob:"
  ];
  const normalized = redirectUri.trim();
  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i);
    if (code >= 0 && code <= 31 || code >= 127 && code <= 159) throw new Error("Invalid redirect URI");
  }
  const colonIndex = normalized.indexOf(":");
  if (colonIndex === -1) throw new Error("Invalid redirect URI");
  const scheme = normalized.slice(0, colonIndex + 1).toLowerCase();
  if (dangerousSchemes.includes(scheme)) throw new Error("Invalid redirect URI");
}
function validateListedRedirectUri(redirectUri) {
  validateRedirectUriSafety(redirectUri);
  const normalized = redirectUri.trim();
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("Invalid redirect URI");
  }
  if (normalized.includes("#") || url.username || url.password) throw new Error("Invalid redirect URI");
  return url;
}
function validateRedirectUri(redirectUri, server) {
  const url = validateListedRedirectUri(redirectUri);
  if (url.protocol === "https:") return;
  if (url.protocol === "http:") {
    if (isLoopbackHostname(url.hostname)) return;
    throw new Error("Redirect URI must use https, or http on a loopback host");
  }
  if (!server.allowPrivateUseRedirectUris) throw new Error("Redirect URI must use https, or http on a loopback host");
}
function validateRegisteredRedirectUris(redirectUris, server) {
  if (!redirectUris || redirectUris.length === 0) throw new Error("redirect_uris is required and must not be empty");
  for (const redirectUri of redirectUris) validateListedRedirectUri(redirectUri);
  let firstRefusal;
  for (const redirectUri of redirectUris) try {
    validateRedirectUri(redirectUri, server);
    return redirectUris;
  } catch (error) {
    firstRefusal ??= error;
  }
  throw firstRefusal instanceof Error ? firstRefusal : /* @__PURE__ */ new Error("Invalid redirect URI");
}
function requireValidRedirectUris(redirectUris, validate) {
  if (!redirectUris || redirectUris.length === 0) throw new Error("redirect_uris is required and must not be empty");
  for (const redirectUri of redirectUris) validate(redirectUri);
  return redirectUris;
}
function resolveDynamicClientRegistrationMetadata(raw, server) {
  const metadata = parseOAuthClientMetadata(raw);
  const capabilities = negotiateDynamicClientRegistrationCapabilities(server, {
    tokenEndpointAuthMethod: metadata.tokenEndpointAuthMethod,
    tokenEndpointAuthMethodsSupported: metadata.tokenEndpointAuthMethodsSupported,
    grantTypes: metadata.grantTypes ?? ["authorization_code"],
    responseTypes: metadata.responseTypes ?? ["code"]
  });
  return {
    ...pickDisplayMetadata(metadata),
    redirectUris: validateRegisteredRedirectUris(metadata.redirectUris, server),
    ...capabilities,
    authMethodExplicit: metadata.tokenEndpointAuthMethod !== void 0 || metadata.tokenEndpointAuthMethodsSupported !== void 0
  };
}
function rawPath(clientId) {
  const schemeEnd = clientId.indexOf("://");
  if (schemeEnd === -1) return "";
  const authorityStart = schemeEnd + 3;
  const authorityEndOffset = clientId.slice(authorityStart).search(/[/?#]/);
  if (authorityEndOffset === -1) return "";
  const pathStart = authorityStart + authorityEndOffset;
  if (clientId[pathStart] !== "/") return "";
  const pathEndOffset = clientId.slice(pathStart).search(/[?#]/);
  return pathEndOffset === -1 ? clientId.slice(pathStart) : clientId.slice(pathStart, pathStart + pathEndOffset);
}
function validateClientIdentifierUrl(clientId) {
  if (clientId !== clientId.trim() || /[\x00-\x20\x7f-\x9f\\]/.test(clientId)) throw new Error("Client Identifier URL contains invalid whitespace or characters");
  if (!/^https:\/\//i.test(clientId)) throw new Error("Client Identifier URL must use an absolute HTTPS URL");
  let parsed;
  try {
    parsed = new URL(clientId);
  } catch {
    throw new Error("Client Identifier URL must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:") throw new Error("Client Identifier URL must use HTTPS");
  if (parsed.username || parsed.password) throw new Error("Client Identifier URL must not contain userinfo");
  if (parsed.hash) throw new Error("Client Identifier URL must not contain a fragment");
  const path = rawPath(clientId);
  if (!path) throw new Error("Client Identifier URL must contain a path component");
  for (const segment of path.split("/")) {
    let decodedSegment;
    try {
      decodedSegment = decodeURIComponent(segment);
    } catch {
      throw new Error("Client Identifier URL contains invalid percent encoding");
    }
    if (decodedSegment === "." || decodedSegment === "..") throw new Error("Client Identifier URL must not contain dot path segments");
  }
}
function isClientIdMetadataDocumentUrl(clientId) {
  try {
    return new URL(clientId).protocol === "https:" && rawPath(clientId) !== "";
  } catch {
    return false;
  }
}
var PRIVATE_JWK_MEMBERS = /* @__PURE__ */ new Set([
  "d",
  "p",
  "q",
  "dp",
  "dq",
  "qi",
  "oth",
  "k"
]);
function parsePublicJwks(value) {
  if (value === void 0) return void 0;
  const jwks = requireJsonObject(value);
  if (!Array.isArray(jwks.keys)) throw new Error("Invalid jwks: keys must be an array");
  return { keys: jwks.keys.map((value$1) => {
    const key2 = requireJsonObject(value$1);
    if (Object.keys(key2).some((member) => PRIVATE_JWK_MEMBERS.has(member))) throw new Error("CIMD documents must not contain private key material");
    return key2;
  }) };
}
function resolvePrivateKeyJwtKeys(metadata, jwks) {
  const { jwksUri } = metadata;
  if (jwks && jwksUri) return { problem: "jwks and jwks_uri must not both be present" };
  if (!jwks && !jwksUri) return { problem: "private_key_jwt requires jwks or jwks_uri" };
  if (jwks && (jwks.keys ?? []).length === 0) return { problem: "private_key_jwt jwks must contain a key" };
  if (jwksUri) {
    const url = new URL(jwksUri);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return { problem: "private_key_jwt jwks_uri must be an https: URL without userinfo or a fragment" };
  }
  const signingAlgorithms = CLIENT_ASSERTION_ALGORITHMS.filter((alg) => (metadata.tokenEndpointAuthSigningAlg === void 0 || metadata.tokenEndpointAuthSigningAlg === alg) && (metadata.tokenEndpointAuthSigningAlgValuesSupported === void 0 || metadata.tokenEndpointAuthSigningAlgValuesSupported.includes(alg)));
  if (signingAlgorithms.length === 0) return { problem: `private_key_jwt requires a token_endpoint_auth_signing_alg of ${CLIENT_ASSERTION_ALGORITHMS.join(" or ")}` };
  const algorithms = jwks ? signingAlgorithms.filter((alg) => (jwks.keys ?? []).some((key2) => isKeyUsableForAlgorithm(key2, alg))) : signingAlgorithms;
  if (algorithms.length === 0) return { problem: `private_key_jwt jwks has no key for ${signingAlgorithms.join(" or ")}` };
  return { keys: jwks ? {
    jwks,
    algorithms
  } : {
    jwksUri,
    algorithms
  } };
}
function resolveClientIdMetadataDocument(metadataUrl, value, server) {
  const raw = requireJsonObject(value);
  const metadata = parseOAuthClientMetadata(raw);
  if (metadata.clientId !== metadataUrl) throw new Error(`client_id "${metadata.clientId}" does not match metadata URL "${metadataUrl}"`);
  if (!metadata.clientName?.trim()) throw new Error("client_name is required and must not be empty");
  const redirectUris = requireValidRedirectUris(metadata.redirectUris, validateRedirectUriSafety);
  if ("client_secret" in raw || "client_secret_expires_at" in raw) throw new Error("CIMD documents must not contain client secrets");
  const jwks = parsePublicJwks(raw.jwks);
  const privateKeyJwt = metadata.tokenEndpointAuthMethod === "private_key_jwt" || !!metadata.tokenEndpointAuthMethodsSupported?.includes("private_key_jwt") ? resolvePrivateKeyJwtKeys(metadata, jwks) : void 0;
  const clientAssertionKeys = privateKeyJwt && "keys" in privateKeyJwt ? privateKeyJwt.keys : void 0;
  let capabilities;
  try {
    capabilities = negotiateCimdClientCapabilities(server, {
      tokenEndpointAuthMethod: metadata.tokenEndpointAuthMethod,
      tokenEndpointAuthMethodsSupported: metadata.tokenEndpointAuthMethodsSupported,
      grantTypes: metadata.grantTypes ?? ["authorization_code"],
      responseTypes: metadata.responseTypes ?? ["code"]
    }, { privateKeyJwt: clientAssertionKeys !== void 0 });
  } catch (error) {
    if (privateKeyJwt && "problem" in privateKeyJwt) throw new Error(privateKeyJwt.problem);
    throw error;
  }
  return {
    ...pickDisplayMetadata(metadata),
    clientId: metadata.clientId,
    clientName: metadata.clientName,
    redirectUris,
    ...capabilities,
    ...capabilities.tokenEndpointAuthMethods.includes("private_key_jwt") ? { clientAssertionKeys } : {}
  };
}
function readStreamChunk(reader, signal) {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const abort = () => {
      reader.cancel().catch(() => void 0);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
async function readJsonWithSizeLimit(response, maxBytes, signal) {
  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null) {
    const declaredSize = Number(contentLength);
    if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
      await response.body?.cancel().catch(() => void 0);
      throw new Error(`Client metadata exceeds size limit: ${contentLength} bytes (max ${maxBytes})`);
    }
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Client metadata response body is empty");
  const chunks = [];
  let totalSize = 0;
  while (true) {
    const { done, value } = await readStreamChunk(reader, signal);
    if (done) break;
    if (!value) continue;
    totalSize += value.length;
    if (totalSize > maxBytes) {
      await reader.cancel().catch(() => void 0);
      throw new Error(`Response exceeded size limit of ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const bytes = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let text;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false
    }).decode(bytes);
  } catch {
    throw new Error("Client metadata response is not valid UTF-8");
  }
  try {
    return {
      value: JSON.parse(text),
      bytes
    };
  } catch {
    throw new Error("Client metadata response is not valid JSON");
  }
}
function fetchCimdOrigin(metadataUrl, signal) {
  return fetch(metadataUrl, {
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-store",
      "User-Agent": OUTBOUND_USER_AGENT
    },
    signal,
    cache: "no-store"
  });
}
async function openCimdCache() {
  if (typeof caches === "undefined") return void 0;
  try {
    return await caches.open(CIMD_CACHE_NAME);
  } catch {
    return;
  }
}
function cacheTtlSeconds(response) {
  const cacheControl = response.headers.get("Cache-Control");
  if (cacheControl === null || /(?:^|,)\s*(?:no-cache|no-store|private)\b/i.test(cacheControl)) return void 0;
  const directive = /(?:^|,)\s*s-maxage\s*=\s*"?(\d+)/i.exec(cacheControl) ?? /(?:^|,)\s*max-age\s*=\s*"?(\d+)/i.exec(cacheControl);
  if (!directive) return void 0;
  const ttl = Math.min(Number(directive[1]), CIMD_CACHE_MAX_TTL_SECONDS);
  return ttl > 0 ? ttl : void 0;
}
async function cacheValidatedDocument(cache, metadataUrl, response, bytes) {
  if (!cache) return;
  const ttl = cacheTtlSeconds(response);
  if (ttl === void 0) return;
  const headers = new Headers({ "Cache-Control": `public, max-age=${ttl}` });
  for (const name of [
    "Content-Type",
    "ETag",
    "Last-Modified"
  ]) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  try {
    await cache.put(metadataUrl, new Response(bytes, {
      status: 200,
      headers
    }));
  } catch {
  }
}
async function tryResolveFromCache(cache, metadataUrl, server, signal) {
  let cached;
  try {
    cached = await cache?.match(metadataUrl);
  } catch {
    return;
  }
  if (!cached) return void 0;
  try {
    const { value } = await readJsonWithSizeLimit(cached, CIMD_MAX_SIZE_BYTES, signal);
    return resolveClientIdMetadataDocument(metadataUrl, value, server);
  } catch (error) {
    if (signal.aborted) throw error;
    try {
      await cache?.delete(metadataUrl);
    } catch {
    }
    return;
  }
}
async function fetchClientIdMetadataDocument(metadataUrl, server) {
  validateClientIdentifierUrl(metadataUrl);
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), CIMD_FETCH_TIMEOUT_MS);
  try {
    const cache = await openCimdCache();
    const cachedDocument = await tryResolveFromCache(cache, metadataUrl, server, abortController.signal);
    if (cachedDocument) return cachedDocument;
    const response = await fetchCimdOrigin(metadataUrl, abortController.signal);
    if (!response.ok) throw new Error(`Failed to fetch client metadata: HTTP ${response.status}`);
    const { value, bytes } = await readJsonWithSizeLimit(response, CIMD_MAX_SIZE_BYTES, abortController.signal);
    const resolved = resolveClientIdMetadataDocument(metadataUrl, value, server);
    clearTimeout(timeoutId);
    await cacheValidatedDocument(cache, metadataUrl, response, bytes);
    return resolved;
  } catch (error) {
    if (abortController.signal.aborted) throw new Error(`Client metadata fetch timed out after ${CIMD_FETCH_TIMEOUT_MS}ms`);
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
function validateIdJagHeader(header, expectedTyp, supportedAlgs) {
  const typ = header.typ;
  if (typeof typ !== "string" || typ !== expectedTyp) return err({
    reason: "invalid_typ",
    got: typ
  });
  const alg = header.alg;
  if (typeof alg !== "string" || alg === "none" || !supportedAlgs.has(alg)) return err({
    reason: "invalid_alg",
    got: alg
  });
  const kidRaw = header.kid;
  return ok({
    typ,
    alg,
    kid: typeof kidRaw === "string" && kidRaw.length > 0 ? kidRaw : void 0
  });
}
async function resolveTrustedIssuer(input) {
  const { iss, alg, resolver, env, request, clientInfo } = input;
  if (typeof iss !== "string" || iss.length === 0) return err({
    reason: "invalid_claim",
    claim: "iss"
  });
  let resolved;
  try {
    resolved = await resolver({
      iss,
      env,
      request,
      clientInfo
    });
  } catch {
    return err({
      reason: "issuer_not_trusted",
      iss
    });
  }
  if (!resolved) return err({
    reason: "issuer_not_trusted",
    iss
  });
  if (resolved.issuer !== iss) return err({
    reason: "issuer_not_trusted",
    iss
  });
  if (!isWellFormedTrustedIssuer(resolved)) return err({
    reason: "issuer_not_trusted",
    iss
  });
  if (!(resolved.algorithms ?? [EMA_DEFAULT_JWT_ALGORITHM]).includes(alg)) return err({
    reason: "invalid_alg",
    got: alg
  });
  return ok(resolved);
}
function isWellFormedTrustedIssuer(issuer) {
  let issuerUrl;
  try {
    issuerUrl = new URL(issuer.issuer);
  } catch {
    return false;
  }
  if (issuerUrl.protocol !== "https:") return false;
  let jwksUrl;
  try {
    jwksUrl = new URL(issuer.jwksUri);
  } catch {
    return false;
  }
  if (jwksUrl.protocol !== "https:") return false;
  const algorithms = issuer.algorithms ?? [EMA_DEFAULT_JWT_ALGORITHM];
  if (algorithms.length === 0) return false;
  for (const alg of algorithms) if (!EMA_SUPPORTED_JWT_ALGORITHMS.has(alg)) return false;
  if (issuer.audience !== void 0) try {
    new URL(issuer.audience);
  } catch {
    return false;
  }
  return true;
}
function validateIdJagClaims(input) {
  const { rawClaims, trustedIssuer, expectedAudience, clientId, configuredResource } = input;
  const { now, clockSkewSeconds, maxAssertionLifetimeSeconds } = input;
  const iss = readRequiredString(rawClaims, "iss");
  if (!iss.ok) return iss;
  if (iss.value !== trustedIssuer.issuer) return err({
    reason: "issuer_not_trusted",
    iss: iss.value
  });
  const sub = readRequiredString(rawClaims, "sub");
  if (!sub.ok) return sub;
  const aud = readAudienceClaim(rawClaims);
  if (!aud.ok) return aud;
  for (const claim of ["authorization_details", "cnf"]) if (rawClaims[claim] !== void 0) return err({
    reason: "unsupported_claim",
    claim
  });
  const resource = rawClaims.resource === void 0 ? ok(configuredResource) : readRequiredString(rawClaims, "resource");
  if (!resource.ok) return resource;
  const claimClientId = readRequiredString(rawClaims, "client_id");
  if (!claimClientId.ok) return claimClientId;
  const jti = readRequiredString(rawClaims, "jti");
  if (!jti.ok) return jti;
  const exp = readNumericDateClaim(rawClaims, "exp");
  if (!exp.ok) return exp;
  const iat = readNumericDateClaim(rawClaims, "iat");
  if (!iat.ok) return iat;
  if ((Array.isArray(aud.value) ? aud.value[0] : aud.value) !== expectedAudience) return err({
    reason: "aud_mismatch",
    expected: expectedAudience,
    got: aud.value
  });
  if (claimClientId.value !== clientId) return err({
    reason: "client_id_mismatch",
    expected: clientId,
    got: claimClientId.value
  });
  if (!validateResourceUri(resource.value)) return err({
    reason: "resource_invalid",
    resource: resource.value
  });
  if (!resourceMatches(resource.value, configuredResource)) return err({
    reason: "resource_mismatch",
    expected: configuredResource,
    got: resource.value
  });
  if (exp.value + clockSkewSeconds <= now) return err({
    reason: "expired",
    exp: exp.value,
    now
  });
  if (iat.value > now + clockSkewSeconds) return err({
    reason: "iat_in_future",
    iat: iat.value,
    now,
    skew: clockSkewSeconds
  });
  if (rawClaims.nbf !== void 0) {
    const nbf = readNumericDateClaim(rawClaims, "nbf");
    if (!nbf.ok) return nbf;
    if (nbf.value > now + clockSkewSeconds) return err({
      reason: "nbf_in_future",
      nbf: nbf.value,
      now,
      skew: clockSkewSeconds
    });
  }
  const lifetime = exp.value - iat.value;
  if (lifetime > maxAssertionLifetimeSeconds + clockSkewSeconds) return err({
    reason: "lifetime_too_long",
    lifetime,
    max: maxAssertionLifetimeSeconds
  });
  let scope;
  let assertionScopes = [];
  if (rawClaims.scope !== void 0) {
    const parsed = readRequiredString(rawClaims, "scope");
    if (!parsed.ok) return parsed;
    const tokens = parsed.value.split(" ").filter(Boolean);
    for (const token of tokens) if (!isValidOAuthScopeToken(token)) return err({
      reason: "invalid_claim",
      claim: "scope"
    });
    scope = parsed.value;
    assertionScopes = tokens;
  }
  return ok({
    claims: {
      ...rawClaims,
      iss: iss.value,
      sub: sub.value,
      aud: aud.value,
      resource: resource.value,
      client_id: claimClientId.value,
      jti: jti.value,
      exp: exp.value,
      iat: iat.value,
      scope
    },
    resource: resource.value,
    assertionScopes
  });
}
function parseEmaScopeParam(scope, assertionScopes) {
  let requested;
  if (scope === void 0) requested = [...assertionScopes];
  else if (typeof scope === "string") {
    const tokens = scope.split(" ").filter(Boolean);
    for (const token of tokens) if (!isValidOAuthScopeToken(token)) return err({ reason: "invalid_scope_param" });
    requested = tokens;
  } else if (Array.isArray(scope) && scope.every((value) => typeof value === "string")) {
    requested = [];
    for (const part of scope) {
      const tokens = part.split(" ").filter(Boolean);
      for (const token of tokens) if (!isValidOAuthScopeToken(token)) return err({ reason: "invalid_scope_param" });
      requested.push(...tokens);
    }
  } else return err({ reason: "invalid_scope_param" });
  if (assertionScopes.length > 0) {
    const allowed = new Set(assertionScopes);
    requested = requested.filter((token) => allowed.has(token));
  }
  return ok(requested);
}
function validateEmaMapperResult(result) {
  if (result === null) return err({ reason: "mapper_denied" });
  if (typeof result !== "object") return err({ reason: "invalid_mapped_user" });
  const r = result;
  if (typeof r.userId !== "string" || r.userId.length === 0 || r.userId.includes(":")) return err({ reason: "invalid_mapped_user" });
  if (!Array.isArray(r.scope) || !r.scope.every((s) => typeof s === "string" && isValidOAuthScopeToken(s))) return err({ reason: "invalid_mapped_scope" });
  if (!("props" in r) || r.props === void 0) return err({ reason: "invalid_mapped_props" });
  if (r.accessTokenTTL !== void 0) {
    if (typeof r.accessTokenTTL !== "number" || !Number.isFinite(r.accessTokenTTL) || r.accessTokenTTL <= 0) return err({ reason: "invalid_mapped_ttl" });
  }
  return ok({
    userId: r.userId,
    scope: r.scope,
    props: r.props,
    metadata: r.metadata,
    accessTokenTTL: r.accessTokenTTL
  });
}
function computeEmaAccessTokenTTL(input) {
  const { configuredDefaultSeconds, assertionExp, mapperTtl, now, minTtlSeconds } = input;
  if (assertionExp - now <= 0) return err({ reason: "assertion_expired_after_processing" });
  const ttl = mapperTtl ?? configuredDefaultSeconds;
  if (ttl < minTtlSeconds) return err({ reason: "invalid_mapped_ttl" });
  return ok(ttl);
}
function readRequiredString(claims, claimName) {
  const value = claims[claimName];
  if (typeof value !== "string" || value.length === 0) return err({
    reason: "invalid_claim",
    claim: claimName
  });
  return ok(value);
}
function readAudienceClaim(claims) {
  const aud = claims.aud;
  if (typeof aud === "string" && aud.length > 0) return ok(aud);
  if (Array.isArray(aud) && aud.length === 1 && typeof aud[0] === "string" && aud[0].length > 0) return ok(aud);
  return err({
    reason: "invalid_claim",
    claim: "aud"
  });
}
function readNumericDateClaim(claims, claimName) {
  const value = claims[claimName];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return err({
    reason: "invalid_claim",
    claim: claimName
  });
  return ok(value);
}
var PROTECTED_RESOURCE_WELL_KNOWN_PREFIX$1 = "/.well-known/oauth-protected-resource";
var NO_CACHE_HEADERS$1 = {
  "Cache-Control": "no-store",
  Pragma: "no-cache"
};
function insufficientScope(auth, scope, description) {
  if (!Array.isArray(scope) || scope.length === 0 || scope.some((value) => typeof value !== "string" || !isValidOAuthScopeToken(value))) throw new TypeError("insufficientScope requires at least one valid OAuth scope token");
  let challenge = `Bearer realm="OAuth", error="insufficient_scope", scope="${[...new Set(scope)].join(" ")}"`;
  challenge += `, resource_metadata="${getResourceMetadataUrl(auth.audience)}"`;
  if (description !== void 0) {
    const quotable = description.replace(/["\\]/g, "").replace(/[^\x21-\x7e]+/g, " ").trim();
    if (quotable) challenge += `, error_description="${quotable}"`;
  }
  return new Response(JSON.stringify({
    error: "insufficient_scope",
    ...description !== void 0 ? { error_description: description } : {}
  }), {
    status: 403,
    headers: {
      ...NO_CACHE_HEADERS$1,
      "Content-Type": "application/json",
      "WWW-Authenticate": challenge
    }
  });
}
function getResourceMetadataUrl(resource) {
  const parsed = new URL(resource);
  const suffix = parsed.pathname === "/" ? "" : parsed.pathname;
  return `${parsed.origin}${PROTECTED_RESOURCE_WELL_KNOWN_PREFIX$1}${suffix}${parsed.search}`;
}
var TRANSACTION_TTL_SECONDS = 600;
var DEFAULT_COOKIE_PREFIX = "__Host-oauth-";
var DEFAULT_REMEMBER_SECONDS = 720 * 60 * 60;
var MIN_SECRET_LENGTH = 32;
var MAX_APPROVALS_COOKIE_BYTES = 3800;
function consentCookies(prefix = DEFAULT_COOKIE_PREFIX) {
  if (typeof prefix !== "string" || !prefix.startsWith("__Host-") || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(prefix)) throw new TypeError('cookiePrefix must start with "__Host-" and contain only cookie-name characters');
  return {
    consent: `${prefix}consent`,
    upstream: `${prefix}upstream`,
    approvals: `${prefix}approvals`
  };
}
function validateRememberConsentOptions(options) {
  if (typeof options !== "object" || options === null) throw new TypeError("remember must be an object with a secret");
  if (typeof options.secret !== "string" || options.secret.length < MIN_SECRET_LENGTH) throw new TypeError(`remember.secret must be a string of at least ${MIN_SECRET_LENGTH} characters`);
  const maxAge = options.maxAgeSeconds;
  if (maxAge !== void 0 && (!Number.isInteger(maxAge) || maxAge <= 0)) throw new TypeError("remember.maxAgeSeconds must be a positive integer");
  if (options.subject !== void 0 && (typeof options.subject !== "string" || options.subject.length === 0)) throw new TypeError("remember.subject must be a non-empty string");
}
function describeConsent(client, request, isClientIdMetadataDocument) {
  const redirectHost = new URL(request.redirectUri).hostname || request.redirectUri;
  return {
    clientId: request.clientId,
    clientName: client?.clientName?.trim() ? client.clientName : request.clientId,
    ...isClientIdMetadataDocument ? { clientDomain: new URL(request.clientId).hostname } : {},
    ...client?.clientUri ? { clientUri: client.clientUri } : {},
    ...client?.logoUri ? { logoUri: client.logoUri } : {},
    redirectUri: request.redirectUri,
    redirectHost,
    redirectIsLoopback: isLoopbackHostname(redirectHost),
    scope: [...request.scope]
  };
}
async function beginConsent(kv, cookies, request) {
  const { handle, hash } = await createTransaction(kv, {
    kind: "consent",
    request
  });
  return {
    handle,
    headers: new Headers({
      "Set-Cookie": bindingCookie(transactionCookieName(cookies.consent, hash), hash, TRANSACTION_TTL_SECONDS),
      "Cache-Control": "no-store",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Frame-Options": "DENY"
    })
  };
}
async function approveConsent(kv, cookies, supportedScopes, request, handle, options = {}) {
  if (options.remember !== void 0) validateRememberConsentOptions(options.remember);
  const transaction = await openTransaction(kv, request, cookies.consent, handle, "consent");
  let approved = transaction.record.request;
  if (options.scope !== void 0) {
    const supported = supportedScopes ? new Set(supportedScopes) : void 0;
    const valid = (scope) => typeof scope === "string" && isValidOAuthScopeToken(scope) && (!supported || supported.has(scope));
    if (!Array.isArray(options.scope) || !options.scope.every(valid)) throw new AuthorizationError("invalid_scope", { description: "Approved scopes must be ones this server supports" });
    approved = {
      ...approved,
      scope: [...new Set(options.scope)]
    };
  }
  await transaction.consume();
  const headers = new Headers({ "Cache-Control": "no-store" });
  headers.append("Set-Cookie", clearCookie(transaction.cookieName));
  if (options.remember) headers.append("Set-Cookie", await rememberApproval(cookies, request, approved, options.remember));
  return {
    request: approved,
    headers
  };
}
async function denyConsent(kv, cookies, request, handle, options = {}) {
  const transaction = await openTransaction(kv, request, cookies.consent, handle, "consent");
  await transaction.consume();
  const record = transaction.record;
  const redirectTo = authorizationErrorRedirect(record.request, "access_denied", options.description);
  const headers = new Headers({
    "Cache-Control": "no-store",
    Location: redirectTo
  });
  headers.append("Set-Cookie", clearCookie(transaction.cookieName));
  return {
    request: record.request,
    redirectTo,
    headers
  };
}
async function isConsentRemembered(cookies, request, authRequest, remember) {
  validateRememberConsentOptions(remember);
  const approvals = await readApprovals(cookies, request, remember.secret);
  const key2 = await approvalKey(authRequest, remember.subject);
  const now = Math.floor(Date.now() / 1e3);
  const approval = approvals.find((entry) => entry.k === key2 && entry.e > now);
  if (!approval) return false;
  const approvedScopes = new Set(approval.s);
  return authRequest.scope.every((scope) => approvedScopes.has(scope));
}
async function beginUpstream(kv, cookies, request, options = {}) {
  const { handle, hash } = await createTransaction(kv, {
    kind: "upstream",
    request,
    data: options.data
  });
  const headers = options.headers ?? new Headers();
  headers.append("Set-Cookie", bindingCookie(transactionCookieName(cookies.upstream, hash), hash, TRANSACTION_TTL_SECONDS));
  headers.set("Cache-Control", "no-store");
  return {
    state: handle,
    headers
  };
}
async function finishUpstream(kv, cookies, request) {
  const state = new URL(request.url).searchParams.get("state");
  if (!state) throw new AuthorizationError("invalid_request", { description: "Missing state parameter" });
  const transaction = await openTransaction(kv, request, cookies.upstream, state, "upstream");
  await transaction.consume();
  const headers = new Headers({ "Cache-Control": "no-store" });
  headers.append("Set-Cookie", clearCookie(transaction.cookieName));
  return {
    request: transaction.record.request,
    data: transaction.record.data,
    headers
  };
}
async function createTransaction(kv, record) {
  const handle = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await sha256Hex2(handle);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv
  }, await transactionKey(handle), new TextEncoder().encode(JSON.stringify(record)));
  await kv.put(`transaction:${hash}`, `${base64url(iv)}.${base64url(new Uint8Array(sealed))}`, { expirationTtl: TRANSACTION_TTL_SECONDS });
  return {
    handle,
    hash
  };
}
async function openTransaction(kv, request, cookieBase, handle, kind) {
  if (typeof handle !== "string" || handle.length === 0) throw new AuthorizationError("invalid_request", { description: "Missing transaction handle" });
  const hash = await sha256Hex2(handle);
  const cookieName = transactionCookieName(cookieBase, hash);
  const bound = readCookie(request, cookieName);
  if (!bound) throw new AuthorizationError("invalid_request", { description: "This authorization was not started in this browser; start again" });
  if (!timingSafeEqual2(hash, bound)) throw new AuthorizationError("invalid_request", { description: "This authorization belongs to a different browser session; start again" });
  const key2 = `transaction:${hash}`;
  const expired = new AuthorizationError("invalid_request", { description: "This authorization expired or was already used; start again" });
  const stored = await kv.get(key2);
  if (!stored) throw expired;
  let record;
  try {
    const [iv, sealed] = stored.split(".");
    const plain = await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv: fromBase64url(iv)
    }, await transactionKey(handle), fromBase64url(sealed));
    record = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw expired;
  }
  if (record.kind !== kind) throw expired;
  return {
    record,
    cookieName,
    consume: () => kv.delete(key2)
  };
}
async function transactionKey(handle) {
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`oauth-transaction-key:${handle}`));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}
function transactionCookieName(base, hash) {
  return `${base}-${hash.slice(0, 16)}`;
}
async function rememberApproval(cookies, request, approved, remember) {
  const maxAge = remember.maxAgeSeconds ?? DEFAULT_REMEMBER_SECONDS;
  const now = Math.floor(Date.now() / 1e3);
  const key2 = await approvalKey(approved, remember.subject);
  const approvals = (await readApprovals(cookies, request, remember.secret)).filter((entry) => entry.e > now && entry.k !== key2);
  approvals.push({
    k: key2,
    s: approved.scope,
    e: now + maxAge
  });
  let value = await signApprovals(approvals, remember.secret);
  while (value.length > MAX_APPROVALS_COOKIE_BYTES && approvals.length > 1) {
    approvals.shift();
    value = await signApprovals(approvals, remember.secret);
  }
  const cookieMaxAge = Math.max(...approvals.map((entry) => entry.e)) - now;
  return `${cookies.approvals}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${cookieMaxAge}`;
}
async function readApprovals(cookies, request, secret) {
  const value = readCookie(request, cookies.approvals);
  if (!value) return [];
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return [];
  const key2 = await hmacKey(secret);
  let valid = false;
  try {
    valid = await crypto.subtle.verify("HMAC", key2, fromBase64url(signature), new TextEncoder().encode(payload));
  } catch {
    return [];
  }
  if (!valid) return [];
  try {
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
    return Array.isArray(parsed) ? parsed.filter(isApproval) : [];
  } catch {
    return [];
  }
}
async function signApprovals(approvals, secret) {
  const payload = base64url(new TextEncoder().encode(JSON.stringify(approvals)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(payload));
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}
function isApproval(value) {
  if (!value || typeof value !== "object") return false;
  const entry = value;
  return typeof entry.k === "string" && typeof entry.e === "number" && Array.isArray(entry.s) && entry.s.every((scope) => typeof scope === "string");
}
async function approvalKey(request, subject) {
  const material = JSON.stringify([
    request.clientId,
    request.redirectUri,
    request.resource ?? null,
    subject ?? null
  ]);
  const digest2 = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return base64url(new Uint8Array(digest2));
}
function hmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {
    name: "HMAC",
    hash: "SHA-256"
  }, false, ["sign", "verify"]);
}
function bindingCookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}
function clearCookie(name) {
  return `${name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}
function readCookie(request, name) {
  const header = request.headers.get("Cookie");
  if (!header) return void 0;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
}
async function sha256Hex2(value) {
  const digest2 = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest2)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function timingSafeEqual2(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}
function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
var PROTECTED_RESOURCE_WELL_KNOWN_PREFIX = "/.well-known/oauth-protected-resource";
var NO_CACHE_HEADERS = {
  "Cache-Control": "no-store",
  Pragma: "no-cache"
};
var BASIC_AUTH_CHALLENGE = 'Basic realm="OAuth"';
if (!(typeof Cloudflare !== "undefined" && Cloudflare.compatibilityFlags?.global_fetch_strictly_public === true)) console.warn(`CIMD (Client ID Metadata Document) is disabled: add '"compatibility_flags": ["global_fetch_strictly_public"]' to your wrangler.jsonc to enable. See: https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public`);
var HandlerType = /* @__PURE__ */ (function(HandlerType$1) {
  HandlerType$1[HandlerType$1["EXPORTED_HANDLER"] = 0] = "EXPORTED_HANDLER";
  HandlerType$1[HandlerType$1["WORKER_ENTRYPOINT"] = 1] = "WORKER_ENTRYPOINT";
  return HandlerType$1;
})(HandlerType || {});
var GrantType = /* @__PURE__ */ (function(GrantType$1) {
  GrantType$1["AUTHORIZATION_CODE"] = "authorization_code";
  GrantType$1["REFRESH_TOKEN"] = "refresh_token";
  GrantType$1["TOKEN_EXCHANGE"] = "urn:ietf:params:oauth:grant-type:token-exchange";
  GrantType$1["JWT_BEARER"] = "urn:ietf:params:oauth:grant-type:jwt-bearer";
  return GrantType$1;
})({});
var DEFAULT_AUTHORIZE_PATH = "/authorize";
var DEFAULT_TOKEN_PATH = "/oauth/token";
function toPublicClientInfo(client) {
  const { authMethodExplicit: _explicit, registrationExpiresAt: _expiry, tokenEndpointAuthMethods: _methods, clientAssertionKeys: _keys, ...publicClient } = client;
  return publicClient;
}
var CLIENT_AUTHENTICATION_PARAMETERS = /* @__PURE__ */ new Set([
  "client_id",
  "client_secret",
  "client_assertion",
  "client_assertion_type"
]);
function isClientAuthMethodAllowed(client, presentedMethod, isClientMetadataDocument) {
  if (presentedMethod === client.tokenEndpointAuthMethod) return true;
  if (isClientMetadataDocument && client.tokenEndpointAuthMethods?.includes(presentedMethod)) return true;
  const isSecretMethod = (method) => method === "client_secret_basic" || method === "client_secret_post";
  return !isClientMetadataDocument && client.authMethodExplicit === void 0 && isSecretMethod(client.tokenEndpointAuthMethod) && isSecretMethod(presentedMethod);
}
var OAuthProvider = class {
  #impl;
  /**
  * Creates a new OAuth provider instance
  * @param options - Configuration options for the provider
  */
  constructor(options) {
    this.#impl = new OAuthProviderImpl(options);
  }
  /**
  * Main fetch handler for the Worker
  * Routes requests to the appropriate handler based on the URL
  * @param request - The HTTP request
  * @param env - Cloudflare Worker environment variables
  * @param ctx - Cloudflare Worker execution context
  * @returns A Promise resolving to an HTTP Response
  */
  fetch(request, env, ctx) {
    return this.#impl.fetch(request, env, ctx);
  }
  /**
  * Purges expired and orphaned data from the KV namespace.
  * Can be called directly from a scheduled handler without needing a request context.
  *
  * @param env - Cloudflare Worker environment variables (must include OAUTH_KV binding)
  * @param options - Optional configuration for batch size and which purge types to enable
  * @returns Statistics about what was checked and purged
  */
  purgeExpiredData(env, options) {
    return this.#impl.createOAuthHelpers(env).purgeExpiredData(options);
  }
};
var OAuthProviderImpl = class {
  /**
  * Creates a new OAuth provider instance
  * @param options - Configuration options for the provider
  */
  constructor(options) {
    this.errorResponses = /* @__PURE__ */ new WeakSet();
    this.typedApiHandlers = [];
    this.typedDefaultHandler = "authorizationServer" in options ? void 0 : this.validateHandler(options.defaultHandler, "defaultHandler");
    const roleBased = "authorizationServer" in options;
    if (!roleBased && "resourceMatchOriginOnly" in options) throw new TypeError("resourceMatchOriginOnly was removed in 1.0. Configure resourceMetadata.resource; audiences are compared exactly against that canonical resource. See the migration guide.");
    let normalizedOptions;
    let configuredResourceServers;
    if (roleBased) {
      const { authorizationServer: authorizationServer$1, ...commonOptions } = options;
      this.validateAuthorizationServerIssuer(authorizationServer$1.issuer);
      this.explicitIssuer = authorizationServer$1.issuer;
      const issuerBase = authorizationServer$1.issuer.replace(/\/+$/, "");
      normalizedOptions = {
        ...commonOptions,
        authorizeEndpoint: authorizationServer$1.authorizeEndpoint ?? `${issuerBase}${DEFAULT_AUTHORIZE_PATH}`,
        tokenEndpoint: authorizationServer$1.tokenEndpoint ?? `${issuerBase}${DEFAULT_TOKEN_PATH}`,
        clientRegistrationEndpoint: authorizationServer$1.clientRegistrationEndpoint
      };
      const declared = authorizationServer$1.resources;
      if (!Array.isArray(declared) || declared.length === 0 || declared.some((value) => typeof value !== "string")) throw new TypeError("resources must list at least one canonical protected resource identifier");
      const duplicate = declared.find((resource, index) => declared.slice(0, index).some((earlier) => isExactResource(earlier, resource)));
      if (duplicate !== void 0) throw new TypeError(`resources must be unique; duplicate ${duplicate}`);
      configuredResourceServers = declared.map((resource) => ({ resourceMetadata: { resource } }));
    } else {
      this.explicitIssuer = void 0;
      normalizedOptions = options;
      configuredResourceServers = [{
        resourceMetadata: withRequiredScopes(options.resourceMetadata, options.requiredScopes),
        resolveExternalToken: options.resolveExternalToken
      }];
    }
    this.options = {
      accessTokenTTL: DEFAULT_ACCESS_TOKEN_TTL,
      refreshTokenTTL: DEFAULT_REFRESH_TOKEN_TTL,
      clientRegistrationTTL: DEFAULT_CLIENT_REGISTRATION_TTL,
      onError: ({ status, code, description }) => console.warn(`OAuth error response: ${status} ${code} - ${description}`),
      ...normalizedOptions
    };
    this.validateEndpoint(this.options.authorizeEndpoint, "authorizeEndpoint");
    this.validateEndpoint(this.options.tokenEndpoint, "tokenEndpoint");
    this.consentCookies = consentCookies(this.options.cookiePrefix);
    if (this.options.clientRegistrationEndpoint) this.validateEndpoint(this.options.clientRegistrationEndpoint, "clientRegistrationEndpoint");
    if (roleBased) this.validateAuthorizationServerRouteIsolation();
    this.resourceServers = configuredResourceServers.map(({ resourceMetadata, resolveExternalToken }) => {
      const metadata = this.snapshotResourceMetadata(resourceMetadata);
      this.validateResourceMetadataOptions(metadata);
      return {
        resourceMetadata: metadata,
        resolveExternalToken
      };
    });
    for (const [index, server] of this.resourceServers.entries()) if (this.resourceServers.slice(0, index).some((other) => isExactResource(other.resourceMetadata.resource, server.resourceMetadata.resource))) throw new TypeError(`resources must be unique; duplicate ${server.resourceMetadata.resource}`);
    if (!roleBased) {
      const legacyOptions = options;
      const hasSingleHandlerConfig = !!(legacyOptions.apiRoute && legacyOptions.apiHandler);
      const hasMultiHandlerConfig = !!legacyOptions.apiHandlers;
      if (hasSingleHandlerConfig && hasMultiHandlerConfig) throw new TypeError("Cannot use both apiRoute/apiHandler and apiHandlers. Use either apiRoute + apiHandler OR apiHandlers, not both.");
      if (!hasSingleHandlerConfig && !hasMultiHandlerConfig) throw new TypeError("Must provide either apiRoute + apiHandler OR apiHandlers. No API route configuration provided.");
      const resourceServer = this.resourceServers[0];
      if (hasSingleHandlerConfig) {
        const handler = this.validateHandler(legacyOptions.apiHandler, "apiHandler");
        (Array.isArray(legacyOptions.apiRoute) ? legacyOptions.apiRoute : [legacyOptions.apiRoute]).forEach((route, index) => {
          this.validateEndpoint(route, Array.isArray(legacyOptions.apiRoute) ? `apiRoute[${index}]` : "apiRoute");
          this.typedApiHandlers.push({
            route,
            handler,
            resourceServer
          });
        });
      } else for (const [route, rawHandler] of Object.entries(legacyOptions.apiHandlers)) {
        this.validateEndpoint(route, `apiHandlers key: ${route}`);
        const handler = this.validateHandler(rawHandler, `apiHandlers[${route}]`);
        this.typedApiHandlers.push({
          route,
          handler,
          resourceServer
        });
      }
      for (const { route } of this.typedApiHandlers) this.assertRouteCoveredByResource(route, resourceServer.resourceMetadata.resource);
    }
    const resources = this.resourceServers.map((server) => server.resourceMetadata.resource);
    const soleResource = resources.length === 1 ? resources[0] : void 0;
    const authorizationServer = roleBased ? options.authorizationServer : void 0;
    this.configuredDefaultAuthorizationResource = authorizationServer?.defaultResource ?? soleResource;
    this.configuredLegacyGrantResource = authorizationServer?.legacyGrantResource ?? soleResource;
    if (roleBased) {
      this.getDefaultAuthorizationResource();
      this.getLegacyGrantResource();
    }
    if (!isValidAccessTokenTTL(this.options.accessTokenTTL)) throw new TypeError(`accessTokenTTL must be an integer of at least ${KV_MIN_EXPIRATION_TTL_SECONDS} seconds (Cloudflare KV's minimum expiration window).`);
    if (this.options.refreshTokenIdleTTL !== void 0 && !isValidAccessTokenTTL(this.options.refreshTokenIdleTTL)) throw new TypeError(`refreshTokenIdleTTL must be an integer of at least ${KV_MIN_EXPIRATION_TTL_SECONDS} seconds (Cloudflare KV's minimum expiration window).`);
    if (this.options.allowPlainPKCE) throw new TypeError("allowPlainPKCE has been removed: MCP and OAuth 2.1 clients use S256 PKCE.");
    if (this.options.allowImplicitFlow) throw new TypeError("allowImplicitFlow has been removed: OAuth 2.1 and MCP use the authorization code flow with PKCE.");
    if (this.options.refreshTokenTTL !== void 0 && !isValidRefreshTokenTTL(this.options.refreshTokenTTL)) throw new TypeError(`refreshTokenTTL must be 0 (no refresh tokens), undefined (no expiry), or an integer of at least ${KV_MIN_EXPIRATION_TTL_SECONDS} seconds (Cloudflare KV's minimum expiration window).`);
    if (this.options.clientRegistrationTTL !== void 0 && !isValidAccessTokenTTL(this.options.clientRegistrationTTL)) throw new TypeError(`clientRegistrationTTL must be undefined (no expiry) or an integer of at least ${KV_MIN_EXPIRATION_TTL_SECONDS} seconds (Cloudflare KV's minimum expiration window).`);
    this.serverCapabilities = buildOAuthServerCapabilities({
      allowTokenExchangeGrant: !!this.options.allowTokenExchangeGrant,
      enterpriseManagedAuthorization: !!this.options.enterpriseManagedAuthorization,
      allowPrivateUseRedirectUris: this.options.allowPrivateUseRedirectUris === true
    });
    validateAuthorizationServerScopes(this.options.scopesSupported);
    this.validateEmaOptions(this.options.enterpriseManagedAuthorization);
    if (this.options.enterpriseManagedAuthorization) {
      this.jwksProvider = createDefaultJwksProvider({ cacheTtlSeconds: this.options.enterpriseManagedAuthorization.jwksCacheTtlSeconds });
      this.jtiStore = createKvJtiStore();
    }
    if (this.options.clientIdMetadataDocumentEnabled) this.clientAssertionVerifier = createClientAssertionVerifier();
  }
  /**
  * Validates that an endpoint is either an absolute path or a full URL
  * @param endpoint - The endpoint to validate
  * @param name - The name of the endpoint property for error messages
  * @throws TypeError if the endpoint is invalid
  */
  validateEndpoint(endpoint, name) {
    if (this.isPath(endpoint)) {
      if (!endpoint.startsWith("/")) throw new TypeError(`${name} path must be an absolute path starting with /`);
      if (this.explicitIssuer && new URL(endpoint, new URL(this.explicitIssuer).origin).hash) throw new TypeError(`${name} must not contain a fragment`);
    } else {
      let parsed;
      try {
        parsed = new URL(endpoint);
      } catch (e) {
        throw new TypeError(`${name} must be either an absolute path starting with / or a valid URL`);
      }
      if (this.explicitIssuer && (!hasAcceptedCanonicalScheme(parsed) || parsed.username || parsed.password || parsed.hash)) throw new TypeError(`${name} must be an absolute HTTPS URL without userinfo or a fragment (http is accepted only on a loopback host)`);
    }
  }
  /** Validate the explicit issuer used to host-gate the role-based AS. */
  validateAuthorizationServerIssuer(issuer) {
    let parsed;
    try {
      parsed = new URL(issuer);
    } catch {
      throw new TypeError("authorizationServer.issuer must be a canonical absolute HTTPS URL");
    }
    if (!validateResourceUri(issuer) || !hasAcceptedCanonicalScheme(parsed) || parsed.username || parsed.password || parsed.search || parsed.hash || foldResourceSchemeAndHost(issuer) !== issuer || parsed.href !== issuer && parsed.origin !== issuer) throw new TypeError("authorizationServer.issuer must be a canonical absolute HTTPS URL (http is accepted only on a loopback host)");
  }
  /**
  * Reject an endpoint another would claim, so it could never be reached. fetch() tries metadata,
  * then token, then registration; the application routes the authorization endpoint. Each check
  * asks the predicate fetch() dispatches on, so it agrees with routing (metadata ignores the
  * query, for one).
  */
  validateAuthorizationServerRouteIsolation() {
    const issuerUrl = new URL(this.explicitIssuer);
    const tokenUrl = new URL(this.getFullEndpointUrl(this.options.tokenEndpoint, issuerUrl));
    if (this.isAuthorizationServerMetadataRequest(tokenUrl)) throw new TypeError("tokenEndpoint must not collide with the authorization server metadata endpoint");
    const authorizeUrl = new URL(this.getFullEndpointUrl(this.options.authorizeEndpoint, issuerUrl));
    if (this.isAuthorizationServerMetadataRequest(authorizeUrl)) throw new TypeError("authorizeEndpoint must not collide with the authorization server metadata endpoint");
    if (this.isTokenEndpoint(authorizeUrl)) throw new TypeError("authorizeEndpoint must not collide with tokenEndpoint");
    if (!this.options.clientRegistrationEndpoint) return;
    if (this.isClientRegistrationEndpoint(authorizeUrl)) throw new TypeError("authorizeEndpoint must not collide with clientRegistrationEndpoint");
    const registrationUrl = new URL(this.getFullEndpointUrl(this.options.clientRegistrationEndpoint, issuerUrl));
    if (this.isTokenEndpoint(registrationUrl)) throw new TypeError("clientRegistrationEndpoint must not collide with tokenEndpoint");
    if (this.isAuthorizationServerMetadataRequest(registrationUrl)) throw new TypeError("clientRegistrationEndpoint must not collide with the authorization server metadata endpoint");
  }
  /**
  * A protected route must be the canonical resource path or a path-boundary descendant of
  * it. Anything else can never validate a token, because every token is bound to the
  * canonical resource, so it would be a permanently 401 zone.
  */
  assertRouteCoveredByResource(route, resource) {
    const resourceUrl = new URL(resource);
    let routePath;
    if (this.isPath(route)) routePath = route.split("?")[0];
    else {
      const routeUrl = new URL(route);
      if (routeUrl.origin !== resourceUrl.origin) throw new TypeError(`API route ${route} is not covered by resourceMetadata.resource ${resource}. An absolute protected route must be on the resource's origin.`);
      for (const [name, value] of resourceUrl.searchParams) {
        const routeValues = routeUrl.searchParams.getAll(name);
        if (routeValues.length > 0 && !routeValues.includes(value)) throw new TypeError(`API route ${route} is not covered by resourceMetadata.resource ${resource}. An absolute protected route must carry the resource's query parameters.`);
      }
      routePath = routeUrl.pathname;
    }
    if (isPathDescendant(routePath, resourceUrl.pathname)) return;
    throw new TypeError(`API route ${route} is not covered by resourceMetadata.resource ${resource}. Protected routes must be the canonical resource path or a descendant of it; use ${resourceUrl.origin} as the resource to cover every path on that origin.`);
  }
  /** Resolve a configured policy value to the registry's canonical spelling. */
  resolveConfiguredResourceDefault(resource, name) {
    if (resource === void 0) return void 0;
    const configured = this.findConfiguredResource(resource);
    if (!configured) throw new TypeError(`${name} must name one of the configured protected resources`);
    return configured;
  }
  getDefaultAuthorizationResource() {
    const sole = this.resourceServers.length === 1 ? this.resourceServers[0].resourceMetadata.resource : void 0;
    return this.resolveConfiguredResourceDefault(this.configuredDefaultAuthorizationResource ?? sole, "defaultResource");
  }
  getLegacyGrantResource() {
    const sole = this.resourceServers.length === 1 ? this.resourceServers[0].resourceMetadata.resource : void 0;
    return this.resolveConfiguredResourceDefault(this.configuredLegacyGrantResource ?? sole, "legacyGrantResource");
  }
  /**
  * The audience a stored access token is treated as bound to.
  *
  * A token issued before resource binding has no stored audience. It keeps
  * working at the server-selected migration resource (the sole resource, or
  * `legacyGrantResource` in a multi-resource deployment) until it expires;
  * refresh binds its grant and returns a bound replacement. The client never
  * chooses this destination. Without a migration resource the token is
  * treated as unbound and rejected.
  *
  * The destination is deployment policy, not an issuance-time claim: changing
  * `legacyGrantResource` re-targets every surviving unbound token and grant.
  * Keep it fixed for the length of the migration window.
  */
  resolveStoredTokenAudience(audience) {
    return audience === void 0 ? this.getLegacyGrantResource() : audience;
  }
  /**
  * Validates that a handler is either an ExportedHandler or a class extending WorkerEntrypoint
  * @param handler - The handler to validate
  * @param name - The name of the handler property for error messages
  * @returns The type of the handler (EXPORTED_HANDLER or WORKER_ENTRYPOINT)
  * @throws TypeError if the handler is invalid
  */
  validateHandler(handler, name) {
    if (typeof handler === "object" && handler !== null && typeof handler.fetch === "function") return {
      type: HandlerType.EXPORTED_HANDLER,
      handler
    };
    if (typeof handler === "function" && handler.prototype instanceof WorkerEntrypoint) return {
      type: HandlerType.WORKER_ENTRYPOINT,
      handler
    };
    throw new TypeError(`${name} must be either an ExportedHandler object with a fetch method or a class extending WorkerEntrypoint`);
  }
  /** Snapshot caller-owned metadata so later mutation cannot change routing or policy. */
  snapshotResourceMetadata(metadata) {
    return {
      ...metadata,
      ...metadata?.authorization_servers ? { authorization_servers: [...metadata.authorization_servers] } : {},
      ...metadata?.scopes_supported ? { scopes_supported: [...metadata.scopes_supported] } : {},
      ...metadata?.bearer_methods_supported ? { bearer_methods_supported: [...metadata.bearer_methods_supported] } : {}
    };
  }
  /** Validate configured RFC 9728 protected resource metadata. */
  validateResourceMetadataOptions(options) {
    if (!options || !validateResourceUri(options.resource) || !hasAcceptedCanonicalScheme(new URL(options.resource))) throw new TypeError("resourceMetadata.resource is required and must be an absolute HTTPS URI without a fragment (http is accepted only on a loopback host)");
    if (foldResourceSchemeAndHost(options.resource) !== options.resource) throw new TypeError("resourceMetadata.resource must use a lowercase scheme and lowercase host");
    const parsedResource = new URL(options.resource);
    if (parsedResource.username || parsedResource.password || parsedResource.href !== options.resource && parsedResource.origin !== options.resource) throw new TypeError("resourceMetadata.resource must use canonical URL serialization without userinfo, a default port, or dot segments");
    if (parsedResource.pathname === PROTECTED_RESOURCE_WELL_KNOWN_PREFIX || parsedResource.pathname.startsWith(`${PROTECTED_RESOURCE_WELL_KNOWN_PREFIX}/`)) throw new TypeError(`resourceMetadata.resource must not be inside the ${PROTECTED_RESOURCE_WELL_KNOWN_PREFIX} namespace`);
    if (options.authorization_servers !== void 0) {
      if (options.authorization_servers.length === 0) throw new TypeError("resourceMetadata.authorization_servers must contain at least one issuer");
      for (const issuer of options.authorization_servers) {
        let parsed;
        try {
          parsed = new URL(issuer);
        } catch {
          throw new TypeError("resourceMetadata.authorization_servers must contain valid HTTPS issuer URLs");
        }
        if (!validateResourceUri(issuer) || !hasAcceptedCanonicalScheme(parsed) || parsed.username || parsed.password || foldResourceSchemeAndHost(issuer) !== issuer || parsed.href !== issuer && parsed.origin !== issuer || issuer.includes("?") || issuer.includes("#")) throw new TypeError("resourceMetadata.authorization_servers must contain valid HTTPS issuer URLs (http is accepted only on a loopback host)");
      }
    }
    if (options.scopes_supported?.some((scope) => !isValidOAuthScopeToken(scope))) throw new TypeError("requiredScopes (or the deprecated resourceMetadata.scopes_supported) must contain valid OAuth scope tokens");
    if (options.bearer_methods_supported?.some((method) => method !== "header")) throw new TypeError("resourceMetadata.bearer_methods_supported only supports 'header'");
  }
  /**
  * Validates MCP Enterprise-Managed Authorization configuration at construction time.
  *
  * Presence of `enterpriseManagedAuthorization` on options enables the feature —
  * there is no separate `enabled` flag (which would silently disable EMA when
  * forgotten). Configuration is checked structurally; runtime concerns
  * (JWKS reachability etc.) are checked when assertions arrive.
  */
  validateEmaOptions(options) {
    if (!options) return;
    if (typeof options.trustedIssuers !== "function") throw new TypeError("enterpriseManagedAuthorization.trustedIssuers must be a resolver function: (input) => EmaTrustedIssuer | null");
    if (typeof options.mapClaims !== "function") throw new TypeError("enterpriseManagedAuthorization.mapClaims must be a function");
    if (options.jwksCacheTtlSeconds !== void 0 && options.jwksCacheTtlSeconds <= 0) throw new TypeError("enterpriseManagedAuthorization.jwksCacheTtlSeconds must be greater than 0");
    if (options.clockSkewSeconds !== void 0 && options.clockSkewSeconds < 0) throw new TypeError("enterpriseManagedAuthorization.clockSkewSeconds must be non-negative");
    if (options.maxAssertionLifetimeSeconds !== void 0 && options.maxAssertionLifetimeSeconds <= 0) throw new TypeError("enterpriseManagedAuthorization.maxAssertionLifetimeSeconds must be greater than 0");
  }
  /**
  * Main fetch handler for the Worker
  * Routes requests to the appropriate handler based on the URL
  * @param request - The HTTP request
  * @param env - Cloudflare Worker environment variables
  * @param ctx - Cloudflare Worker execution context
  * @returns A Promise resolving to an HTTP Response
  */
  async fetch(request, env, ctx) {
    return this.fetchForRoles(request, env, ctx, "combined");
  }
  async fetchAuthorizationServer(request, env, ctx) {
    return this.fetchForRoles(request, env, ctx, "authorization-server");
  }
  async fetchForRoles(request, env, ctx, role) {
    const url = new URL(request.url);
    const servesProtectedResources = role === "combined";
    const metadataResourceServer = servesProtectedResources ? this.findResourceServerForMetadataUrl(url) : void 0;
    const apiRoute = servesProtectedResources ? this.findApiRouteForUrl(url) : void 0;
    if (request.method === "OPTIONS") {
      if (apiRoute !== void 0 || this.isAuthorizationServerMetadataRequest(url) || servesProtectedResources && this.isProtectedResourceMetadataPath(url) || this.isTokenEndpoint(url) || this.options.clientRegistrationEndpoint && this.isClientRegistrationEndpoint(url)) return withCorsHeaders(new Response(null, {
        status: 204,
        headers: { "Content-Length": "0" }
      }), request);
    }
    if (this.isAuthorizationServerMetadataRequest(url)) {
      if (request.method !== "GET" && request.method !== "HEAD") return withCorsHeaders(new Response(null, {
        status: 405,
        headers: { Allow: "GET, HEAD, OPTIONS" }
      }), request);
      return withCorsHeaders(withoutBodyForHead(request, await this.handleMetadataDiscovery(url)), request);
    }
    if (servesProtectedResources && this.isProtectedResourceMetadataPath(url)) {
      if (!metadataResourceServer) return withCorsHeaders(new Response(null, { status: 404 }), request);
      if (request.method !== "GET" && request.method !== "HEAD") return withCorsHeaders(new Response(null, {
        status: 405,
        headers: { Allow: "GET, HEAD, OPTIONS" }
      }), request);
      return withCorsHeaders(withoutBodyForHead(request, this.handleProtectedResourceMetadata(url, metadataResourceServer)), request);
    }
    if (this.isTokenEndpoint(url)) {
      const parsed = await this.parseTokenEndpointRequest(request, env);
      if (parsed instanceof Response) return withCorsHeaders(parsed, request);
      let response;
      if (parsed.isRevocationRequest) response = await this.revokeToken(parsed.body, parsed.clientInfo, env);
      else response = await this.handleTokenRequest(parsed.body, parsed.clientInfo, parsed.clientAuthMethod, env, url, request);
      if (response.ok && !this.errorResponses.has(response)) await this.renewClientRegistrationIfDue(env, parsed.clientInfo, Math.floor(Date.now() / 1e3));
      return withCorsHeaders(response, request);
    }
    if (this.options.clientRegistrationEndpoint && this.isClientRegistrationEndpoint(url)) return withCorsHeaders(await this.handleClientRegistration(request, env), request);
    if (apiRoute) return withCorsHeaders(await this.handleApiRequest(request, env, ctx, apiRoute), request);
    const defaultHandler = this.typedDefaultHandler;
    if (!defaultHandler) return new Response(null, { status: 404 });
    if (!env.OAUTH_PROVIDER) env.OAUTH_PROVIDER = this.createOAuthHelpers(env);
    if (defaultHandler.type === HandlerType.EXPORTED_HANDLER) return defaultHandler.handler.fetch(request, env, ctx);
    return new defaultHandler.handler(ctx, env).fetch(request);
  }
  /**
  * Decodes a token and returns token data with decrypted props
  * @param token - The granted token
  * @param env - Cloudflare Worker environment variables
  * @returns Promise resolving to token data with decrypted props, or null if token is invalid
  */
  async unwrapToken(token, env) {
    const parts = token.split(":");
    if (!(parts.length === 3)) return null;
    const [userId, grantId] = parts;
    const id = await generateTokenId(token);
    const tokenData = await env.OAUTH_KV.get(`token:${userId}:${grantId}:${id}`, { type: "json" });
    if (!tokenData) return null;
    const now = Math.floor(Date.now() / 1e3);
    if (tokenData.expiresAt < now) return null;
    const decryptedProps = await decryptProps(await unwrapKeyWithToken(token, tokenData.wrappedEncryptionKey), tokenData.grant.encryptedProps);
    const { grant } = tokenData;
    return {
      id: tokenData.id,
      grantId: tokenData.grantId,
      userId: tokenData.userId,
      createdAt: tokenData.createdAt,
      expiresAt: tokenData.expiresAt,
      audience: tokenData.audience,
      scope: tokenData.scope || grant.scope,
      grant: {
        clientId: grant.clientId,
        scope: grant.scope,
        props: decryptedProps
      }
    };
  }
  async validateAccessToken(token, resource, env) {
    const configuredResource = this.findConfiguredResource(resource);
    if (!configuredResource) throw new TypeError("resource must name one registered protected resource");
    const summary = await this.unwrapToken(token, env);
    if (!summary || !isExactResource(this.resolveStoredTokenAudience(summary.audience), configuredResource)) return null;
    return {
      props: summary.grant.props,
      audience: configuredResource,
      expiresAt: summary.expiresAt,
      scope: summary.scope,
      userId: summary.userId,
      clientId: summary.grant.clientId
    };
  }
  /**
  * Determines if an endpoint configuration is a path or a full URL
  * @param endpoint - The endpoint configuration
  * @returns True if the endpoint is a path (starts with /), false if it's a full URL
  */
  isPath(endpoint) {
    return endpoint.startsWith("/");
  }
  /**
  * Matches a URL against an endpoint pattern that can be a full URL or just a path
  * @param url - The URL to check
  * @param endpoint - The endpoint pattern (full URL or path)
  * @returns True if the URL matches the endpoint pattern
  */
  matchEndpoint(url, endpoint, allowAdditionalQuery = false) {
    if (!this.explicitIssuer) {
      if (this.isPath(endpoint)) return url.pathname === endpoint;
      const legacyEndpoint = new URL(endpoint);
      return url.hostname === legacyEndpoint.hostname && url.pathname === legacyEndpoint.pathname;
    }
    const endpointUrl = new URL(this.getFullEndpointUrl(endpoint, url));
    if (url.origin !== endpointUrl.origin || url.pathname !== endpointUrl.pathname) return false;
    const unmatchedActualQuery = [...url.searchParams.entries()];
    const configuredQueryNames = /* @__PURE__ */ new Set();
    for (const [name, value] of endpointUrl.searchParams) {
      configuredQueryNames.add(name);
      const match = unmatchedActualQuery.findIndex(([actualName, actualValue]) => {
        return actualName === name && actualValue === value;
      });
      if (match === -1) return false;
      unmatchedActualQuery.splice(match, 1);
    }
    if (!allowAdditionalQuery) return unmatchedActualQuery.length === 0;
    return unmatchedActualQuery.every(([name]) => !configuredQueryNames.has(name));
  }
  /**
  * Checks if a URL matches the configured token endpoint
  * @param url - The URL to check
  * @returns True if the URL matches the token endpoint
  */
  isTokenEndpoint(url) {
    return this.matchEndpoint(url, this.options.tokenEndpoint, true);
  }
  isAuthorizationEndpointRequest(url) {
    return this.matchEndpoint(url, this.options.authorizeEndpoint, true);
  }
  /**
  * Checks if a URL matches the configured client registration endpoint
  * @param url - The URL to check
  * @returns True if the URL matches the client registration endpoint
  */
  isClientRegistrationEndpoint(url) {
    if (!this.options.clientRegistrationEndpoint) return false;
    return this.matchEndpoint(url, this.options.clientRegistrationEndpoint, true);
  }
  /**
  * Checks if a URL is a request for OAuth Protected Resource Metadata (RFC 9728).
  * Only the well-known URL constructed from the configured canonical resource
  * may return its document; aliases would violate RFC 9728 §3.3.
  */
  findResourceServerForMetadataUrl(url) {
    return this.resourceServers.find((server) => {
      const expected = new URL(this.getConfiguredResourceMetadataUrl(server.resourceMetadata.resource));
      return url.origin === expected.origin && url.pathname === expected.pathname && requestCarriesResourceQuery(url, expected);
    });
  }
  /** Exact RFC 8414 discovery location for the configured issuer. */
  getAuthorizationServerMetadataUrl(requestUrl) {
    if (!this.explicitIssuer) return `${requestUrl.origin}/.well-known/oauth-authorization-server`;
    const issuer = new URL(this.explicitIssuer);
    const issuerPath = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/+$/, "");
    return `${issuer.origin}/.well-known/oauth-authorization-server${issuerPath}`;
  }
  isAuthorizationServerMetadataRequest(url) {
    const expected = new URL(this.getAuthorizationServerMetadataUrl(url));
    return url.origin === expected.origin && url.pathname === expected.pathname;
  }
  /** Whether this instance is the role-based authorization server with a fixed issuer. */
  get hasExplicitIssuer() {
    return this.explicitIssuer !== void 0;
  }
  /** Whether a URL is in the RFC 9728 protected-resource metadata namespace. */
  isProtectedResourceMetadataPath(url) {
    return url.pathname === PROTECTED_RESOURCE_WELL_KNOWN_PREFIX || url.pathname.startsWith(PROTECTED_RESOURCE_WELL_KNOWN_PREFIX + "/");
  }
  createInvalidClientResponse(description, basicAuthenticationAttempted, internal, request) {
    return this.createErrorResponse("invalid_client", {
      description,
      statusCode: 401,
      ...basicAuthenticationAttempted ? { headers: { "WWW-Authenticate": BASIC_AUTH_CHALLENGE } } : {}
    }, internal, request);
  }
  /**
  * Parses and validates a token endpoint request (used for both token exchange and revocation)
  * @param request - The HTTP request to parse
  * @returns Promise with parsed body and client info, or error response
  */
  async parseTokenEndpointRequest(request, env) {
    if (request.method !== "POST") return this.createErrorResponse("invalid_request", {
      description: "Method not allowed",
      statusCode: 405,
      headers: { Allow: "POST, OPTIONS" }
    }, {
      category: "token-endpoint-request",
      reason: "method_not_allowed"
    });
    const contentType = request.headers.get("Content-Type") || "";
    let body = {};
    if (contentType.split(";")[0].trim().toLowerCase() !== "application/x-www-form-urlencoded") return this.createErrorResponse("invalid_request", {
      description: "Content-Type must be application/x-www-form-urlencoded",
      statusCode: 400
    }, {
      category: "token-endpoint-request",
      reason: "unsupported_content_type"
    });
    let formData;
    try {
      formData = await request.formData();
    } catch {
      return this.createErrorResponse("invalid_request", {
        description: "Request body must be valid application/x-www-form-urlencoded data",
        statusCode: 400
      }, {
        category: "token-endpoint-request",
        reason: "malformed_request_body"
      });
    }
    const processedKeys = /* @__PURE__ */ new Set();
    for (const key2 of formData.keys()) {
      if (processedKeys.has(key2)) continue;
      processedKeys.add(key2);
      const allValues = CLIENT_AUTHENTICATION_PARAMETERS.has(key2) ? formData.getAll(key2).filter((entry) => entry !== "") : formData.getAll(key2);
      if (allValues.length === 0) continue;
      if (key2 !== "resource" && allValues.length > 1) return this.createErrorResponse("invalid_request", {
        description: `Request parameter "${key2}" must not be repeated`,
        statusCode: 400
      }, {
        category: "token-endpoint-request",
        reason: "repeated_parameter",
        detail: { parameter: key2 }
      });
      body[key2] = allValues.length > 1 ? allValues : allValues[0];
    }
    const basicAuthorization = parseBasicAuthorizationHeader(request.headers.get("Authorization"));
    const basicAuthenticationAttempted = basicAuthorization.kind !== "not-basic";
    const sent = (name) => body[name] !== void 0;
    const clientAssertionAttempted = sent("client_assertion") || sent("client_assertion_type");
    let clientId = "";
    let clientSecret = "";
    if (basicAuthenticationAttempted) {
      if (sent("client_id") || sent("client_secret") || clientAssertionAttempted) return this.createErrorResponse("invalid_request", {
        description: "Client must not use multiple authentication methods",
        statusCode: 400
      }, {
        category: "client-authentication",
        reason: "multiple_authentication_methods"
      });
      if (basicAuthorization.kind === "malformed") return this.createInvalidClientResponse("Client authentication failed: invalid Basic credentials", basicAuthenticationAttempted, {
        category: "client-authentication",
        reason: "malformed_basic_credentials"
      });
      clientId = basicAuthorization.clientId;
      clientSecret = basicAuthorization.clientSecret;
    } else if (clientAssertionAttempted) {
      if (sent("client_secret")) return this.createErrorResponse("invalid_request", {
        description: "Client must not use multiple authentication methods",
        statusCode: 400
      }, {
        category: "client-authentication",
        reason: "multiple_authentication_methods"
      });
      if (!sent("client_assertion") || !sent("client_assertion_type")) return this.createErrorResponse("invalid_request", {
        description: "client_assertion and client_assertion_type must be sent together",
        statusCode: 400
      }, {
        category: "client-authentication",
        reason: "client_assertion_incomplete"
      });
      clientId = body.client_id || readClientAssertionIssuer(body.client_assertion) || "";
    } else {
      clientId = body.client_id;
      clientSecret = body.client_secret || "";
    }
    if (!clientId) return this.createInvalidClientResponse("Client ID is required", basicAuthenticationAttempted, {
      category: "client-authentication",
      reason: "client_id_missing"
    });
    let clientInfo;
    try {
      clientInfo = await this.getClient(env, clientId);
    } catch (error) {
      if (error instanceof CimdFetchError) return this.createInvalidClientResponse("Client not found", basicAuthenticationAttempted, {
        category: "client-id-metadata-document",
        reason: error.reason,
        detail: {
          metadataUrl: error.metadataUrl,
          message: error.detail
        }
      }, request);
      throw error;
    }
    if (!clientInfo) return this.createInvalidClientResponse("Client not found", basicAuthenticationAttempted, {
      category: "client-authentication",
      reason: "client_not_found"
    });
    const presentedAuthMethod = basicAuthenticationAttempted ? "client_secret_basic" : clientAssertionAttempted ? "private_key_jwt" : sent("client_secret") ? "client_secret_post" : "none";
    const registeredAuthMethod = clientInfo.tokenEndpointAuthMethod;
    if (!isClientAuthMethodAllowed(clientInfo, presentedAuthMethod, !!this.options.clientIdMetadataDocumentEnabled && isClientIdMetadataDocumentUrl(clientInfo.clientId))) return this.createInvalidClientResponse("Client authentication failed", basicAuthenticationAttempted, {
      category: "client-authentication",
      reason: "token_endpoint_auth_method_mismatch",
      detail: {
        clientId: clientInfo.clientId,
        registeredMethod: registeredAuthMethod,
        presentedMethod: presentedAuthMethod
      }
    });
    if (presentedAuthMethod === "private_key_jwt") {
      const failure = await this.verifyClientAssertion(body, clientInfo, env, request);
      if (failure) return failure;
    } else if (presentedAuthMethod !== "none") {
      if (!clientSecret) return this.createInvalidClientResponse("Client authentication failed: missing client_secret", basicAuthenticationAttempted, {
        category: "client-authentication",
        reason: "client_secret_missing"
      });
      if (!clientInfo.clientSecret) return this.createInvalidClientResponse("Client authentication failed: client has no registered secret", basicAuthenticationAttempted, {
        category: "client-authentication",
        reason: "client_secret_not_registered"
      });
      if (await hashSecret(clientSecret) !== clientInfo.clientSecret) return this.createInvalidClientResponse("Client authentication failed: invalid client_secret", basicAuthenticationAttempted, {
        category: "client-authentication",
        reason: "client_secret_mismatch"
      });
    }
    const isRevocationRequest = !body.grant_type && !!body.token;
    return {
      body,
      clientInfo,
      clientAuthMethod: presentedAuthMethod,
      isRevocationRequest
    };
  }
  /**
  * Authenticates a `private_key_jwt` request (RFC 7523 §2.2). The method check has already
  * confirmed that the client registered the method, which only a CIMD client with usable keys can.
  * @returns An `invalid_client` response, or `undefined` once the assertion verified and was consumed
  */
  async verifyClientAssertion(body, clientInfo, env, request) {
    const keys = clientInfo.clientAssertionKeys;
    const verifier = this.clientAssertionVerifier;
    if (!keys || !verifier) throw new Error("private_key_jwt client resolved without keys or a verifier");
    if (body.client_assertion_type !== JWT_BEARER_CLIENT_ASSERTION_TYPE) return this.createInvalidClientResponse("Client authentication failed", false, {
      category: "client-authentication",
      reason: "client_assertion_type_unsupported",
      detail: {
        clientId: clientInfo.clientId,
        clientAssertionType: String(body.client_assertion_type)
      }
    });
    const requestUrl = new URL(request.url);
    const verified = await verifier.verify({
      assertion: body.client_assertion,
      clientId: clientInfo.clientId,
      keys,
      issuer: this.getAuthorizationServerIssuer(requestUrl),
      tokenEndpoint: this.getFullEndpointUrl(this.options.tokenEndpoint, requestUrl),
      env
    });
    if (verified.ok) return void 0;
    return this.createInvalidClientResponse("Client authentication failed", false, {
      category: "client-authentication",
      reason: "client_assertion_invalid",
      detail: {
        clientId: clientInfo.clientId,
        ...verified.error
      }
    }, request);
  }
  /**
  * Checks if a URL matches a specific API route
  * @param url - The URL to check
  * @param route - The API route to check against
  * @returns True if the URL matches the API route
  */
  matchApiRoute(url, route) {
    const pathMatches = (configuredPath, rootMatchesDescendants) => {
      if (configuredPath === "/") return rootMatchesDescendants || url.pathname === "/";
      const normalized = configuredPath.endsWith("/") ? configuredPath.slice(0, -1) : configuredPath;
      return url.pathname === normalized || url.pathname.startsWith(normalized + "/");
    };
    if (this.isPath(route)) return pathMatches(route, false);
    else {
      const apiUrl = new URL(route);
      return url.origin === apiUrl.origin && pathMatches(apiUrl.pathname, true) && requestCarriesResourceQuery(url, apiUrl);
    }
  }
  /**
  * Finds the appropriate API handler for a URL
  * @param url - The URL to find a handler for
  * @returns The TypedHandler for the URL, or undefined if no handler matches
  */
  findApiRouteForUrl(url) {
    return this.typedApiHandlers.filter(({ route }) => this.matchApiRoute(url, route)).sort((left, right) => new URL(right.route, url.origin).pathname.length - new URL(left.route, url.origin).pathname.length)[0];
  }
  /**
  * Gets the full URL for an endpoint, using the provided request URL's
  * origin for endpoints specified as just paths
  * @param endpoint - The endpoint configuration (path or full URL)
  * @param requestUrl - The URL of the incoming request
  * @returns The full URL for the endpoint
  */
  getFullEndpointUrl(endpoint, requestUrl) {
    if (this.isPath(endpoint)) return `${this.explicitIssuer ? new URL(this.explicitIssuer).origin : requestUrl.origin}${endpoint}`;
    else return endpoint;
  }
  /**
  * Gets the authorization server issuer using the same derivation as RFC 8414 metadata.
  */
  getAuthorizationServerIssuer(requestUrl) {
    if (this.explicitIssuer) return this.explicitIssuer;
    const tokenEndpoint = this.getFullEndpointUrl(this.options.tokenEndpoint, requestUrl);
    return new URL(tokenEndpoint).origin;
  }
  /**
  * Handles the OAuth metadata discovery endpoint
  * Implements RFC 8414 for OAuth Server Metadata
  * @param requestUrl - The URL of the incoming request
  * @returns Response with OAuth server metadata
  */
  async handleMetadataDiscovery(requestUrl) {
    const tokenEndpoint = this.getFullEndpointUrl(this.options.tokenEndpoint, requestUrl);
    const authorizeEndpoint = this.getFullEndpointUrl(this.options.authorizeEndpoint, requestUrl);
    let registrationEndpoint = void 0;
    if (this.options.clientRegistrationEndpoint) registrationEndpoint = this.getFullEndpointUrl(this.options.clientRegistrationEndpoint, requestUrl);
    const responseTypesSupported = this.serverCapabilities.responseTypes;
    const grantTypesSupported = this.serverCapabilities.grantTypes;
    const authorizationGrantProfilesSupported = this.options.enterpriseManagedAuthorization ? [EMA_ID_JAG_GRANT_PROFILE] : [];
    const cimdSupported = !!this.options.clientIdMetadataDocumentEnabled && this.hasGlobalFetchStrictlyPublic();
    const metadata = {
      issuer: this.getAuthorizationServerIssuer(requestUrl),
      authorization_endpoint: authorizeEndpoint,
      token_endpoint: tokenEndpoint,
      ...this.resourceServers.length > 0 ? { protected_resources: this.resourceServers.map((server) => server.resourceMetadata.resource) } : {},
      registration_endpoint: registrationEndpoint,
      scopes_supported: this.options.scopesSupported,
      response_types_supported: responseTypesSupported,
      response_modes_supported: ["query"],
      grant_types_supported: grantTypesSupported,
      ...authorizationGrantProfilesSupported.length > 0 ? { authorization_grant_profiles_supported: authorizationGrantProfilesSupported } : {},
      token_endpoint_auth_methods_supported: [...this.serverCapabilities.tokenEndpointAuthMethods, ...cimdSupported ? ["private_key_jwt"] : []],
      ...cimdSupported ? { token_endpoint_auth_signing_alg_values_supported: [...CLIENT_ASSERTION_ALGORITHMS] } : {},
      revocation_endpoint: tokenEndpoint,
      code_challenge_methods_supported: this.serverCapabilities.codeChallengeMethods,
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: cimdSupported
    };
    return new Response(JSON.stringify(metadata), { headers: { "Content-Type": "application/json" } });
  }
  /** Scopes that are baseline requirements of the protected resource itself. */
  getProtectedResourceScopes(resourceServer) {
    return this.normalizeProtectedResourceScopes(resourceServer.resourceMetadata.scopes_supported ?? []);
  }
  /** Deduplicate resource-facing scopes and remove authorization-server-only capabilities. */
  normalizeProtectedResourceScopes(scopes) {
    return baselineResourceScopes(scopes);
  }
  /**
  * Handles the OAuth Protected Resource Metadata endpoint
  * Implements RFC 9728 for OAuth Protected Resource Metadata
  * @param requestUrl - The URL of the incoming request
  * @returns Response with protected resource metadata
  */
  handleProtectedResourceMetadata(requestUrl, resourceServer) {
    const rm = resourceServer.resourceMetadata;
    const authorizationServer = this.getAuthorizationServerIssuer(requestUrl);
    const resourceScopes = this.getProtectedResourceScopes(resourceServer);
    const metadata = {
      resource: rm.resource,
      authorization_servers: rm.authorization_servers ?? [authorizationServer],
      ...resourceScopes.length > 0 ? { scopes_supported: resourceScopes } : {},
      bearer_methods_supported: rm.bearer_methods_supported ?? ["header"]
    };
    if (rm.resource_name) metadata.resource_name = rm.resource_name;
    return new Response(JSON.stringify(metadata), { headers: { "Content-Type": "application/json" } });
  }
  /**
  * Handles client authentication and token issuance via the token endpoint
  * Supports authorization_code and refresh_token grant types
  * @param body - The parsed request body
  * @param clientInfo - The authenticated client information
  * @param env - Cloudflare Worker environment variables
  * @returns Response with token data or error
  */
  async handleTokenRequest(body, clientInfo, clientAuthMethod, env, requestUrl, request) {
    try {
      const grantType = body.grant_type;
      if (!(grantType === GrantType.AUTHORIZATION_CODE || grantType === GrantType.REFRESH_TOKEN || grantType === GrantType.TOKEN_EXCHANGE && !!this.options.allowTokenExchangeGrant || grantType === GrantType.JWT_BEARER && !!this.options.enterpriseManagedAuthorization)) return this.createErrorResponse("unsupported_grant_type", { description: "Grant type not supported" }, {
        category: "token-endpoint-request",
        reason: "grant_type_not_supported"
      });
      if (grantType !== GrantType.JWT_BEARER && Array.isArray(clientInfo.grantTypes)) {
        const registered = clientInfo.grantTypes;
        if (!(registered.includes(grantType) || grantType === GrantType.REFRESH_TOKEN && registered.includes(GrantType.AUTHORIZATION_CODE))) return this.createErrorResponse("unauthorized_client", { description: "The client is not registered for this grant type" }, {
          category: "token-endpoint-request",
          reason: "grant_type_not_registered"
        });
      }
      this.validateTokenRequestResourceIndicator(body.resource);
      if (grantType === GrantType.AUTHORIZATION_CODE) return await this.handleAuthorizationCodeGrant(body, clientInfo, env);
      else if (grantType === GrantType.REFRESH_TOKEN) return await this.handleRefreshTokenGrant(body, clientInfo, env);
      else if (grantType === GrantType.TOKEN_EXCHANGE && this.options.allowTokenExchangeGrant) return await this.handleTokenExchangeGrant(body, clientInfo, env);
      else if (grantType === GrantType.JWT_BEARER) return await this.handleJwtBearerGrant(body, clientInfo, clientAuthMethod, env, requestUrl, request);
      throw new Error("Unreachable supported grant type");
    } catch (error) {
      const response = this.createOAuthErrorResponse(error);
      if (response) return response;
      throw error;
    }
  }
  /**
  * Build a structured OAuth token-endpoint response from an OAuth error.
  *
  * The supported form is throwing this package's exported `OAuthError` from
  * token issuance or `tokenExchangeCallback`. Anything else is re-thrown so
  * unexpected failures still surface as 500s.
  */
  /**
  * Run `tokenExchangeCallback`. An `invalid_grant` it throws means the grant can never work again
  * (RFC 6749 §5.2: invalid, expired, or revoked; transient failures are `temporarily_unavailable`),
  * so the grant it ran for is revoked, with its tokens, before the error answers. A failed
  * revocation is logged and the callback's error still answers the request.
  */
  async callTokenExchangeCallback(options, env) {
    try {
      return await Promise.resolve(this.options.tokenExchangeCallback({
        ...options,
        env
      }));
    } catch (error) {
      if (error instanceof OAuthError && error.code === "invalid_grant") try {
        await this.createOAuthHelpers(env).revokeGrant(options.grantId, options.userId);
      } catch (revokeError) {
        console.warn(`Failed to revoke grant ${options.grantId} after tokenExchangeCallback answered invalid_grant:`, revokeError);
      }
      throw error;
    }
  }
  createOAuthErrorResponse(error) {
    if (!(error instanceof OAuthError)) return void 0;
    return this.createErrorResponse(error.code, error.options, error.options.internal ?? {
      category: "token-exchange-callback",
      reason: "callback_error",
      detail: error
    });
  }
  /**
  * Build a structured protected-resource response from an external-token error.
  *
  * Only this package's exported `ExternalTokenError` is converted. Standard
  * bearer failures receive an RFC 6750 / RFC 9728 challenge unless the caller
  * supplied one. Other errors retain the pre-existing behavior and are re-thrown.
  */
  createExternalTokenErrorResponse(error, resourceMetadataUrl, resourceServer) {
    if (!(error instanceof ExternalTokenError)) return void 0;
    const headers = error.headers ?? {};
    const hasChallenge = Object.keys(headers).some((name) => name.toLowerCase() === "www-authenticate");
    const isBearerError = error.code === "invalid_token" && error.statusCode === 401 || error.code === "insufficient_scope" && error.statusCode === 403;
    let challengeHeaders;
    if (isBearerError && !hasChallenge) {
      const requiredScopes = [...new Set(error.requiredScopes ?? [])];
      if (requiredScopes.some((scope) => !isValidOAuthScopeToken(scope))) throw new TypeError("ExternalTokenError requiredScopes must contain valid OAuth scope tokens");
      challengeHeaders = {
        ...headers,
        "WWW-Authenticate": this.buildWwwAuthenticateHeader(resourceMetadataUrl, error.code, void 0, requiredScopes, resourceServer)
      };
    }
    return this.createErrorResponse(error.code, {
      description: error.description,
      statusCode: error.statusCode,
      headers: challengeHeaders ?? headers
    }, {
      category: "protected-resource",
      reason: "resolver_rejected",
      detail: error
    });
  }
  /**
  * Handles the authorization code grant type
  * Exchanges an authorization code for access and refresh tokens
  * @param body - The parsed request body
  * @param clientInfo - The authenticated client information
  * @param env - Cloudflare Worker environment variables
  * @returns Response with token data or error
  */
  async handleAuthorizationCodeGrant(body, clientInfo, env) {
    const code = body.code;
    const redirectUri = body.redirect_uri;
    const codeVerifier = body.code_verifier;
    if (!code) return this.createErrorResponse("invalid_request", { description: "Authorization code is required" }, {
      category: "authorization-code-grant",
      reason: "code_missing"
    });
    const codeParts = code.split(":");
    if (codeParts.length !== 3) return this.createErrorResponse("invalid_grant", { description: "Invalid authorization code format" }, {
      category: "authorization-code-grant",
      reason: "code_malformed"
    });
    const [userId, grantId, _] = codeParts;
    const grantKey = `grant:${userId}:${grantId}`;
    const grantData = await env.OAUTH_KV.get(grantKey, { type: "json" });
    if (!grantData) return this.createErrorResponse("invalid_grant", { description: "Grant not found or authorization code expired" }, {
      category: "authorization-code-grant",
      reason: "grant_not_found"
    });
    const codeHash = await hashSecret(code);
    if (!grantData.authCodeId || codeHash !== grantData.authCodeId) return this.createErrorResponse("invalid_grant", { description: "Invalid authorization code" }, {
      category: "authorization-code-grant",
      reason: "code_mismatch"
    });
    if (grantData.clientId !== clientInfo.clientId) return this.createErrorResponse("invalid_grant", { description: "Client ID mismatch" }, {
      category: "authorization-code-grant",
      reason: "client_mismatch"
    });
    if (!grantData.authCodeWrappedKey) {
      try {
        await this.createOAuthHelpers(env).revokeGrant(grantId, userId);
      } catch {
      }
      return this.createErrorResponse("invalid_grant", { description: "Authorization code already used" }, {
        category: "authorization-code-grant",
        reason: "code_replayed"
      });
    }
    try {
      if (grantData.codeChallenge) validatePkceCodeChallengeMethod(this.serverCapabilities, grantData.codeChallengeMethod);
      else normalizePkceCodeChallengeMethod(grantData.codeChallengeMethod);
    } catch (error) {
      return this.createErrorResponse("invalid_grant", { description: error instanceof Error ? error.message : "Invalid PKCE code_challenge_method" }, {
        category: "authorization-code-grant",
        reason: "pkce_method_invalid",
        detail: error
      });
    }
    const isPkceEnabled = !!grantData.codeChallenge;
    if (!redirectUri && !isPkceEnabled) return this.createErrorResponse("invalid_request", { description: "redirect_uri is required when not using PKCE" }, {
      category: "authorization-code-grant",
      reason: "redirect_uri_missing"
    });
    if (redirectUri && !isValidRedirectUri(redirectUri, clientInfo.redirectUris)) return this.createErrorResponse("invalid_grant", { description: "Invalid redirect URI" }, {
      category: "authorization-code-grant",
      reason: "redirect_uri_invalid"
    });
    if (redirectUri && grantData.redirectUri !== void 0 && redirectUri !== grantData.redirectUri) return this.createErrorResponse("invalid_grant", { description: "redirect_uri does not match the authorization request" }, {
      category: "authorization-code-grant",
      reason: "redirect_uri_mismatch"
    });
    if (!isPkceEnabled && codeVerifier) return this.createErrorResponse("invalid_request", { description: "code_verifier provided for a flow that did not use PKCE" }, {
      category: "authorization-code-grant",
      reason: "unexpected_code_verifier"
    });
    if (isPkceEnabled) {
      if (!codeVerifier) return this.createErrorResponse("invalid_request", { description: "code_verifier is required for PKCE" }, {
        category: "authorization-code-grant",
        reason: "code_verifier_missing"
      });
      const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
      if (base64UrlEncode(String.fromCharCode(...new Uint8Array(hashBuffer))) !== grantData.codeChallenge) return this.createErrorResponse("invalid_grant", { description: "Invalid PKCE code_verifier" }, {
        category: "authorization-code-grant",
        reason: "code_verifier_mismatch"
      });
    }
    const resourceResolution = this.resolveTokenResource(body.resource, grantData);
    const audience = resourceResolution.audience;
    let accessTokenTTL = this.options.accessTokenTTL;
    let refreshTokenTTL = this.options.refreshTokenTTL;
    const encryptionKey = await unwrapKeyWithToken(code, grantData.authCodeWrappedKey);
    let grantEncryptionKey = encryptionKey;
    let accessTokenEncryptionKey = encryptionKey;
    let encryptedAccessTokenProps = grantData.encryptedProps;
    let tokenScopes = this.downscope(body.scope, grantData.scope);
    if (grantsNoneOfTheRequestedScopes(body.scope, tokenScopes)) return this.createErrorResponse("invalid_scope", { description: "None of the requested scopes were granted" }, {
      category: "authorization-code-grant",
      reason: "scope_not_granted"
    });
    if (this.options.tokenExchangeCallback) {
      const decryptedProps = await decryptProps(encryptionKey, grantData.encryptedProps);
      let grantProps = decryptedProps;
      let accessTokenProps = decryptedProps;
      const callbackOptions = {
        grantType: GrantType.AUTHORIZATION_CODE,
        clientId: clientInfo.clientId,
        subjectClientId: grantData.clientId,
        userId,
        grantId,
        scope: grantData.scope,
        requestedScope: tokenScopes,
        resource: audience,
        props: decryptedProps
      };
      const callbackResult = await this.callTokenExchangeCallback(callbackOptions, env);
      if (callbackResult) {
        if (callbackResult.newProps) {
          grantProps = callbackResult.newProps;
          if (!callbackResult.accessTokenProps) accessTokenProps = callbackResult.newProps;
        }
        if (callbackResult.accessTokenProps) accessTokenProps = callbackResult.accessTokenProps;
        if (callbackResult.accessTokenTTL !== void 0) accessTokenTTL = callbackResult.accessTokenTTL;
        if (callbackResult.refreshTokenTTL !== void 0) {
          if (!isValidRefreshTokenTTL(callbackResult.refreshTokenTTL)) return this.createErrorResponse("invalid_request", { description: `refreshTokenTTL must be 0 (no refresh token) or an integer of at least ${KV_MIN_EXPIRATION_TTL_SECONDS} seconds` }, {
            category: "authorization-code-grant",
            reason: "refresh_token_ttl_invalid"
          });
          refreshTokenTTL = callbackResult.refreshTokenTTL;
        }
        if (callbackResult.accessTokenScope) tokenScopes = this.downscope(callbackResult.accessTokenScope, grantData.scope);
      }
      const grantResult = await encryptProps(grantProps);
      grantData.encryptedProps = grantResult.encryptedData;
      grantEncryptionKey = grantResult.key;
      if (accessTokenProps !== grantProps) {
        const tokenResult = await encryptProps(accessTokenProps);
        encryptedAccessTokenProps = tokenResult.encryptedData;
        accessTokenEncryptionKey = tokenResult.key;
      } else {
        encryptedAccessTokenProps = grantData.encryptedProps;
        accessTokenEncryptionKey = grantEncryptionKey;
      }
    }
    if (!isValidAccessTokenTTL(accessTokenTTL)) return this.createErrorResponse("invalid_request", { description: "Requested token lifetime must be at least 60 seconds" }, {
      category: "authorization-code-grant",
      reason: "requested_ttl_too_short"
    });
    const now = Math.floor(Date.now() / 1e3);
    const useRefreshToken = refreshTokenTTL !== 0;
    delete grantData.codeChallenge;
    delete grantData.codeChallengeMethod;
    delete grantData.authCodeWrappedKey;
    let refreshToken;
    if (useRefreshToken) {
      refreshToken = `${userId}:${grantId}:${generateRandomString(TOKEN_LENGTH)}`;
      const refreshTokenId = await generateTokenId(refreshToken);
      const refreshTokenWrappedKey = await wrapKeyWithToken(refreshToken, grantEncryptionKey);
      const expiresAt = refreshTokenTTL !== void 0 ? now + refreshTokenTTL : void 0;
      grantData.refreshTokenId = refreshTokenId;
      grantData.refreshTokenWrappedKey = refreshTokenWrappedKey;
      grantData.previousRefreshTokenId = void 0;
      grantData.previousRefreshTokenWrappedKey = void 0;
      grantData.expiresAt = expiresAt;
    } else grantData.expiresAt = now + accessTokenTTL;
    if (resourceResolution.grantResourceBackfill) grantData.resource = resourceResolution.grantResourceBackfill;
    await this.saveGrantWithTTL(env, grantKey, grantData, now);
    const tokenResponse = {
      access_token: await this.createAccessToken({
        userId,
        grantId,
        clientId: grantData.clientId,
        scope: tokenScopes,
        encryptedProps: encryptedAccessTokenProps,
        encryptionKey: accessTokenEncryptionKey,
        expiresIn: accessTokenTTL,
        audience,
        env
      }),
      token_type: "bearer",
      expires_in: accessTokenTTL,
      scope: tokenScopes.join(" "),
      resource: audience
    };
    if (refreshToken) tokenResponse.refresh_token = refreshToken;
    return new Response(JSON.stringify(tokenResponse), { headers: {
      "Content-Type": "application/json",
      ...NO_CACHE_HEADERS
    } });
  }
  /**
  * Handles the refresh token grant type
  * Issues a new access token using a refresh token
  * @param body - The parsed request body
  * @param clientInfo - The authenticated client information
  * @param env - Cloudflare Worker environment variables
  * @returns Response with token data or error
  */
  async handleRefreshTokenGrant(body, clientInfo, env) {
    const refreshToken = body.refresh_token;
    if (!refreshToken) return this.createErrorResponse("invalid_request", { description: "Refresh token is required" }, {
      category: "refresh-token-grant",
      reason: "refresh_token_missing"
    });
    const tokenParts = refreshToken.split(":");
    if (tokenParts.length !== 3) return this.createErrorResponse("invalid_grant", { description: "Invalid token format" }, {
      category: "refresh-token-grant",
      reason: "refresh_token_malformed"
    });
    const [userId, grantId, _] = tokenParts;
    const providedTokenHash = await generateTokenId(refreshToken);
    const grantKey = `grant:${userId}:${grantId}`;
    const grantData = await env.OAUTH_KV.get(grantKey, { type: "json" });
    if (!grantData) return this.createErrorResponse("invalid_grant", { description: "Grant not found" }, {
      category: "refresh-token-grant",
      reason: "grant_not_found"
    });
    const isCurrentToken = grantData.refreshTokenId === providedTokenHash;
    const isPreviousToken = grantData.previousRefreshTokenId === providedTokenHash;
    if (!isCurrentToken && !isPreviousToken) return this.createErrorResponse("invalid_grant", { description: "Invalid refresh token" }, {
      category: "refresh-token-grant",
      reason: "refresh_token_mismatch"
    });
    if (grantData.clientId !== clientInfo.clientId) return this.createErrorResponse("invalid_grant", { description: "Client ID mismatch" }, {
      category: "refresh-token-grant",
      reason: "client_mismatch"
    });
    if (grantData.expiresAt !== void 0) {
      const now$1 = Math.floor(Date.now() / 1e3);
      if (grantData.expiresAt - now$1 < KV_MIN_EXPIRATION_TTL_SECONDS) return this.createErrorResponse("invalid_grant", { description: "Refresh token has expired" }, {
        category: "refresh-token-grant",
        reason: "refresh_token_expired"
      });
    }
    const resourceResolution = this.resolveTokenResource(body.resource, grantData);
    const audience = resourceResolution.audience;
    const newAccessToken = `${userId}:${grantId}:${generateRandomString(TOKEN_LENGTH)}`;
    const accessTokenId = await generateTokenId(newAccessToken);
    let accessTokenTTL = this.options.accessTokenTTL;
    let refreshTokenIdleTTL = this.options.refreshTokenIdleTTL;
    let wrappedKeyToUse;
    if (isCurrentToken) wrappedKeyToUse = grantData.refreshTokenWrappedKey;
    else wrappedKeyToUse = grantData.previousRefreshTokenWrappedKey;
    const encryptionKey = await unwrapKeyWithToken(refreshToken, wrappedKeyToUse);
    let grantEncryptionKey = encryptionKey;
    let accessTokenEncryptionKey = encryptionKey;
    let encryptedAccessTokenProps = grantData.encryptedProps;
    let tokenScopes = this.downscope(body.scope, grantData.scope);
    if (grantsNoneOfTheRequestedScopes(body.scope, tokenScopes)) return this.createErrorResponse("invalid_scope", { description: "None of the requested scopes were granted" }, {
      category: "refresh-token-grant",
      reason: "scope_not_granted"
    });
    let grantPropsChanged = false;
    if (this.options.tokenExchangeCallback) {
      const decryptedProps = await decryptProps(encryptionKey, grantData.encryptedProps);
      let grantProps = decryptedProps;
      let accessTokenProps = decryptedProps;
      const callbackOptions = {
        grantType: GrantType.REFRESH_TOKEN,
        clientId: clientInfo.clientId,
        subjectClientId: grantData.clientId,
        userId,
        grantId,
        scope: grantData.scope,
        requestedScope: tokenScopes,
        resource: audience,
        props: decryptedProps
      };
      const callbackResult = await this.callTokenExchangeCallback(callbackOptions, env);
      if (callbackResult) {
        if (callbackResult.newProps) {
          grantProps = callbackResult.newProps;
          grantPropsChanged = true;
          if (!callbackResult.accessTokenProps) accessTokenProps = callbackResult.newProps;
        }
        if (callbackResult.accessTokenProps) accessTokenProps = callbackResult.accessTokenProps;
        if (callbackResult.accessTokenTTL !== void 0) accessTokenTTL = callbackResult.accessTokenTTL;
        if (callbackResult.refreshTokenIdleTTL !== void 0) {
          if (!isValidAccessTokenTTL(callbackResult.refreshTokenIdleTTL)) return this.createErrorResponse("invalid_request", { description: `refreshTokenIdleTTL must be an integer of at least ${KV_MIN_EXPIRATION_TTL_SECONDS} seconds` }, {
            category: "refresh-token-grant",
            reason: "refresh_token_idle_ttl_invalid"
          });
          refreshTokenIdleTTL = callbackResult.refreshTokenIdleTTL;
        }
        if (callbackResult.accessTokenScope) tokenScopes = this.downscope(callbackResult.accessTokenScope, grantData.scope);
      }
      if (grantPropsChanged) {
        const grantResult = await encryptProps(grantProps);
        grantData.encryptedProps = grantResult.encryptedData;
        if (grantResult.key !== encryptionKey) {
          grantEncryptionKey = grantResult.key;
          wrappedKeyToUse = await wrapKeyWithToken(refreshToken, grantEncryptionKey);
        } else grantEncryptionKey = grantResult.key;
      }
      if (accessTokenProps !== grantProps) {
        const tokenResult = await encryptProps(accessTokenProps);
        encryptedAccessTokenProps = tokenResult.encryptedData;
        accessTokenEncryptionKey = tokenResult.key;
      } else {
        encryptedAccessTokenProps = grantData.encryptedProps;
        accessTokenEncryptionKey = grantEncryptionKey;
      }
    }
    const now = Math.floor(Date.now() / 1e3);
    if (grantData.expiresAt !== void 0 && grantData.expiresAt - now < KV_MIN_EXPIRATION_TTL_SECONDS) return this.createErrorResponse("invalid_grant", { description: "Refresh token has expired" }, {
      category: "refresh-token-grant",
      reason: "refresh_token_expired"
    });
    if (refreshTokenIdleTTL !== void 0) grantData.expiresAt = now + refreshTokenIdleTTL;
    if (grantData.expiresAt !== void 0) {
      const remainingRefreshTokenLifetime = grantData.expiresAt - now;
      if (remainingRefreshTokenLifetime > 0) accessTokenTTL = Math.min(accessTokenTTL, remainingRefreshTokenLifetime);
    }
    if (!isValidAccessTokenTTL(accessTokenTTL)) return this.createErrorResponse("invalid_request", { description: "Requested token lifetime must be at least 60 seconds" }, {
      category: "refresh-token-grant",
      reason: "requested_ttl_too_short"
    });
    const accessTokenExpiresAt = now + accessTokenTTL;
    const accessTokenWrappedKey = await wrapKeyWithToken(newAccessToken, accessTokenEncryptionKey);
    const newRefreshToken = `${userId}:${grantId}:${generateRandomString(TOKEN_LENGTH)}`;
    const newRefreshTokenId = await generateTokenId(newRefreshToken);
    const newRefreshTokenWrappedKey = await wrapKeyWithToken(newRefreshToken, grantEncryptionKey);
    grantData.previousRefreshTokenId = providedTokenHash;
    grantData.previousRefreshTokenWrappedKey = wrappedKeyToUse;
    grantData.refreshTokenId = newRefreshTokenId;
    grantData.refreshTokenWrappedKey = newRefreshTokenWrappedKey;
    if (resourceResolution.grantResourceBackfill) grantData.resource = resourceResolution.grantResourceBackfill;
    await this.saveGrantWithTTL(env, grantKey, grantData, now);
    const accessTokenData = {
      id: accessTokenId,
      grantId,
      userId,
      createdAt: now,
      expiresAt: accessTokenExpiresAt,
      audience,
      scope: tokenScopes,
      wrappedEncryptionKey: accessTokenWrappedKey,
      grant: {
        clientId: grantData.clientId,
        scope: grantData.scope,
        encryptedProps: encryptedAccessTokenProps
      }
    };
    try {
      await env.OAUTH_KV.put(`token:${userId}:${grantId}:${accessTokenId}`, JSON.stringify(accessTokenData), { expirationTtl: accessTokenTTL });
    } catch (error) {
      this.throwRetryableTokenStorageErrorIfKvRateLimited(error);
      throw error;
    }
    const tokenResponse = {
      access_token: newAccessToken,
      token_type: "bearer",
      expires_in: accessTokenTTL,
      refresh_token: newRefreshToken,
      scope: tokenScopes.join(" "),
      resource: audience
    };
    return new Response(JSON.stringify(tokenResponse), { headers: {
      "Content-Type": "application/json",
      ...NO_CACHE_HEADERS
    } });
  }
  /**
  * Core token exchange logic (RFC 8693)
  * Performs the actual token exchange operation
  * This method is not private because `OAuthHelpers` needs to call it. Note that since
  * `OAuthProviderImpl` is not exposed outside this module, this is still effectively
  * module-private.
  * @param subjectToken - The subject token to exchange
  * @param requestedScopes - Optional requested scopes, limited to the subject token's scopes
  * @param requestedResource - Optional resource/audience; when present, it must match the configured canonical resource
  * @param expiresIn - Optional TTL override in seconds
  * @param clientInfo - The client making the exchange request
  * @param env - Cloudflare Worker environment variables
  * @returns Promise resolving to token response
  * @throws OAuthError with OAuth error code and description
  */
  async exchangeToken(subjectToken, requestedScopes, requestedResource, expiresIn, clientInfo, env) {
    const tokenSummary = await this.unwrapToken(subjectToken, env);
    if (!tokenSummary) throw new OAuthError("invalid_request", {
      description: "Invalid or expired subject token",
      internal: {
        category: "token-exchange-grant",
        reason: "subject_token_invalid"
      }
    });
    const grantKey = `grant:${tokenSummary.userId}:${tokenSummary.grantId}`;
    const grantData = await env.OAUTH_KV.get(grantKey, { type: "json" });
    if (!grantData) throw new OAuthError("invalid_request", {
      description: "Grant not found",
      internal: {
        category: "token-exchange-grant",
        reason: "grant_not_found"
      }
    });
    const crossClientExchange = grantData.clientId !== clientInfo.clientId;
    const crossClientRejection = () => new OAuthError("invalid_request", {
      description: "The subject token was issued to a different client",
      internal: {
        category: "token-exchange-grant",
        reason: "cross_client_subject_token"
      }
    });
    if (crossClientExchange && !this.options.tokenExchangeCallback) throw crossClientRejection();
    let tokenScopes = this.downscope(requestedScopes, tokenSummary.scope);
    if (grantsNoneOfTheRequestedScopes(requestedScopes, tokenScopes)) throw new OAuthError("invalid_scope", {
      description: "None of the requested scopes were granted",
      internal: {
        category: "token-exchange-grant",
        reason: "scope_not_granted"
      }
    });
    const newAudience = this.resolveTokenExchangeResource(requestedResource, tokenSummary.audience);
    const now = Math.floor(Date.now() / 1e3);
    const subjectTokenRemainingLifetime = tokenSummary.expiresAt - now;
    if (subjectTokenRemainingLifetime < KV_MIN_EXPIRATION_TTL_SECONDS) throw new OAuthError("invalid_request", {
      description: "Subject token is too close to expiry to exchange",
      internal: {
        category: "token-exchange-grant",
        reason: "subject_token_near_expiry"
      }
    });
    let accessTokenTTL = this.options.accessTokenTTL ?? DEFAULT_ACCESS_TOKEN_TTL;
    if (expiresIn !== void 0) {
      if (expiresIn <= 0) throw new OAuthError("invalid_request", {
        description: "Invalid expires_in parameter",
        internal: {
          category: "token-exchange-grant",
          reason: "expires_in_invalid"
        }
      });
      accessTokenTTL = Math.min(expiresIn, subjectTokenRemainingLifetime);
    } else accessTokenTTL = Math.min(accessTokenTTL, subjectTokenRemainingLifetime);
    const subjectTokenData = await env.OAUTH_KV.get(`token:${tokenSummary.userId}:${tokenSummary.grantId}:${tokenSummary.id}`, { type: "json" });
    if (!subjectTokenData) throw new OAuthError("invalid_request", {
      description: "Subject token data not found",
      internal: {
        category: "token-exchange-grant",
        reason: "subject_token_data_missing"
      }
    });
    const encryptionKey = await unwrapKeyWithToken(subjectToken, subjectTokenData.wrappedEncryptionKey);
    let accessTokenEncryptionKey = encryptionKey;
    let encryptedAccessTokenProps = subjectTokenData.grant.encryptedProps;
    if (this.options.tokenExchangeCallback) {
      const decryptedProps = await decryptProps(encryptionKey, subjectTokenData.grant.encryptedProps);
      const callbackOptions = {
        grantType: GrantType.TOKEN_EXCHANGE,
        clientId: clientInfo.clientId,
        subjectClientId: grantData.clientId,
        userId: tokenSummary.userId,
        grantId: tokenSummary.grantId,
        scope: tokenSummary.grant.scope,
        requestedScope: tokenScopes,
        resource: newAudience,
        props: decryptedProps
      };
      const callbackResult = await this.callTokenExchangeCallback(callbackOptions, env);
      if (crossClientExchange && callbackResult?.allowCrossClientExchange !== true) throw crossClientRejection();
      if (callbackResult) {
        let accessTokenProps = decryptedProps;
        if (callbackResult.newProps) {
          if (!callbackResult.accessTokenProps) accessTokenProps = callbackResult.newProps;
        }
        if (callbackResult.accessTokenProps) accessTokenProps = callbackResult.accessTokenProps;
        if (callbackResult.accessTokenTTL !== void 0) accessTokenTTL = Math.min(callbackResult.accessTokenTTL, subjectTokenRemainingLifetime);
        if (accessTokenProps !== decryptedProps) {
          const tokenResult = await encryptProps(accessTokenProps);
          encryptedAccessTokenProps = tokenResult.encryptedData;
          accessTokenEncryptionKey = tokenResult.key;
        }
        if (callbackResult.accessTokenScope) tokenScopes = this.downscope(callbackResult.accessTokenScope, tokenSummary.scope);
      }
    }
    if (!isValidAccessTokenTTL(accessTokenTTL)) throw new OAuthError("invalid_request", {
      description: "Requested token lifetime must be at least 60 seconds",
      internal: {
        category: "token-exchange-grant",
        reason: "requested_ttl_too_short"
      }
    });
    return {
      access_token: await this.createAccessToken({
        userId: tokenSummary.userId,
        grantId: tokenSummary.grantId,
        clientId: clientInfo.clientId,
        scope: tokenScopes,
        encryptedProps: encryptedAccessTokenProps,
        encryptionKey: accessTokenEncryptionKey,
        expiresIn: accessTokenTTL,
        audience: newAudience,
        env
      }),
      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      token_type: "bearer",
      expires_in: accessTokenTTL,
      scope: tokenScopes.join(" "),
      resource: newAudience
    };
  }
  /**
  * Handles OAuth 2.0 token exchange requests (RFC 8693)
  * Exchanges an existing access token for a new one with modified characteristics
  * @param body - The parsed request body
  * @param clientInfo - The authenticated client information
  * @param env - Cloudflare Worker environment variables
  * @returns Response with new token data or error
  */
  async handleTokenExchangeGrant(body, clientInfo, env) {
    const subjectToken = body.subject_token;
    const subjectTokenType = body.subject_token_type;
    const requestedTokenType = body.requested_token_type || "urn:ietf:params:oauth:token-type:access_token";
    const requestedScope = body.scope;
    const requestedResource = body.resource;
    if (!subjectToken) return this.createErrorResponse("invalid_request", { description: "subject_token is required" }, {
      category: "token-exchange-grant",
      reason: "subject_token_missing"
    });
    if (!subjectTokenType) return this.createErrorResponse("invalid_request", { description: "subject_token_type is required" }, {
      category: "token-exchange-grant",
      reason: "subject_token_type_missing"
    });
    if (subjectTokenType !== "urn:ietf:params:oauth:token-type:access_token") return this.createErrorResponse("invalid_request", { description: "Only access_token subject_token_type is supported" }, {
      category: "token-exchange-grant",
      reason: "subject_token_type_unsupported"
    });
    if (requestedTokenType !== "urn:ietf:params:oauth:token-type:access_token") return this.createErrorResponse("invalid_request", { description: "Only access_token requested_token_type is supported" }, {
      category: "token-exchange-grant",
      reason: "requested_token_type_unsupported"
    });
    let requestedScopes;
    if (requestedScope) if (typeof requestedScope === "string") requestedScopes = requestedScope.split(" ").filter(Boolean);
    else if (Array.isArray(requestedScope)) requestedScopes = requestedScope;
    else return this.createErrorResponse("invalid_request", { description: "Invalid scope parameter format" }, {
      category: "token-exchange-grant",
      reason: "scope_malformed"
    });
    let expiresIn;
    if (body.expires_in !== void 0) {
      const requestedTTL = parseInt(body.expires_in, 10);
      if (isNaN(requestedTTL) || requestedTTL <= 0) return this.createErrorResponse("invalid_request", { description: "Invalid expires_in parameter" }, {
        category: "token-exchange-grant",
        reason: "expires_in_invalid"
      });
      expiresIn = requestedTTL;
    }
    try {
      const tokenResponse = await this.exchangeToken(subjectToken, requestedScopes, requestedResource, expiresIn, clientInfo, env);
      return new Response(JSON.stringify(tokenResponse), { headers: {
        "Content-Type": "application/json",
        ...NO_CACHE_HEADERS
      } });
    } catch (error) {
      const response = this.createOAuthErrorResponse(error);
      if (response) return response;
      throw error;
    }
  }
  /**
  * Handles the MCP Enterprise-Managed Authorization JWT-bearer grant.
  *
  * Acts as a thin shell around `runEmaPipeline`: gate non-EMA traffic, run
  * the pipeline, translate the typed `EmaValidationError` Result back to a
  * standard OAuth wire response. All validation logic lives in pure
  * functions in `src/ema/`.
  */
  async handleJwtBearerGrant(body, clientInfo, clientAuthMethod, env, requestUrl, request) {
    const enterpriseOptions = this.options.enterpriseManagedAuthorization;
    if (!enterpriseOptions) return this.createErrorResponse("unsupported_grant_type", { description: "Grant type not supported" }, {
      category: "enterprise-managed-authorization",
      reason: "grant_disabled"
    });
    if (clientAuthMethod === "none" && !enterpriseOptions.allowPublicClients) return this.createErrorResponse("invalid_client", {
      description: "Enterprise-managed authorization requires client authentication",
      statusCode: 401
    }, {
      category: "enterprise-managed-authorization",
      reason: "client_authentication_required"
    });
    const result = await this.runEmaPipeline({
      body,
      clientInfo,
      env,
      requestUrl,
      request,
      enterpriseOptions
    });
    if (!result.ok) {
      const wire = emaErrorToWire(result.error);
      return this.createErrorResponse(wire.code, { description: wire.message }, {
        category: "enterprise-managed-authorization",
        reason: result.error.reason,
        detail: result.error
      });
    }
    return new Response(JSON.stringify(result.value), { headers: {
      "Content-Type": "application/json",
      ...NO_CACHE_HEADERS
    } });
  }
  /**
  * Runs the full EMA token-request pipeline as a chain of pure validators
  * and adapter calls. Each step short-circuits on the first failure.
  *
  * Sequence:
  *   parse → validate header → trust issuer → fetch JWKS → select key →
  *   verify signature → validate claims → record jti → parse scope →
  *   run mapper → validate mapper result → compute TTL → mint token.
  */
  async runEmaPipeline(args) {
    const { body, clientInfo, env, requestUrl, request, enterpriseOptions } = args;
    const { jwksProvider, jtiStore } = this;
    const configuredResource = this.resolveNewTokenResource(body.resource);
    if (!jwksProvider || !jtiStore) throw new Error("EMA pipeline invoked without configured adapters");
    const now = Math.floor(Date.now() / 1e3);
    const parsed = parseIdJag(body.assertion, EMA_MAX_JWT_BYTES);
    if (!parsed.ok) return parsed;
    const header = validateIdJagHeader(parsed.value.header, EMA_ID_JAG_JWT_TYPE, EMA_SUPPORTED_JWT_ALGORITHMS);
    if (!header.ok) return header;
    const alg = header.value.alg;
    const trustedIssuer = await resolveTrustedIssuer({
      iss: parsed.value.rawClaims.iss,
      alg,
      resolver: enterpriseOptions.trustedIssuers,
      env,
      request,
      clientInfo
    });
    if (!trustedIssuer.ok) return trustedIssuer;
    const verified = await this.verifyAssertionSignature({
      parsed: parsed.value,
      header: header.value,
      trustedIssuer: trustedIssuer.value,
      jwksProvider,
      now
    });
    if (!verified.ok) return verified;
    const claims = validateIdJagClaims({
      rawClaims: parsed.value.rawClaims,
      trustedIssuer: trustedIssuer.value,
      expectedAudience: trustedIssuer.value.audience ?? this.getAuthorizationServerIssuer(requestUrl),
      clientId: clientInfo.clientId,
      configuredResource,
      now,
      clockSkewSeconds: enterpriseOptions.clockSkewSeconds ?? EMA_DEFAULT_CLOCK_SKEW_SECONDS,
      maxAssertionLifetimeSeconds: enterpriseOptions.maxAssertionLifetimeSeconds ?? EMA_DEFAULT_MAX_ASSERTION_LIFETIME_SECONDS
    });
    if (!claims.ok) return claims;
    const markNow = Math.floor(Date.now() / 1e3);
    const replay = await jtiStore.markUsed({
      issuer: claims.value.claims.iss,
      jti: claims.value.claims.jti,
      exp: claims.value.claims.exp,
      now: markNow,
      env
    });
    if (!replay.ok) return replay;
    const requestedScope = parseEmaScopeParam(body.scope, claims.value.assertionScopes);
    if (!requestedScope.ok) return requestedScope;
    let mapperOutput;
    try {
      mapperOutput = await enterpriseOptions.mapClaims({
        claims: claims.value.claims,
        clientInfo,
        resource: configuredResource,
        requestedScope: requestedScope.value,
        request: args.request,
        env
      });
    } catch {
      return err({ reason: "mapper_threw" });
    }
    const mapped = validateEmaMapperResult(mapperOutput);
    if (!mapped.ok) return mapped;
    const issueNow = Math.floor(Date.now() / 1e3);
    const ttl = computeEmaAccessTokenTTL({
      configuredDefaultSeconds: this.options.accessTokenTTL ?? DEFAULT_ACCESS_TOKEN_TTL,
      assertionExp: claims.value.claims.exp,
      mapperTtl: mapped.value.accessTokenTTL,
      now: issueNow,
      minTtlSeconds: KV_MIN_EXPIRATION_TTL_SECONDS
    });
    if (!ttl.ok) return ttl;
    return ok(await this.issueEmaAccessToken({
      clientId: clientInfo.clientId,
      userId: mapped.value.userId,
      mapperScope: mapped.value.scope,
      mapperProps: mapped.value.props,
      mapperMetadata: mapped.value.metadata,
      assertionScopes: claims.value.assertionScopes,
      resource: configuredResource,
      accessTokenTTLSeconds: ttl.value,
      env,
      now: issueNow
    }));
  }
  /**
  * Verifies the ID-JAG signature against the trusted issuer's JWKS,
  * force-refreshing once on a `kid` miss to accommodate IdP key rotation.
  * Uses the in-memory cached JWKS fetcher with anti-DoS cool-down.
  */
  async verifyAssertionSignature(args) {
    const alg = args.header.alg;
    const { jwksProvider } = args;
    const initialJwks = await jwksProvider.fetch(args.trustedIssuer, {
      forceRefresh: false,
      now: args.now
    });
    if (!initialJwks.ok) return initialJwks;
    let jwk = selectJwk(initialJwks.value, alg, args.header.kid);
    if (!jwk.ok && args.header.kid) {
      const refreshed = await jwksProvider.fetch(args.trustedIssuer, {
        forceRefresh: true,
        now: args.now
      });
      if (!refreshed.ok) return refreshed;
      jwk = selectJwk(refreshed.value, alg, args.header.kid);
    }
    if (!jwk.ok) return jwk;
    if (!await verifyIdJagSignature({
      alg,
      jwk: jwk.value,
      signingInput: args.parsed.signingInput,
      signature: args.parsed.signature
    })) return err({ reason: "signature_failed" });
    return ok(void 0);
  }
  /**
  * Mints the access token for an authorized EMA request.
  *
  * Uses the same grant + access-token machinery as the authorization-code
  * grant: encrypt the props, persist the grant under `grant:userId:grantId`,
  * and create an opaque access token bound to the resource as audience.
  */
  async issueEmaAccessToken(args) {
    const tokenScopes = args.assertionScopes.length > 0 ? this.downscope(args.mapperScope, args.assertionScopes) : args.mapperScope;
    const grantId = generateRandomString(16);
    const { encryptedData, key: encryptionKey } = await encryptProps(args.mapperProps);
    const grant = {
      id: grantId,
      clientId: args.clientId,
      userId: args.userId,
      scope: tokenScopes,
      metadata: args.mapperMetadata ?? null,
      encryptedProps: encryptedData,
      createdAt: args.now,
      expiresAt: args.now + args.accessTokenTTLSeconds,
      resource: args.resource
    };
    await this.saveGrantWithTTL(args.env, `grant:${args.userId}:${grantId}`, grant, args.now);
    return {
      access_token: await this.createAccessToken({
        userId: args.userId,
        grantId,
        clientId: args.clientId,
        scope: tokenScopes,
        encryptedProps: encryptedData,
        encryptionKey,
        expiresIn: args.accessTokenTTLSeconds,
        audience: args.resource,
        env: args.env
      }),
      token_type: "bearer",
      expires_in: args.accessTokenTTLSeconds,
      scope: tokenScopes.join(" "),
      resource: args.resource
    };
  }
  /**
  * Handles an RFC 7009 revocation request from an authenticated client.
  * - Access tokens: Revokes only the specific token
  * - Refresh tokens: Revokes the entire grant (access + refresh tokens)
  * Per RFC 7009 §2.1, the server MUST verify the token was issued to the client making the request.
  * @param body - The parsed request body containing token parameter
  * @param clientInfo - The authenticated client information
  * @param env - Cloudflare Worker environment variables
  * @returns Response confirming revocation or error
  */
  async revokeToken(body, clientInfo, env) {
    const token = body.token;
    const tokenTypeHint = body.token_type_hint;
    if (!token) return this.createErrorResponse("invalid_request", { description: "Token parameter is required" }, {
      category: "token-revocation",
      reason: "token_missing"
    });
    const tokenParts = token.split(":");
    if (tokenParts.length !== 3) return new Response("", { status: 200 });
    const [userId, grantId, _] = tokenParts;
    const tokenId = await generateTokenId(token);
    if (tokenTypeHint === "refresh_token") {
      if (await this.revokeRefreshIfOwned(tokenId, userId, grantId, clientInfo, env)) return new Response("", { status: 200 });
      if (await this.revokeAccessIfOwned(tokenId, userId, grantId, clientInfo, env)) return new Response("", { status: 200 });
    } else {
      if (await this.revokeAccessIfOwned(tokenId, userId, grantId, clientInfo, env)) return new Response("", { status: 200 });
      if (await this.revokeRefreshIfOwned(tokenId, userId, grantId, clientInfo, env)) return new Response("", { status: 200 });
    }
    return new Response("", { status: 200 });
  }
  /** Revoke an access token if it exists and belongs to the requesting client. */
  async revokeAccessIfOwned(tokenId, userId, grantId, clientInfo, env) {
    const tokenData = await env.OAUTH_KV.get(`token:${userId}:${grantId}:${tokenId}`, { type: "json" });
    if (!tokenData) return false;
    const tokenClientId = tokenData.grant?.clientId;
    if (tokenClientId !== void 0) {
      if (tokenClientId !== clientInfo.clientId) return false;
    } else if ((await env.OAUTH_KV.get(`grant:${userId}:${grantId}`, { type: "json" }))?.clientId !== clientInfo.clientId) return false;
    await this.revokeSpecificAccessToken(tokenId, userId, grantId, env);
    return true;
  }
  /** Revoke a refresh token (and its grant) if it exists and belongs to the requesting client. */
  async revokeRefreshIfOwned(tokenId, userId, grantId, clientInfo, env) {
    const grantData = await env.OAUTH_KV.get(`grant:${userId}:${grantId}`, { type: "json" });
    if (!grantData) return false;
    if (!(grantData.refreshTokenId === tokenId || grantData.previousRefreshTokenId === tokenId)) return false;
    if (grantData.clientId !== clientInfo.clientId) return false;
    await this.createOAuthHelpers(env).revokeGrant(grantId, userId);
    return true;
  }
  /**
  * Revokes a specific access token without affecting the refresh token
  * @param tokenId - The hashed token ID
  * @param userId - The user ID extracted from the token
  * @param grantId - The grant ID extracted from the token
  * @param env - Cloudflare Worker environment variables
  */
  async revokeSpecificAccessToken(tokenId, userId, grantId, env) {
    const tokenKey = `token:${userId}:${grantId}:${tokenId}`;
    await env.OAUTH_KV.delete(tokenKey);
  }
  /**
  * Handles the dynamic client registration endpoint (RFC 7591)
  * @param request - The HTTP request
  * @param env - Cloudflare Worker environment variables
  * @returns Response with client registration data or error
  */
  async handleClientRegistration(request, env) {
    if (!this.options.clientRegistrationEndpoint) return this.createErrorResponse("not_implemented", {
      description: "Client registration is not enabled",
      statusCode: 501
    }, {
      category: "client-registration",
      reason: "registration_disabled"
    });
    if (request.method !== "POST") return this.createErrorResponse("invalid_request", {
      description: "Method not allowed",
      statusCode: 405,
      headers: { Allow: "POST, OPTIONS" }
    }, {
      category: "client-registration",
      reason: "method_not_allowed"
    });
    if (parseInt(request.headers.get("Content-Length") || "0", 10) > 1048576) return this.createErrorResponse("invalid_request", {
      description: "Request payload too large, must be under 1 MiB",
      statusCode: 413
    }, {
      category: "client-registration",
      reason: "declared_payload_too_large"
    });
    const callbackRequest = request.clone();
    let parsedJson;
    try {
      const text = await readTextWithLimit(request, 1048576);
      if (text === void 0) {
        callbackRequest.body?.cancel().catch(() => void 0);
        return this.createErrorResponse("invalid_request", {
          description: "Request payload too large, must be under 1 MiB",
          statusCode: 413
        }, {
          category: "client-registration",
          reason: "payload_too_large"
        });
      }
      parsedJson = JSON.parse(text);
    } catch {
      return this.createErrorResponse("invalid_request", {
        description: "Invalid JSON payload",
        statusCode: 400
      }, {
        category: "client-registration",
        reason: "json_malformed"
      });
    }
    let clientMetadata;
    let metadata;
    try {
      clientMetadata = requireJsonObject(parsedJson);
      const capabilities = this.options.disallowPublicClientRegistration ? {
        ...this.serverCapabilities,
        tokenEndpointAuthMethods: this.serverCapabilities.tokenEndpointAuthMethods.filter((method) => method !== "none")
      } : this.serverCapabilities;
      metadata = resolveDynamicClientRegistrationMetadata(clientMetadata, capabilities);
    } catch (error) {
      if (this.options.disallowPublicClientRegistration && wouldRegisterPublicClient(clientMetadata, this.serverCapabilities)) return this.createErrorResponse("invalid_client_metadata", { description: "Public client registration is not allowed" }, {
        category: "client-registration",
        reason: "public_client_forbidden"
      });
      return this.createErrorResponse("invalid_client_metadata", { description: error instanceof Error ? error.message : "Invalid client metadata" }, {
        category: "client-registration",
        reason: "metadata_invalid",
        detail: error
      });
    }
    const authMethod = metadata.tokenEndpointAuthMethod;
    const isPublicClient = authMethod === "none";
    const clientId = generateRandomString(16);
    let clientSecret;
    let hashedSecret;
    if (!isPublicClient) {
      clientSecret = generateRandomString(32);
      hashedSecret = await hashSecret(clientSecret);
    }
    const clientInfo = {
      clientId,
      redirectUris: metadata.redirectUris,
      clientName: metadata.clientName,
      logoUri: metadata.logoUri,
      clientUri: metadata.clientUri,
      policyUri: metadata.policyUri,
      tosUri: metadata.tosUri,
      jwksUri: metadata.jwksUri,
      i18n: metadata.i18n,
      contacts: metadata.contacts,
      grantTypes: metadata.grantTypes,
      responseTypes: metadata.responseTypes,
      registrationDate: Math.floor(Date.now() / 1e3),
      tokenEndpointAuthMethod: authMethod,
      ...metadata.authMethodExplicit ? { authMethodExplicit: true } : {},
      ...!isPublicClient && hashedSecret ? { clientSecret: hashedSecret } : {}
    };
    if (this.options.clientRegistrationCallback) {
      let callbackResult;
      try {
        callbackResult = await Promise.resolve(this.options.clientRegistrationCallback({
          clientMetadata,
          request: callbackRequest
        }));
      } catch (error) {
        return this.createErrorResponse("server_error", {
          description: "Client registration callback failed",
          statusCode: 500
        }, {
          category: "client-registration",
          reason: "callback_failed",
          detail: error
        });
      }
      if (callbackResult !== void 0) return this.createErrorResponse(callbackResult.code || "invalid_client_metadata", {
        description: callbackResult.description || "Client registration denied",
        statusCode: callbackResult.status ?? 400
      }, {
        category: "client-registration",
        reason: "callback_denied",
        detail: callbackResult
      });
    }
    await this.putRegisteredClient(env, clientInfo, clientInfo.registrationDate);
    const response = {
      client_id: clientInfo.clientId,
      redirect_uris: clientInfo.redirectUris,
      client_name: clientInfo.clientName,
      logo_uri: clientInfo.logoUri,
      client_uri: clientInfo.clientUri,
      policy_uri: clientInfo.policyUri,
      tos_uri: clientInfo.tosUri,
      jwks_uri: clientInfo.jwksUri,
      contacts: clientInfo.contacts,
      grant_types: clientInfo.grantTypes,
      response_types: clientInfo.responseTypes,
      token_endpoint_auth_method: clientInfo.tokenEndpointAuthMethod,
      client_id_issued_at: clientInfo.registrationDate
    };
    if (clientInfo.i18n) {
      for (const [key2, value] of Object.entries(clientInfo.i18n)) if (!(key2 in response)) response[key2] = value;
    }
    if (clientSecret) {
      response.client_secret = clientSecret;
      response.client_secret_expires_at = this.options.clientRegistrationTTL !== void 0 && clientInfo.registrationDate ? clientInfo.registrationDate + this.options.clientRegistrationTTL : 0;
      response.client_secret_issued_at = clientInfo.registrationDate;
    }
    return new Response(JSON.stringify(response), {
      status: 201,
      headers: {
        "Content-Type": "application/json",
        ...NO_CACHE_HEADERS
      }
    });
  }
  /**
  * Handles API requests by validating the access token and calling the API handler
  * @param request - The HTTP request
  * @param env - Cloudflare Worker environment variables
  * @param ctx - Cloudflare Worker execution context
  * @returns Response from the API handler or error
  */
  async handleApiRequest(request, env, ctx, apiRoute) {
    const url = new URL(request.url);
    const { resourceServer } = apiRoute;
    const configuredResource = resourceServer.resourceMetadata.resource;
    const externalTokenResolver = resourceServer.resolveExternalToken;
    const resourceMetadataUrl = this.getResourceMetadataUrlForRequest(url, resourceServer);
    const challenge = (error, description, scopes = []) => this.buildWwwAuthenticateHeader(resourceMetadataUrl, error, description, scopes, resourceServer);
    const authHeader = request.headers.get("Authorization");
    const bearerMatch = authHeader ? /^Bearer[\t ]+([^\s,]+)$/i.exec(authHeader) : null;
    if (!bearerMatch) return new Response(null, {
      status: 401,
      headers: {
        ...NO_CACHE_HEADERS,
        "WWW-Authenticate": challenge()
      }
    });
    const accessToken = bearerMatch[1];
    const parts = accessToken.split(":");
    const isPossiblyInternalFormat = parts.length === 3;
    let tokenData = null;
    let userId = "";
    let grantId = "";
    if (isPossiblyInternalFormat) {
      [userId, grantId] = parts;
      const id = await generateTokenId(accessToken);
      tokenData = await env.OAUTH_KV.get(`token:${userId}:${grantId}:${id}`, { type: "json" });
    }
    if (!tokenData && (!externalTokenResolver || isIssuedTokenFormat(accessToken))) return this.createErrorResponse("invalid_token", {
      description: "Invalid access token",
      statusCode: 401,
      headers: { "WWW-Authenticate": challenge("invalid_token") }
    }, {
      category: "protected-resource",
      reason: "token_not_found"
    });
    if (tokenData) {
      const tokenAudience = this.resolveStoredTokenAudience(tokenData.audience);
      if (!isExactResource(tokenAudience, configuredResource)) return this.createErrorResponse("invalid_token", {
        description: "Access token is not bound to the configured resource",
        statusCode: 401,
        headers: { "WWW-Authenticate": challenge("invalid_token") }
      }, {
        category: "protected-resource",
        reason: "token_audience_unbound"
      });
      const now = Math.floor(Date.now() / 1e3);
      if (tokenData.expiresAt < now) return this.createErrorResponse("invalid_token", {
        description: "Access token expired",
        statusCode: 401,
        headers: { "WWW-Authenticate": challenge("invalid_token") }
      }, {
        category: "protected-resource",
        reason: "token_expired"
      });
      if (tokenAudience) {
        const requestUrl = new URL(request.url);
        const resourceServer$1 = `${requestUrl.protocol}//${requestUrl.host}${requestUrl.pathname}${requestUrl.search}`;
        if (!(Array.isArray(tokenAudience) ? tokenAudience : [tokenAudience]).some((aud) => audienceMatches(resourceServer$1, aud))) return this.createErrorResponse("invalid_token", {
          description: "Token audience does not match resource server",
          statusCode: 401,
          headers: { "WWW-Authenticate": challenge("invalid_token", "Invalid audience") }
        }, {
          category: "protected-resource",
          reason: "audience_mismatch"
        });
      }
      ctx.props = await decryptProps(await unwrapKeyWithToken(accessToken, tokenData.wrappedEncryptionKey), tokenData.grant.encryptedProps);
      ctx.auth = {
        token: accessToken,
        audience: configuredResource,
        expiresAt: tokenData.expiresAt,
        scope: [...tokenData.scope || tokenData.grant.scope],
        userId: tokenData.userId,
        clientId: tokenData.grant.clientId
      };
    } else if (externalTokenResolver) {
      let ext;
      try {
        ext = await externalTokenResolver({
          token: accessToken,
          request,
          env
        });
      } catch (error) {
        const response = this.createExternalTokenErrorResponse(error, resourceMetadataUrl, resourceServer);
        if (response) return response;
        throw error;
      }
      if (!ext) return this.createErrorResponse("invalid_token", {
        description: "Invalid access token",
        statusCode: 401,
        headers: { "WWW-Authenticate": challenge("invalid_token") }
      }, {
        category: "protected-resource",
        reason: "external_token_rejected"
      });
      if (typeof ext.audience !== "string" || !isExactResource(ext.audience, configuredResource)) return this.createErrorResponse("invalid_token", {
        description: "External access token is not bound to the configured resource",
        statusCode: 401,
        headers: { "WWW-Authenticate": challenge("invalid_token") }
      }, {
        category: "protected-resource",
        reason: "external_audience_unbound"
      });
      if (ext.audience) {
        const requestUrl = new URL(request.url);
        const resourceServer$1 = `${requestUrl.protocol}//${requestUrl.host}${requestUrl.pathname}${requestUrl.search}`;
        if (!(Array.isArray(ext.audience) ? ext.audience : [ext.audience]).some((aud) => audienceMatches(resourceServer$1, aud))) return this.createErrorResponse("invalid_token", {
          description: "Token audience does not match resource server",
          statusCode: 401,
          headers: { "WWW-Authenticate": challenge("invalid_token", "Invalid audience") }
        }, {
          category: "protected-resource",
          reason: "external_audience_mismatch"
        });
      }
      ctx.props = ext.props;
      ctx.auth = {
        token: accessToken,
        audience: configuredResource,
        scope: []
      };
    }
    if (!env.OAUTH_PROVIDER) env.OAUTH_PROVIDER = this.createOAuthHelpers(env);
    const apiHandler = apiRoute.handler;
    if (apiHandler.type === HandlerType.EXPORTED_HANDLER) return apiHandler.handler.fetch(request, env, ctx);
    else return new apiHandler.handler(ctx, env).fetch(request);
  }
  /**
  * Creates the helper methods object for OAuth operations
  * This is passed to the handler functions to allow them to interact with the OAuth system
  * @param env - Cloudflare Worker environment variables
  * @returns An instance of OAuthHelpers
  */
  createOAuthHelpers(env) {
    return new OAuthHelpersImpl(env, this);
  }
  /**
  * Saves a grant to KV with appropriate TTL based on expiration
  * @param env - The environment bindings
  * @param grantKey - The KV key for the grant
  * @param grantData - The grant data to save
  * @param now - Current timestamp in seconds
  */
  async saveGrantWithTTL(env, grantKey, grantData, now) {
    const minExpiration = now + KV_MIN_EXPIRATION_TTL_SECONDS + KV_EXPIRATION_CLAMP_MARGIN_SECONDS;
    const kvOptions = grantData.expiresAt !== void 0 ? { expiration: Math.max(grantData.expiresAt, minExpiration) } : {};
    try {
      await env.OAUTH_KV.put(grantKey, JSON.stringify(grantData), grantPutOptions(grantData, kvOptions));
    } catch (error) {
      this.throwRetryableTokenStorageErrorIfKvRateLimited(error);
      throw error;
    }
  }
  throwRetryableTokenStorageErrorIfKvRateLimited(error) {
    if (!this.isKvRateLimitError(error)) return;
    throw new OAuthError("temporarily_unavailable", {
      description: "Token issuance is temporarily unavailable; retry shortly",
      statusCode: 429,
      headers: { "Retry-After": "30" },
      internal: {
        category: "token-issuance",
        reason: "kv_rate_limited",
        detail: error
      }
    });
  }
  isKvRateLimitError(error) {
    if (!(error instanceof Error)) return false;
    return /KV .*failed: 429 Too Many Requests/i.test(error.message) || /429 Too Many Requests/i.test(error.message);
  }
  /**
  * Fetches client information from KV storage or via CIMD (Client ID Metadata Document)
  * This method is not private because `OAuthHelpers` needs to call it. Note that since
  * `OAuthProviderImpl` is not exposed outside this module, this is still effectively
  * module-private.
  *
  * Supports CIMD: If clientId is an HTTPS URL with a non-root path, the metadata
  * document will be fetched from that URL instead of looking up in KV storage.
  *
  * @param env - Cloudflare Worker environment variables
  * @param clientId - The client ID to look up (can be a regular ID or an HTTPS URL for CIMD)
  * @returns The client information, or null if the client does not exist. Null means
  * definitive absence; failures to determine the answer throw instead (KV errors
  * propagate, and a CIMD metadata fetch failure throws `CimdFetchError`), so an
  * upstream outage is distinguishable from an unregistered client.
  */
  /**
  * Write a client record that is subject to `clientRegistrationTTL`. The record carries
  * the expiry it was written with, so a later token request can tell a registration the
  * provider may renew from a permanent one without listing KV. With the TTL unset the
  * record is written to last, and any stamp from an earlier configuration is dropped.
  */
  async putRegisteredClient(env, client, now) {
    const ttl = this.options.clientRegistrationTTL;
    const { registrationExpiresAt: _previous, ...record } = client;
    if (ttl === void 0) {
      await env.OAUTH_KV.put(`client:${client.clientId}`, JSON.stringify(record));
      return;
    }
    await env.OAUTH_KV.put(`client:${client.clientId}`, JSON.stringify({
      ...record,
      registrationExpiresAt: now + ttl
    }), { expirationTtl: ttl });
  }
  /**
  * Renew a dynamically registered client whose registration has passed half of
  * `clientRegistrationTTL`, so a client still exchanging tokens does not vanish from
  * under its live grants. Without this, a grant that outlives its registration fails
  * every refresh with `invalid_client` although nothing was revoked. Only records
  * stamped with `registrationExpiresAt` qualify: CIMD clients are never stored,
  * `createClient()` records never expire, and a record from before the stamp existed
  * cannot be told from a permanent one, so it keeps its original schedule and
  * re-registers once. The half-life rule bounds this to one write per client per half
  * TTL. Best effort: the token response it follows has already been produced.
  *
  * KV has no compare-and-set, so a `deleteClient()` that lands between the read below and
  * the write is undone by it, as it would be by a concurrent `updateClient()`. The window
  * is one KV round trip, once per client per half TTL; closing it needs the serialised
  * storage of #237.
  */
  async renewClientRegistrationIfDue(env, client, now) {
    const ttl = this.options.clientRegistrationTTL;
    if (ttl === void 0 || client.registrationExpiresAt === void 0) return;
    if (client.registrationExpiresAt - now > ttl / 2) return;
    try {
      const current = await env.OAUTH_KV.get(`client:${client.clientId}`, { type: "json" });
      if (current) await this.putRegisteredClient(env, current, now);
    } catch (error) {
      console.warn(`Failed to renew client registration ${client.clientId}:`, error);
    }
  }
  async getClient(env, clientId) {
    if (isClientIdMetadataDocumentUrl(clientId)) {
      if (!this.options.clientIdMetadataDocumentEnabled) {
        const clientKey$1 = `client:${clientId}`;
        return env.OAUTH_KV.get(clientKey$1, { type: "json" });
      }
      if (!this.hasGlobalFetchStrictlyPublic()) throw new Error(`CIMD is enabled but 'global_fetch_strictly_public' compatibility flag is not set.`);
      try {
        return await fetchClientIdMetadataDocument(clientId, this.serverCapabilities);
      } catch (error) {
        console.warn(`CIMD fetch failed for ${clientId}:`, error instanceof Error ? error.message : error);
        throw new CimdFetchError(clientId, error);
      }
    }
    const clientKey = `client:${clientId}`;
    return env.OAUTH_KV.get(clientKey, { type: "json" });
  }
  /** Resolve a value to the registry's canonical spelling, requiring one value. */
  /**
  * Resolve a stored grant or token resource. A 0.x record may hold an array; it resolves
  * when exactly one configured resource appears in it, so multi-audience grants for two
  * resources this server still hosts are ambiguous and fail closed.
  */
  findStoredConfiguredResource(value) {
    if (!Array.isArray(value)) return this.findConfiguredResource(value);
    const matches = /* @__PURE__ */ new Set();
    for (const entry of value) {
      const configured = this.findConfiguredResource(entry);
      if (configured) matches.add(configured);
    }
    return matches.size === 1 ? [...matches][0] : void 0;
  }
  findConfiguredResource(value) {
    const distinct = Array.isArray(value) ? [...new Set(value)] : [value];
    const singular = distinct.length === 1 ? distinct[0] : void 0;
    if (typeof singular !== "string" || !validateResourceUri(singular)) return void 0;
    return this.resourceServers.map((server) => server.resourceMetadata.resource).find((configured) => isExactResource(singular, configured));
  }
  /**
  * Resolve a client-supplied RFC 8707 resource indicator to a configured resource.
  *
  * An exact match wins. Otherwise a request may name the URL it uses at the resource
  * when that URL differs from a configured resource only by query parameters the
  * configured resource does not constrain, such as `https://mcp.example.com/mcp?mode=x`
  * for `https://mcp.example.com/mcp`. The resource server already treats that URL as
  * covered by the resource (its 401 points at the resource's metadata, and the
  * resource's tokens are accepted there), and RFC 8707 §2.2 lets the authorization
  * server map a requested value to a more general resource. The audience stays the
  * configured resource, so the token is no broader. See {@link findCoveringResource}.
  * Only client requests use this; stored audiences and configuration stay exact.
  */
  findRequestedResource(value) {
    const exact = this.findConfiguredResource(value);
    if (exact) return exact;
    const distinct = Array.isArray(value) ? [...new Set(value)] : [value];
    const singular = distinct.length === 1 ? distinct[0] : void 0;
    if (typeof singular !== "string" || !validateResourceUri(singular)) return void 0;
    return findCoveringResource(singular, this.resourceServers.map((server) => server.resourceMetadata.resource));
  }
  /** Select the audience for a new interactive authorization. */
  resolveAuthorizationRequestResource(requestedResource) {
    if (requestedResource === void 0) {
      const defaultResource = this.getDefaultAuthorizationResource();
      if (defaultResource) return defaultResource;
      throw new AuthorizationError("invalid_target", { description: "The resource parameter is required when the authorization server has multiple resources" });
    }
    const configured = this.findRequestedResource(requestedResource);
    if (!configured) throw new AuthorizationError("invalid_target", { description: "The resource parameter must name exactly one configured protected resource" });
    return configured;
  }
  /** Whether an existing grant belongs to the replacement bucket for a resource. */
  shouldReplaceGrantForResource(grantResource, resource) {
    if (grantResource === void 0) return this.getLegacyGrantResource() === resource;
    return isExactResource(grantResource, resource);
  }
  /** Select the audience for a new non-interactive grant such as EMA. */
  resolveNewTokenResource(requestedResource) {
    try {
      return this.resolveAuthorizationRequestResource(requestedResource);
    } catch (error) {
      if (error instanceof AuthorizationError) throw new OAuthError("invalid_target", {
        description: error.description,
        internal: {
          category: "resource-indicator",
          reason: "resource_invalid",
          detail: error
        }
      });
      throw error;
    }
  }
  /** Validate explicit resource syntax and configured-resource policy. */
  validateTokenRequestResourceIndicator(requestedResource) {
    if (requestedResource === void 0) return;
    if (!this.findRequestedResource(requestedResource)) throw new OAuthError("invalid_target", {
      description: "The resource parameter must name exactly one configured protected resource",
      internal: {
        category: "resource-indicator",
        reason: "resource_not_configured"
      }
    });
  }
  /** Resolve token exchange strictly within the subject token's audience ceiling. */
  resolveTokenExchangeResource(requestedResource, subjectResource) {
    const subjectAudience = this.findStoredConfiguredResource(this.resolveStoredTokenAudience(subjectResource));
    if (!subjectAudience) throw new OAuthError("invalid_target", {
      description: "Subject token is not bound to a configured resource",
      internal: {
        category: "resource-indicator",
        reason: "subject_token_audience_unbound"
      }
    });
    const resourceWasProvided = requestedResource !== void 0;
    const requestedAudience = resourceWasProvided ? this.findRequestedResource(requestedResource) : void 0;
    if (resourceWasProvided && (!requestedAudience || requestedAudience !== subjectAudience)) throw new OAuthError("invalid_target", {
      description: "The requested resource must exactly match the subject token audience",
      internal: {
        category: "resource-indicator",
        reason: "resource_subject_token_mismatch"
      }
    });
    return subjectAudience;
  }
  /**
  * Resolves an access-token audience from a token request and its authorization grant.
  * The configured canonical resource is inherited when omitted and cannot be overridden.
  */
  resolveTokenResource(requestedResource, grant) {
    const grantedResource = grant.resource;
    const resourceWasProvided = requestedResource !== void 0;
    const grantResourceWasStored = grantedResource !== void 0;
    const canonicalGrantResource = this.findStoredConfiguredResource(grantedResource);
    const canonicalRequestedResource = resourceWasProvided ? this.findRequestedResource(requestedResource) : void 0;
    if (grantResourceWasStored && !canonicalGrantResource) throw new OAuthError("invalid_grant", {
      description: "The authorization grant is not bound to a configured resource",
      internal: {
        category: "resource-indicator",
        reason: "grant_audience_unbound"
      }
    });
    if (canonicalGrantResource) {
      if (resourceWasProvided && canonicalRequestedResource !== canonicalGrantResource) throw new OAuthError("invalid_target", {
        description: "The requested resource does not match the authorization grant",
        internal: {
          category: "resource-indicator",
          reason: "resource_grant_mismatch"
        }
      });
      return {
        audience: canonicalGrantResource,
        ...grantedResource === canonicalGrantResource ? {} : { grantResourceBackfill: canonicalGrantResource }
      };
    }
    const legacyGrantResource = this.getLegacyGrantResource();
    if (!legacyGrantResource) throw new OAuthError("invalid_grant", {
      description: "This legacy authorization grant has no resource binding and must be reauthorized",
      internal: {
        category: "resource-indicator",
        reason: "legacy_grant_unbound"
      }
    });
    if (resourceWasProvided && canonicalRequestedResource !== legacyGrantResource) throw new OAuthError("invalid_target", {
      description: "The requested resource does not match the server legacy-grant migration policy",
      internal: {
        category: "resource-indicator",
        reason: "legacy_grant_resource_mismatch"
      }
    });
    return {
      audience: legacyGrantResource,
      grantResourceBackfill: legacyGrantResource
    };
  }
  /**
  * Creates and stores an access token
  * @param params - Options for creating the access token
  * @returns The access token string
  */
  async createAccessToken(params) {
    const { userId, grantId, clientId, scope, encryptedProps, encryptionKey, expiresIn, audience, env } = params;
    if (!isValidAccessTokenTTL(expiresIn)) throw new OAuthError("invalid_request", {
      description: "Requested token lifetime must be at least 60 seconds",
      internal: {
        category: "token-issuance",
        reason: "requested_ttl_too_short"
      }
    });
    const accessToken = `${userId}:${grantId}:${generateRandomString(TOKEN_LENGTH)}`;
    const now = Math.floor(Date.now() / 1e3);
    const accessTokenId = await generateTokenId(accessToken);
    const accessTokenData = {
      id: accessTokenId,
      grantId,
      userId,
      createdAt: now,
      expiresAt: now + expiresIn,
      audience,
      scope,
      wrappedEncryptionKey: await wrapKeyWithToken(accessToken, encryptionKey),
      grant: {
        clientId,
        scope,
        encryptedProps
      }
    };
    try {
      await env.OAUTH_KV.put(`token:${userId}:${grantId}:${accessTokenId}`, JSON.stringify(accessTokenData), { expirationTtl: expiresIn });
    } catch (error) {
      this.throwRetryableTokenStorageErrorIfKvRateLimited(error);
      throw error;
    }
    return accessToken;
  }
  /**
  * Restricts requested scopes to the scopes available for the current flow.
  * If no scope is requested, all available scopes are returned.
  * @param requestedScope - The scope parameter from the request (string or array)
  * @param allowedScopes - The maximum scopes available for the current flow
  * @returns The requested scopes that are included in the allowed scopes
  */
  downscope(requestedScope, allowedScopes) {
    if (!requestedScope) return allowedScopes;
    return (typeof requestedScope === "string" ? requestedScope.split(" ").filter(Boolean) : requestedScope).filter((scope) => allowedScopes.includes(scope));
  }
  /**
  * Checks if the global_fetch_strictly_public compatibility flag is enabled.
  * This flag is required for CIMD to prevent SSRF attacks.
  * See: https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public
  */
  hasGlobalFetchStrictlyPublic() {
    return !!(typeof Cloudflare !== "undefined" && Cloudflare.compatibilityFlags ? Cloudflare.compatibilityFlags : null)?.global_fetch_strictly_public;
  }
  /**
  * Builds a WWW-Authenticate header value with resource_metadata per RFC 9728 §5.1
  */
  buildWwwAuthenticateHeader(resourceMetadataUrl, error, errorDescription, requiredScopes = [], resourceServer = this.resourceServers[0]) {
    let header = 'Bearer realm="OAuth"';
    if (resourceMetadataUrl) header += `, resource_metadata="${resourceMetadataUrl}"`;
    if (error) header += `, error="${error}"`;
    const challengeScopes = requiredScopes.length > 0 ? this.normalizeProtectedResourceScopes(requiredScopes) : this.getProtectedResourceScopes(resourceServer);
    if (challengeScopes.length > 0) header += `, scope="${challengeScopes.join(" ")}"`;
    if (errorDescription) header += `, error_description="${errorDescription}"`;
    return header;
  }
  /** Build the RFC 9728 well-known URL for the configured canonical resource. */
  getConfiguredResourceMetadataUrl(resource) {
    const authorityStart = resource.indexOf("://") + 3;
    const suffixOffset = resource.slice(authorityStart).search(/[/?]/);
    const suffixStart = suffixOffset === -1 ? resource.length : authorityStart + suffixOffset;
    let suffix = resource.slice(suffixStart);
    if (suffix === "/") suffix = "";
    if (suffix.startsWith("/?")) suffix = suffix.slice(1);
    return resource.slice(0, suffixStart) + PROTECTED_RESOURCE_WELL_KNOWN_PREFIX + suffix;
  }
  /**
  * RFC 9728 §3.3 requires metadata fetched from a challenge to identify the
  * original protected-resource URL. Descendant and alias routes can still use
  * a base audience, but must not advertise a document for a different URL.
  */
  getResourceMetadataUrlForRequest(requestUrl, resourceServer) {
    const configuredResource = resourceServer.resourceMetadata.resource;
    if (isExactResource(requestUrl.href, configuredResource)) return this.getConfiguredResourceMetadataUrl(configuredResource);
    const resourceUrl = new URL(configuredResource);
    if (requestUrl.origin === resourceUrl.origin && requestCarriesResourceQuery(requestUrl, resourceUrl) && isPathDescendant(requestUrl.pathname, resourceUrl.pathname)) return this.getConfiguredResourceMetadataUrl(configuredResource);
  }
  /**
  * Helper function to create OAuth error responses.
  *
  * `internal` (optional) carries a tagged, server-side-only reason. It is
  * forwarded to the deployer's `onError` hook but never placed on the wire,
  * so the public response stays RFC-compliant and free of information leak
  * while the deployer can still observe which check failed.
  */
  createErrorResponse(code, options, internal, request) {
    const { description } = options;
    const responseStatus = options.statusCode ?? 400;
    const responseHeaders = {
      ...NO_CACHE_HEADERS,
      ...options.headers ?? {}
    };
    const customErrorResponse = this.options.onError?.({
      code,
      description,
      status: responseStatus,
      headers: responseHeaders,
      internal,
      ...request ? { request } : {}
    });
    const body = JSON.stringify({
      error: code,
      error_description: description
    });
    const response = customErrorResponse ?? new Response(body, {
      status: responseStatus,
      headers: {
        "Content-Type": "application/json",
        ...responseHeaders
      }
    });
    this.errorResponses.add(response);
    return response;
  }
};
var ExternalTokenError = class extends Error {
  /**
  * Creates an intentional external-token validation error.
  * @param code - Standard OAuth error code to return
  * @param options - Public response details
  */
  constructor(code, options) {
    super(options.description);
    this.name = "ExternalTokenError";
    this.code = code;
    this.description = options.description;
    this.statusCode = options.statusCode;
    this.headers = options.headers;
    this.requiredScopes = options.requiredScopes;
  }
};
var CimdFetchError = class extends Error {
  /**
  * Creates an error for a failed CIMD fetch or validation.
  * @param metadataUrl - The CIMD URL that could not be resolved
  * @param cause - The underlying fetch or validation failure
  */
  constructor(metadataUrl, cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`CIMD fetch failed for ${metadataUrl}: ${detail}`);
    this.reason = "metadata_resolution_failed";
    this.name = "CimdFetchError";
    this.metadataUrl = metadataUrl;
    this.detail = detail;
  }
};
var DEFAULT_ACCESS_TOKEN_TTL = 3600;
var DEFAULT_REFRESH_TOKEN_TTL = 720 * 60 * 60;
var DEFAULT_CLIENT_REGISTRATION_TTL = 2160 * 60 * 60;
var KV_MIN_EXPIRATION_TTL_SECONDS = 60;
function wouldRegisterPublicClient(clientMetadata, server) {
  if (!clientMetadata) return false;
  try {
    return resolveDynamicClientRegistrationMetadata(clientMetadata, server).tokenEndpointAuthMethod === "none";
  } catch {
    return false;
  }
}
function withRequiredScopes(metadata, requiredScopes) {
  if (!metadata || typeof metadata !== "object") return metadata;
  const { scopes_supported: deprecated, ...rest } = metadata;
  const scopes = resolveRequiredScopes(requiredScopes, deprecated);
  return scopes === void 0 ? rest : {
    ...rest,
    scopes_supported: scopes
  };
}
function isValidRefreshTokenTTL(ttl) {
  return ttl === 0 || isValidAccessTokenTTL(ttl);
}
function parsePurgeCursor(cursor) {
  if (cursor === void 0) return { phase: "grants" };
  const separator = cursor.indexOf(":");
  const phase = cursor.slice(0, separator);
  if (separator < 0 || phase !== "grants" && phase !== "tokens") throw new TypeError("Invalid purgeExpiredData cursor");
  const kvCursor = cursor.slice(separator + 1);
  return kvCursor ? {
    phase,
    kvCursor
  } : { phase };
}
function grantsNoneOfTheRequestedScopes(requested, granted) {
  return (typeof requested === "string" ? requested.split(" ").filter(Boolean) : requested ?? []).length > 0 && granted.length === 0;
}
async function readTextWithLimit(request, maxBytes) {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let total = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel().catch(() => void 0);
      return;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
function isValidAccessTokenTTL(value) {
  return Number.isInteger(value) && value >= KV_MIN_EXPIRATION_TTL_SECONDS;
}
var KV_EXPIRATION_CLAMP_MARGIN_SECONDS = 5;
var DEFAULT_PURGE_BATCH_SIZE = 50;
var MAX_KV_LIST_LIMIT = 1e3;
var DEFAULT_REVOKE_EXISTING_GRANTS_BATCH_SIZE = 50;
var MAX_KV_METADATA_BYTES = 1024;
function grantKeyMetadata(grant) {
  const metadata = { clientId: grant.clientId };
  if (grant.resource !== void 0) metadata.resource = grant.resource;
  if (grant.redirectUri !== void 0) metadata.redirectUri = grant.redirectUri;
  return new TextEncoder().encode(JSON.stringify(metadata)).byteLength <= MAX_KV_METADATA_BYTES ? metadata : void 0;
}
function grantPutOptions(grant, expiry = {}) {
  const metadata = grantKeyMetadata(grant);
  return metadata ? {
    ...expiry,
    metadata
  } : expiry;
}
function parseGrantKey(name) {
  const rest = name.slice(6);
  const separator = rest.lastIndexOf(":");
  if (!name.startsWith("grant:") || separator <= 0 || separator === rest.length - 1) return void 0;
  return {
    userId: rest.slice(0, separator),
    grantId: rest.slice(separator + 1)
  };
}
function isGrantKeyMetadata(value) {
  if (typeof value !== "object" || value === null) return false;
  const { clientId, resource, redirectUri } = value;
  return typeof clientId === "string" && (resource === void 0 || typeof resource === "string" || Array.isArray(resource)) && (redirectUri === void 0 || typeof redirectUri === "string");
}
var TOKEN_LENGTH = 32;
var ISSUED_GRANT_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;
var ISSUED_TOKEN_SECRET_PATTERN = /* @__PURE__ */ new RegExp(`^[A-Za-z0-9_-]{${TOKEN_LENGTH}}$`);
function audienceMatches(resourceServerUrl, audienceValue) {
  try {
    const resource = new URL(resourceServerUrl);
    const audience = new URL(audienceValue);
    if (resource.origin !== audience.origin) return false;
    if (!requestCarriesResourceQuery(resource, audience)) return false;
    if (audience.pathname === "/" || audience.pathname === "") return true;
    const descendantPrefix = audience.pathname.endsWith("/") ? audience.pathname : audience.pathname + "/";
    return resource.pathname === audience.pathname || resource.pathname.startsWith(descendantPrefix);
  } catch {
    return false;
  }
}
function isExactResource(value, configuredResource) {
  if (Array.isArray(value)) return value.some((entry) => typeof entry === "string" && resourceMatches(entry, configuredResource));
  return typeof value === "string" && resourceMatches(value, configuredResource);
}
function withoutBodyForHead(request, response) {
  if (request.method !== "HEAD") return response;
  return new Response(null, {
    status: response.status,
    headers: response.headers
  });
}
function isPathDescendant(candidate, base) {
  if (base === "" || base === "/") return true;
  if (base.endsWith("/")) return candidate.startsWith(base);
  return candidate === base || candidate.startsWith(`${base}/`);
}
async function hashSecret(secret) {
  return generateTokenId(secret);
}
function parseBasicAuthorizationHeader(header) {
  if (!header) return { kind: "not-basic" };
  const schemeEnd = header.search(/[ \t]/);
  if ((schemeEnd === -1 ? header : header.slice(0, schemeEnd)).toLowerCase() !== "basic") return { kind: "not-basic" };
  if (schemeEnd === -1) return { kind: "malformed" };
  const encodedCredentials = header.slice(schemeEnd).trim();
  if (!encodedCredentials || /[ \t]/.test(encodedCredentials)) return { kind: "malformed" };
  try {
    const credentials = atob(encodedCredentials);
    const separatorIndex = credentials.indexOf(":");
    if (separatorIndex === -1) return { kind: "malformed" };
    return {
      kind: "credentials",
      clientId: decodeFormUrlEncodedComponent(credentials.slice(0, separatorIndex)),
      clientSecret: decodeFormUrlEncodedComponent(credentials.slice(separatorIndex + 1))
    };
  } catch {
    return { kind: "malformed" };
  }
}
function decodeFormUrlEncodedComponent(value) {
  return decodeURIComponent(value.replace(/\+/g, " "));
}
function isIssuedTokenFormat(token) {
  const parts = token.split(":");
  if (parts.length < 3) return false;
  const secret = parts[parts.length - 1];
  const grantId = parts[parts.length - 2];
  return parts.slice(0, -2).join(":").length > 0 && ISSUED_GRANT_ID_PATTERN.test(grantId) && ISSUED_TOKEN_SECRET_PATTERN.test(secret);
}
function generateRandomString(length) {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let result = "";
  const values = new Uint8Array(length);
  crypto.getRandomValues(values);
  for (let i = 0; i < length; i++) result += characters.charAt(values[i] % 64);
  return result;
}
async function generateTokenId(token) {
  const data = new TextEncoder().encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function isLoopbackUri(uri) {
  try {
    return isLoopbackHostname(new URL(uri).hostname);
  } catch {
    return false;
  }
}
function isValidRedirectUri(requestUri, registeredUris) {
  return registeredUris.some((registered) => {
    if (isLoopbackUri(requestUri) && isLoopbackUri(registered)) try {
      const reqUrl = new URL(requestUri);
      const regUrl = new URL(registered);
      return reqUrl.protocol === regUrl.protocol && reqUrl.hostname === regUrl.hostname && reqUrl.pathname === regUrl.pathname && reqUrl.search === regUrl.search;
    } catch {
      return false;
    }
    return requestUri === registered;
  });
}
function base64UrlEncode(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function arrayBufferToBase64(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}
function base64ToArrayBuffer(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
  return bytes.buffer;
}
async function encryptProps(data) {
  const key2 = await crypto.subtle.generateKey({
    name: "AES-GCM",
    length: 256
  }, true, ["encrypt", "decrypt"]);
  const iv = new Uint8Array(12);
  const jsonData = JSON.stringify(data);
  const encodedData = new TextEncoder().encode(jsonData);
  return {
    encryptedData: arrayBufferToBase64(await crypto.subtle.encrypt({
      name: "AES-GCM",
      iv
    }, key2, encodedData)),
    key: key2
  };
}
async function decryptProps(key2, encryptedData) {
  const encryptedBuffer = base64ToArrayBuffer(encryptedData);
  const iv = new Uint8Array(12);
  const decryptedBuffer = await crypto.subtle.decrypt({
    name: "AES-GCM",
    iv
  }, key2, encryptedBuffer);
  const jsonData = new TextDecoder().decode(decryptedBuffer);
  return JSON.parse(jsonData);
}
var WRAPPING_KEY_HMAC_KEY = new Uint8Array([
  34,
  126,
  38,
  134,
  141,
  241,
  225,
  109,
  128,
  112,
  234,
  23,
  151,
  91,
  71,
  166,
  130,
  24,
  250,
  135,
  40,
  174,
  222,
  133,
  181,
  29,
  74,
  217,
  150,
  202,
  202,
  67
]);
async function deriveKeyFromToken(tokenStr) {
  const encoder = new TextEncoder();
  const hmacKey$1 = await crypto.subtle.importKey("raw", WRAPPING_KEY_HMAC_KEY, {
    name: "HMAC",
    hash: "SHA-256"
  }, false, ["sign"]);
  const hmacResult = await crypto.subtle.sign("HMAC", hmacKey$1, encoder.encode(tokenStr));
  return await crypto.subtle.importKey("raw", hmacResult, { name: "AES-KW" }, false, ["wrapKey", "unwrapKey"]);
}
async function wrapKeyWithToken(tokenStr, keyToWrap) {
  const wrappingKey = await deriveKeyFromToken(tokenStr);
  return arrayBufferToBase64(await crypto.subtle.wrapKey("raw", keyToWrap, wrappingKey, { name: "AES-KW" }));
}
async function unwrapKeyWithToken(tokenStr, wrappedKeyBase64) {
  const wrappingKey = await deriveKeyFromToken(tokenStr);
  const wrappedKeyBuffer = base64ToArrayBuffer(wrappedKeyBase64);
  return await crypto.subtle.unwrapKey("raw", wrappedKeyBuffer, wrappingKey, { name: "AES-KW" }, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
}
var OAuthHelpersImpl = class {
  /**
  * Creates a new OAuthHelpers instance
  * @param env - Cloudflare Worker environment variables
  * @param provider - Reference to the parent provider instance
  */
  constructor(env, provider) {
    this.env = env;
    this.provider = provider;
  }
  /**
  * Parses an OAuth authorization request from the HTTP request
  * @param request - The HTTP request containing OAuth parameters
  * @returns The parsed authorization request parameters
  * @throws AuthorizationError for expected authorization-request validation failures
  * @throws CimdFetchError when the client ID is a CIMD URL whose document cannot be resolved
  */
  async parseAuthRequest(request) {
    const url = new URL(request.url);
    if (this.provider.hasExplicitIssuer && !this.provider.isAuthorizationEndpointRequest(url)) throw new AuthorizationError("invalid_request", { description: "Authorization request was sent to an unconfigured endpoint" });
    const responseType = url.searchParams.get("response_type") || "";
    const clientId = url.searchParams.get("client_id") || "";
    const redirectUri = url.searchParams.get("redirect_uri") || "";
    const scope = (url.searchParams.get("scope") || "").split(" ").filter(Boolean);
    const state = url.searchParams.get("state") || "";
    const codeChallenge = url.searchParams.get("code_challenge") || void 0;
    const codeChallengeMethod = url.searchParams.get("code_challenge_method") || void 0;
    const issuer = this.provider.getAuthorizationServerIssuer(url);
    const resourceParams = url.searchParams.getAll("resource");
    const resourceParam = resourceParams.length > 0 ? resourceParams.length === 1 ? resourceParams[0] : resourceParams : void 0;
    if (!clientId) throw new AuthorizationError("invalid_request", { description: "client_id is required" });
    const clientInfo = await this.lookupClient(clientId);
    if (!clientInfo) throw new AuthorizationError("invalid_request", { description: "Invalid client_id" });
    try {
      validateRedirectUri(redirectUri, this.provider.serverCapabilities);
    } catch {
      throw new AuthorizationError("invalid_request", { description: "Invalid redirect URI" });
    }
    if (!redirectUri || !isValidRedirectUri(redirectUri, clientInfo.redirectUris)) throw new AuthorizationError("invalid_request", { description: "Invalid redirect URI" });
    const withRedirect = (error) => {
      throw withAuthorizationRedirect(error, redirectUri, state || void 0, issuer);
    };
    let resource;
    try {
      resource = this.provider.resolveAuthorizationRequestResource(resourceParam);
    } catch (error) {
      if (error instanceof AuthorizationError) withRedirect(error);
      throw error;
    }
    try {
      validateAuthorizationResponseType(this.provider.serverCapabilities, responseType, clientInfo.responseTypes);
      validateAuthorizationPkce(this.provider.serverCapabilities, {
        responseType,
        codeChallenge,
        codeChallengeMethod
      }, clientInfo);
    } catch (error) {
      if (error instanceof AuthorizationError) withRedirect(error);
      throw error;
    }
    return {
      responseType,
      clientId,
      redirectUri,
      scope,
      state,
      codeChallenge,
      codeChallengeMethod,
      resource,
      issuer
    };
  }
  /**
  * Looks up a client by its client ID
  * @param clientId - The client ID to look up
  * @returns A Promise resolving to the client info, or null if the client does not
  * exist. Null means definitive absence; failures to determine the answer throw
  * instead (KV errors propagate, and a CIMD metadata fetch failure throws
  * `CimdFetchError`), so an upstream outage cannot masquerade as an unregistered
  * client.
  * @throws CimdFetchError when the client ID is a CIMD URL and fetching or
  * validating the metadata document fails.
  */
  async lookupClient(clientId) {
    const client = await this.provider.getClient(this.env, clientId);
    return client ? toPublicClientInfo(client) : null;
  }
  /**
  * Completes an authorization request by creating a grant and an authorization code.
  * @param options - Options specifying the grant details
  * @returns A Promise resolving to an object containing the redirect URL
  * @throws Error when the request's response type is not permitted
  * @throws CimdFetchError when the client ID is a CIMD URL whose document cannot be resolved
  */
  async completeAuthorization(options) {
    const { clientId, redirectUri } = options.request;
    if (!clientId || !redirectUri) throw new Error("Client ID and Redirect URI are required in the authorization request.");
    if (typeof options.userId !== "string" || options.userId.length === 0 || options.userId.includes(":")) throw new TypeError('userId must be a non-empty string without ":"');
    const clientInfo = await this.lookupClient(clientId);
    if (!clientInfo || !isValidRedirectUri(redirectUri, clientInfo.redirectUris)) throw new Error("Invalid redirect URI. The redirect URI provided does not match any registered URI for this client.");
    try {
      validateRedirectUri(redirectUri, this.provider.serverCapabilities);
    } catch {
      throw new AuthorizationError("invalid_request", { description: "Invalid redirect URI" });
    }
    validateAuthorizationResponseType(this.provider.serverCapabilities, options.request.responseType, clientInfo.responseTypes);
    const effectiveResource = this.provider.resolveAuthorizationRequestResource(options.request.resource);
    validateAuthorizationPkce(this.provider.serverCapabilities, options.request, clientInfo);
    let grantsToRevoke = [];
    if (options.revokeExistingGrants !== false) {
      const isCimdClient = isClientIdMetadataDocumentUrl(clientId);
      const readConcurrency = DEFAULT_REVOKE_EXISTING_GRANTS_BATCH_SIZE;
      grantsToRevoke = await this.findGrantIds(options.userId, (grant$1) => grant$1.clientId === clientId && (!isCimdClient || grant$1.redirectUri === options.request.redirectUri) && this.provider.shouldReplaceGrantForResource(grant$1.resource, effectiveResource), readConcurrency);
    }
    const grantId = generateRandomString(16);
    const { encryptedData, key: encryptionKey } = await encryptProps(options.props);
    const now = Math.floor(Date.now() / 1e3);
    const authCodeSecret = generateRandomString(32);
    const authCode = `${options.userId}:${grantId}:${authCodeSecret}`;
    const authCodeId = await hashSecret(authCode);
    const authCodeWrappedKey = await wrapKeyWithToken(authCode, encryptionKey);
    const grant = {
      id: grantId,
      clientId: options.request.clientId,
      userId: options.userId,
      scope: options.scope,
      metadata: options.metadata,
      encryptedProps: encryptedData,
      createdAt: now,
      authCodeId,
      authCodeWrappedKey,
      codeChallenge: options.request.codeChallenge,
      codeChallengeMethod: options.request.codeChallengeMethod,
      resource: effectiveResource,
      redirectUri: options.request.redirectUri
    };
    const grantKey = `grant:${options.userId}:${grantId}`;
    await this.env.OAUTH_KV.put(grantKey, JSON.stringify(grant), grantPutOptions(grant, { expirationTtl: 600 }));
    const redirectUrl = new URL(options.request.redirectUri);
    redirectUrl.searchParams.set("code", authCode);
    if (options.request.state) redirectUrl.searchParams.set("state", options.request.state);
    if (options.request.issuer) redirectUrl.searchParams.set("iss", options.request.issuer);
    try {
      await Promise.allSettled(grantsToRevoke.map((oldGrantId) => this.revokeGrant(oldGrantId, options.userId)));
    } catch {
    }
    return { redirectTo: redirectUrl.toString() };
  }
  /**
  * IDs of the user's grants that satisfy `matches`, judged from KV key metadata
  * wherever a grant carries it. Only grants written without metadata, by a version
  * before 1.0 or because theirs would not fit, are read, `readConcurrency` at a time.
  *
  * This runs on the interactive authorization path, where the pre-metadata cost of one
  * `get()` per grant broke re-authorization for a user with more grants than a Worker
  * has subrequests. The cost is now one `list()` per thousand grants plus one `get()`
  * per legacy grant, and every refresh rewrites its grant with metadata, so the legacy
  * share shrinks on its own.
  */
  async findGrantIds(userId, matches, readConcurrency) {
    const grantIds = [];
    for await (const grants of this.findGrants(userId, matches, readConcurrency)) grantIds.push(...grants.map((grant) => grant.grantId));
    return grantIds;
  }
  /**
  * Finds grants matching `matches`, for one user or, with `userId` undefined, for every user.
  * Metadata-carrying keys are matched without a read; legacy grants are read,
  * `readConcurrency` at a time. Matches are yielded as they are found (each page's metadata
  * matches, then each batch of reads), so a caller can act on them before the scan goes on.
  */
  async *findGrants(userId, matches, readConcurrency) {
    const prefix = userId === void 0 ? "grant:" : `grant:${userId}:`;
    let cursor;
    do {
      const page2 = await this.env.OAUTH_KV.list({
        prefix,
        limit: MAX_KV_LIST_LIMIT,
        cursor
      });
      const toRead = [];
      const found = [];
      for (const key2 of page2.keys) {
        const owner = parseGrantKey(key2.name);
        if (!owner || userId !== void 0 && owner.userId !== userId) continue;
        if (isGrantKeyMetadata(key2.metadata)) {
          if (matches(key2.metadata)) found.push(owner);
        } else toRead.push({
          name: key2.name,
          ...owner
        });
      }
      if (found.length > 0) yield found;
      for (let start = 0; start < toRead.length; start += readConcurrency) {
        const batch = toRead.slice(start, start + readConcurrency);
        const grants = await Promise.all(batch.map(({ name }) => this.env.OAUTH_KV.get(name, { type: "json" })));
        const read = batch.filter((_, index) => {
          const grant = grants[index];
          return grant !== null && matches(grant);
        });
        if (read.length > 0) yield read.map(({ userId: userId$1, grantId }) => ({
          userId: userId$1,
          grantId
        }));
      }
      cursor = page2.list_complete ? void 0 : page2.cursor;
    } while (cursor);
  }
  /**
  * Creates a new OAuth client
  * @param clientInfo - Partial client information to create the client with
  * @returns A Promise resolving to the created client info
  */
  async createClient(clientInfo) {
    const clientId = generateRandomString(16);
    const authMethodWasExplicit = clientInfo.tokenEndpointAuthMethod !== void 0;
    const tokenEndpointAuthMethod = clientInfo.tokenEndpointAuthMethod || "client_secret_basic";
    const isPublicClient = tokenEndpointAuthMethod === "none";
    const newClient = {
      clientId,
      redirectUris: clientInfo.redirectUris || [],
      clientName: clientInfo.clientName,
      logoUri: clientInfo.logoUri,
      clientUri: clientInfo.clientUri,
      policyUri: clientInfo.policyUri,
      tosUri: clientInfo.tosUri,
      jwksUri: clientInfo.jwksUri,
      i18n: clientInfo.i18n,
      contacts: clientInfo.contacts,
      grantTypes: clientInfo.grantTypes || [
        GrantType.AUTHORIZATION_CODE,
        GrantType.REFRESH_TOKEN,
        ...this.provider.options.allowTokenExchangeGrant ? [GrantType.TOKEN_EXCHANGE] : []
      ],
      responseTypes: clientInfo.responseTypes || ["code"],
      registrationDate: Math.floor(Date.now() / 1e3),
      tokenEndpointAuthMethod,
      ...authMethodWasExplicit ? { authMethodExplicit: true } : {}
    };
    validateRegisteredRedirectUris(newClient.redirectUris, this.provider.serverCapabilities);
    validateClientCapabilities(this.provider.serverCapabilities, {
      grantTypes: newClient.grantTypes,
      responseTypes: newClient.responseTypes,
      tokenEndpointAuthMethod
    });
    let clientSecret;
    if (!isPublicClient) {
      clientSecret = generateRandomString(32);
      newClient.clientSecret = await hashSecret(clientSecret);
    }
    await this.env.OAUTH_KV.put(`client:${clientId}`, JSON.stringify(newClient));
    const clientResponse = toPublicClientInfo(newClient);
    if (!isPublicClient && clientSecret) clientResponse.clientSecret = clientSecret;
    return clientResponse;
  }
  /**
  * Lists all registered OAuth clients with pagination support
  * @param options - Optional pagination parameters (limit and cursor)
  * @returns A Promise resolving to the list result with items and optional cursor
  */
  async listClients(options) {
    const listOptions = { prefix: "client:" };
    if (options?.limit !== void 0) listOptions.limit = options.limit;
    if (options?.cursor !== void 0) listOptions.cursor = options.cursor;
    const response = await this.env.OAUTH_KV.list(listOptions);
    const clients = [];
    const promises = response.keys.map(async (key2) => {
      const clientId = key2.name.substring(7);
      const client = await this.provider.getClient(this.env, clientId);
      if (client) clients.push(toPublicClientInfo(client));
    });
    await Promise.all(promises);
    return {
      items: clients,
      cursor: response.list_complete ? void 0 : response.cursor
    };
  }
  /**
  * Updates an existing OAuth client
  * @param clientId - The ID of the client to update
  * @param updates - Partial client information with fields to update
  * @returns A Promise resolving to the updated client info, or null if not found
  */
  async updateClient(clientId, updates) {
    if (this.provider.options.clientIdMetadataDocumentEnabled && isClientIdMetadataDocumentUrl(clientId)) throw new TypeError("Client ID Metadata Document clients are updated by changing their document");
    const client = await this.provider.getClient(this.env, clientId);
    if (!client) return null;
    if (updates.redirectUris !== void 0) {
      if (!Array.isArray(updates.redirectUris) || updates.redirectUris.length === 0) throw new Error("redirectUris must not be empty");
      validateRegisteredRedirectUris(updates.redirectUris, this.provider.serverCapabilities);
    }
    const authMethodWasExplicit = updates.tokenEndpointAuthMethod !== void 0;
    const authMethod = updates.tokenEndpointAuthMethod || client.tokenEndpointAuthMethod || "client_secret_basic";
    const isPublicClient = authMethod === "none";
    let secretToStore = client.clientSecret;
    let originalSecret = void 0;
    if (isPublicClient) secretToStore = void 0;
    else if (updates.clientSecret) {
      originalSecret = updates.clientSecret;
      secretToStore = await hashSecret(updates.clientSecret);
    }
    const updatedClient = {
      ...client,
      ...updates,
      clientId: client.clientId,
      tokenEndpointAuthMethod: authMethod,
      authMethodExplicit: authMethodWasExplicit ? true : client.authMethodExplicit
    };
    if (updates.grantTypes !== void 0 || updates.responseTypes !== void 0 || updates.tokenEndpointAuthMethod !== void 0) validateClientCapabilities(this.provider.serverCapabilities, {
      grantTypes: updatedClient.grantTypes ?? [GrantType.AUTHORIZATION_CODE, GrantType.REFRESH_TOKEN],
      responseTypes: updatedClient.responseTypes ?? ["code"],
      tokenEndpointAuthMethod: authMethod
    });
    if (!isPublicClient && secretToStore) updatedClient.clientSecret = secretToStore;
    else delete updatedClient.clientSecret;
    if (client.registrationExpiresAt === void 0) await this.env.OAUTH_KV.put(`client:${updatedClient.clientId}`, JSON.stringify(updatedClient));
    else await this.provider.putRegisteredClient(this.env, updatedClient, Math.floor(Date.now() / 1e3));
    const response = toPublicClientInfo(updatedClient);
    if (!isPublicClient && originalSecret) response.clientSecret = originalSecret;
    return response;
  }
  /**
  * Deletes an OAuth client and revokes all associated grants across all users.
  * @param clientId - The ID of the client to delete
  * @returns A Promise resolving when the deletion is confirmed.
  */
  async deleteClient(clientId) {
    await this.env.OAUTH_KV.delete(`client:${clientId}`);
    const grants = this.findGrants(void 0, (grant) => grant.clientId === clientId, DEFAULT_REVOKE_EXISTING_GRANTS_BATCH_SIZE);
    for await (const found of grants) for (const { userId, grantId } of found) await this.revokeGrant(grantId, userId);
  }
  /**
  * Lists all authorization grants for a specific user with pagination support
  * Returns a summary of each grant without sensitive information
  * @param userId - The ID of the user whose grants to list
  * @param options - Optional pagination parameters (limit and cursor)
  * @returns A Promise resolving to the list result with grant summaries and optional cursor
  */
  async listUserGrants(userId, options) {
    const listOptions = { prefix: `grant:${userId}:` };
    if (options?.limit !== void 0) listOptions.limit = options.limit;
    if (options?.cursor !== void 0) listOptions.cursor = options.cursor;
    const isOwn = (key2) => !key2.name.slice(listOptions.prefix.length).includes(":");
    let response = await this.env.OAUTH_KV.list(listOptions);
    let ownKeys = response.keys.filter(isOwn);
    while (ownKeys.length === 0 && !response.list_complete) {
      response = await this.env.OAUTH_KV.list({
        ...listOptions,
        cursor: response.cursor
      });
      ownKeys = response.keys.filter(isOwn);
    }
    const grantSummaries = [];
    const promises = ownKeys.map(async (key2) => {
      const grantData = await this.env.OAUTH_KV.get(key2.name, { type: "json" });
      if (grantData) {
        const summary = {
          id: grantData.id,
          clientId: grantData.clientId,
          userId: grantData.userId,
          scope: grantData.scope,
          metadata: grantData.metadata,
          createdAt: grantData.createdAt,
          expiresAt: grantData.expiresAt,
          redirectUri: grantData.redirectUri,
          resource: grantData.resource
        };
        grantSummaries.push(summary);
      }
    });
    await Promise.all(promises);
    return {
      items: grantSummaries,
      cursor: response.list_complete ? void 0 : response.cursor
    };
  }
  /**
  * Revokes an authorization grant and all its associated access tokens
  * @param grantId - The ID of the grant to revoke
  * @param userId - The ID of the user who owns the grant
  * @returns A Promise resolving when the revocation is confirmed.
  */
  /** {@inheritDoc OAuthHelpers.describeConsent} */
  async describeConsent(authRequest) {
    const client = await this.lookupClient(authRequest.clientId);
    const isCimd = !!this.provider.options.clientIdMetadataDocumentEnabled && isClientIdMetadataDocumentUrl(authRequest.clientId);
    return describeConsent(client, authRequest, isCimd);
  }
  /** {@inheritDoc OAuthHelpers.isConsentRemembered} */
  isConsentRemembered(request, authRequest, remember) {
    return isConsentRemembered(this.provider.consentCookies, request, authRequest, remember);
  }
  /** {@inheritDoc OAuthHelpers.beginConsent} */
  beginConsent(authRequest) {
    return beginConsent(this.env.OAUTH_KV, this.provider.consentCookies, authRequest);
  }
  /** {@inheritDoc OAuthHelpers.approveConsent} */
  approveConsent(request, handle, options) {
    return approveConsent(this.env.OAUTH_KV, this.provider.consentCookies, this.provider.options.scopesSupported, request, handle, options);
  }
  /** {@inheritDoc OAuthHelpers.denyConsent} */
  denyConsent(request, handle, options) {
    return denyConsent(this.env.OAUTH_KV, this.provider.consentCookies, request, handle, options);
  }
  /** {@inheritDoc OAuthHelpers.beginUpstream} */
  beginUpstream(authRequest, options) {
    return beginUpstream(this.env.OAUTH_KV, this.provider.consentCookies, authRequest, options);
  }
  /** {@inheritDoc OAuthHelpers.finishUpstream} */
  finishUpstream(request) {
    return finishUpstream(this.env.OAUTH_KV, this.provider.consentCookies, request);
  }
  async revokeGrant(grantId, userId) {
    const grantKey = `grant:${userId}:${grantId}`;
    const tokenPrefix = `token:${userId}:${grantId}:`;
    let cursor;
    let allTokensDeleted = false;
    while (!allTokensDeleted) {
      const listOptions = { prefix: tokenPrefix };
      if (cursor) listOptions.cursor = cursor;
      const result = await this.env.OAUTH_KV.list(listOptions);
      if (result.keys.length > 0) await Promise.all(result.keys.map((key2) => {
        return this.env.OAUTH_KV.delete(key2.name);
      }));
      if (result.list_complete) allTokensDeleted = true;
      else cursor = result.cursor;
    }
    await this.env.OAUTH_KV.delete(grantKey);
  }
  /**
  * Decodes a token and returns token data with decrypted props
  * @param token - The token
  * @returns Promise resolving to token data with decrypted props, or null if token is invalid
  */
  async unwrapToken(token) {
    return await this.provider.unwrapToken(token, this.env);
  }
  /**
  * Exchanges an existing access token for a new one with modified characteristics
  * Implements OAuth 2.0 Token Exchange (RFC 8693)
  * @param options - Options for token exchange including subject token and optional modifications
  * @returns Promise resolving to token response with new access token
  * @throws CimdFetchError when the grant's client ID is a CIMD URL whose document cannot be resolved
  */
  async exchangeToken(options) {
    const tokenSummary = await this.unwrapToken(options.subjectToken);
    if (!tokenSummary) throw new Error("Invalid or expired subject token");
    const clientInfo = await this.lookupClient(tokenSummary.grant.clientId);
    if (!clientInfo) throw new Error("Client not found");
    return await this.provider.exchangeToken(options.subjectToken, options.scope, options.aud, options.expiresIn, clientInfo, this.env);
  }
  async purgeExpiredData(options) {
    const batchSize = options?.batchSize ?? DEFAULT_PURGE_BATCH_SIZE;
    const purgeOrphanedGrants = options?.purgeOrphanedGrants !== false;
    const purgeExpiredGrants = options?.purgeExpiredGrants !== false;
    const purgeOrphanedTokens = options?.purgeOrphanedTokens !== false;
    const start = parsePurgeCursor(options?.cursor);
    const now = Math.floor(Date.now() / 1e3);
    const result = {
      grantsChecked: 0,
      grantsPurged: 0,
      tokensChecked: 0,
      tokensPurged: 0,
      done: false
    };
    if (start.phase === "grants" && (purgeOrphanedGrants || purgeExpiredGrants)) {
      const knownGoodClients = /* @__PURE__ */ new Set();
      const knownMissingClients = /* @__PURE__ */ new Set();
      let grantCursor = start.kvCursor;
      let grantsDone = false;
      while (!grantsDone && result.grantsChecked < batchSize) {
        const listOptions = {
          prefix: "grant:",
          limit: Math.min(1e3, batchSize - result.grantsChecked)
        };
        if (grantCursor) listOptions.cursor = grantCursor;
        const page2 = await this.env.OAUTH_KV.list(listOptions);
        for (const key2 of page2.keys) {
          if (result.grantsChecked >= batchSize) break;
          result.grantsChecked++;
          const grantData = await this.env.OAUTH_KV.get(key2.name, { type: "json" });
          if (!grantData) continue;
          let shouldPurge = false;
          if (purgeExpiredGrants && grantData.expiresAt !== void 0 && now >= grantData.expiresAt) shouldPurge = true;
          if (!shouldPurge && purgeOrphanedGrants && !isClientIdMetadataDocumentUrl(grantData.clientId)) {
            if (knownMissingClients.has(grantData.clientId)) shouldPurge = true;
            else if (!knownGoodClients.has(grantData.clientId)) if (await this.env.OAUTH_KV.get(`client:${grantData.clientId}`, { type: "json" })) knownGoodClients.add(grantData.clientId);
            else {
              knownMissingClients.add(grantData.clientId);
              shouldPurge = true;
            }
          }
          if (shouldPurge) {
            await this.revokeGrant(grantData.id, grantData.userId);
            result.grantsPurged++;
          }
        }
        if (page2.list_complete) grantsDone = true;
        else grantCursor = page2.cursor;
      }
      if (!grantsDone) return {
        ...result,
        cursor: `grants:${grantCursor ?? ""}`
      };
    }
    if (purgeOrphanedTokens) {
      const knownGoodGrants = /* @__PURE__ */ new Set();
      const knownMissingGrants = /* @__PURE__ */ new Set();
      let tokenCursor = start.phase === "tokens" ? start.kvCursor : void 0;
      let tokensDone = false;
      while (!tokensDone && result.tokensChecked < batchSize) {
        const listOptions = {
          prefix: "token:",
          limit: Math.min(1e3, batchSize - result.tokensChecked)
        };
        if (tokenCursor) listOptions.cursor = tokenCursor;
        const page2 = await this.env.OAUTH_KV.list(listOptions);
        for (const key2 of page2.keys) {
          if (result.tokensChecked >= batchSize) break;
          result.tokensChecked++;
          const tokenData = await this.env.OAUTH_KV.get(key2.name, { type: "json" });
          if (!tokenData) continue;
          const grantKey = `grant:${tokenData.userId}:${tokenData.grantId}`;
          if (knownMissingGrants.has(grantKey)) {
            await this.env.OAUTH_KV.delete(key2.name);
            result.tokensPurged++;
          } else if (!knownGoodGrants.has(grantKey)) if (await this.env.OAUTH_KV.get(grantKey)) knownGoodGrants.add(grantKey);
          else {
            knownMissingGrants.add(grantKey);
            await this.env.OAUTH_KV.delete(key2.name);
            result.tokensPurged++;
          }
        }
        if (page2.list_complete) tokensDone = true;
        else tokenCursor = page2.cursor;
      }
      if (!tokensDone) return {
        ...result,
        cursor: `tokens:${tokenCursor ?? ""}`
      };
    }
    result.done = true;
    return result;
  }
};
var oauth_provider_default = OAuthProvider;

// mcp-oauth.mjs
var ORIGIN = "https://mcp.artificialmindhive.com";
var RESOURCE = ORIGIN + "/mcp";
var SCOPE = "wt:operate";
var PREFIX = "mcp-oauth-v1:";
var escape = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
var json2 = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
var digest = async (value) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((x) => x.toString(16).padStart(2, "0")).join("");
function prefixedKV(kv) {
  return {
    get: (key2, options) => kv.get(PREFIX + key2, options),
    put: (key2, value, options) => kv.put(PREFIX + key2, value, options),
    delete: (key2) => kv.delete(PREFIX + key2),
    async list(options = {}) {
      const result = await kv.list({ ...options, prefix: PREFIX + (options.prefix || "") });
      return { ...result, keys: result.keys.map((k) => ({ ...k, name: k.name.slice(PREFIX.length) })) };
    }
  };
}
function page(details, handle) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Walrus Tusk \xB7 AMH</title>
<style>*{box-sizing:border-box}body{margin:0;background:#07110e;color:#ecfff5;font:17px/1.5 system-ui;min-height:100svh;display:grid;place-items:center;padding:24px}main{width:min(100%,520px);padding:28px;border:1px solid #315e46;border-radius:24px;background:#101e18}small{color:#99d7b5}h1{font-size:30px;line-height:1.15}p{overflow-wrap:anywhere}label{display:block;margin-top:24px}input{width:100%;padding:15px;margin:8px 0 18px;border:1px solid #59856b;border-radius:10px;background:#07110e;color:white;font:inherit}button{min-height:48px;padding:12px 20px;border:0;border-radius:12px;font:700 16px system-ui;cursor:pointer}button[value=approve]{background:#82ffae;color:#062013}button[value=deny]{background:#24372d;color:white}a{color:#82ffae}.actions{display:flex;gap:12px;flex-wrap:wrap}</style>
<main><small>AMH / WALRUS TUSK / CF OPS</small><h1>Connect ${escape(details.clientName)}</h1>
<p>Access will return to <strong>${escape(details.redirectHost)}</strong>.</p>
<p>${details.clientDomain ? `App identity: <strong>${escape(details.clientDomain)}</strong>.` : "The app supplied its name; check the destination above."}${details.redirectIsLoopback ? " This connects an app running on your computer." : ""}</p>
<p>Allow this app to use your Walrus Tusk tools, including changes to connected sites and repositories, within the permissions of your key. Existing tool approval rules still apply.</p>
<p><small>Requested access: ${details.scope.map(escape).join(", ") || SCOPE}. Your key stays on this server; the app receives separate, revocable access.</small></p>
<form method="post" action="/oauth/authorize"><input type="hidden" name="handle" value="${escape(handle)}"><label for="key">Your Walrus Tusk connection key</label><input id="key" name="key" type="password" autocomplete="current-password" placeholder="Paste your WT connection key" maxlength="1024"><div class="actions"><button name="decision" value="approve">Allow connection</button><button name="decision" value="deny">Cancel</button></div></form>
<p><small>Use the same private key as your working WT connection. Never paste your Cloudflare API token here.</small></p><a href="/setup" target="_blank" rel="noopener noreferrer">Walrus Tusk setup</a></main></html>`;
}
function createOAuthWorker(legacy, authorizeConnector2) {
  const defaultHandler = {
    async fetch(request, env, ctx) {
      if (new URL(request.url).pathname !== "/oauth/authorize") return legacy.fetch(request, env, ctx);
      const oauth = env.OAUTH_PROVIDER;
      try {
        if (request.method === "GET") {
          const parsed = await oauth.parseAuthRequest(request);
          if (!parsed.codeChallenge || parsed.codeChallengeMethod !== "S256") return json2({ error: "invalid_request", error_description: "S256 PKCE is required." }, 400);
          const details = await oauth.describeConsent(parsed);
          const consent = await oauth.beginConsent(parsed);
          consent.headers.set("Content-Type", "text/html; charset=utf-8");
          consent.headers.set("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${new URL(parsed.redirectUri).origin}; base-uri 'none'; frame-ancestors 'none'`);
          consent.headers.set("Referrer-Policy", "same-origin");
          return new Response(page(details, consent.handle), { headers: consent.headers });
        }
        if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
        if (request.headers.get("origin") !== ORIGIN) return json2({ error: "invalid_request", error_description: "Open this connection from your app again." }, 403);
        const form = await request.formData();
        const handle = String(form.get("handle") || "");
        if (form.get("decision") !== "approve") {
          const denied = await oauth.denyConsent(request, handle);
          return new Response(null, { status: 302, headers: denied.headers });
        }
        const key2 = String(form.get("key") || "").trim();
        const auth = key2.length <= 1024 ? await authorizeConnector2(env, key2) : { ok: false };
        if (!auth.ok) return new Response("That WT connection key was not accepted. Go back and try your existing WT key.", { status: 401, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
        const approved = await oauth.approveConsent(request, handle);
        const scope = [.../* @__PURE__ */ new Set([...approved.request.scope, SCOPE])];
        const { redirectTo } = await oauth.completeAuthorization({
          request: approved.request,
          userId: await digest(key2),
          scope,
          metadata: { provider: "Walrus Tusk", mode: auth.mode },
          // The library encrypts props under a grant-specific key, wrapped by OAuth credentials.
          props: { connectorKey: key2 }
        });
        approved.headers.set("Location", redirectTo);
        return new Response(null, { status: 302, headers: approved.headers });
      } catch (error) {
        if (error instanceof AuthorizationError && error.redirectTo && request.method === "GET") return Response.redirect(error.redirectTo, 302);
        if (error instanceof AuthorizationError || error instanceof CimdFetchError) return json2({ error: "invalid_request", error_description: "This connection request expired or could not be verified. Start again from your app." }, 400);
        throw error;
      }
    }
  };
  const provider = new oauth_provider_default({
    apiRoute: "/mcp",
    apiHandler: {
      async fetch(request, env, ctx) {
        if (ctx.auth && !ctx.auth.scope.includes(SCOPE)) return insufficientScope(ctx.auth, [SCOPE]);
        if (!ctx.props?.connectorKey) return json2({ error: "invalid_token" }, 401);
        const headers = new Headers(request.headers);
        headers.set("authorization", "Bearer " + ctx.props.connectorKey);
        return legacy.fetch(new Request(request, { headers }), env, ctx);
      }
    },
    defaultHandler,
    authorizeEndpoint: ORIGIN + "/oauth/authorize",
    tokenEndpoint: ORIGIN + "/oauth/token",
    clientRegistrationEndpoint: ORIGIN + "/oauth/register",
    resourceMetadata: { resource: RESOURCE, authorization_servers: [ORIGIN], resource_name: "AMH Walrus Tusk CF Ops MCP" },
    scopesSupported: [SCOPE, "offline_access"],
    requiredScopes: [SCOPE],
    accessTokenTTL: 3600,
    refreshTokenTTL: 2592e3,
    refreshTokenIdleTTL: 2592e3,
    clientIdMetadataDocumentEnabled: true,
    async tokenExchangeCallback({ props, env }) {
      if (!props?.connectorKey || !(await authorizeConnector2(env, props.connectorKey)).ok) throw new OAuthError("invalid_grant", { description: "The underlying WT connection was revoked." });
    },
    onError(error) {
      console.warn(JSON.stringify({ event: "mcp_oauth_error", code: error.code, reason: error.internal?.reason }));
    }
  });
  return {
    scheduled: legacy.scheduled,
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const oauthRoute = ["/oauth/authorize", "/oauth/token", "/oauth/register"].includes(url.pathname);
      const discovery = url.pathname.startsWith("/.well-known/oauth-");
      const mcp = url.pathname === "/mcp" || url.pathname.startsWith("/mcp/");
      if (!oauthRoute && !discovery && !mcp) return legacy.fetch(request, env, ctx);
      try {
        if (url.pathname === "/.well-known/oauth-protected-resource") {
          url.pathname = "/.well-known/oauth-protected-resource/mcp";
          request = new Request(url, request);
        }
        if (oauthRoute && env.RATE_LIMITER) {
          const ip = request.headers.get("cf-connecting-ip") || "unknown";
          const result = await env.RATE_LIMITER.limit({ key: "mcp-oauth:" + await digest(ip) });
          if (!result.success) return new Response("Please wait before trying again.", { status: 429, headers: { "retry-after": "60" } });
        }
        if (oauthRoute && request.method === "POST") {
          const reader = request.body?.getReader();
          let size = 0;
          const chunks = [];
          if (reader) for (; ; ) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 16384) {
              await reader.cancel();
              return json2({ error: "request_too_large" }, 413);
            }
            chunks.push(value);
          }
          request = new Request(request, { body: new Blob(chunks) });
        }
        if (mcp && !request.headers.has("authorization")) {
          const key2 = request.headers.get("x-mcp-key") || url.searchParams.get("key");
          if (key2) {
            const headers = new Headers(request.headers);
            headers.set("authorization", "Bearer " + key2);
            request = new Request(request, { headers });
          }
        }
        if (mcp) {
          const supplied = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
          if (supplied && (await authorizeConnector2(env, supplied)).ok) return legacy.fetch(request, env, ctx);
        }
        return await provider.fetch(request, { ...env, OAUTH_KV: prefixedKV(env.CLOUDFLARE_OPS_OAUTH) }, ctx);
      } catch {
        console.error(JSON.stringify({ event: "mcp_oauth_unavailable" }));
        return json2({ error: "temporarily_unavailable", error_description: "Connection service unavailable. Please try again." }, 503);
      }
    }
  };
}

// entry.mjs
var entry_default = createOAuthWorker(index_default, authorizeConnector);
export {
  RateLimiterDO,
  entry_default as default
};

