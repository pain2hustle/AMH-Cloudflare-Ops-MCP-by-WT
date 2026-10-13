var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ../src/client.js
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
    } catch (err) {
      throw new CloudflareError(
        redactToken(
          `Network error calling Cloudflare API: ${err && err.message}`,
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
    let page = 1;
    for (let guard = 0; guard < 1e3; guard++) {
      const sep = path.includes("?") ? "&" : "?";
      const { result, result_info } = await this.request(
        "GET",
        `${path}${sep}page=${page}&per_page=${perPage}`
      );
      if (Array.isArray(result)) out.push(...result);
      const info = result_info || {};
      const totalPages = info.total_pages || 1;
      if (!info.page || page >= totalPages) break;
      page += 1;
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

// ../src/dns.js
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

// ../src/dmarc.js
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

// ../src/bimi.js
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
  } catch (err) {
    warnings.push(`Could not fetch logo URL: ${err && err.message}`);
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

// ../src/zone.js
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

// ../src/email.js
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

// ../src/plan.js
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
  const ok = !findings.some((f) => f.severity === "error");
  return { domain, zone_id: snap.zone_id, ok, findings, snapshot: snap };
}
__name(planEmailAuth, "planEmailAuth");

// ../src/cache.js
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

// ../src/pages.js
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
    const err = new Error(
      `pages_cutover FAILED after deleting ${deleted.length} record(s): ${e && e.message || e}. Rollback restored ${restored.ok}/${restored.attempted}.` + (restored.failed.length ? ` ${restored.failed.length} could NOT be restored \u2014 see .restore for the exact records to re-create by hand.` : ` The zone is back to its previous state.`)
    );
    err.restore = { snapshot, restored, deleted };
    throw err;
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

// ../src/turnstile.js
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

// ../src/tokens.js
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

// ../src/doctor.js
async function safeRequest(client, method, path) {
  try {
    return await client.request(method, path);
  } catch (err) {
    return { result: null, error: err && err.message || String(err) };
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

// ../src/federation.js
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

// ../src/policy.js
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

// oauth.js
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
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value))));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
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
    let page = JSON.parse(encoded);
    page = page.replace("<html><head>", '<html lang="en"><head>\n<title>Connected \u2014 Walrus Tusk // AMH</title>').replace(/\s*<a\s+href="https:\/\/cfops\.nothingunseen\.com"[\s\S]*?<\/a>/gi, "").replace(/\s*<a\s+href="https:\/\/nothingunseen\.com"[\s\S]*?<\/a>/gi, "").replaceAll('href="WT Landing.dc.html"', 'href="https://artificialmindhive.com/WalrusTooth"').replaceAll('href="WT Docs.dc.html"', 'href="https://artificialmindhive.com/wtdocs"').replaceAll('href="WT Agents.dc.html"', 'href="https://console.artificialmindhive.com/console"').replaceAll('href="WT FAQ.dc.html"', 'href="https://artificialmindhive.com/wtfaq"').replaceAll('href="AMH Agent Console.dc.html"', 'href="https://console.artificialmindhive.com/console"').replaceAll('href="WT Console Unlock.dc.html"', 'href="https://console.artificialmindhive.com/console"').replaceAll('href="/docs"', 'href="https://artificialmindhive.com/wtdocs"').replaceAll('href="/agents"', 'href="https://console.artificialmindhive.com/console"').replaceAll('href="/faq"', 'href="https://artificialmindhive.com/wtfaq"').replaceAll('href="/console"', 'href="https://console.artificialmindhive.com/console"').replaceAll('href="/"', 'href="https://artificialmindhive.com/WalrusTooth"').replace(/https:\/\/mcp\.artificialmindhive\.com\/mcp/gi, `${origin}/mcp`).replace(/https:\/\/cfops\.nothingunseen\.com\/mcp/gi, `${origin}/mcp`).replace(/https:\/\/cfops\.nothingunseen\.com/gi, origin).replace(/cfops_[A-Za-z0-9_-]+/g, connectorKey);
    return open + JSON.stringify(page).replace(/</g, "\\u003c") + close;
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
  // Extra full-power keys, one per outside agent (e.g. Grok), so each can be revoked alone
  // without rotating the owner's main key. Comma-separated secret MCP_EXTRA_ADMIN_KEYS.
  if (env.MCP_EXTRA_ADMIN_KEYS) {
    for (const k of String(env.MCP_EXTRA_ADMIN_KEYS).split(",").map((x) => x.trim()).filter(Boolean)) {
      if (await timingSafeEqual(provided, k)) return { ok: true, mode: "admin", connectionId: null };
    }
  }
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

// index.js
// ../src/pages-deploy.js
// pages-deploy.js — Cloudflare Pages deploy/rollback/inspect over the API, no wrangler, no PC.
// Same rules as every other write here: DRY-RUN unless apply=true. artificialmindhive's
// production branch is refused outright: that site only ships through the amh-hive
// build-hive-dist path (raw deploys buried it 4+ times).
// Upload flow mirrors `wrangler pages deploy`: upload-token -> check-missing -> upload ->
// upsert-hashes -> create deployment with a {path: hash} manifest.

var PAGES_ACCOUNT_ALIASES = { amh: "0ebf6d65d7a9ddccd41cba0b8bd1414c", doors: "1d5fae607a857fc56cd575763bf8f3bc" };
var PAGES_PROTECTED = new Set(["artificialmindhive"]);
var PAGES_MAX_FILES = 2000, PAGES_MAX_BYTES = 60 * 1024 * 1024, PAGES_MAX_FILE = 25 * 1024 * 1024;
var PAGES_TYPES = { html: "text/html", htm: "text/html", css: "text/css", js: "application/javascript", mjs: "application/javascript", json: "application/json", txt: "text/plain", xml: "application/xml", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", pdf: "application/pdf", webmanifest: "application/manifest+json", wasm: "application/wasm", glb: "model/gltf-binary" };

function pagesAccount(a) {
  const s = String(a || "").trim().toLowerCase();
  const id = PAGES_ACCOUNT_ALIASES[s] || s;
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("account must be amh, doors, or a 32-hex account id");
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
  if (!s || s.includes("\0") || parts.some((x) => x === ".." || x === "." || x === "") ) throw new Error(`bad file path: ${p}`);
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
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
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
    project, production_branch: p.production_branch, domains: p.domains,
    deployments: (result || []).map((d) => ({ id: d.id, short_id: d.short_id, environment: d.environment, branch: d.deployment_trigger && d.deployment_trigger.metadata && d.deployment_trigger.metadata.branch, url: d.url, created_on: d.created_on, status: d.latest_stage && d.latest_stage.status, serving_production: d.id === liveId })),
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
    if (path === "/_headers" || path === "/_redirects" || path === "/_routes.json") { special[path.slice(1)] = new TextDecoder().decode(bytes); continue; }
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

  const { result: up } = await client.request("GET", `/accounts/${account}/pages/projects/${project}/upload-token`);
  const jwt = up && up.jwt;
  if (!jwt) throw new Error("no upload token from Cloudflare");
  const assets = async (path, body) => {
    const r = await fetch(`https://api.cloudflare.com/client/v4/pages/assets/${path}`, { method: "POST", headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!j.success) throw new Error(`pages assets/${path} failed: ${(j.errors && j.errors[0] && j.errors[0].message) || r.status}`);
    return j.result;
  };
  const unique = [...new Map(entries.map((e) => [e.hash, e])).values()];
  const missing = new Set(await assets("check-missing", { hashes: unique.map((e) => e.hash) }));
  let batch = [], size = 0;
  const flush = async () => { if (batch.length) await assets("upload", batch); batch = []; size = 0; };
  for (const e of unique) {
    if (!missing.has(e.hash)) continue;
    if (batch.length >= 1000 || size + e.b64.length > 40 * 1024 * 1024) await flush();
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
  if (!j.success) throw new Error(`create deployment failed: ${(j.errors && j.errors[0] && j.errors[0].message) || r.status}`);
  return { applied: true, ...plan, uploaded: missing.size, deployment: { id: j.result.id, url: j.result.url, environment: j.result.environment } };
}

async function wranglerDoctor(client, args, altClient) {
  const out = { accounts: {} };
  const base = client;
  for (const [alias, id] of Object.entries(PAGES_ACCOUNT_ALIASES)) {
    client = (altClient && altClient(id)) || base;
    try {
      const all = [];
      for (let page = 1; page <= 10; page++) {
        const { result } = await client.request("GET", `/accounts/${id}/pages/projects?per_page=10&page=${page}`);
        all.push(...(result || []));
        if (!result || result.length < 10) break;
      }
      let workers = null;
      try { const { result } = await client.request("GET", `/accounts/${id}/workers/scripts`); workers = (result || []).map((w) => w.id); } catch (e) { workers = "unreadable: " + String(e.message || e).slice(0, 80); }
      out.accounts[alias] = { id, pages_projects: all.map((p) => ({ name: p.name, production_branch: p.production_branch, domains: p.domains })), workers };
    } catch (e) {
      out.accounts[alias] = { id, error: String(e.message || e).slice(0, 200) };
    }
  }
  if (args.project) {
    client = (altClient && altClient(pagesAccount(args.account || "amh"))) || base;
    try {
      const account = pagesAccount(args.account || "amh"), project = pagesProject(args.project);
      const p = await pagesGetProject(client, account, project);
      out.project = { name: project, production_branch: p.production_branch, domains: p.domains, live_deployment: p.canonical_deployment && { id: p.canonical_deployment.id, url: p.canonical_deployment.url, created_on: p.canonical_deployment.created_on }, latest: p.latest_deployment && { id: p.latest_deployment.id, env: p.latest_deployment.environment, created_on: p.latest_deployment.created_on } };
    } catch (e) { out.project = { error: String(e.message || e).slice(0, 200) }; }
  }
  return out;
}

var PAGES_DEPLOY_TOOL_DEFS = [
  { name: "pages_deploy", description: "Deploy a COMPLETE built static site to a Cloudflare Pages project through the API (like `wrangler pages deploy`, no PC needed). Dry-run by default; apply=true uploads and deploys. branch = production branch goes LIVE; any other branch is a preview URL. A deploy replaces the whole site, so send every file. To change only a few files on a live site use pages_patch (or pass patch=true with edits [{path,find,replace}] here). Static only (no functions/). artificialmindhive production is refused.",
    inputSchema: { type: "object", properties: {
      account: { type: "string", description: "amh (pain2hustle1) or doors (austinsdoors1), or an account id" },
      project: { type: "string" }, branch: { type: "string", description: "default = production branch" },
      files: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string", description: "text file contents" }, content_base64: { type: "string", description: "binary file contents" } }, required: ["path"] } },
      commit_message: { type: "string" }, commit_hash: { type: "string" }, apply: { type: "boolean" },
    }, required: ["account", "project", "files"] } },
  { name: "pages_list_deployments", description: "List recent deployments of a Pages project, marking the one serving production. Read-only.",
    inputSchema: { type: "object", properties: { account: { type: "string" }, project: { type: "string" }, limit: { type: "number" } }, required: ["account", "project"] } },
  { name: "pages_get_deployment", description: "Details of one Pages deployment: url, branch, stages, commit message. Pass path (+ optional find) to read that file's RAW live text instead. Read-only.",
    inputSchema: { type: "object", properties: { account: { type: "string" }, project: { type: "string" }, deployment_id: { type: "string" } }, required: ["account", "project", "deployment_id"] } },
  { name: "pages_rollback", description: "Put a past production deployment back live. Dry-run by default; apply=true rolls back. artificialmindhive needs force=true plus a note.",
    inputSchema: { type: "object", properties: { account: { type: "string" }, project: { type: "string" }, deployment_id: { type: "string" }, apply: { type: "boolean" }, force: { type: "boolean" }, note: { type: "string" } }, required: ["account", "project", "deployment_id"] } },
  { name: "wrangler_doctor", description: "One-call health check: Pages projects (with production branch + domains) and Workers on both accounts, plus live vs latest deployment for one project. Read-only.",
    inputSchema: { type: "object", properties: { account: { type: "string" }, project: { type: "string" } } } },
];
// pages-patch.js — change a FEW files on a live Pages site without sending the whole site.
// Takes the live production deployment's {path: hash} manifest, swaps in only the files the
// agent sends (or deletes), and creates a new deployment from that. Every other file stays
// byte-identical to what is live. _redirects/_headers are not in Cloudflare's manifest, so the
// hub keeps the last known copy per project in KV (pages:special:<account>:<project>) and
// re-sends it; a patch is refused if it would silently drop them.
// Injected into the live hub bundle by inject-pages-patch.cjs (uses helpers from pages-deploy.js).

var PATCH_MAX_FILES = 200;

async function pagesSpecialGet(env, account, project) {
  if (!env || !env.CLOUDFLARE_OPS_OAUTH) return null;
  return await env.CLOUDFLARE_OPS_OAUTH.get(`pages:special:${account}:${project}`, "json");
}
async function pagesSpecialPut(env, account, project, special) {
  if (!env || !env.CLOUDFLARE_OPS_OAUTH || !special || !Object.keys(special).length) return;
  await env.CLOUDFLARE_OPS_OAUTH.put(`pages:special:${account}:${project}`, JSON.stringify({ ...special, saved: new Date().toISOString() }));
}

// Fetch one file as it is served by a deployment's own URL (no proxy, no custom-domain cache).
// Pages 308s /x.html -> /x, so redirects are followed but must stay on the same page.
async function pagesFetchLiveFile(deployUrl, path) {
  const u = new URL(path, deployUrl);
  const res = await fetch(u.toString(), { redirect: "follow" });
  const landed = new URL(res.url || u.toString()).pathname.replace(/\/$/, "");
  const want = path.replace(/\.html$/, "").replace(/\/index$/, "").replace(/\/$/, "");
  if (res.status !== 200) throw new Error(`${path} returned ${res.status} on the live deployment`);
  if (landed !== want && landed !== path) throw new Error(`${path} redirected to ${landed}; read that path instead`);
  return new Uint8Array(await res.arrayBuffer());
}

// JSON bodies of <script> tags (TradingView-style widget configs, ld+json, inline data).
function pagesJsonBlocks(html) {
  const out = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const body = m[1].trim();
    if (!/^[\[{]/.test(body)) continue;
    try { JSON.parse(body); out.push({ ok: true }); } catch (e) { out.push({ ok: false, error: String(e.message || e).slice(0, 140) }); }
  }
  return out;
}

// worker.checks: [{path, status, contains?}] — plus worker.expect_title on "/".
async function pagesHealth(deployUrl, worker) {
  const results = [];
  const checks = [...(worker.expect_title ? [{ path: "/", status: 200, contains: `<title>${worker.expect_title}</title>` }] : []), ...(worker.checks || [])];
  for (const c of checks) {
    let got = null;
    for (let i = 0; i < 6; i++) {
      if (i) await new Promise((r) => setTimeout(r, 3000));
      try {
        const res = await fetch(new URL(c.path, deployUrl).toString(), { redirect: "follow" });
        const body = await res.text();
        got = { path: c.path, status: res.status, ok: res.status === (c.status || 200) && (!c.contains || body.includes(c.contains)) };
      } catch (e) { got = { path: c.path, ok: false, error: String(e.message || e).slice(0, 100) }; }
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
    const around = Math.min(Math.max(Number(args.around) || 300, 0), 4000);
    const hits = [];
    let i = text.indexOf(find);
    while (i !== -1 && hits.length < 10) { hits.push({ at: i, snippet: text.slice(Math.max(0, i - around), i + find.length + around) }); i = text.indexOf(find, i + 1); }
    let n = 0, j = text.indexOf(find); while (j !== -1) { n++; j = text.indexOf(find, j + 1); }
    return { ...out, find, occurrences: n, hits };
  }
  const offset = Math.max(Number(args.offset) || 0, 0), length = Math.min(Math.max(Number(args.length) || 20000, 1), 60000);
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
  // Sites with server code (_worker / Functions): Cloudflare never returns the deployed worker, so the
  // owner's deploy script stores the exact _worker.bundle wrangler uploaded, tagged with the deployment
  // it went live as. A patch re-attaches it only if live is still that deployment (or one of our patches).
  let worker = null;
  if (base.uses_functions || PAGES_PROTECTED.has(project)) {
    worker = env && env.CLOUDFLARE_OPS_OAUTH ? await env.CLOUDFLARE_OPS_OAUTH.get(`pages:worker:${account}:${project}`, "json") : null;
    if (!worker || !worker.bundle_b64) return { error: `${project} runs server code and the hub has no saved worker bundle for it, so it can't be patched in place. On a Walrus Tusk user key, run site_autodeploy once (deploys the site from its GitHub repo on every merge), then change it with repo_commit_push + repo_open_pr + repo_merge_pr.` };
    const known = [worker.for_deployment, ...(worker.deployments || [])];
    if (!known.includes(live.id)) return { error: `${project} live deployment (${live.id.slice(0, 8)}) is not the one the saved worker bundle belongs to (${String(worker.for_deployment).slice(0, 8)}). Someone deployed outside the hub; the owner must refresh it (npm run deploy in amh-hive). Nothing deployed.` };
  }
  const manifest = { ...(base.files || {}) };
  if (!Object.keys(manifest).length) return { error: "Cloudflare returned an empty file list for the live deployment; refusing to patch" };

  const files = Array.isArray(args.files) ? args.files.slice() : [];
  const editLog = [];
  const edits = Array.isArray(args.edits) ? args.edits : [];
  if (edits.length) {
    const byPath = new Map();
    for (const e of edits) { const ep = pagesPath(e.path); if (!byPath.has(ep)) byPath.set(ep, []); byPath.get(ep).push(e); }
    for (const [ep, list] of byPath) {
      if (!manifest[ep]) throw new Error(`${ep} is not in the live site; send it in files to add it`);
      let text = new TextDecoder().decode(await pagesFetchLiveFile(base.url, ep));
      for (const e of list) {
        const find = String(e.find ?? ""), repl = String(e.replace ?? "");
        if (!find) throw new Error("each edit needs find (exact text from the live file)");
        let n = 0, k = text.indexOf(find); while (k !== -1) { n++; k = text.indexOf(find, k + find.length); }
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
    if (path === "/_headers" || path === "/_redirects" || path === "/_routes.json") { special[path.slice(1)] = new TextDecoder().decode(bytes); specialFromArgs = true; continue; }
    if (path.startsWith("/functions/") || path.startsWith("/_worker")) throw new Error("functions/_worker need a build step; patch static files only");
    const ext = (path.match(/\.([a-z0-9]+)$/i) || [])[1] || "";
    const b64 = bytesToB64(bytes);
    entries.push({ path, b64, ext, size: bytes.length, type: PAGES_TYPES[ext.toLowerCase()] || "application/octet-stream", hash: await pagesHash(b64, ext) });
  }
  if (total > PAGES_MAX_BYTES) throw new Error("patch over 60 MiB");
  if (!special._redirects && !special._headers && args.no_redirects !== true) {
    return { error: `the hub has no saved _redirects/_headers for ${project}, and Cloudflare doesn't return them. Fix (once per site): if the site's source is on GitHub, read its _redirects and _headers with repo_read and save them with pages_special_files (or include them in files). If you're not sure, ask the user. If the site has neither file, pass no_redirects=true.` };
  }

  const changed = entries.map((e) => ({ path: e.path, action: manifest[e.path] ? (manifest[e.path] === e.hash ? "same" : "replace") : "add", bytes: e.size }));
  const missingDeletes = deletes.filter((d) => !manifest[d]);
  const plan = {
    project, account, branch, production, domains_affected: production ? p.domains : [],
    base_deployment: live.id, live_files: Object.keys(base.files || {}).length,
    changed, edits: editLog, deleted: deletes.filter((d) => manifest[d]), delete_not_found: missingDeletes,
    special_files: Object.keys(special), special_source: specialFromArgs ? "sent in this call" : "hub saved copy",
    rollback_hint: { tool: "pages_rollback", deployment_id: live.id },
  };
  if (args.apply !== true) return { dry_run: true, ...plan, warning: production ? "PRODUCTION: only the files above change on " + (p.domains || []).join(", ") : "preview branch only", next: "call again with apply=true" };

  for (const e of entries) manifest[e.path] = e.hash;
  for (const d of deletes) delete manifest[d];

  const { result: up } = await client.request("GET", `/accounts/${account}/pages/projects/${project}/upload-token`);
  const jwt = up && up.jwt;
  if (!jwt) throw new Error("no upload token from Cloudflare");
  const assets = async (path, body) => {
    const r = await fetch(`https://api.cloudflare.com/client/v4/pages/assets/${path}`, { method: "POST", headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!j.success) throw new Error(`pages assets/${path} failed: ${(j.errors && j.errors[0] && j.errors[0].message) || r.status}`);
    return j.result;
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
    // anything else wrangler sent for this project (Functions routing config, wrangler config hash, ...)
    for (const [name, part] of Object.entries(worker.extra || {})) {
      if (part.file) form.append(name, new File([b64ToBytes(part.b64)], name));
      else form.append(name, new TextDecoder().decode(b64ToBytes(part.b64)));
    }
  }
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/${project}/deployments`, { method: "POST", headers: { authorization: `Bearer ${client._token}` }, body: form });
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error(`create deployment failed: ${(j.errors && j.errors[0] && j.errors[0].message) || r.status}`);
  if (specialFromArgs) await pagesSpecialPut(env, account, project, special);

  // Server-code sites: prove the new deployment still works (title + worker endpoints) or roll back.
  if (worker && production) {
    const health = await pagesHealth(j.result.url, worker);
    if (!health.ok) {
      let rolled = null;
      try { await client.request("POST", `/accounts/${account}/pages/projects/${project}/deployments/${live.id}/rollback`); rolled = live.id; } catch (e) { rolled = "ROLLBACK FAILED: " + String(e.message || e).slice(0, 120); }
      return { error: "health check failed after deploy; rolled back automatically", rolled_back_to: rolled, health, deployment: { id: j.result.id, url: j.result.url } };
    }
    worker.deployments = [...new Set([...(worker.deployments || []), worker.for_deployment, j.result.id])].slice(-50);
    worker.for_deployment = j.result.id;
    worker.updated_by_patch = new Date().toISOString();
    await env.CLOUDFLARE_OPS_OAUTH.put(`pages:worker:${account}:${project}`, JSON.stringify(worker));
    plan.health = health;
  }

  // check each changed file on the new deployment's own URL (bypasses any proxy/cache in front of the domain)
  const checks = [];
  for (const e of entries.slice(0, 10)) {
    try {
      const u = new URL(e.path, j.result.url);
      let res, ok = false;
      for (let i = 0; i < 5 && !ok; i++) {
        if (i) await new Promise((r) => setTimeout(r, 3000));
        res = await fetch(u.toString(), { redirect: "follow" });
        ok = res.status === 200 && (await pagesHash(bytesToB64(new Uint8Array(await res.arrayBuffer())), e.ext)) === e.hash;
      }
      checks.push({ path: e.path, status: res.status, matches: ok });
    } catch (err) { checks.push({ path: e.path, error: String(err.message || err).slice(0, 120) }); }
  }
  if (env && env.CLOUDFLARE_OPS_OAUTH) {
    await env.CLOUDFLARE_OPS_OAUTH.put(`patchlog:${project}:${Date.now()}`, JSON.stringify({ account, project, branch, base: live.id, deployment: j.result.id, changed, deleted: plan.deleted, actor: actor || "unknown", at: new Date().toISOString() }), { expirationTtl: 60 * 60 * 24 * 90 });
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
    return { project, saved: cur ? Object.keys(cur).filter((k) => k !== "saved") : [], saved_at: cur && cur.saved, ...(cur || {}) };
  }
  await pagesSpecialPut(env, account, project, special);
  return { ok: true, project, saved: Object.keys(special) };
}

var PAGES_PATCH_TOOL_DEFS = [
  { name: "pages_read_file", description: "Read the RAW text of one file exactly as the live production deployment serves it (no summarizer, no proxy). Use find to get the exact snippet(s) around a string; else returns content in chunks (offset/length). Read-only.",
    inputSchema: { type: "object", properties: { account: { type: "string" }, project: { type: "string" }, path: { type: "string", description: "e.g. insights.html" }, find: { type: "string" }, around: { type: "number", description: "chars of context each side (default 300)" }, offset: { type: "number" }, length: { type: "number" } }, required: ["account", "project", "path"] } },
  { name: "pages_patch", description: "Change ONLY a few files on a live Pages site (no PC, no full file set). Best: edits [{path, find, replace}] — the hub fetches the live file, replaces the exact text (must match once), and deploys. Or files [{path, content}] for whole changed files. The hub copies the live deployment's file list, swaps in the changes (and removes any in delete), keeps _redirects/_headers, and deploys. Every other file stays exactly as live. Dry-run by default; apply=true deploys. branch = production branch goes LIVE, any other = preview. Returns rollback_hint. Sites with server code (artificialmindhive) re-attach the owner-saved worker bundle and get a title + API health check after deploy, with automatic rollback on failure.",
    inputSchema: { type: "object", properties: {
      account: { type: "string", description: "amh (pain2hustle1) or doors (austinsdoors1)" },
      project: { type: "string" }, branch: { type: "string", description: "default = production branch (LIVE)" },
      edits: { type: "array", description: "exact find/replace on live files", items: { type: "object", properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" }, count: { type: "number", description: "expected matches, default 1" } }, required: ["path", "find", "replace"] } },
      files: { type: "array", description: "ONLY the changed/new files", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, content_base64: { type: "string" } }, required: ["path"] } },
      delete: { type: "array", items: { type: "string" }, description: "paths to remove from the site" },
      commit_message: { type: "string" }, apply: { type: "boolean" }, no_redirects: { type: "boolean" },
    }, required: ["account", "project"] } },
  { name: "pages_special_files", description: "Read (no args besides account/project) or save the hub's copy of a project's _redirects/_headers, which pages_patch re-sends on every patch.",
    inputSchema: { type: "object", properties: { account: { type: "string" }, project: { type: "string" }, _redirects: { type: "string" }, _headers: { type: "string" } }, required: ["account", "project"] } },
];

// github-tools.js — Austin's GitHub (pain2hustle/* and pain2hustle1/*) from the hub, no PC. Same tool names/shapes as
// the PC ops server (repo_list / repo_read / repo_commit_push / repo_open_pr) plus repo_search.
// Writes are fenced in code, because the token itself is broad:
//   - only branches grok/<name> or agent/<name>; never the default branch, never force, never delete a branch
//   - never anything under .github/ (workflows run with repo secrets)
// Uses the git data API, so one call = one commit, however many files.

var GH_OWNER = "pain2hustle";
var GH_OWNERS = ["pain2hustle", "pain2hustle1"]; // Austin's two GitHub accounts (the token is a collaborator on pain2hustle1 repos)
var GH_BRANCH_RE = /^(grok|agent)\/[A-Za-z0-9._-]{1,60}$/;
var GH_MAX_FILES = 100, GH_MAX_BYTES = 20 * 1024 * 1024;

async function gh(env, method, path, body, accept) {
  if (!env.GITHUB_TOKEN) throw new Error("no GitHub token: add one at /setup");
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: accept || "application/vnd.github+json", "user-agent": "amh-cfops-hub", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (accept && accept.includes("raw") && r.ok) return await r.arrayBuffer();
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`GitHub ${method} ${path.split("?")[0]}: ${r.status} ${j.message || ""}`.trim()); e.status = r.status; throw e; }
  return j;
}
// owners/token can be overridden per request (WT user keys use their own GitHub token + login)
function ghOwners(env) { return (env && env.GH_OWNERS_OVERRIDE) || GH_OWNERS; }
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
  for (let page = 1; page <= 5; page++) {
    const r = await gh(env, "GET", `/user/repos?per_page=100&page=${page}&affiliation=owner,collaborator&sort=pushed`);
    out.push(...r);
    if (r.length < 100) break;
  }
  const q = String(args.q || "").toLowerCase();
  const OWNERS = ghOwners(env).map((o) => o.toLowerCase());
  return { owners: ghOwners(env), repos: out.filter((r) => OWNERS.includes(r.owner.login.toLowerCase()) && (!q || (r.name + " " + (r.description || "")).toLowerCase().includes(q)))
    .map((r) => ({ repo: r.full_name, private: r.private, default_branch: r.default_branch, pushed_at: r.pushed_at, description: r.description, url: r.html_url })) };
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
    const around = Math.min(Math.max(Number(args.around) || 300, 0), 4000), hits = [];
    let i = text.indexOf(find), n = 0;
    while (i !== -1) { n++; if (hits.length < 10) hits.push({ at: i, snippet: text.slice(Math.max(0, i - around), i + find.length + around) }); i = text.indexOf(find, i + 1); }
    return { ...out, find, occurrences: n, hits };
  }
  const offset = Math.max(Number(args.offset) || 0, 0), length = Math.min(Math.max(Number(args.length) || 20000, 1), 60000);
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
  try { headSha = (await gh(env, "GET", `/repos/${repo}/git/ref/heads/${ghEnc(branch)}`)).object.sha; }
  catch (e) {
    if (e.status !== 404) throw e;
    headSha = (await gh(env, "GET", `/repos/${repo}/git/ref/heads/${ghEnc(info.default_branch)}`)).object.sha;
    created = true;
  }
  const headCommit = await gh(env, "GET", `/repos/${repo}/git/commits/${headSha}`);

  const tree = [], log = [];
  let total = 0;
  const readAt = async (p) => new TextDecoder().decode(await gh(env, "GET", `/repos/${repo}/contents/${ghEnc(p)}?ref=${headSha}`, null, "application/vnd.github.raw"));
  const byPath = new Map();
  for (const e of edits) { const p = ghWritable(ghPath(e.path)); if (!byPath.has(p)) byPath.set(p, []); byPath.get(p).push(e); }
  for (const [p, list] of byPath) {
    let text = await readAt(p);
    for (const e of list) {
      const find = String(e.find ?? ""), repl = String(e.replace ?? "");
      if (!find) throw new Error("each edit needs find");
      let n = 0, k = text.indexOf(find); while (k !== -1) { n++; k = text.indexOf(find, k + find.length); }
      const want = e.count != null ? Number(e.count) : 1;
      if (n !== want) throw new Error(`${p}: find occurs ${n} time(s), expected ${want}. Use repo_read with find to see the exact text.`);
      text = text.split(find).join(repl);
    }
    files.push({ path: p, content: text });
  }
  for (const f of files) {
    const p = ghWritable(ghPath(f.path));
    if (!p) throw new Error("empty path");
    if (f.delete === true) { tree.push({ path: p, mode: "100644", type: "blob", sha: null }); log.push({ path: p, action: "delete" }); continue; }
    const b64 = f.encoding === "base64" || f.content_base64 != null;
    const content = String(f.content_base64 ?? f.content ?? "");
    total += content.length;
    if (total > GH_MAX_BYTES) throw new Error("commit over 20 MB");
    const blob = await gh(env, "POST", `/repos/${repo}/git/blobs`, { content, encoding: b64 ? "base64" : "utf-8" });
    tree.push({ path: p, mode: "100644", type: "blob", sha: blob.sha });
    log.push({ path: p, action: "write", bytes: content.length });
  }
  const newTree = await gh(env, "POST", `/repos/${repo}/git/trees`, { base_tree: headCommit.tree.sha, tree });
  const author = { name: String(args.author || "Bucktooth (Grok)").slice(0, 80), email: "agents@artificialmindhive.com", date: new Date().toISOString() };
  const commit = await gh(env, "POST", `/repos/${repo}/git/commits`, { message: `${message}\n\nvia cfops hub (${actor || "agent"})`, tree: newTree.sha, parents: [headSha], author });
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
  const pr = await gh(env, "POST", `/repos/${repo}/pulls`, { title: String(args.title || branch).slice(0, 200), head: branch, base: info.default_branch, body: String(args.body || "Opened by an agent through the Walrus Tusk MCP hub. Review and merge.").slice(0, 20000) });
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
  { name: "repo_list", description: "List Austin's GitHub repos (pain2hustle/* and pain2hustle1/*): default branch, last push, private flag. Optional q filters by name/description. No PC needed.",
    inputSchema: { type: "object", properties: { q: { type: "string" } } } },
  { name: "repo_read", description: "Read a file (raw text) or list a folder from a pain2hustle repo at a branch/ref. Use find (+around) to get exact snippets, or offset/length for big files. No PC needed.",
    inputSchema: { type: "object", properties: { repo: { type: "string", description: "pain2hustle/<name>, pain2hustle1/<name>, or <name> (= pain2hustle)" }, path: { type: "string" }, ref: { type: "string" }, find: { type: "string" }, around: { type: "number" }, offset: { type: "number" }, length: { type: "number" } }, required: ["repo"] } },
  { name: "repo_search", description: "Search code inside one pain2hustle repo (GitHub code search). Returns matching file paths.",
    inputSchema: { type: "object", properties: { repo: { type: "string" }, query: { type: "string" } }, required: ["repo", "query"] } },
  { name: "repo_commit_push", description: "Commit to a grok/<name> (or agent/<name>) branch on GitHub in ONE commit, no PC. Branch is created from the default branch if new. files [{path, content, encoding?:'base64', delete?:true}] and/or edits [{path, find, replace}] applied to the branch's current file. Never touches the default branch, never force-pushes, never writes .github/.",
    inputSchema: { type: "object", properties: {
      repo: { type: "string" }, branch: { type: "string", description: "grok/<short-name>" }, message: { type: "string" },
      files: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, encoding: { type: "string", enum: ["utf8", "base64"] }, delete: { type: "boolean" } }, required: ["path"] } },
      edits: { type: "array", items: { type: "object", properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" }, count: { type: "number" } }, required: ["path", "find", "replace"] } },
      author: { type: "string" },
    }, required: ["repo", "branch", "message"] } },
  { name: "repo_open_pr", description: "Open (or find) a pull request from a grok/<name> branch into the default branch so Austin can review and merge.",
    inputSchema: { type: "object", properties: { repo: { type: "string" }, branch: { type: "string" }, title: { type: "string" }, body: { type: "string" } }, required: ["repo", "branch", "title"] } },
];
GITHUB_TOOL_DEFS.push({ name: "repo_merge_pr", description: "Merge an open grok/* or agent/* pull request into the default branch (normal merge commit, history kept, no force). Refused if the PR touches .github/.",
  inputSchema: { type: "object", properties: { repo: { type: "string" }, number: { type: "number" }, branch: { type: "string", description: "or give the PR's branch" } }, required: ["repo"] } });
var GITHUB_TOOLS = new Set(GITHUB_TOOL_DEFS.map((t) => t.name));
async function runGithubTool(name, args, env, actor) {
  try {
    if (name === "repo_list") return await ghRepoList(env, args);
    if (name === "repo_read") return await ghRead(env, args);
    if (name === "repo_search") return await ghSearch(env, args);
    if (name === "repo_commit_push") return await ghCommitPush(env, args, actor);
    if (name === "repo_open_pr") return await ghOpenPr(env, args);
    if (name === "repo_merge_pr") return await ghMergePr(env, args);
  } catch (e) { return { error: String((e && e.message) || e).slice(0, 600) }; }
  return { error: "unknown repo tool" };
}

// sealed-box.js — libsodium crypto_box_seal, needed to set GitHub Actions secrets from the hub.
// Vendored, unmodified: tweetnacl 1.0.3 (nacl-fast.js, public domain / Unlicense) and blakejs 1.2.1
// (util.js + blake2b.js, CC0). Generated by scripts/build-sealed-box.cjs — do not edit by hand.
var __wtNacl = (function () { var module = { exports: {} }; var exports = module.exports; var require = undefined;
(function(nacl) {
'use strict';

// Ported in 2014 by Dmitry Chestnykh and Devi Mandiri.
// Public domain.
//
// Implementation derived from TweetNaCl version 20140427.
// See for details: http://tweetnacl.cr.yp.to/

var gf = function(init) {
  var i, r = new Float64Array(16);
  if (init) for (i = 0; i < init.length; i++) r[i] = init[i];
  return r;
};

//  Pluggable, initialized in high-level API below.
var randombytes = function(/* x, n */) { throw new Error('no PRNG'); };

var _0 = new Uint8Array(16);
var _9 = new Uint8Array(32); _9[0] = 9;

var gf0 = gf(),
    gf1 = gf([1]),
    _121665 = gf([0xdb41, 1]),
    D = gf([0x78a3, 0x1359, 0x4dca, 0x75eb, 0xd8ab, 0x4141, 0x0a4d, 0x0070, 0xe898, 0x7779, 0x4079, 0x8cc7, 0xfe73, 0x2b6f, 0x6cee, 0x5203]),
    D2 = gf([0xf159, 0x26b2, 0x9b94, 0xebd6, 0xb156, 0x8283, 0x149a, 0x00e0, 0xd130, 0xeef3, 0x80f2, 0x198e, 0xfce7, 0x56df, 0xd9dc, 0x2406]),
    X = gf([0xd51a, 0x8f25, 0x2d60, 0xc956, 0xa7b2, 0x9525, 0xc760, 0x692c, 0xdc5c, 0xfdd6, 0xe231, 0xc0a4, 0x53fe, 0xcd6e, 0x36d3, 0x2169]),
    Y = gf([0x6658, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666]),
    I = gf([0xa0b0, 0x4a0e, 0x1b27, 0xc4ee, 0xe478, 0xad2f, 0x1806, 0x2f43, 0xd7a7, 0x3dfb, 0x0099, 0x2b4d, 0xdf0b, 0x4fc1, 0x2480, 0x2b83]);

function ts64(x, i, h, l) {
  x[i]   = (h >> 24) & 0xff;
  x[i+1] = (h >> 16) & 0xff;
  x[i+2] = (h >>  8) & 0xff;
  x[i+3] = h & 0xff;
  x[i+4] = (l >> 24)  & 0xff;
  x[i+5] = (l >> 16)  & 0xff;
  x[i+6] = (l >>  8)  & 0xff;
  x[i+7] = l & 0xff;
}

function vn(x, xi, y, yi, n) {
  var i,d = 0;
  for (i = 0; i < n; i++) d |= x[xi+i]^y[yi+i];
  return (1 & ((d - 1) >>> 8)) - 1;
}

function crypto_verify_16(x, xi, y, yi) {
  return vn(x,xi,y,yi,16);
}

function crypto_verify_32(x, xi, y, yi) {
  return vn(x,xi,y,yi,32);
}

function core_salsa20(o, p, k, c) {
  var j0  = c[ 0] & 0xff | (c[ 1] & 0xff)<<8 | (c[ 2] & 0xff)<<16 | (c[ 3] & 0xff)<<24,
      j1  = k[ 0] & 0xff | (k[ 1] & 0xff)<<8 | (k[ 2] & 0xff)<<16 | (k[ 3] & 0xff)<<24,
      j2  = k[ 4] & 0xff | (k[ 5] & 0xff)<<8 | (k[ 6] & 0xff)<<16 | (k[ 7] & 0xff)<<24,
      j3  = k[ 8] & 0xff | (k[ 9] & 0xff)<<8 | (k[10] & 0xff)<<16 | (k[11] & 0xff)<<24,
      j4  = k[12] & 0xff | (k[13] & 0xff)<<8 | (k[14] & 0xff)<<16 | (k[15] & 0xff)<<24,
      j5  = c[ 4] & 0xff | (c[ 5] & 0xff)<<8 | (c[ 6] & 0xff)<<16 | (c[ 7] & 0xff)<<24,
      j6  = p[ 0] & 0xff | (p[ 1] & 0xff)<<8 | (p[ 2] & 0xff)<<16 | (p[ 3] & 0xff)<<24,
      j7  = p[ 4] & 0xff | (p[ 5] & 0xff)<<8 | (p[ 6] & 0xff)<<16 | (p[ 7] & 0xff)<<24,
      j8  = p[ 8] & 0xff | (p[ 9] & 0xff)<<8 | (p[10] & 0xff)<<16 | (p[11] & 0xff)<<24,
      j9  = p[12] & 0xff | (p[13] & 0xff)<<8 | (p[14] & 0xff)<<16 | (p[15] & 0xff)<<24,
      j10 = c[ 8] & 0xff | (c[ 9] & 0xff)<<8 | (c[10] & 0xff)<<16 | (c[11] & 0xff)<<24,
      j11 = k[16] & 0xff | (k[17] & 0xff)<<8 | (k[18] & 0xff)<<16 | (k[19] & 0xff)<<24,
      j12 = k[20] & 0xff | (k[21] & 0xff)<<8 | (k[22] & 0xff)<<16 | (k[23] & 0xff)<<24,
      j13 = k[24] & 0xff | (k[25] & 0xff)<<8 | (k[26] & 0xff)<<16 | (k[27] & 0xff)<<24,
      j14 = k[28] & 0xff | (k[29] & 0xff)<<8 | (k[30] & 0xff)<<16 | (k[31] & 0xff)<<24,
      j15 = c[12] & 0xff | (c[13] & 0xff)<<8 | (c[14] & 0xff)<<16 | (c[15] & 0xff)<<24;

  var x0 = j0, x1 = j1, x2 = j2, x3 = j3, x4 = j4, x5 = j5, x6 = j6, x7 = j7,
      x8 = j8, x9 = j9, x10 = j10, x11 = j11, x12 = j12, x13 = j13, x14 = j14,
      x15 = j15, u;

  for (var i = 0; i < 20; i += 2) {
    u = x0 + x12 | 0;
    x4 ^= u<<7 | u>>>(32-7);
    u = x4 + x0 | 0;
    x8 ^= u<<9 | u>>>(32-9);
    u = x8 + x4 | 0;
    x12 ^= u<<13 | u>>>(32-13);
    u = x12 + x8 | 0;
    x0 ^= u<<18 | u>>>(32-18);

    u = x5 + x1 | 0;
    x9 ^= u<<7 | u>>>(32-7);
    u = x9 + x5 | 0;
    x13 ^= u<<9 | u>>>(32-9);
    u = x13 + x9 | 0;
    x1 ^= u<<13 | u>>>(32-13);
    u = x1 + x13 | 0;
    x5 ^= u<<18 | u>>>(32-18);

    u = x10 + x6 | 0;
    x14 ^= u<<7 | u>>>(32-7);
    u = x14 + x10 | 0;
    x2 ^= u<<9 | u>>>(32-9);
    u = x2 + x14 | 0;
    x6 ^= u<<13 | u>>>(32-13);
    u = x6 + x2 | 0;
    x10 ^= u<<18 | u>>>(32-18);

    u = x15 + x11 | 0;
    x3 ^= u<<7 | u>>>(32-7);
    u = x3 + x15 | 0;
    x7 ^= u<<9 | u>>>(32-9);
    u = x7 + x3 | 0;
    x11 ^= u<<13 | u>>>(32-13);
    u = x11 + x7 | 0;
    x15 ^= u<<18 | u>>>(32-18);

    u = x0 + x3 | 0;
    x1 ^= u<<7 | u>>>(32-7);
    u = x1 + x0 | 0;
    x2 ^= u<<9 | u>>>(32-9);
    u = x2 + x1 | 0;
    x3 ^= u<<13 | u>>>(32-13);
    u = x3 + x2 | 0;
    x0 ^= u<<18 | u>>>(32-18);

    u = x5 + x4 | 0;
    x6 ^= u<<7 | u>>>(32-7);
    u = x6 + x5 | 0;
    x7 ^= u<<9 | u>>>(32-9);
    u = x7 + x6 | 0;
    x4 ^= u<<13 | u>>>(32-13);
    u = x4 + x7 | 0;
    x5 ^= u<<18 | u>>>(32-18);

    u = x10 + x9 | 0;
    x11 ^= u<<7 | u>>>(32-7);
    u = x11 + x10 | 0;
    x8 ^= u<<9 | u>>>(32-9);
    u = x8 + x11 | 0;
    x9 ^= u<<13 | u>>>(32-13);
    u = x9 + x8 | 0;
    x10 ^= u<<18 | u>>>(32-18);

    u = x15 + x14 | 0;
    x12 ^= u<<7 | u>>>(32-7);
    u = x12 + x15 | 0;
    x13 ^= u<<9 | u>>>(32-9);
    u = x13 + x12 | 0;
    x14 ^= u<<13 | u>>>(32-13);
    u = x14 + x13 | 0;
    x15 ^= u<<18 | u>>>(32-18);
  }
   x0 =  x0 +  j0 | 0;
   x1 =  x1 +  j1 | 0;
   x2 =  x2 +  j2 | 0;
   x3 =  x3 +  j3 | 0;
   x4 =  x4 +  j4 | 0;
   x5 =  x5 +  j5 | 0;
   x6 =  x6 +  j6 | 0;
   x7 =  x7 +  j7 | 0;
   x8 =  x8 +  j8 | 0;
   x9 =  x9 +  j9 | 0;
  x10 = x10 + j10 | 0;
  x11 = x11 + j11 | 0;
  x12 = x12 + j12 | 0;
  x13 = x13 + j13 | 0;
  x14 = x14 + j14 | 0;
  x15 = x15 + j15 | 0;

  o[ 0] = x0 >>>  0 & 0xff;
  o[ 1] = x0 >>>  8 & 0xff;
  o[ 2] = x0 >>> 16 & 0xff;
  o[ 3] = x0 >>> 24 & 0xff;

  o[ 4] = x1 >>>  0 & 0xff;
  o[ 5] = x1 >>>  8 & 0xff;
  o[ 6] = x1 >>> 16 & 0xff;
  o[ 7] = x1 >>> 24 & 0xff;

  o[ 8] = x2 >>>  0 & 0xff;
  o[ 9] = x2 >>>  8 & 0xff;
  o[10] = x2 >>> 16 & 0xff;
  o[11] = x2 >>> 24 & 0xff;

  o[12] = x3 >>>  0 & 0xff;
  o[13] = x3 >>>  8 & 0xff;
  o[14] = x3 >>> 16 & 0xff;
  o[15] = x3 >>> 24 & 0xff;

  o[16] = x4 >>>  0 & 0xff;
  o[17] = x4 >>>  8 & 0xff;
  o[18] = x4 >>> 16 & 0xff;
  o[19] = x4 >>> 24 & 0xff;

  o[20] = x5 >>>  0 & 0xff;
  o[21] = x5 >>>  8 & 0xff;
  o[22] = x5 >>> 16 & 0xff;
  o[23] = x5 >>> 24 & 0xff;

  o[24] = x6 >>>  0 & 0xff;
  o[25] = x6 >>>  8 & 0xff;
  o[26] = x6 >>> 16 & 0xff;
  o[27] = x6 >>> 24 & 0xff;

  o[28] = x7 >>>  0 & 0xff;
  o[29] = x7 >>>  8 & 0xff;
  o[30] = x7 >>> 16 & 0xff;
  o[31] = x7 >>> 24 & 0xff;

  o[32] = x8 >>>  0 & 0xff;
  o[33] = x8 >>>  8 & 0xff;
  o[34] = x8 >>> 16 & 0xff;
  o[35] = x8 >>> 24 & 0xff;

  o[36] = x9 >>>  0 & 0xff;
  o[37] = x9 >>>  8 & 0xff;
  o[38] = x9 >>> 16 & 0xff;
  o[39] = x9 >>> 24 & 0xff;

  o[40] = x10 >>>  0 & 0xff;
  o[41] = x10 >>>  8 & 0xff;
  o[42] = x10 >>> 16 & 0xff;
  o[43] = x10 >>> 24 & 0xff;

  o[44] = x11 >>>  0 & 0xff;
  o[45] = x11 >>>  8 & 0xff;
  o[46] = x11 >>> 16 & 0xff;
  o[47] = x11 >>> 24 & 0xff;

  o[48] = x12 >>>  0 & 0xff;
  o[49] = x12 >>>  8 & 0xff;
  o[50] = x12 >>> 16 & 0xff;
  o[51] = x12 >>> 24 & 0xff;

  o[52] = x13 >>>  0 & 0xff;
  o[53] = x13 >>>  8 & 0xff;
  o[54] = x13 >>> 16 & 0xff;
  o[55] = x13 >>> 24 & 0xff;

  o[56] = x14 >>>  0 & 0xff;
  o[57] = x14 >>>  8 & 0xff;
  o[58] = x14 >>> 16 & 0xff;
  o[59] = x14 >>> 24 & 0xff;

  o[60] = x15 >>>  0 & 0xff;
  o[61] = x15 >>>  8 & 0xff;
  o[62] = x15 >>> 16 & 0xff;
  o[63] = x15 >>> 24 & 0xff;
}

function core_hsalsa20(o,p,k,c) {
  var j0  = c[ 0] & 0xff | (c[ 1] & 0xff)<<8 | (c[ 2] & 0xff)<<16 | (c[ 3] & 0xff)<<24,
      j1  = k[ 0] & 0xff | (k[ 1] & 0xff)<<8 | (k[ 2] & 0xff)<<16 | (k[ 3] & 0xff)<<24,
      j2  = k[ 4] & 0xff | (k[ 5] & 0xff)<<8 | (k[ 6] & 0xff)<<16 | (k[ 7] & 0xff)<<24,
      j3  = k[ 8] & 0xff | (k[ 9] & 0xff)<<8 | (k[10] & 0xff)<<16 | (k[11] & 0xff)<<24,
      j4  = k[12] & 0xff | (k[13] & 0xff)<<8 | (k[14] & 0xff)<<16 | (k[15] & 0xff)<<24,
      j5  = c[ 4] & 0xff | (c[ 5] & 0xff)<<8 | (c[ 6] & 0xff)<<16 | (c[ 7] & 0xff)<<24,
      j6  = p[ 0] & 0xff | (p[ 1] & 0xff)<<8 | (p[ 2] & 0xff)<<16 | (p[ 3] & 0xff)<<24,
      j7  = p[ 4] & 0xff | (p[ 5] & 0xff)<<8 | (p[ 6] & 0xff)<<16 | (p[ 7] & 0xff)<<24,
      j8  = p[ 8] & 0xff | (p[ 9] & 0xff)<<8 | (p[10] & 0xff)<<16 | (p[11] & 0xff)<<24,
      j9  = p[12] & 0xff | (p[13] & 0xff)<<8 | (p[14] & 0xff)<<16 | (p[15] & 0xff)<<24,
      j10 = c[ 8] & 0xff | (c[ 9] & 0xff)<<8 | (c[10] & 0xff)<<16 | (c[11] & 0xff)<<24,
      j11 = k[16] & 0xff | (k[17] & 0xff)<<8 | (k[18] & 0xff)<<16 | (k[19] & 0xff)<<24,
      j12 = k[20] & 0xff | (k[21] & 0xff)<<8 | (k[22] & 0xff)<<16 | (k[23] & 0xff)<<24,
      j13 = k[24] & 0xff | (k[25] & 0xff)<<8 | (k[26] & 0xff)<<16 | (k[27] & 0xff)<<24,
      j14 = k[28] & 0xff | (k[29] & 0xff)<<8 | (k[30] & 0xff)<<16 | (k[31] & 0xff)<<24,
      j15 = c[12] & 0xff | (c[13] & 0xff)<<8 | (c[14] & 0xff)<<16 | (c[15] & 0xff)<<24;

  var x0 = j0, x1 = j1, x2 = j2, x3 = j3, x4 = j4, x5 = j5, x6 = j6, x7 = j7,
      x8 = j8, x9 = j9, x10 = j10, x11 = j11, x12 = j12, x13 = j13, x14 = j14,
      x15 = j15, u;

  for (var i = 0; i < 20; i += 2) {
    u = x0 + x12 | 0;
    x4 ^= u<<7 | u>>>(32-7);
    u = x4 + x0 | 0;
    x8 ^= u<<9 | u>>>(32-9);
    u = x8 + x4 | 0;
    x12 ^= u<<13 | u>>>(32-13);
    u = x12 + x8 | 0;
    x0 ^= u<<18 | u>>>(32-18);

    u = x5 + x1 | 0;
    x9 ^= u<<7 | u>>>(32-7);
    u = x9 + x5 | 0;
    x13 ^= u<<9 | u>>>(32-9);
    u = x13 + x9 | 0;
    x1 ^= u<<13 | u>>>(32-13);
    u = x1 + x13 | 0;
    x5 ^= u<<18 | u>>>(32-18);

    u = x10 + x6 | 0;
    x14 ^= u<<7 | u>>>(32-7);
    u = x14 + x10 | 0;
    x2 ^= u<<9 | u>>>(32-9);
    u = x2 + x14 | 0;
    x6 ^= u<<13 | u>>>(32-13);
    u = x6 + x2 | 0;
    x10 ^= u<<18 | u>>>(32-18);

    u = x15 + x11 | 0;
    x3 ^= u<<7 | u>>>(32-7);
    u = x3 + x15 | 0;
    x7 ^= u<<9 | u>>>(32-9);
    u = x7 + x3 | 0;
    x11 ^= u<<13 | u>>>(32-13);
    u = x11 + x7 | 0;
    x15 ^= u<<18 | u>>>(32-18);

    u = x0 + x3 | 0;
    x1 ^= u<<7 | u>>>(32-7);
    u = x1 + x0 | 0;
    x2 ^= u<<9 | u>>>(32-9);
    u = x2 + x1 | 0;
    x3 ^= u<<13 | u>>>(32-13);
    u = x3 + x2 | 0;
    x0 ^= u<<18 | u>>>(32-18);

    u = x5 + x4 | 0;
    x6 ^= u<<7 | u>>>(32-7);
    u = x6 + x5 | 0;
    x7 ^= u<<9 | u>>>(32-9);
    u = x7 + x6 | 0;
    x4 ^= u<<13 | u>>>(32-13);
    u = x4 + x7 | 0;
    x5 ^= u<<18 | u>>>(32-18);

    u = x10 + x9 | 0;
    x11 ^= u<<7 | u>>>(32-7);
    u = x11 + x10 | 0;
    x8 ^= u<<9 | u>>>(32-9);
    u = x8 + x11 | 0;
    x9 ^= u<<13 | u>>>(32-13);
    u = x9 + x8 | 0;
    x10 ^= u<<18 | u>>>(32-18);

    u = x15 + x14 | 0;
    x12 ^= u<<7 | u>>>(32-7);
    u = x12 + x15 | 0;
    x13 ^= u<<9 | u>>>(32-9);
    u = x13 + x12 | 0;
    x14 ^= u<<13 | u>>>(32-13);
    u = x14 + x13 | 0;
    x15 ^= u<<18 | u>>>(32-18);
  }

  o[ 0] = x0 >>>  0 & 0xff;
  o[ 1] = x0 >>>  8 & 0xff;
  o[ 2] = x0 >>> 16 & 0xff;
  o[ 3] = x0 >>> 24 & 0xff;

  o[ 4] = x5 >>>  0 & 0xff;
  o[ 5] = x5 >>>  8 & 0xff;
  o[ 6] = x5 >>> 16 & 0xff;
  o[ 7] = x5 >>> 24 & 0xff;

  o[ 8] = x10 >>>  0 & 0xff;
  o[ 9] = x10 >>>  8 & 0xff;
  o[10] = x10 >>> 16 & 0xff;
  o[11] = x10 >>> 24 & 0xff;

  o[12] = x15 >>>  0 & 0xff;
  o[13] = x15 >>>  8 & 0xff;
  o[14] = x15 >>> 16 & 0xff;
  o[15] = x15 >>> 24 & 0xff;

  o[16] = x6 >>>  0 & 0xff;
  o[17] = x6 >>>  8 & 0xff;
  o[18] = x6 >>> 16 & 0xff;
  o[19] = x6 >>> 24 & 0xff;

  o[20] = x7 >>>  0 & 0xff;
  o[21] = x7 >>>  8 & 0xff;
  o[22] = x7 >>> 16 & 0xff;
  o[23] = x7 >>> 24 & 0xff;

  o[24] = x8 >>>  0 & 0xff;
  o[25] = x8 >>>  8 & 0xff;
  o[26] = x8 >>> 16 & 0xff;
  o[27] = x8 >>> 24 & 0xff;

  o[28] = x9 >>>  0 & 0xff;
  o[29] = x9 >>>  8 & 0xff;
  o[30] = x9 >>> 16 & 0xff;
  o[31] = x9 >>> 24 & 0xff;
}

function crypto_core_salsa20(out,inp,k,c) {
  core_salsa20(out,inp,k,c);
}

function crypto_core_hsalsa20(out,inp,k,c) {
  core_hsalsa20(out,inp,k,c);
}

var sigma = new Uint8Array([101, 120, 112, 97, 110, 100, 32, 51, 50, 45, 98, 121, 116, 101, 32, 107]);
            // "expand 32-byte k"

function crypto_stream_salsa20_xor(c,cpos,m,mpos,b,n,k) {
  var z = new Uint8Array(16), x = new Uint8Array(64);
  var u, i;
  for (i = 0; i < 16; i++) z[i] = 0;
  for (i = 0; i < 8; i++) z[i] = n[i];
  while (b >= 64) {
    crypto_core_salsa20(x,z,k,sigma);
    for (i = 0; i < 64; i++) c[cpos+i] = m[mpos+i] ^ x[i];
    u = 1;
    for (i = 8; i < 16; i++) {
      u = u + (z[i] & 0xff) | 0;
      z[i] = u & 0xff;
      u >>>= 8;
    }
    b -= 64;
    cpos += 64;
    mpos += 64;
  }
  if (b > 0) {
    crypto_core_salsa20(x,z,k,sigma);
    for (i = 0; i < b; i++) c[cpos+i] = m[mpos+i] ^ x[i];
  }
  return 0;
}

function crypto_stream_salsa20(c,cpos,b,n,k) {
  var z = new Uint8Array(16), x = new Uint8Array(64);
  var u, i;
  for (i = 0; i < 16; i++) z[i] = 0;
  for (i = 0; i < 8; i++) z[i] = n[i];
  while (b >= 64) {
    crypto_core_salsa20(x,z,k,sigma);
    for (i = 0; i < 64; i++) c[cpos+i] = x[i];
    u = 1;
    for (i = 8; i < 16; i++) {
      u = u + (z[i] & 0xff) | 0;
      z[i] = u & 0xff;
      u >>>= 8;
    }
    b -= 64;
    cpos += 64;
  }
  if (b > 0) {
    crypto_core_salsa20(x,z,k,sigma);
    for (i = 0; i < b; i++) c[cpos+i] = x[i];
  }
  return 0;
}

function crypto_stream(c,cpos,d,n,k) {
  var s = new Uint8Array(32);
  crypto_core_hsalsa20(s,n,k,sigma);
  var sn = new Uint8Array(8);
  for (var i = 0; i < 8; i++) sn[i] = n[i+16];
  return crypto_stream_salsa20(c,cpos,d,sn,s);
}

function crypto_stream_xor(c,cpos,m,mpos,d,n,k) {
  var s = new Uint8Array(32);
  crypto_core_hsalsa20(s,n,k,sigma);
  var sn = new Uint8Array(8);
  for (var i = 0; i < 8; i++) sn[i] = n[i+16];
  return crypto_stream_salsa20_xor(c,cpos,m,mpos,d,sn,s);
}

/*
* Port of Andrew Moon's Poly1305-donna-16. Public domain.
* https://github.com/floodyberry/poly1305-donna
*/

var poly1305 = function(key) {
  this.buffer = new Uint8Array(16);
  this.r = new Uint16Array(10);
  this.h = new Uint16Array(10);
  this.pad = new Uint16Array(8);
  this.leftover = 0;
  this.fin = 0;

  var t0, t1, t2, t3, t4, t5, t6, t7;

  t0 = key[ 0] & 0xff | (key[ 1] & 0xff) << 8; this.r[0] = ( t0                     ) & 0x1fff;
  t1 = key[ 2] & 0xff | (key[ 3] & 0xff) << 8; this.r[1] = ((t0 >>> 13) | (t1 <<  3)) & 0x1fff;
  t2 = key[ 4] & 0xff | (key[ 5] & 0xff) << 8; this.r[2] = ((t1 >>> 10) | (t2 <<  6)) & 0x1f03;
  t3 = key[ 6] & 0xff | (key[ 7] & 0xff) << 8; this.r[3] = ((t2 >>>  7) | (t3 <<  9)) & 0x1fff;
  t4 = key[ 8] & 0xff | (key[ 9] & 0xff) << 8; this.r[4] = ((t3 >>>  4) | (t4 << 12)) & 0x00ff;
  this.r[5] = ((t4 >>>  1)) & 0x1ffe;
  t5 = key[10] & 0xff | (key[11] & 0xff) << 8; this.r[6] = ((t4 >>> 14) | (t5 <<  2)) & 0x1fff;
  t6 = key[12] & 0xff | (key[13] & 0xff) << 8; this.r[7] = ((t5 >>> 11) | (t6 <<  5)) & 0x1f81;
  t7 = key[14] & 0xff | (key[15] & 0xff) << 8; this.r[8] = ((t6 >>>  8) | (t7 <<  8)) & 0x1fff;
  this.r[9] = ((t7 >>>  5)) & 0x007f;

  this.pad[0] = key[16] & 0xff | (key[17] & 0xff) << 8;
  this.pad[1] = key[18] & 0xff | (key[19] & 0xff) << 8;
  this.pad[2] = key[20] & 0xff | (key[21] & 0xff) << 8;
  this.pad[3] = key[22] & 0xff | (key[23] & 0xff) << 8;
  this.pad[4] = key[24] & 0xff | (key[25] & 0xff) << 8;
  this.pad[5] = key[26] & 0xff | (key[27] & 0xff) << 8;
  this.pad[6] = key[28] & 0xff | (key[29] & 0xff) << 8;
  this.pad[7] = key[30] & 0xff | (key[31] & 0xff) << 8;
};

poly1305.prototype.blocks = function(m, mpos, bytes) {
  var hibit = this.fin ? 0 : (1 << 11);
  var t0, t1, t2, t3, t4, t5, t6, t7, c;
  var d0, d1, d2, d3, d4, d5, d6, d7, d8, d9;

  var h0 = this.h[0],
      h1 = this.h[1],
      h2 = this.h[2],
      h3 = this.h[3],
      h4 = this.h[4],
      h5 = this.h[5],
      h6 = this.h[6],
      h7 = this.h[7],
      h8 = this.h[8],
      h9 = this.h[9];

  var r0 = this.r[0],
      r1 = this.r[1],
      r2 = this.r[2],
      r3 = this.r[3],
      r4 = this.r[4],
      r5 = this.r[5],
      r6 = this.r[6],
      r7 = this.r[7],
      r8 = this.r[8],
      r9 = this.r[9];

  while (bytes >= 16) {
    t0 = m[mpos+ 0] & 0xff | (m[mpos+ 1] & 0xff) << 8; h0 += ( t0                     ) & 0x1fff;
    t1 = m[mpos+ 2] & 0xff | (m[mpos+ 3] & 0xff) << 8; h1 += ((t0 >>> 13) | (t1 <<  3)) & 0x1fff;
    t2 = m[mpos+ 4] & 0xff | (m[mpos+ 5] & 0xff) << 8; h2 += ((t1 >>> 10) | (t2 <<  6)) & 0x1fff;
    t3 = m[mpos+ 6] & 0xff | (m[mpos+ 7] & 0xff) << 8; h3 += ((t2 >>>  7) | (t3 <<  9)) & 0x1fff;
    t4 = m[mpos+ 8] & 0xff | (m[mpos+ 9] & 0xff) << 8; h4 += ((t3 >>>  4) | (t4 << 12)) & 0x1fff;
    h5 += ((t4 >>>  1)) & 0x1fff;
    t5 = m[mpos+10] & 0xff | (m[mpos+11] & 0xff) << 8; h6 += ((t4 >>> 14) | (t5 <<  2)) & 0x1fff;
    t6 = m[mpos+12] & 0xff | (m[mpos+13] & 0xff) << 8; h7 += ((t5 >>> 11) | (t6 <<  5)) & 0x1fff;
    t7 = m[mpos+14] & 0xff | (m[mpos+15] & 0xff) << 8; h8 += ((t6 >>>  8) | (t7 <<  8)) & 0x1fff;
    h9 += ((t7 >>> 5)) | hibit;

    c = 0;

    d0 = c;
    d0 += h0 * r0;
    d0 += h1 * (5 * r9);
    d0 += h2 * (5 * r8);
    d0 += h3 * (5 * r7);
    d0 += h4 * (5 * r6);
    c = (d0 >>> 13); d0 &= 0x1fff;
    d0 += h5 * (5 * r5);
    d0 += h6 * (5 * r4);
    d0 += h7 * (5 * r3);
    d0 += h8 * (5 * r2);
    d0 += h9 * (5 * r1);
    c += (d0 >>> 13); d0 &= 0x1fff;

    d1 = c;
    d1 += h0 * r1;
    d1 += h1 * r0;
    d1 += h2 * (5 * r9);
    d1 += h3 * (5 * r8);
    d1 += h4 * (5 * r7);
    c = (d1 >>> 13); d1 &= 0x1fff;
    d1 += h5 * (5 * r6);
    d1 += h6 * (5 * r5);
    d1 += h7 * (5 * r4);
    d1 += h8 * (5 * r3);
    d1 += h9 * (5 * r2);
    c += (d1 >>> 13); d1 &= 0x1fff;

    d2 = c;
    d2 += h0 * r2;
    d2 += h1 * r1;
    d2 += h2 * r0;
    d2 += h3 * (5 * r9);
    d2 += h4 * (5 * r8);
    c = (d2 >>> 13); d2 &= 0x1fff;
    d2 += h5 * (5 * r7);
    d2 += h6 * (5 * r6);
    d2 += h7 * (5 * r5);
    d2 += h8 * (5 * r4);
    d2 += h9 * (5 * r3);
    c += (d2 >>> 13); d2 &= 0x1fff;

    d3 = c;
    d3 += h0 * r3;
    d3 += h1 * r2;
    d3 += h2 * r1;
    d3 += h3 * r0;
    d3 += h4 * (5 * r9);
    c = (d3 >>> 13); d3 &= 0x1fff;
    d3 += h5 * (5 * r8);
    d3 += h6 * (5 * r7);
    d3 += h7 * (5 * r6);
    d3 += h8 * (5 * r5);
    d3 += h9 * (5 * r4);
    c += (d3 >>> 13); d3 &= 0x1fff;

    d4 = c;
    d4 += h0 * r4;
    d4 += h1 * r3;
    d4 += h2 * r2;
    d4 += h3 * r1;
    d4 += h4 * r0;
    c = (d4 >>> 13); d4 &= 0x1fff;
    d4 += h5 * (5 * r9);
    d4 += h6 * (5 * r8);
    d4 += h7 * (5 * r7);
    d4 += h8 * (5 * r6);
    d4 += h9 * (5 * r5);
    c += (d4 >>> 13); d4 &= 0x1fff;

    d5 = c;
    d5 += h0 * r5;
    d5 += h1 * r4;
    d5 += h2 * r3;
    d5 += h3 * r2;
    d5 += h4 * r1;
    c = (d5 >>> 13); d5 &= 0x1fff;
    d5 += h5 * r0;
    d5 += h6 * (5 * r9);
    d5 += h7 * (5 * r8);
    d5 += h8 * (5 * r7);
    d5 += h9 * (5 * r6);
    c += (d5 >>> 13); d5 &= 0x1fff;

    d6 = c;
    d6 += h0 * r6;
    d6 += h1 * r5;
    d6 += h2 * r4;
    d6 += h3 * r3;
    d6 += h4 * r2;
    c = (d6 >>> 13); d6 &= 0x1fff;
    d6 += h5 * r1;
    d6 += h6 * r0;
    d6 += h7 * (5 * r9);
    d6 += h8 * (5 * r8);
    d6 += h9 * (5 * r7);
    c += (d6 >>> 13); d6 &= 0x1fff;

    d7 = c;
    d7 += h0 * r7;
    d7 += h1 * r6;
    d7 += h2 * r5;
    d7 += h3 * r4;
    d7 += h4 * r3;
    c = (d7 >>> 13); d7 &= 0x1fff;
    d7 += h5 * r2;
    d7 += h6 * r1;
    d7 += h7 * r0;
    d7 += h8 * (5 * r9);
    d7 += h9 * (5 * r8);
    c += (d7 >>> 13); d7 &= 0x1fff;

    d8 = c;
    d8 += h0 * r8;
    d8 += h1 * r7;
    d8 += h2 * r6;
    d8 += h3 * r5;
    d8 += h4 * r4;
    c = (d8 >>> 13); d8 &= 0x1fff;
    d8 += h5 * r3;
    d8 += h6 * r2;
    d8 += h7 * r1;
    d8 += h8 * r0;
    d8 += h9 * (5 * r9);
    c += (d8 >>> 13); d8 &= 0x1fff;

    d9 = c;
    d9 += h0 * r9;
    d9 += h1 * r8;
    d9 += h2 * r7;
    d9 += h3 * r6;
    d9 += h4 * r5;
    c = (d9 >>> 13); d9 &= 0x1fff;
    d9 += h5 * r4;
    d9 += h6 * r3;
    d9 += h7 * r2;
    d9 += h8 * r1;
    d9 += h9 * r0;
    c += (d9 >>> 13); d9 &= 0x1fff;

    c = (((c << 2) + c)) | 0;
    c = (c + d0) | 0;
    d0 = c & 0x1fff;
    c = (c >>> 13);
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
  this.h[1] &= 0x1fff;
  for (i = 2; i < 10; i++) {
    this.h[i] += c;
    c = this.h[i] >>> 13;
    this.h[i] &= 0x1fff;
  }
  this.h[0] += (c * 5);
  c = this.h[0] >>> 13;
  this.h[0] &= 0x1fff;
  this.h[1] += c;
  c = this.h[1] >>> 13;
  this.h[1] &= 0x1fff;
  this.h[2] += c;

  g[0] = this.h[0] + 5;
  c = g[0] >>> 13;
  g[0] &= 0x1fff;
  for (i = 1; i < 10; i++) {
    g[i] = this.h[i] + c;
    c = g[i] >>> 13;
    g[i] &= 0x1fff;
  }
  g[9] -= (1 << 13);

  mask = (c ^ 1) - 1;
  for (i = 0; i < 10; i++) g[i] &= mask;
  mask = ~mask;
  for (i = 0; i < 10; i++) this.h[i] = (this.h[i] & mask) | g[i];

  this.h[0] = ((this.h[0]       ) | (this.h[1] << 13)                    ) & 0xffff;
  this.h[1] = ((this.h[1] >>>  3) | (this.h[2] << 10)                    ) & 0xffff;
  this.h[2] = ((this.h[2] >>>  6) | (this.h[3] <<  7)                    ) & 0xffff;
  this.h[3] = ((this.h[3] >>>  9) | (this.h[4] <<  4)                    ) & 0xffff;
  this.h[4] = ((this.h[4] >>> 12) | (this.h[5] <<  1) | (this.h[6] << 14)) & 0xffff;
  this.h[5] = ((this.h[6] >>>  2) | (this.h[7] << 11)                    ) & 0xffff;
  this.h[6] = ((this.h[7] >>>  5) | (this.h[8] <<  8)                    ) & 0xffff;
  this.h[7] = ((this.h[8] >>>  8) | (this.h[9] <<  5)                    ) & 0xffff;

  f = this.h[0] + this.pad[0];
  this.h[0] = f & 0xffff;
  for (i = 1; i < 8; i++) {
    f = (((this.h[i] + this.pad[i]) | 0) + (f >>> 16)) | 0;
    this.h[i] = f & 0xffff;
  }

  mac[macpos+ 0] = (this.h[0] >>> 0) & 0xff;
  mac[macpos+ 1] = (this.h[0] >>> 8) & 0xff;
  mac[macpos+ 2] = (this.h[1] >>> 0) & 0xff;
  mac[macpos+ 3] = (this.h[1] >>> 8) & 0xff;
  mac[macpos+ 4] = (this.h[2] >>> 0) & 0xff;
  mac[macpos+ 5] = (this.h[2] >>> 8) & 0xff;
  mac[macpos+ 6] = (this.h[3] >>> 0) & 0xff;
  mac[macpos+ 7] = (this.h[3] >>> 8) & 0xff;
  mac[macpos+ 8] = (this.h[4] >>> 0) & 0xff;
  mac[macpos+ 9] = (this.h[4] >>> 8) & 0xff;
  mac[macpos+10] = (this.h[5] >>> 0) & 0xff;
  mac[macpos+11] = (this.h[5] >>> 8) & 0xff;
  mac[macpos+12] = (this.h[6] >>> 0) & 0xff;
  mac[macpos+13] = (this.h[6] >>> 8) & 0xff;
  mac[macpos+14] = (this.h[7] >>> 0) & 0xff;
  mac[macpos+15] = (this.h[7] >>> 8) & 0xff;
};

poly1305.prototype.update = function(m, mpos, bytes) {
  var i, want;

  if (this.leftover) {
    want = (16 - this.leftover);
    if (want > bytes)
      want = bytes;
    for (i = 0; i < want; i++)
      this.buffer[this.leftover + i] = m[mpos+i];
    bytes -= want;
    mpos += want;
    this.leftover += want;
    if (this.leftover < 16)
      return;
    this.blocks(this.buffer, 0, 16);
    this.leftover = 0;
  }

  if (bytes >= 16) {
    want = bytes - (bytes % 16);
    this.blocks(m, mpos, want);
    mpos += want;
    bytes -= want;
  }

  if (bytes) {
    for (i = 0; i < bytes; i++)
      this.buffer[this.leftover + i] = m[mpos+i];
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
  crypto_onetimeauth(x,0,m,mpos,n,k);
  return crypto_verify_16(h,hpos,x,0);
}

function crypto_secretbox(c,m,d,n,k) {
  var i;
  if (d < 32) return -1;
  crypto_stream_xor(c,0,m,0,d,n,k);
  crypto_onetimeauth(c, 16, c, 32, d - 32, c);
  for (i = 0; i < 16; i++) c[i] = 0;
  return 0;
}

function crypto_secretbox_open(m,c,d,n,k) {
  var i;
  var x = new Uint8Array(32);
  if (d < 32) return -1;
  crypto_stream(x,0,32,n,k);
  if (crypto_onetimeauth_verify(c, 16,c, 32,d - 32,x) !== 0) return -1;
  crypto_stream_xor(m,0,c,0,d,n,k);
  for (i = 0; i < 32; i++) m[i] = 0;
  return 0;
}

function set25519(r, a) {
  var i;
  for (i = 0; i < 16; i++) r[i] = a[i]|0;
}

function car25519(o) {
  var i, v, c = 1;
  for (i = 0; i < 16; i++) {
    v = o[i] + c + 65535;
    c = Math.floor(v / 65536);
    o[i] = v - c * 65536;
  }
  o[0] += c-1 + 37 * (c-1);
}

function sel25519(p, q, b) {
  var t, c = ~(b-1);
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
    m[0] = t[0] - 0xffed;
    for (i = 1; i < 15; i++) {
      m[i] = t[i] - 0xffff - ((m[i-1]>>16) & 1);
      m[i-1] &= 0xffff;
    }
    m[15] = t[15] - 0x7fff - ((m[14]>>16) & 1);
    b = (m[15]>>16) & 1;
    m[14] &= 0xffff;
    sel25519(t, m, 1-b);
  }
  for (i = 0; i < 16; i++) {
    o[2*i] = t[i] & 0xff;
    o[2*i+1] = t[i]>>8;
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
  for (i = 0; i < 16; i++) o[i] = n[2*i] + (n[2*i+1] << 8);
  o[15] &= 0x7fff;
}

function A(o, a, b) {
  for (var i = 0; i < 16; i++) o[i] = a[i] + b[i];
}

function Z(o, a, b) {
  for (var i = 0; i < 16; i++) o[i] = a[i] - b[i];
}

function M(o, a, b) {
  var v, c,
     t0 = 0,  t1 = 0,  t2 = 0,  t3 = 0,  t4 = 0,  t5 = 0,  t6 = 0,  t7 = 0,
     t8 = 0,  t9 = 0, t10 = 0, t11 = 0, t12 = 0, t13 = 0, t14 = 0, t15 = 0,
    t16 = 0, t17 = 0, t18 = 0, t19 = 0, t20 = 0, t21 = 0, t22 = 0, t23 = 0,
    t24 = 0, t25 = 0, t26 = 0, t27 = 0, t28 = 0, t29 = 0, t30 = 0,
    b0 = b[0],
    b1 = b[1],
    b2 = b[2],
    b3 = b[3],
    b4 = b[4],
    b5 = b[5],
    b6 = b[6],
    b7 = b[7],
    b8 = b[8],
    b9 = b[9],
    b10 = b[10],
    b11 = b[11],
    b12 = b[12],
    b13 = b[13],
    b14 = b[14],
    b15 = b[15];

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

  t0  += 38 * t16;
  t1  += 38 * t17;
  t2  += 38 * t18;
  t3  += 38 * t19;
  t4  += 38 * t20;
  t5  += 38 * t21;
  t6  += 38 * t22;
  t7  += 38 * t23;
  t8  += 38 * t24;
  t9  += 38 * t25;
  t10 += 38 * t26;
  t11 += 38 * t27;
  t12 += 38 * t28;
  t13 += 38 * t29;
  t14 += 38 * t30;
  // t15 left as is

  // first car
  c = 1;
  v =  t0 + c + 65535; c = Math.floor(v / 65536);  t0 = v - c * 65536;
  v =  t1 + c + 65535; c = Math.floor(v / 65536);  t1 = v - c * 65536;
  v =  t2 + c + 65535; c = Math.floor(v / 65536);  t2 = v - c * 65536;
  v =  t3 + c + 65535; c = Math.floor(v / 65536);  t3 = v - c * 65536;
  v =  t4 + c + 65535; c = Math.floor(v / 65536);  t4 = v - c * 65536;
  v =  t5 + c + 65535; c = Math.floor(v / 65536);  t5 = v - c * 65536;
  v =  t6 + c + 65535; c = Math.floor(v / 65536);  t6 = v - c * 65536;
  v =  t7 + c + 65535; c = Math.floor(v / 65536);  t7 = v - c * 65536;
  v =  t8 + c + 65535; c = Math.floor(v / 65536);  t8 = v - c * 65536;
  v =  t9 + c + 65535; c = Math.floor(v / 65536);  t9 = v - c * 65536;
  v = t10 + c + 65535; c = Math.floor(v / 65536); t10 = v - c * 65536;
  v = t11 + c + 65535; c = Math.floor(v / 65536); t11 = v - c * 65536;
  v = t12 + c + 65535; c = Math.floor(v / 65536); t12 = v - c * 65536;
  v = t13 + c + 65535; c = Math.floor(v / 65536); t13 = v - c * 65536;
  v = t14 + c + 65535; c = Math.floor(v / 65536); t14 = v - c * 65536;
  v = t15 + c + 65535; c = Math.floor(v / 65536); t15 = v - c * 65536;
  t0 += c-1 + 37 * (c-1);

  // second car
  c = 1;
  v =  t0 + c + 65535; c = Math.floor(v / 65536);  t0 = v - c * 65536;
  v =  t1 + c + 65535; c = Math.floor(v / 65536);  t1 = v - c * 65536;
  v =  t2 + c + 65535; c = Math.floor(v / 65536);  t2 = v - c * 65536;
  v =  t3 + c + 65535; c = Math.floor(v / 65536);  t3 = v - c * 65536;
  v =  t4 + c + 65535; c = Math.floor(v / 65536);  t4 = v - c * 65536;
  v =  t5 + c + 65535; c = Math.floor(v / 65536);  t5 = v - c * 65536;
  v =  t6 + c + 65535; c = Math.floor(v / 65536);  t6 = v - c * 65536;
  v =  t7 + c + 65535; c = Math.floor(v / 65536);  t7 = v - c * 65536;
  v =  t8 + c + 65535; c = Math.floor(v / 65536);  t8 = v - c * 65536;
  v =  t9 + c + 65535; c = Math.floor(v / 65536);  t9 = v - c * 65536;
  v = t10 + c + 65535; c = Math.floor(v / 65536); t10 = v - c * 65536;
  v = t11 + c + 65535; c = Math.floor(v / 65536); t11 = v - c * 65536;
  v = t12 + c + 65535; c = Math.floor(v / 65536); t12 = v - c * 65536;
  v = t13 + c + 65535; c = Math.floor(v / 65536); t13 = v - c * 65536;
  v = t14 + c + 65535; c = Math.floor(v / 65536); t14 = v - c * 65536;
  v = t15 + c + 65535; c = Math.floor(v / 65536); t15 = v - c * 65536;
  t0 += c-1 + 37 * (c-1);

  o[ 0] = t0;
  o[ 1] = t1;
  o[ 2] = t2;
  o[ 3] = t3;
  o[ 4] = t4;
  o[ 5] = t5;
  o[ 6] = t6;
  o[ 7] = t7;
  o[ 8] = t8;
  o[ 9] = t9;
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
    if(a !== 2 && a !== 4) M(c, c, i);
  }
  for (a = 0; a < 16; a++) o[a] = c[a];
}

function pow2523(o, i) {
  var c = gf();
  var a;
  for (a = 0; a < 16; a++) c[a] = i[a];
  for (a = 250; a >= 0; a--) {
      S(c, c);
      if(a !== 1) M(c, c, i);
  }
  for (a = 0; a < 16; a++) o[a] = c[a];
}

function crypto_scalarmult(q, n, p) {
  var z = new Uint8Array(32);
  var x = new Float64Array(80), r, i;
  var a = gf(), b = gf(), c = gf(),
      d = gf(), e = gf(), f = gf();
  for (i = 0; i < 31; i++) z[i] = n[i];
  z[31]=(n[31]&127)|64;
  z[0]&=248;
  unpack25519(x,p);
  for (i = 0; i < 16; i++) {
    b[i]=x[i];
    d[i]=a[i]=c[i]=0;
  }
  a[0]=d[0]=1;
  for (i=254; i>=0; --i) {
    r=(z[i>>>3]>>>(i&7))&1;
    sel25519(a,b,r);
    sel25519(c,d,r);
    A(e,a,c);
    Z(a,a,c);
    A(c,b,d);
    Z(b,b,d);
    S(d,e);
    S(f,a);
    M(a,c,a);
    M(c,b,e);
    A(e,a,c);
    Z(a,a,c);
    S(b,a);
    Z(c,d,f);
    M(a,c,_121665);
    A(a,a,d);
    M(c,c,a);
    M(a,d,f);
    M(d,b,x);
    S(b,e);
    sel25519(a,b,r);
    sel25519(c,d,r);
  }
  for (i = 0; i < 16; i++) {
    x[i+16]=a[i];
    x[i+32]=c[i];
    x[i+48]=b[i];
    x[i+64]=d[i];
  }
  var x32 = x.subarray(32);
  var x16 = x.subarray(16);
  inv25519(x32,x32);
  M(x16,x16,x32);
  pack25519(q,x16);
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
  0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd,
  0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc,
  0x3956c25b, 0xf348b538, 0x59f111f1, 0xb605d019,
  0x923f82a4, 0xaf194f9b, 0xab1c5ed5, 0xda6d8118,
  0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe,
  0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2,
  0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1,
  0x9bdc06a7, 0x25c71235, 0xc19bf174, 0xcf692694,
  0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3,
  0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65,
  0x2de92c6f, 0x592b0275, 0x4a7484aa, 0x6ea6e483,
  0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5,
  0x983e5152, 0xee66dfab, 0xa831c66d, 0x2db43210,
  0xb00327c8, 0x98fb213f, 0xbf597fc7, 0xbeef0ee4,
  0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725,
  0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70,
  0x27b70a85, 0x46d22ffc, 0x2e1b2138, 0x5c26c926,
  0x4d2c6dfc, 0x5ac42aed, 0x53380d13, 0x9d95b3df,
  0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8,
  0x81c2c92e, 0x47edaee6, 0x92722c85, 0x1482353b,
  0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001,
  0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30,
  0xd192e819, 0xd6ef5218, 0xd6990624, 0x5565a910,
  0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8,
  0x19a4c116, 0xb8d2d0c8, 0x1e376c08, 0x5141ab53,
  0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8,
  0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb,
  0x5b9cca4f, 0x7763e373, 0x682e6ff3, 0xd6b2b8a3,
  0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60,
  0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec,
  0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9,
  0xbef9a3f7, 0xb2c67915, 0xc67178f2, 0xe372532b,
  0xca273ece, 0xea26619c, 0xd186b8c7, 0x21c0c207,
  0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178,
  0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6,
  0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b,
  0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493,
  0x3c9ebe0a, 0x15c9bebc, 0x431d67c4, 0x9c100d4c,
  0x4cc5d4be, 0xcb3e42b6, 0x597f299c, 0xfc657e2a,
  0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817
];

function crypto_hashblocks_hl(hh, hl, m, n) {
  var wh = new Int32Array(16), wl = new Int32Array(16),
      bh0, bh1, bh2, bh3, bh4, bh5, bh6, bh7,
      bl0, bl1, bl2, bl3, bl4, bl5, bl6, bl7,
      th, tl, i, j, h, l, a, b, c, d;

  var ah0 = hh[0],
      ah1 = hh[1],
      ah2 = hh[2],
      ah3 = hh[3],
      ah4 = hh[4],
      ah5 = hh[5],
      ah6 = hh[6],
      ah7 = hh[7],

      al0 = hl[0],
      al1 = hl[1],
      al2 = hl[2],
      al3 = hl[3],
      al4 = hl[4],
      al5 = hl[5],
      al6 = hl[6],
      al7 = hl[7];

  var pos = 0;
  while (n >= 128) {
    for (i = 0; i < 16; i++) {
      j = 8 * i + pos;
      wh[i] = (m[j+0] << 24) | (m[j+1] << 16) | (m[j+2] << 8) | m[j+3];
      wl[i] = (m[j+4] << 24) | (m[j+5] << 16) | (m[j+6] << 8) | m[j+7];
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

      // add
      h = ah7;
      l = al7;

      a = l & 0xffff; b = l >>> 16;
      c = h & 0xffff; d = h >>> 16;

      // Sigma1
      h = ((ah4 >>> 14) | (al4 << (32-14))) ^ ((ah4 >>> 18) | (al4 << (32-18))) ^ ((al4 >>> (41-32)) | (ah4 << (32-(41-32))));
      l = ((al4 >>> 14) | (ah4 << (32-14))) ^ ((al4 >>> 18) | (ah4 << (32-18))) ^ ((ah4 >>> (41-32)) | (al4 << (32-(41-32))));

      a += l & 0xffff; b += l >>> 16;
      c += h & 0xffff; d += h >>> 16;

      // Ch
      h = (ah4 & ah5) ^ (~ah4 & ah6);
      l = (al4 & al5) ^ (~al4 & al6);

      a += l & 0xffff; b += l >>> 16;
      c += h & 0xffff; d += h >>> 16;

      // K
      h = K[i*2];
      l = K[i*2+1];

      a += l & 0xffff; b += l >>> 16;
      c += h & 0xffff; d += h >>> 16;

      // w
      h = wh[i%16];
      l = wl[i%16];

      a += l & 0xffff; b += l >>> 16;
      c += h & 0xffff; d += h >>> 16;

      b += a >>> 16;
      c += b >>> 16;
      d += c >>> 16;

      th = c & 0xffff | d << 16;
      tl = a & 0xffff | b << 16;

      // add
      h = th;
      l = tl;

      a = l & 0xffff; b = l >>> 16;
      c = h & 0xffff; d = h >>> 16;

      // Sigma0
      h = ((ah0 >>> 28) | (al0 << (32-28))) ^ ((al0 >>> (34-32)) | (ah0 << (32-(34-32)))) ^ ((al0 >>> (39-32)) | (ah0 << (32-(39-32))));
      l = ((al0 >>> 28) | (ah0 << (32-28))) ^ ((ah0 >>> (34-32)) | (al0 << (32-(34-32)))) ^ ((ah0 >>> (39-32)) | (al0 << (32-(39-32))));

      a += l & 0xffff; b += l >>> 16;
      c += h & 0xffff; d += h >>> 16;

      // Maj
      h = (ah0 & ah1) ^ (ah0 & ah2) ^ (ah1 & ah2);
      l = (al0 & al1) ^ (al0 & al2) ^ (al1 & al2);

      a += l & 0xffff; b += l >>> 16;
      c += h & 0xffff; d += h >>> 16;

      b += a >>> 16;
      c += b >>> 16;
      d += c >>> 16;

      bh7 = (c & 0xffff) | (d << 16);
      bl7 = (a & 0xffff) | (b << 16);

      // add
      h = bh3;
      l = bl3;

      a = l & 0xffff; b = l >>> 16;
      c = h & 0xffff; d = h >>> 16;

      h = th;
      l = tl;

      a += l & 0xffff; b += l >>> 16;
      c += h & 0xffff; d += h >>> 16;

      b += a >>> 16;
      c += b >>> 16;
      d += c >>> 16;

      bh3 = (c & 0xffff) | (d << 16);
      bl3 = (a & 0xffff) | (b << 16);

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

      if (i%16 === 15) {
        for (j = 0; j < 16; j++) {
          // add
          h = wh[j];
          l = wl[j];

          a = l & 0xffff; b = l >>> 16;
          c = h & 0xffff; d = h >>> 16;

          h = wh[(j+9)%16];
          l = wl[(j+9)%16];

          a += l & 0xffff; b += l >>> 16;
          c += h & 0xffff; d += h >>> 16;

          // sigma0
          th = wh[(j+1)%16];
          tl = wl[(j+1)%16];
          h = ((th >>> 1) | (tl << (32-1))) ^ ((th >>> 8) | (tl << (32-8))) ^ (th >>> 7);
          l = ((tl >>> 1) | (th << (32-1))) ^ ((tl >>> 8) | (th << (32-8))) ^ ((tl >>> 7) | (th << (32-7)));

          a += l & 0xffff; b += l >>> 16;
          c += h & 0xffff; d += h >>> 16;

          // sigma1
          th = wh[(j+14)%16];
          tl = wl[(j+14)%16];
          h = ((th >>> 19) | (tl << (32-19))) ^ ((tl >>> (61-32)) | (th << (32-(61-32)))) ^ (th >>> 6);
          l = ((tl >>> 19) | (th << (32-19))) ^ ((th >>> (61-32)) | (tl << (32-(61-32)))) ^ ((tl >>> 6) | (th << (32-6)));

          a += l & 0xffff; b += l >>> 16;
          c += h & 0xffff; d += h >>> 16;

          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;

          wh[j] = (c & 0xffff) | (d << 16);
          wl[j] = (a & 0xffff) | (b << 16);
        }
      }
    }

    // add
    h = ah0;
    l = al0;

    a = l & 0xffff; b = l >>> 16;
    c = h & 0xffff; d = h >>> 16;

    h = hh[0];
    l = hl[0];

    a += l & 0xffff; b += l >>> 16;
    c += h & 0xffff; d += h >>> 16;

    b += a >>> 16;
    c += b >>> 16;
    d += c >>> 16;

    hh[0] = ah0 = (c & 0xffff) | (d << 16);
    hl[0] = al0 = (a & 0xffff) | (b << 16);

    h = ah1;
    l = al1;

    a = l & 0xffff; b = l >>> 16;
    c = h & 0xffff; d = h >>> 16;

    h = hh[1];
    l = hl[1];

    a += l & 0xffff; b += l >>> 16;
    c += h & 0xffff; d += h >>> 16;

    b += a >>> 16;
    c += b >>> 16;
    d += c >>> 16;

    hh[1] = ah1 = (c & 0xffff) | (d << 16);
    hl[1] = al1 = (a & 0xffff) | (b << 16);

    h = ah2;
    l = al2;

    a = l & 0xffff; b = l >>> 16;
    c = h & 0xffff; d = h >>> 16;

    h = hh[2];
    l = hl[2];

    a += l & 0xffff; b += l >>> 16;
    c += h & 0xffff; d += h >>> 16;

    b += a >>> 16;
    c += b >>> 16;
    d += c >>> 16;

    hh[2] = ah2 = (c & 0xffff) | (d << 16);
    hl[2] = al2 = (a & 0xffff) | (b << 16);

    h = ah3;
    l = al3;

    a = l & 0xffff; b = l >>> 16;
    c = h & 0xffff; d = h >>> 16;

    h = hh[3];
    l = hl[3];

    a += l & 0xffff; b += l >>> 16;
    c += h & 0xffff; d += h >>> 16;

    b += a >>> 16;
    c += b >>> 16;
    d += c >>> 16;

    hh[3] = ah3 = (c & 0xffff) | (d << 16);
    hl[3] = al3 = (a & 0xffff) | (b << 16);

    h = ah4;
    l = al4;

    a = l & 0xffff; b = l >>> 16;
    c = h & 0xffff; d = h >>> 16;

    h = hh[4];
    l = hl[4];

    a += l & 0xffff; b += l >>> 16;
    c += h & 0xffff; d += h >>> 16;

    b += a >>> 16;
    c += b >>> 16;
    d += c >>> 16;

    hh[4] = ah4 = (c & 0xffff) | (d << 16);
    hl[4] = al4 = (a & 0xffff) | (b << 16);

    h = ah5;
    l = al5;

    a = l & 0xffff; b = l >>> 16;
    c = h & 0xffff; d = h >>> 16;

    h = hh[5];
    l = hl[5];

    a += l & 0xffff; b += l >>> 16;
    c += h & 0xffff; d += h >>> 16;

    b += a >>> 16;
    c += b >>> 16;
    d += c >>> 16;

    hh[5] = ah5 = (c & 0xffff) | (d << 16);
    hl[5] = al5 = (a & 0xffff) | (b << 16);

    h = ah6;
    l = al6;

    a = l & 0xffff; b = l >>> 16;
    c = h & 0xffff; d = h >>> 16;

    h = hh[6];
    l = hl[6];

    a += l & 0xffff; b += l >>> 16;
    c += h & 0xffff; d += h >>> 16;

    b += a >>> 16;
    c += b >>> 16;
    d += c >>> 16;

    hh[6] = ah6 = (c & 0xffff) | (d << 16);
    hl[6] = al6 = (a & 0xffff) | (b << 16);

    h = ah7;
    l = al7;

    a = l & 0xffff; b = l >>> 16;
    c = h & 0xffff; d = h >>> 16;

    h = hh[7];
    l = hl[7];

    a += l & 0xffff; b += l >>> 16;
    c += h & 0xffff; d += h >>> 16;

    b += a >>> 16;
    c += b >>> 16;
    d += c >>> 16;

    hh[7] = ah7 = (c & 0xffff) | (d << 16);
    hl[7] = al7 = (a & 0xffff) | (b << 16);

    pos += 128;
    n -= 128;
  }

  return n;
}

function crypto_hash(out, m, n) {
  var hh = new Int32Array(8),
      hl = new Int32Array(8),
      x = new Uint8Array(256),
      i, b = n;

  hh[0] = 0x6a09e667;
  hh[1] = 0xbb67ae85;
  hh[2] = 0x3c6ef372;
  hh[3] = 0xa54ff53a;
  hh[4] = 0x510e527f;
  hh[5] = 0x9b05688c;
  hh[6] = 0x1f83d9ab;
  hh[7] = 0x5be0cd19;

  hl[0] = 0xf3bcc908;
  hl[1] = 0x84caa73b;
  hl[2] = 0xfe94f82b;
  hl[3] = 0x5f1d36f1;
  hl[4] = 0xade682d1;
  hl[5] = 0x2b3e6c1f;
  hl[6] = 0xfb41bd6b;
  hl[7] = 0x137e2179;

  crypto_hashblocks_hl(hh, hl, m, n);
  n %= 128;

  for (i = 0; i < n; i++) x[i] = m[b-n+i];
  x[n] = 128;

  n = 256-128*(n<112?1:0);
  x[n-9] = 0;
  ts64(x, n-8,  (b / 0x20000000) | 0, b << 3);
  crypto_hashblocks_hl(hh, hl, x, n);

  for (i = 0; i < 8; i++) ts64(out, 8*i, hh[i], hl[i]);

  return 0;
}

function add(p, q) {
  var a = gf(), b = gf(), c = gf(),
      d = gf(), e = gf(), f = gf(),
      g = gf(), h = gf(), t = gf();

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
    b = (s[(i/8)|0] >> (i&7)) & 1;
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

  for (i = 0; i < 32; i++) sk[i+32] = pk[i];
  return 0;
}

var L = new Float64Array([0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10]);

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
    x[i+1] += x[i] >> 8;
    r[i] = x[i] & 255;
  }
}

function reduce(r) {
  var x = new Float64Array(64), i;
  for (i = 0; i < 64; i++) x[i] = r[i];
  for (i = 0; i < 64; i++) r[i] = 0;
  modL(r, x);
}

// Note: difference from C - smlen returned, not passed as argument.
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

  crypto_hash(r, sm.subarray(32), n+32);
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
      x[i+j] += h[i] * d[j];
    }
  }

  modL(sm.subarray(32), x);
  return smlen;
}

function unpackneg(r, p) {
  var t = gf(), chk = gf(), num = gf(),
      den = gf(), den2 = gf(), den4 = gf(),
      den6 = gf();

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

  if (par25519(r[0]) === (p[31]>>7)) Z(r[0], gf0, r[0]);

  M(r[3], r[0], r[1]);
  return 0;
}

function crypto_sign_open(m, sm, n, pk) {
  var i;
  var t = new Uint8Array(32), h = new Uint8Array(64);
  var p = [gf(), gf(), gf(), gf()],
      q = [gf(), gf(), gf(), gf()];

  if (n < 64) return -1;

  if (unpackneg(q, pk)) return -1;

  for (i = 0; i < n; i++) m[i] = sm[i];
  for (i = 0; i < 32; i++) m[i+32] = pk[i];
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

var crypto_secretbox_KEYBYTES = 32,
    crypto_secretbox_NONCEBYTES = 24,
    crypto_secretbox_ZEROBYTES = 32,
    crypto_secretbox_BOXZEROBYTES = 16,
    crypto_scalarmult_BYTES = 32,
    crypto_scalarmult_SCALARBYTES = 32,
    crypto_box_PUBLICKEYBYTES = 32,
    crypto_box_SECRETKEYBYTES = 32,
    crypto_box_BEFORENMBYTES = 32,
    crypto_box_NONCEBYTES = crypto_secretbox_NONCEBYTES,
    crypto_box_ZEROBYTES = crypto_secretbox_ZEROBYTES,
    crypto_box_BOXZEROBYTES = crypto_secretbox_BOXZEROBYTES,
    crypto_sign_BYTES = 64,
    crypto_sign_PUBLICKEYBYTES = 32,
    crypto_sign_SECRETKEYBYTES = 64,
    crypto_sign_SEEDBYTES = 32,
    crypto_hash_BYTES = 64;

nacl.lowlevel = {
  crypto_core_hsalsa20: crypto_core_hsalsa20,
  crypto_stream_xor: crypto_stream_xor,
  crypto_stream: crypto_stream,
  crypto_stream_salsa20_xor: crypto_stream_salsa20_xor,
  crypto_stream_salsa20: crypto_stream_salsa20,
  crypto_onetimeauth: crypto_onetimeauth,
  crypto_onetimeauth_verify: crypto_onetimeauth_verify,
  crypto_verify_16: crypto_verify_16,
  crypto_verify_32: crypto_verify_32,
  crypto_secretbox: crypto_secretbox,
  crypto_secretbox_open: crypto_secretbox_open,
  crypto_scalarmult: crypto_scalarmult,
  crypto_scalarmult_base: crypto_scalarmult_base,
  crypto_box_beforenm: crypto_box_beforenm,
  crypto_box_afternm: crypto_box_afternm,
  crypto_box: crypto_box,
  crypto_box_open: crypto_box_open,
  crypto_box_keypair: crypto_box_keypair,
  crypto_hash: crypto_hash,
  crypto_sign: crypto_sign,
  crypto_sign_keypair: crypto_sign_keypair,
  crypto_sign_open: crypto_sign_open,

  crypto_secretbox_KEYBYTES: crypto_secretbox_KEYBYTES,
  crypto_secretbox_NONCEBYTES: crypto_secretbox_NONCEBYTES,
  crypto_secretbox_ZEROBYTES: crypto_secretbox_ZEROBYTES,
  crypto_secretbox_BOXZEROBYTES: crypto_secretbox_BOXZEROBYTES,
  crypto_scalarmult_BYTES: crypto_scalarmult_BYTES,
  crypto_scalarmult_SCALARBYTES: crypto_scalarmult_SCALARBYTES,
  crypto_box_PUBLICKEYBYTES: crypto_box_PUBLICKEYBYTES,
  crypto_box_SECRETKEYBYTES: crypto_box_SECRETKEYBYTES,
  crypto_box_BEFORENMBYTES: crypto_box_BEFORENMBYTES,
  crypto_box_NONCEBYTES: crypto_box_NONCEBYTES,
  crypto_box_ZEROBYTES: crypto_box_ZEROBYTES,
  crypto_box_BOXZEROBYTES: crypto_box_BOXZEROBYTES,
  crypto_sign_BYTES: crypto_sign_BYTES,
  crypto_sign_PUBLICKEYBYTES: crypto_sign_PUBLICKEYBYTES,
  crypto_sign_SECRETKEYBYTES: crypto_sign_SECRETKEYBYTES,
  crypto_sign_SEEDBYTES: crypto_sign_SEEDBYTES,
  crypto_hash_BYTES: crypto_hash_BYTES,

  gf: gf,
  D: D,
  L: L,
  pack25519: pack25519,
  unpack25519: unpack25519,
  M: M,
  A: A,
  S: S,
  Z: Z,
  pow2523: pow2523,
  add: add,
  set25519: set25519,
  modL: modL,
  scalarmult: scalarmult,
  scalarbase: scalarbase,
};

/* High-level API */

function checkLengths(k, n) {
  if (k.length !== crypto_secretbox_KEYBYTES) throw new Error('bad key size');
  if (n.length !== crypto_secretbox_NONCEBYTES) throw new Error('bad nonce size');
}

function checkBoxLengths(pk, sk) {
  if (pk.length !== crypto_box_PUBLICKEYBYTES) throw new Error('bad public key size');
  if (sk.length !== crypto_box_SECRETKEYBYTES) throw new Error('bad secret key size');
}

function checkArrayTypes() {
  for (var i = 0; i < arguments.length; i++) {
    if (!(arguments[i] instanceof Uint8Array))
      throw new TypeError('unexpected type, use Uint8Array');
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

nacl.secretbox = function(msg, nonce, key) {
  checkArrayTypes(msg, nonce, key);
  checkLengths(key, nonce);
  var m = new Uint8Array(crypto_secretbox_ZEROBYTES + msg.length);
  var c = new Uint8Array(m.length);
  for (var i = 0; i < msg.length; i++) m[i+crypto_secretbox_ZEROBYTES] = msg[i];
  crypto_secretbox(c, m, m.length, nonce, key);
  return c.subarray(crypto_secretbox_BOXZEROBYTES);
};

nacl.secretbox.open = function(box, nonce, key) {
  checkArrayTypes(box, nonce, key);
  checkLengths(key, nonce);
  var c = new Uint8Array(crypto_secretbox_BOXZEROBYTES + box.length);
  var m = new Uint8Array(c.length);
  for (var i = 0; i < box.length; i++) c[i+crypto_secretbox_BOXZEROBYTES] = box[i];
  if (c.length < 32) return null;
  if (crypto_secretbox_open(m, c, c.length, nonce, key) !== 0) return null;
  return m.subarray(crypto_secretbox_ZEROBYTES);
};

nacl.secretbox.keyLength = crypto_secretbox_KEYBYTES;
nacl.secretbox.nonceLength = crypto_secretbox_NONCEBYTES;
nacl.secretbox.overheadLength = crypto_secretbox_BOXZEROBYTES;

nacl.scalarMult = function(n, p) {
  checkArrayTypes(n, p);
  if (n.length !== crypto_scalarmult_SCALARBYTES) throw new Error('bad n size');
  if (p.length !== crypto_scalarmult_BYTES) throw new Error('bad p size');
  var q = new Uint8Array(crypto_scalarmult_BYTES);
  crypto_scalarmult(q, n, p);
  return q;
};

nacl.scalarMult.base = function(n) {
  checkArrayTypes(n);
  if (n.length !== crypto_scalarmult_SCALARBYTES) throw new Error('bad n size');
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
  return {publicKey: pk, secretKey: sk};
};

nacl.box.keyPair.fromSecretKey = function(secretKey) {
  checkArrayTypes(secretKey);
  if (secretKey.length !== crypto_box_SECRETKEYBYTES)
    throw new Error('bad secret key size');
  var pk = new Uint8Array(crypto_box_PUBLICKEYBYTES);
  crypto_scalarmult_base(pk, secretKey);
  return {publicKey: pk, secretKey: new Uint8Array(secretKey)};
};

nacl.box.publicKeyLength = crypto_box_PUBLICKEYBYTES;
nacl.box.secretKeyLength = crypto_box_SECRETKEYBYTES;
nacl.box.sharedKeyLength = crypto_box_BEFORENMBYTES;
nacl.box.nonceLength = crypto_box_NONCEBYTES;
nacl.box.overheadLength = nacl.secretbox.overheadLength;

nacl.sign = function(msg, secretKey) {
  checkArrayTypes(msg, secretKey);
  if (secretKey.length !== crypto_sign_SECRETKEYBYTES)
    throw new Error('bad secret key size');
  var signedMsg = new Uint8Array(crypto_sign_BYTES+msg.length);
  crypto_sign(signedMsg, msg, msg.length, secretKey);
  return signedMsg;
};

nacl.sign.open = function(signedMsg, publicKey) {
  checkArrayTypes(signedMsg, publicKey);
  if (publicKey.length !== crypto_sign_PUBLICKEYBYTES)
    throw new Error('bad public key size');
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
    throw new Error('bad signature size');
  if (publicKey.length !== crypto_sign_PUBLICKEYBYTES)
    throw new Error('bad public key size');
  var sm = new Uint8Array(crypto_sign_BYTES + msg.length);
  var m = new Uint8Array(crypto_sign_BYTES + msg.length);
  var i;
  for (i = 0; i < crypto_sign_BYTES; i++) sm[i] = sig[i];
  for (i = 0; i < msg.length; i++) sm[i+crypto_sign_BYTES] = msg[i];
  return (crypto_sign_open(m, sm, sm.length, publicKey) >= 0);
};

nacl.sign.keyPair = function() {
  var pk = new Uint8Array(crypto_sign_PUBLICKEYBYTES);
  var sk = new Uint8Array(crypto_sign_SECRETKEYBYTES);
  crypto_sign_keypair(pk, sk);
  return {publicKey: pk, secretKey: sk};
};

nacl.sign.keyPair.fromSecretKey = function(secretKey) {
  checkArrayTypes(secretKey);
  if (secretKey.length !== crypto_sign_SECRETKEYBYTES)
    throw new Error('bad secret key size');
  var pk = new Uint8Array(crypto_sign_PUBLICKEYBYTES);
  for (var i = 0; i < pk.length; i++) pk[i] = secretKey[32+i];
  return {publicKey: pk, secretKey: new Uint8Array(secretKey)};
};

nacl.sign.keyPair.fromSeed = function(seed) {
  checkArrayTypes(seed);
  if (seed.length !== crypto_sign_SEEDBYTES)
    throw new Error('bad seed size');
  var pk = new Uint8Array(crypto_sign_PUBLICKEYBYTES);
  var sk = new Uint8Array(crypto_sign_SECRETKEYBYTES);
  for (var i = 0; i < 32; i++) sk[i] = seed[i];
  crypto_sign_keypair(pk, sk, true);
  return {publicKey: pk, secretKey: sk};
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
  // Zero length arguments are considered not equal.
  if (x.length === 0 || y.length === 0) return false;
  if (x.length !== y.length) return false;
  return (vn(x, 0, y, 0, x.length) === 0) ? true : false;
};

nacl.setPRNG = function(fn) {
  randombytes = fn;
};

(function() {
  // Initialize PRNG if environment provides CSPRNG.
  // If not, methods calling randombytes will throw.
  var crypto = typeof self !== 'undefined' ? (self.crypto || self.msCrypto) : null;
  if (crypto && crypto.getRandomValues) {
    // Browsers.
    var QUOTA = 65536;
    nacl.setPRNG(function(x, n) {
      var i, v = new Uint8Array(n);
      for (i = 0; i < n; i += QUOTA) {
        crypto.getRandomValues(v.subarray(i, i + Math.min(n - i, QUOTA)));
      }
      for (i = 0; i < n; i++) x[i] = v[i];
      cleanup(v);
    });
  } else if (typeof require !== 'undefined') {
    // Node.js.
    crypto = require('crypto');
    if (crypto && crypto.randomBytes) {
      nacl.setPRNG(function(x, n) {
        var i, v = crypto.randomBytes(n);
        for (i = 0; i < n; i++) x[i] = v[i];
        cleanup(v);
      });
    }
  }
})();

})(typeof module !== 'undefined' && module.exports ? module.exports : (self.nacl = self.nacl || {}));

return module.exports; })();
var __wtBlake = (function () { var mods = {}; var req = function (n) { return mods[n.replace("./", "")]; };
(function (module, exports, require) {
const ERROR_MSG_INPUT = 'Input must be an string, Buffer or Uint8Array'

// For convenience, let people hash a string, not just a Uint8Array
function normalizeInput (input) {
  let ret
  if (input instanceof Uint8Array) {
    ret = input
  } else if (typeof input === 'string') {
    const encoder = new TextEncoder()
    ret = encoder.encode(input)
  } else {
    throw new Error(ERROR_MSG_INPUT)
  }
  return ret
}

// Converts a Uint8Array to a hexadecimal string
// For example, toHex([255, 0, 255]) returns "ff00ff"
function toHex (bytes) {
  return Array.prototype.map
    .call(bytes, function (n) {
      return (n < 16 ? '0' : '') + n.toString(16)
    })
    .join('')
}

// Converts any value in [0...2^32-1] to an 8-character hex string
function uint32ToHex (val) {
  return (0x100000000 + val).toString(16).substring(1)
}

// For debugging: prints out hash state in the same format as the RFC
// sample computation exactly, so that you can diff
function debugPrint (label, arr, size) {
  let msg = '\n' + label + ' = '
  for (let i = 0; i < arr.length; i += 2) {
    if (size === 32) {
      msg += uint32ToHex(arr[i]).toUpperCase()
      msg += ' '
      msg += uint32ToHex(arr[i + 1]).toUpperCase()
    } else if (size === 64) {
      msg += uint32ToHex(arr[i + 1]).toUpperCase()
      msg += uint32ToHex(arr[i]).toUpperCase()
    } else throw new Error('Invalid size ' + size)
    if (i % 6 === 4) {
      msg += '\n' + new Array(label.length + 4).join(' ')
    } else if (i < arr.length - 2) {
      msg += ' '
    }
  }
  console.log(msg)
}

// For performance testing: generates N bytes of input, hashes M times
// Measures and prints MB/second hash performance each time
function testSpeed (hashFn, N, M) {
  let startMs = new Date().getTime()

  const input = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    input[i] = i % 256
  }
  const genMs = new Date().getTime()
  console.log('Generated random input in ' + (genMs - startMs) + 'ms')
  startMs = genMs

  for (let i = 0; i < M; i++) {
    const hashHex = hashFn(input)
    const hashMs = new Date().getTime()
    const ms = hashMs - startMs
    startMs = hashMs
    console.log('Hashed in ' + ms + 'ms: ' + hashHex.substring(0, 20) + '...')
    console.log(
      Math.round((N / (1 << 20) / (ms / 1000)) * 100) / 100 + ' MB PER SECOND'
    )
  }
}

module.exports = {
  normalizeInput: normalizeInput,
  toHex: toHex,
  debugPrint: debugPrint,
  testSpeed: testSpeed
}

})(mods.__u = { exports: {} }, mods.__u.exports, req); mods.util = mods.__u.exports;
var m2 = { exports: {} };
(function (module, exports, require) {
// Blake2B in pure Javascript
// Adapted from the reference implementation in RFC7693
// Ported to Javascript by DC - https://github.com/dcposch

const util = require('./util')

// 64-bit unsigned addition
// Sets v[a,a+1] += v[b,b+1]
// v should be a Uint32Array
function ADD64AA (v, a, b) {
  const o0 = v[a] + v[b]
  let o1 = v[a + 1] + v[b + 1]
  if (o0 >= 0x100000000) {
    o1++
  }
  v[a] = o0
  v[a + 1] = o1
}

// 64-bit unsigned addition
// Sets v[a,a+1] += b
// b0 is the low 32 bits of b, b1 represents the high 32 bits
function ADD64AC (v, a, b0, b1) {
  let o0 = v[a] + b0
  if (b0 < 0) {
    o0 += 0x100000000
  }
  let o1 = v[a + 1] + b1
  if (o0 >= 0x100000000) {
    o1++
  }
  v[a] = o0
  v[a + 1] = o1
}

// Little-endian byte access
function B2B_GET32 (arr, i) {
  return arr[i] ^ (arr[i + 1] << 8) ^ (arr[i + 2] << 16) ^ (arr[i + 3] << 24)
}

// G Mixing function
// The ROTRs are inlined for speed
function B2B_G (a, b, c, d, ix, iy) {
  const x0 = m[ix]
  const x1 = m[ix + 1]
  const y0 = m[iy]
  const y1 = m[iy + 1]

  ADD64AA(v, a, b) // v[a,a+1] += v[b,b+1] ... in JS we must store a uint64 as two uint32s
  ADD64AC(v, a, x0, x1) // v[a, a+1] += x ... x0 is the low 32 bits of x, x1 is the high 32 bits

  // v[d,d+1] = (v[d,d+1] xor v[a,a+1]) rotated to the right by 32 bits
  let xor0 = v[d] ^ v[a]
  let xor1 = v[d + 1] ^ v[a + 1]
  v[d] = xor1
  v[d + 1] = xor0

  ADD64AA(v, c, d)

  // v[b,b+1] = (v[b,b+1] xor v[c,c+1]) rotated right by 24 bits
  xor0 = v[b] ^ v[c]
  xor1 = v[b + 1] ^ v[c + 1]
  v[b] = (xor0 >>> 24) ^ (xor1 << 8)
  v[b + 1] = (xor1 >>> 24) ^ (xor0 << 8)

  ADD64AA(v, a, b)
  ADD64AC(v, a, y0, y1)

  // v[d,d+1] = (v[d,d+1] xor v[a,a+1]) rotated right by 16 bits
  xor0 = v[d] ^ v[a]
  xor1 = v[d + 1] ^ v[a + 1]
  v[d] = (xor0 >>> 16) ^ (xor1 << 16)
  v[d + 1] = (xor1 >>> 16) ^ (xor0 << 16)

  ADD64AA(v, c, d)

  // v[b,b+1] = (v[b,b+1] xor v[c,c+1]) rotated right by 63 bits
  xor0 = v[b] ^ v[c]
  xor1 = v[b + 1] ^ v[c + 1]
  v[b] = (xor1 >>> 31) ^ (xor0 << 1)
  v[b + 1] = (xor0 >>> 31) ^ (xor1 << 1)
}

// Initialization Vector
const BLAKE2B_IV32 = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372,
  0x5f1d36f1, 0xa54ff53a, 0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c,
  0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19
])

const SIGMA8 = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 14, 10, 4, 8, 9, 15, 13,
  6, 1, 12, 0, 2, 11, 7, 5, 3, 11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1,
  9, 4, 7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8, 9, 0, 5, 7, 2, 4,
  10, 15, 14, 1, 11, 12, 6, 8, 3, 13, 2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5,
  15, 14, 1, 9, 12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11, 13, 11, 7,
  14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10, 6, 15, 14, 9, 11, 3, 0, 8, 12, 2,
  13, 7, 1, 4, 10, 5, 10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0, 0,
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 14, 10, 4, 8, 9, 15, 13, 6,
  1, 12, 0, 2, 11, 7, 5, 3
]

// These are offsets into a uint64 buffer.
// Multiply them all by 2 to make them offsets into a uint32 buffer,
// because this is Javascript and we don't have uint64s
const SIGMA82 = new Uint8Array(
  SIGMA8.map(function (x) {
    return x * 2
  })
)

// Compression function. 'last' flag indicates last block.
// Note we're representing 16 uint64s as 32 uint32s
const v = new Uint32Array(32)
const m = new Uint32Array(32)
function blake2bCompress (ctx, last) {
  let i = 0

  // init work variables
  for (i = 0; i < 16; i++) {
    v[i] = ctx.h[i]
    v[i + 16] = BLAKE2B_IV32[i]
  }

  // low 64 bits of offset
  v[24] = v[24] ^ ctx.t
  v[25] = v[25] ^ (ctx.t / 0x100000000)
  // high 64 bits not supported, offset may not be higher than 2**53-1

  // last block flag set ?
  if (last) {
    v[28] = ~v[28]
    v[29] = ~v[29]
  }

  // get little-endian words
  for (i = 0; i < 32; i++) {
    m[i] = B2B_GET32(ctx.b, 4 * i)
  }

  // twelve rounds of mixing
  // uncomment the DebugPrint calls to log the computation
  // and match the RFC sample documentation
  // util.debugPrint('          m[16]', m, 64)
  for (i = 0; i < 12; i++) {
    // util.debugPrint('   (i=' + (i < 10 ? ' ' : '') + i + ') v[16]', v, 64)
    B2B_G(0, 8, 16, 24, SIGMA82[i * 16 + 0], SIGMA82[i * 16 + 1])
    B2B_G(2, 10, 18, 26, SIGMA82[i * 16 + 2], SIGMA82[i * 16 + 3])
    B2B_G(4, 12, 20, 28, SIGMA82[i * 16 + 4], SIGMA82[i * 16 + 5])
    B2B_G(6, 14, 22, 30, SIGMA82[i * 16 + 6], SIGMA82[i * 16 + 7])
    B2B_G(0, 10, 20, 30, SIGMA82[i * 16 + 8], SIGMA82[i * 16 + 9])
    B2B_G(2, 12, 22, 24, SIGMA82[i * 16 + 10], SIGMA82[i * 16 + 11])
    B2B_G(4, 14, 16, 26, SIGMA82[i * 16 + 12], SIGMA82[i * 16 + 13])
    B2B_G(6, 8, 18, 28, SIGMA82[i * 16 + 14], SIGMA82[i * 16 + 15])
  }
  // util.debugPrint('   (i=12) v[16]', v, 64)

  for (i = 0; i < 16; i++) {
    ctx.h[i] = ctx.h[i] ^ v[i] ^ v[i + 16]
  }
  // util.debugPrint('h[8]', ctx.h, 64)
}

// reusable parameterBlock
const parameterBlock = new Uint8Array([
  0,
  0,
  0,
  0, //  0: outlen, keylen, fanout, depth
  0,
  0,
  0,
  0, //  4: leaf length, sequential mode
  0,
  0,
  0,
  0, //  8: node offset
  0,
  0,
  0,
  0, // 12: node offset
  0,
  0,
  0,
  0, // 16: node depth, inner length, rfu
  0,
  0,
  0,
  0, // 20: rfu
  0,
  0,
  0,
  0, // 24: rfu
  0,
  0,
  0,
  0, // 28: rfu
  0,
  0,
  0,
  0, // 32: salt
  0,
  0,
  0,
  0, // 36: salt
  0,
  0,
  0,
  0, // 40: salt
  0,
  0,
  0,
  0, // 44: salt
  0,
  0,
  0,
  0, // 48: personal
  0,
  0,
  0,
  0, // 52: personal
  0,
  0,
  0,
  0, // 56: personal
  0,
  0,
  0,
  0 // 60: personal
])

// Creates a BLAKE2b hashing context
// Requires an output length between 1 and 64 bytes
// Takes an optional Uint8Array key
// Takes an optinal Uint8Array salt
// Takes an optinal Uint8Array personal
function blake2bInit (outlen, key, salt, personal) {
  if (outlen === 0 || outlen > 64) {
    throw new Error('Illegal output length, expected 0 < length <= 64')
  }
  if (key && key.length > 64) {
    throw new Error('Illegal key, expected Uint8Array with 0 < length <= 64')
  }
  if (salt && salt.length !== 16) {
    throw new Error('Illegal salt, expected Uint8Array with length is 16')
  }
  if (personal && personal.length !== 16) {
    throw new Error('Illegal personal, expected Uint8Array with length is 16')
  }

  // state, 'param block'
  const ctx = {
    b: new Uint8Array(128),
    h: new Uint32Array(16),
    t: 0, // input count
    c: 0, // pointer within buffer
    outlen: outlen // output length in bytes
  }

  // initialize parameterBlock before usage
  parameterBlock.fill(0)
  parameterBlock[0] = outlen
  if (key) parameterBlock[1] = key.length
  parameterBlock[2] = 1 // fanout
  parameterBlock[3] = 1 // depth
  if (salt) parameterBlock.set(salt, 32)
  if (personal) parameterBlock.set(personal, 48)

  // initialize hash state
  for (let i = 0; i < 16; i++) {
    ctx.h[i] = BLAKE2B_IV32[i] ^ B2B_GET32(parameterBlock, i * 4)
  }

  // key the hash, if applicable
  if (key) {
    blake2bUpdate(ctx, key)
    // at the end
    ctx.c = 128
  }

  return ctx
}

// Updates a BLAKE2b streaming hash
// Requires hash context and Uint8Array (byte array)
function blake2bUpdate (ctx, input) {
  for (let i = 0; i < input.length; i++) {
    if (ctx.c === 128) {
      // buffer full ?
      ctx.t += ctx.c // add counters
      blake2bCompress(ctx, false) // compress (not last)
      ctx.c = 0 // counter to zero
    }
    ctx.b[ctx.c++] = input[i]
  }
}

// Completes a BLAKE2b streaming hash
// Returns a Uint8Array containing the message digest
function blake2bFinal (ctx) {
  ctx.t += ctx.c // mark last block offset

  while (ctx.c < 128) {
    // fill up with zeros
    ctx.b[ctx.c++] = 0
  }
  blake2bCompress(ctx, true) // final block flag = 1

  // little endian convert and store
  const out = new Uint8Array(ctx.outlen)
  for (let i = 0; i < ctx.outlen; i++) {
    out[i] = ctx.h[i >> 2] >> (8 * (i & 3))
  }
  return out
}

// Computes the BLAKE2B hash of a string or byte array, and returns a Uint8Array
//
// Returns a n-byte Uint8Array
//
// Parameters:
// - input - the input bytes, as a string, Buffer or Uint8Array
// - key - optional key Uint8Array, up to 64 bytes
// - outlen - optional output length in bytes, default 64
// - salt - optional salt bytes, string, Buffer or Uint8Array
// - personal - optional personal bytes, string, Buffer or Uint8Array
function blake2b (input, key, outlen, salt, personal) {
  // preprocess inputs
  outlen = outlen || 64
  input = util.normalizeInput(input)
  if (salt) {
    salt = util.normalizeInput(salt)
  }
  if (personal) {
    personal = util.normalizeInput(personal)
  }

  // do the math
  const ctx = blake2bInit(outlen, key, salt, personal)
  blake2bUpdate(ctx, input)
  return blake2bFinal(ctx)
}

// Computes the BLAKE2B hash of a string or byte array
//
// Returns an n-byte hash in hex, all lowercase
//
// Parameters:
// - input - the input bytes, as a string, Buffer, or Uint8Array
// - key - optional key Uint8Array, up to 64 bytes
// - outlen - optional output length in bytes, default 64
// - salt - optional salt bytes, string, Buffer or Uint8Array
// - personal - optional personal bytes, string, Buffer or Uint8Array
function blake2bHex (input, key, outlen, salt, personal) {
  const output = blake2b(input, key, outlen, salt, personal)
  return util.toHex(output)
}

module.exports = {
  blake2b: blake2b,
  blake2bHex: blake2bHex,
  blake2bInit: blake2bInit,
  blake2bUpdate: blake2bUpdate,
  blake2bFinal: blake2bFinal
}

})(m2, m2.exports, req);
return m2.exports; })();
function wtSealedBox(messageBytes, recipientPublicKey) {
  var eph = __wtNacl.box.keyPair();
  var both = new Uint8Array(64); both.set(eph.publicKey, 0); both.set(recipientPublicKey, 32);
  var nonce = __wtBlake.blake2b(both, null, 24);
  var boxed = __wtNacl.box(messageBytes, nonce, recipientPublicKey, eph.secretKey);
  var out = new Uint8Array(32 + boxed.length); out.set(eph.publicKey, 0); out.set(boxed, 32);
  return out;
}

// autodeploy.js — phase 2 for Walrus Tusk users: sites with server code (Functions / _worker) deploy
// from the user's GitHub repo through GitHub Actions, so no PC is ever needed.
//   site_autodeploy: (1) makes sure the Pages project exists, (2) stores CLOUDFLARE_API_TOKEN +
//   CLOUDFLARE_ACCOUNT_ID as encrypted repo secrets (libsodium sealed box, see sealed-box.js),
//   (3) opens a PR adding .github/workflows/walrus-tusk-deploy.yml. The USER taps Merge — that is
//   their consent; the hub never writes the default branch or .github/ directly.
//   After that, every push/merge to the default branch builds + deploys the whole site.

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
    "          node-version: 20",
  ];
  if (buildCommand) lines.push("      - name: Build", `        working-directory: ${JSON.stringify(rootDir)}`, "        run: |", `          ${buildCommand}`);
  lines.push(
    "      - name: Deploy to Cloudflare Pages",
    "        uses: cloudflare/wrangler-action@v3",
    "        with:",
    "          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
    "          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
    `          workingDirectory: ${JSON.stringify(rootDir)}`,
    `          command: pages deploy ${outputDir} --project-name=${project} --branch=${prodBranch} --commit-dirty=true`,
  );
  return lines.join("\n") + "\n";
}

function adBytes(s) { return new TextEncoder().encode(s); }
function adB64(bytes) { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
function adUnb64(s) { const bin = atob(s); const o = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o; }

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
  try { proj = await pagesGetProject(cfClient, accountId, project); } catch (e) { if (!/not found|8000007|404/i.test(String(e.message))) throw e; }
  const prodBranch = proj ? proj.production_branch : "main";
  const workflow = adWorkflow({ deployBranch, project, prodBranch, outputDir, buildCommand, rootDir });
  const plan = {
    repo, deploys_on_push_to: deployBranch, pages_project: project, project_exists: !!proj, live_domains: proj ? proj.domains : [`${project}.pages.dev (new)`],
    production_branch: prodBranch, secrets_to_set: ["CLOUDFLARE_API_TOKEN (your saved Cloudflare token)", "CLOUDFLARE_ACCOUNT_ID"],
    workflow_file: AD_WORKFLOW_PATH, workflow,
    after: "A pull request opens in your repo. Tap Merge in the GitHub app: from then on every merge to " + deployBranch + " deploys the whole site, server code included.",
  };
  if (args.apply !== true) return { dry_run: true, ...plan, next: "call again with apply=true" };

  if (!proj) {
    const { result } = await cfClient.request("POST", `/accounts/${accountId}/pages/projects`, { name: project, production_branch: "main" });
    proj = result; created = true;
  }
  // repo secrets (sealed box with the repo's public key)
  const pk = await gh(ghEnv, "GET", `/repos/${repo}/actions/secrets/public-key`);
  for (const [name, value] of [["CLOUDFLARE_API_TOKEN", cfToken], ["CLOUDFLARE_ACCOUNT_ID", accountId]]) {
    const sealed = wtSealedBox(adBytes(value), adUnb64(pk.key));
    await gh(ghEnv, "PUT", `/repos/${repo}/actions/secrets/${name}`, { encrypted_value: adB64(sealed), key_id: pk.key_id });
  }
  // workflow on a branch + PR (never the default branch)
  const head = (await gh(ghEnv, "GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(info.default_branch)}`)).object.sha;
  try { await gh(ghEnv, "POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${AD_BRANCH}`, sha: head }); }
  catch (e) { if (e.status !== 422) throw e; } // branch already exists
  let existingSha;
  try { existingSha = (await gh(ghEnv, "GET", `/repos/${repo}/contents/${AD_WORKFLOW_PATH}?ref=${encodeURIComponent(AD_BRANCH)}`)).sha; } catch (e) { if (e.status !== 404) throw e; }
  await gh(ghEnv, "PUT", `/repos/${repo}/contents/${AD_WORKFLOW_PATH}`, { message: "Walrus Tusk: deploy to Cloudflare Pages on push", content: adB64(adBytes(workflow)), branch: AD_BRANCH, ...(existingSha ? { sha: existingSha } : {}) });
  let pr;
  const open = await gh(ghEnv, "GET", `/repos/${repo}/pulls?state=open&head=${repo.split("/")[0]}:${encodeURIComponent(AD_BRANCH)}`);
  if (open.length) pr = open[0];
  else pr = await gh(ghEnv, "POST", `/repos/${repo}/pulls`, { title: "Walrus Tusk: auto-deploy to Cloudflare Pages", head: AD_BRANCH, base: info.default_branch, body: `Adds \`${AD_WORKFLOW_PATH}\`. After you merge, every push to \`${deployBranch}\` deploys \`${outputDir}\` to the Cloudflare Pages project **${project}** (${(proj.domains || []).join(", ") || project + ".pages.dev"}).\n\nRepo secrets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID were set by Walrus Tusk. Remove them under Settings → Secrets → Actions to turn this off.` });
  return { applied: true, ...plan, project_created: created, secrets_set: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"], pull_request: pr.html_url, next: "Tap Merge on that pull request. The first deploy starts right after; check it with site_autodeploy_status." };
}

async function siteAutodeployStatus(ghEnv, args) {
  const repo = ghRepo(args.repo, ghEnv);
  let runs;
  try { runs = await gh(ghEnv, "GET", `/repos/${repo}/actions/workflows/walrus-tusk-deploy.yml/runs?per_page=5`); }
  catch (e) { if (e.status === 404) return { repo, set_up: false, note: "No Walrus Tusk deploy workflow on the default branch yet. Run site_autodeploy, then merge its PR." }; throw e; }
  return { repo, set_up: true, runs: (runs.workflow_runs || []).map((r) => ({ status: r.status, result: r.conclusion, commit: (r.head_sha || "").slice(0, 7), message: (r.display_title || "").slice(0, 80), started: r.run_started_at, url: r.html_url })) };
}

var AUTODEPLOY_TOOL_DEFS = [
  { name: "site_autodeploy", description: "One-time setup for sites with server code (Functions/_worker), or any site you keep in GitHub: deploys the repo to a Cloudflare Pages project on every push via GitHub Actions — no PC. Sets the repo secrets and opens a pull request adding the workflow; the user taps Merge to turn it on. Dry-run by default; apply=true does it. After that, change the site with repo_commit_push + repo_open_pr + repo_merge_pr.",
    inputSchema: { type: "object", properties: {
      repo: { type: "string", description: "owner/name" }, project: { type: "string", description: "Cloudflare Pages project (created if it doesn't exist)" },
      account: { type: "string" }, output_dir: { type: "string", description: "folder to deploy, default '.'" },
      build_command: { type: "string", description: "optional, one line, e.g. npm ci && npm run build" }, root_dir: { type: "string", description: "repo subfolder to work in, default '.'" },
      deploy_branch: { type: "string", description: "default: the repo's default branch" }, apply: { type: "boolean" },
    }, required: ["repo", "project"] } },
  { name: "site_autodeploy_status", description: "Latest Walrus Tusk deploy runs for a repo (queued / running / success / failure, with links).",
    inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] } },
];

// wt-users.js — Walrus Tusk self-serve users: anyone gets a key at /join, adds THEIR OWN Cloudflare
// (and optional GitHub) token at /setup, then their AI (Grok, Claude, ChatGPT…) can read, patch and deploy
// THEIR sites and commit to THEIR repos from a phone. Nothing here can reach the owner's accounts:
//   - user keys are `wtu_…`, stored only as a SHA-256 hash (KV wtuser:<hash>)
//   - their tokens are AES-GCM encrypted with the hub secret WT_USER_SECRET (KV wtcreds:<id>)
//   - every Cloudflare call uses their token and is limited to the accounts that token can see
//   - every GitHub call uses their token and is limited to their login + orgs
//   - the tool list for user keys is a fixed allowlist (no federation, no owner/admin tools)

var WTU_PREFIX = "wtu_";
var WTU_PAGES_TOOLS = ["pages_list_deployments", "pages_get_deployment", "pages_read_file", "pages_patch", "pages_deploy", "pages_rollback", "pages_special_files"];
var WTU_REPO_TOOLS = ["repo_list", "repo_read", "repo_search", "repo_commit_push", "repo_open_pr", "repo_merge_pr"];
var WTU_JOIN_PER_HOUR = 5;

function wtuB64(bytes) { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
function wtuUnb64(s) { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
async function wtuSha(s) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join(""); }
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

// ---------- verifying what a user pastes ----------
async function wtuCheckCloudflare(token) {
  const call = async (p) => { const r = await fetch(`https://api.cloudflare.com/client/v4${p}`, { headers: { authorization: `Bearer ${token}` } }); return r.json().catch(() => ({})); };
  const acc = await call("/accounts?per_page=50");
  if (!acc.success || !(acc.result || []).length) return { ok: false, error: "Cloudflare didn't accept that token, or it can't see any account. Make sure it has Account → Cloudflare Pages → Edit." };
  const accounts = [];
  for (const a of acc.result) {
    const names = [];
    let pagesOk = false;
    for (let page = 1; page <= 10; page++) {
      const p = await call(`/accounts/${a.id}/pages/projects?per_page=10&page=${page}`);
      if (!p.success) break;
      pagesOk = true;
      names.push(...(p.result || []).map((x) => x.name));
      if ((p.result || []).length < 10) break;
    }
    accounts.push({ id: a.id, name: a.name, pages: pagesOk, projects: names });
  }
  if (!accounts.some((a) => a.pages)) return { ok: false, error: "The token works but has no Pages permission. Edit it and add Account → Cloudflare Pages → Edit." };
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

// ---------- HTTP: /join and /setup ----------
function wtuJson(obj, status = 200) { return new Response(JSON.stringify(obj, null, 2), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" } }); }
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
  if (request.method === "GET") return new Response(wtuPage(p, url.origin), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const kv = env.CLOUDFLARE_OPS_OAUTH;
  const body = await wtuBody(request);

  if (p === "/join") {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const hourKey = `wtjoin:${await wtuSha(ip)}:${new Date().toISOString().slice(0, 13)}`;
    const n = Number(await kv.get(hourKey)) || 0;
    if (n >= WTU_JOIN_PER_HOUR) return wtuJson({ error: "too many new keys from this network this hour; try again later" }, 429);
    await kv.put(hourKey, String(n + 1), { expirationTtl: 7200 });
    const key = WTU_PREFIX + wtuRandom(40);
    const id = "u_" + wtuRandom(16);
    await kv.put(`wtuser:${await wtuSha(key)}`, JSON.stringify({ id, created: new Date().toISOString(), label: String(body.label || "").slice(0, 60) }));
    return wtuJson({ ok: true, key, mcp_url: `${url.origin}/mcp?key=${key}`, setup_url: `${url.origin}/setup`, note: "Save this key now — it is shown once. Next: add your Cloudflare token at /setup." });
  }

  // /setup
  const key = String(body.key || "").trim();
  const auth = key.startsWith(WTU_PREFIX) ? await wtuAuthorize(env, key) : { ok: false };
  if (!auth.ok) return wtuJson({ error: "unknown key — get one at /join" }, 401);
  const creds = (await wtuCreds(env, auth.userId)) || {};
  if (body.delete === true || body.delete === "true") {
    await kv.delete(`wtcreds:${auth.userId}`);
    return wtuJson({ ok: true, deleted: true, note: "Your saved tokens are gone from the hub. Also revoke them in Cloudflare/GitHub." });
  }
  const out = { ok: true };
  const cfTok = String(body.cloudflare_token || "").trim();
  const ghTok = String(body.github_token || "").trim();
  if (!cfTok && !ghTok && !creds.cf_token) return wtuJson({ error: "paste a Cloudflare API token" }, 400);
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
  creds.updated = new Date().toISOString();
  await kv.put(`wtcreds:${auth.userId}`, JSON.stringify(await wtuEncrypt(env, creds)));
  out.next = `Add this to your AI app as an MCP connector: ${url.origin}/mcp?key=<your key>. Then ask it to "list my sites".`;
  return wtuJson(out);
}

// ---------- MCP: tool list + calls for user keys ----------
var WTU_EXTRA_DEFS = [
  { name: "my_sites", description: "List the Cloudflare Pages sites your token can see (all your accounts): project, production branch, domains, last deploy. Start here.", inputSchema: { type: "object", properties: {} } },
  { name: "wt_whoami", description: "Show what this Walrus Tusk key is connected to (Cloudflare accounts, GitHub login). Tokens are never shown.", inputSchema: { type: "object", properties: {} } },
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
        for (let page = 1; page <= 10; page++) {
        const { result } = await client.request("GET", `/accounts/${a.id}/pages/projects?per_page=10&page=${page}`);
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
  } catch (e) { return { error: String((e && e.message) || e).slice(0, 600) }; }
}

// ---------- pages ----------
function wtuPage(p, origin) {
  const css = `:root{--bg:#07080b;--card:#11131a;--line:#262a36;--gold:#e8b64c;--gold2:#ffd27a;--ink:#f3f1ea;--mut:#9aa0ad;--bad:#ff6b6b;--ok:#5fd38d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:560px;margin:0 auto;padding:28px 16px 60px}h1{font-size:28px;margin:0 0 4px;letter-spacing:-.02em}h1 b{color:var(--gold)}
.sub{color:var(--mut);margin:0 0 22px}.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;margin:14px 0}
h2{font-size:15px;margin:0 0 10px;color:var(--gold2);text-transform:uppercase;letter-spacing:.08em}ol{padding-left:20px;margin:6px 0}li{margin:4px 0}
label{display:block;font-size:13px;color:var(--mut);margin:12px 0 4px}input{width:100%;padding:12px;border-radius:10px;border:1px solid var(--line);background:#0b0d12;color:var(--ink);font:14px ui-monospace,Consolas,monospace}
button{width:100%;margin-top:16px;padding:14px;border:0;border-radius:12px;background:linear-gradient(180deg,var(--gold2),var(--gold));color:#1a1405;font-weight:700;font-size:16px}
code,.mono{font-family:ui-monospace,Consolas,monospace;font-size:13px;word-break:break-all}.out{white-space:pre-wrap;margin-top:12px;font-size:13px}.bad{color:var(--bad)}.ok{color:var(--ok)}a{color:var(--gold2)}
.key{background:#0b0d12;border:1px dashed var(--gold);border-radius:10px;padding:12px;margin:8px 0}`;
  const head = (t) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t} — Walrus Tusk</title><style>${css}</style></head><body><main>`;
  if (p === "/join") return head("Get your key") + `
<h1>Walrus <b>Tusk</b></h1><p class="sub">Let your AI edit and deploy your Cloudflare sites from your phone.</p>
<div class="card"><h2>1 · Get your key</h2><p>One tap. No account, no email.</p><button id="go">Get my key</button><div id="res" class="out"></div></div>
<div class="card"><h2>How it works</h2><ol><li>Get a key here.</li><li>Add your Cloudflare token on the <a href="${origin}/setup">setup page</a> (and GitHub, optional).</li><li>Add the MCP link to Grok, Claude or ChatGPT.</li><li>Say “list my sites”, then “change … on my homepage”. It reads the live page, shows a dry run, and deploys only the changed file.</li></ol></div>
<script>document.getElementById('go').onclick=async()=>{const b=document.getElementById('go');b.disabled=true;b.textContent='…';const r=await fetch('/join',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});const j=await r.json();const o=document.getElementById('res');
if(!r.ok){o.innerHTML='<span class=bad>'+(j.error||'failed')+'</span>';b.disabled=false;b.textContent='Get my key';return}
b.style.display='none';o.innerHTML='<b class=ok>Your key (save it now, shown once):</b><div class="key mono">'+j.key+'</div><b>MCP link for your AI app:</b><div class="key mono">'+j.mcp_url+'</div><a href="/setup#'+j.key+'">Next: add your Cloudflare token →</a>';try{localStorage.setItem('wtu',j.key)}catch(e){}}</script></main></body></html>`;
  return head("Setup") + `
<h1>Walrus <b>Tusk</b> setup</h1><p class="sub">Your tokens are encrypted and only ever used for your own accounts. You can delete them any time.</p>
<div class="card"><h2>Cloudflare token</h2><ol><li>Open <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank">Cloudflare → API Tokens</a> → <b>Create Token</b> → <b>Custom token</b>.</li><li>Permissions: <b>Account → Cloudflare Pages → Edit</b>. Optional: <b>Zone → Analytics → Read</b>.</li><li>Account resources: your account. Create, then copy the token.</li></ol></div>
<div class="card"><h2>GitHub token (optional)</h2><ol><li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank">GitHub → Fine-grained token</a>.</li><li>Repository access: the repos you want your AI to edit.</li><li>Permissions: <b>Contents</b>, <b>Pull requests</b> → Read and write. For sites with server code also <b>Secrets</b>, <b>Workflows</b>, <b>Actions</b> → Read and write (used once, by auto-deploy setup).</li></ol><p class="sub" style="margin:8px 0 0">Your AI can then commit to <code>grok/…</code> or <code>agent/…</code> branches and open/merge PRs. It can't force-push, delete branches, or touch <code>.github/</code>.</p></div>
<div class="card"><h2>Save</h2><label>Your Walrus Tusk key</label><input id="k" placeholder="wtu_…" autocomplete="off"><label>Cloudflare API token</label><input id="cf" type="password" autocomplete="off"><label>GitHub token (optional)</label><input id="gh" type="password" autocomplete="off"><button id="save">Check &amp; save</button><div id="res" class="out"></div></div>
<script>const k=document.getElementById('k');k.value=(location.hash.slice(1)||(()=>{try{return localStorage.getItem('wtu')||''}catch(e){return''}})());
document.getElementById('save').onclick=async()=>{const b=document.getElementById('save');b.disabled=true;b.textContent='Checking…';const r=await fetch('/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:k.value.trim(),cloudflare_token:document.getElementById('cf').value.trim(),github_token:document.getElementById('gh').value.trim()})});const j=await r.json();const o=document.getElementById('res');b.disabled=false;b.textContent='Check & save';
if(!r.ok){o.innerHTML='<span class=bad>'+(j.error||'failed')+'</span>';return}document.getElementById('cf').value='';document.getElementById('gh').value='';
let h='<b class=ok>Saved.</b>\\n';(j.cloudflare||[]).forEach(a=>h+='Cloudflare: '+a.account+(a.pages_access?' — '+a.sites.length+' site(s): '+a.sites.join(', '):' — no Pages access')+'\\n');if(j.github)h+='GitHub: '+j.github.login+'\\n';h+='\\nAdd to your AI app as an MCP connector:\\n<span class=mono>'+location.origin+'/mcp?key='+k.value.trim()+'</span>\\n\\nThen say: “list my sites”.';o.innerHTML=h}</script></main></body></html>`;
}

var PAGES_DEPLOY_TOOLS = new Set(PAGES_DEPLOY_TOOL_DEFS.map((t) => t.name));
// altClient(accountId) may return a client for another account (the owner's second Cloudflare login).
async function runPagesDeployTool(name, args, client, altClient) {
  try {
    if (altClient && args.account && name !== "wrangler_doctor") { const alt = altClient(pagesAccount(args.account)); if (alt) client = alt; }
    if (name === "pages_deploy") return await pagesDeploy(client, args);
    if (name === "pages_list_deployments") return await pagesListDeployments(client, args);
    if (name === "pages_get_deployment") return await pagesGetDeployment(client, args);
    if (name === "pages_rollback") return await pagesRollback(client, args);
    if (name === "wrangler_doctor") return await wranglerDoctor(client, args, altClient);
  } catch (e) {
    return { error: String((e && e.message) || e).slice(0, 600) };
  }
  return { error: "unknown pages tool" };
}


var SERVER = {
  name: "cloudflare-ops-mcp",
  title: "AMH Walrus Tusk Cloudflare Ops MCP \u2014 SafeTry Agent Harness",
  version: "0.9.1"
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
  ...PAGES_DEPLOY_TOOL_DEFS,
  ...PAGES_PATCH_TOOL_DEFS,
  ...GITHUB_TOOL_DEFS,
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
async function runTool(name, args, env, authContext) {
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
  // stale-catalog aliases: clients that cached the 0.6.3 tool list can still reach the new tools
  if (name === "pages_deploy" && (args.patch === true || Array.isArray(args.edits))) name = "pages_patch";
  if (name === "pages_get_deployment" && args.path) name = "pages_read_file";
  if (name === "pages_patch" || name === "pages_special_files" || name === "pages_read_file") {
    try {
      let c = client;
      if (authContext?.mode === "admin" && env.CLOUDFLARE_API_TOKEN_DOORS && args.account && pagesAccount(args.account) === "1d5fae607a857fc56cd575763bf8f3bc") c = new CloudflareClient({ token: env.CLOUDFLARE_API_TOKEN_DOORS });
      if (name === "pages_read_file") return await pagesReadFile(c, args);
      return name === "pages_patch" ? await pagesPatch(c, args, env, authContext?.connectionId || authContext?.mode) : await pagesSaveSpecial(c, args, env);
    } catch (e) { return { error: String((e && e.message) || e).slice(0, 600) }; }
  }
  if (PAGES_DEPLOY_TOOLS.has(name)) return await runPagesDeployTool(name, args, client, (acct) => authContext?.mode === "admin" && env.CLOUDFLARE_API_TOKEN_DOORS && acct === "1d5fae607a857fc56cd575763bf8f3bc" ? new CloudflareClient({ token: env.CLOUDFLARE_API_TOKEN_DOORS }) : null);
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
        await env.CLOUDFLARE_OPS_OAUTH.put(`mintlog:${minted.id}`, JSON.stringify({ id: minted.id, domain: minted.domain, zone_id: zoneId, preset: minted.preset, expires_on: minted.expires_on, keep_days: Number(args.keep_days) >= 1 ? Math.min(365, Math.floor(Number(args.keep_days))) : null, at: new Date().toISOString(), actor: authContext?.connectionId || authContext?.mode || "unknown" }), { expirationTtl: 60 * 60 * 24 * 30 });
      }
      return minted;
    }
    case "list_tokens":
      return { tokens: await listTokens(client), presets: Object.keys(TOKEN_PRESETS), last_audit: env.CLOUDFLARE_OPS_OAUTH ? await env.CLOUDFLARE_OPS_OAUTH.get("audit:last", "json") : null, this_week: env.CLOUDFLARE_OPS_OAUTH ? await env.CLOUDFLARE_OPS_OAUTH.get(`digest:${new Date(Date.now() - ((new Date().getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10)}`, "json") : null };
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
    // Connector apps (Grok) keep only the first ~45 tools, so the small, high-value upstreams go first.
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
      // GitHub straight from the hub (no PC). pc__repo_* (the PC copies) route here too, so they work with the PC off.
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
  { const wtr = await wtuHandleHttp(request, env, url); if (wtr) return wtr; }
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
  constructor(state) {
    this.state = state;
    this.hits = null;
  }
  async fetch(request) {
    const url = new URL(request.url);
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
    await this.state.storage.deleteAll();
    this.hits = null;
  }
};
// Token-vending auditor (hourly cron). Revokes hub-minted ("cfops …") tokens that have no mint log,
// reach beyond the one zone they were minted for, have no expiry, or are already expired.
// Tokens not named "cfops …" (Austin's own) are never read past the name and never touched.
async function auditMintedTokens(env) {
  const report = { at: new Date().toISOString(), checked: 0, revoked: [], kept: 0, errors: [] };
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token) { report.errors.push("no CLOUDFLARE_API_TOKEN"); return report; }
  const client = new CloudflareClient({ token });
  const unusedDays = Number(env.CLOUDFLARE_OPS_OAUTH && await env.CLOUDFLARE_OPS_OAUTH.get("cfg:unused_days")) || 7;
  report.unused_days = unusedDays;
  let list = [];
  try {
    for (let page = 1; page <= 10; page++) {
      const { result } = await client.request("GET", `/user/tokens?per_page=50&page=${page}`);
      list.push(...(result || []));
      if (!result || result.length < 50) break;
    }
  } catch (e) { report.errors.push("list: " + String(e.message || e).slice(0, 160)); }
  for (const t of list) {
    if (!/^cfops /.test(String(t.name || ""))) continue;
    report.checked++;
    let why = null;
    const log = env.CLOUDFLARE_OPS_OAUTH ? await env.CLOUDFLARE_OPS_OAUTH.get(`mintlog:${t.id}`, "json") : null;
    const keep = (log && log.keep_days) || unusedDays;
    if (t.status === "expired" || (t.expires_on && Date.parse(t.expires_on) < Date.now())) why = "expired";
    else if (!t.expires_on) why = "no expiry";
    else if (Date.now() - Date.parse(t.last_used_on || t.issued_on || 0) > keep * 864e5) why = `unused ${keep} days`;
    else if (!log) why = "no mint log entry";
    else {
      const res = (t.policies || []).flatMap((p) => Object.keys(p.resources || {}));
      if (!log.zone_id || res.some((r) => r !== `com.cloudflare.api.account.zone.${log.zone_id}`)) why = "scope beyond its zone";
    }
    if (!why) { report.kept++; continue; }
    try { await client.request("DELETE", `/user/tokens/${encodeURIComponent(t.id)}`); report.revoked.push({ id: t.id, name: t.name, why }); }
    catch (e) { report.errors.push(`revoke ${t.id}: ${String(e.message || e).slice(0, 120)}`); }
  }
  if (env.CLOUDFLARE_OPS_OAUTH) {
    await env.CLOUDFLARE_OPS_OAUTH.put("audit:last", JSON.stringify(report), { expirationTtl: 60 * 60 * 24 * 30 });
    const d = new Date(), monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10);
    const key = `digest:${monday}`;
    const dg = (await env.CLOUDFLARE_OPS_OAUTH.get(key, "json")) || { week_of: monday, audits: 0, revoked: [], tokens: {} };
    dg.audits++;
    dg.revoked.push(...report.revoked.map((r) => ({ ...r, at: report.at })));
    for (const t of list) if (/^cfops /.test(String(t.name || ""))) dg.tokens[t.id] = { name: t.name, issued_on: t.issued_on, last_used_on: t.last_used_on || null, expires_on: t.expires_on || null };
    dg.revoked = dg.revoked.slice(-200);
    await env.CLOUDFLARE_OPS_OAUTH.put(key, JSON.stringify(dg), { expirationTtl: 60 * 60 * 24 * 60 });
  }
  console.log(JSON.stringify({ event: "token_audit", ...report }));
  return report;
}
__name(auditMintedTokens, "auditMintedTokens");
var index_default = {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(auditMintedTokens(env).catch((e) => console.log(JSON.stringify({ event: "token_audit_failed", error: String(e && e.message || e).slice(0, 200) }))));
  },
  async fetch(request, env, ctx) {
    // No cron slot left on the free plan: audit at most hourly, piggybacked on real traffic.
    if (ctx && env.CLOUDFLARE_OPS_OAUTH) ctx.waitUntil(env.CLOUDFLARE_OPS_OAUTH.get("audit:last", "json").then((r) => (!r || Date.now() - Date.parse(r.at) > 36e5) ? auditMintedTokens(env) : null).catch(() => {}));
    try {
      return harden(await fetchInner(request, env));
    } catch (e) {
      const safe = redactToken(String(e && e.stack || e && e.message || e));
      return new Response(JSON.stringify({ ok: false, error: "worker_exception", detail: safe.split("\n").slice(0, 3).join(" | ") }, null, 2), { status: 500, headers: { "content-type": "application/json", ...CORS } });
    }
  }
};
export {
  RateLimiterDO,
  index_default as default
};
//# sourceMappingURL=index.js.map