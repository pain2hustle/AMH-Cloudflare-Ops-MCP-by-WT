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
  { name: "pages_deploy", description: "Deploy a COMPLETE built static site to a Cloudflare Pages project through the API (like `wrangler pages deploy`, no PC needed). Dry-run by default; apply=true uploads and deploys. branch = production branch goes LIVE; any other branch is a preview URL. A deploy replaces the whole site, so send every file. To change only a few files on a live site use pages_patch. Static only (no functions/). artificialmindhive production is refused.",
    inputSchema: { type: "object", properties: {
      account: { type: "string", description: "amh (pain2hustle1) or doors (austinsdoors1), or an account id" },
      project: { type: "string" }, branch: { type: "string", description: "default = production branch" },
      files: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string", description: "text file contents" }, content_base64: { type: "string", description: "binary file contents" } }, required: ["path"] } },
      commit_message: { type: "string" }, commit_hash: { type: "string" }, apply: { type: "boolean" },
    }, required: ["account", "project", "files"] } },
  { name: "pages_list_deployments", description: "List recent deployments of a Pages project, marking the one serving production. Read-only.",
    inputSchema: { type: "object", properties: { account: { type: "string" }, project: { type: "string" }, limit: { type: "number" } }, required: ["account", "project"] } },
  { name: "pages_get_deployment", description: "Details of one Pages deployment: url, branch, stages, commit message. Read-only.",
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

async function pagesPatch(client, args, env, actor) {
  const account = pagesAccount(args.account), project = pagesProject(args.project);
  const p = await pagesGetProject(client, account, project);
  const branch = String(args.branch || p.production_branch || "main").trim();
  if (!/^[A-Za-z0-9._/-]{1,80}$/.test(branch)) throw new Error("bad branch");
  const production = branch === p.production_branch;
  if (PAGES_PROTECTED.has(project) && production) return { error: `${project} production is not patchable yet (its live _worker can't be carried over by the API). Patch a preview branch, or ask Splice/Claude.` };
  const live = p.canonical_deployment;
  if (!live || !live.id) return { error: "project has no live production deployment to patch onto" };
  const { result: base } = await client.request("GET", `/accounts/${account}/pages/projects/${project}/deployments/${live.id}`);
  if (base.uses_functions) return { error: `${project}'s live deployment runs Functions; a patch can't carry them over. Not patchable from here.` };
  const manifest = { ...(base.files || {}) };
  if (!Object.keys(manifest).length) return { error: "Cloudflare returned an empty file list for the live deployment; refusing to patch" };

  const files = Array.isArray(args.files) ? args.files : [];
  const deletes = (Array.isArray(args.delete) ? args.delete : []).map(pagesPath);
  if (!files.length && !deletes.length) throw new Error("files: give ONLY the files you changed, as [{path, content}] or [{path, content_base64}]");
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
    return { error: `the hub has no saved _redirects/_headers for ${project}, and Cloudflare doesn't return them. Include them in files, or pass no_redirects=true if the site has none.` };
  }

  const changed = entries.map((e) => ({ path: e.path, action: manifest[e.path] ? (manifest[e.path] === e.hash ? "same" : "replace") : "add", bytes: e.size }));
  const missingDeletes = deletes.filter((d) => !manifest[d]);
  const plan = {
    project, account, branch, production, domains_affected: production ? p.domains : [],
    base_deployment: live.id, live_files: Object.keys(base.files || {}).length,
    changed, deleted: deletes.filter((d) => manifest[d]), delete_not_found: missingDeletes,
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
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/${project}/deployments`, { method: "POST", headers: { authorization: `Bearer ${client._token}` }, body: form });
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error(`create deployment failed: ${(j.errors && j.errors[0] && j.errors[0].message) || r.status}`);
  if (specialFromArgs) await pagesSpecialPut(env, account, project, special);

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
  { name: "pages_patch", description: "Change ONLY a few files on a live Pages site (no PC, no full file set). The hub copies the live deployment's file list, swaps in the files you send (and removes any in delete), keeps _redirects/_headers, and deploys. Every other file stays exactly as live. Dry-run by default; apply=true deploys. branch = production branch goes LIVE, any other = preview. Returns rollback_hint. Not for artificialmindhive production or sites with Functions.",
    inputSchema: { type: "object", properties: {
      account: { type: "string", description: "amh (pain2hustle1) or doors (austinsdoors1)" },
      project: { type: "string" }, branch: { type: "string", description: "default = production branch (LIVE)" },
      files: { type: "array", description: "ONLY the changed/new files", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, content_base64: { type: "string" } }, required: ["path"] } },
      delete: { type: "array", items: { type: "string" }, description: "paths to remove from the site" },
      commit_message: { type: "string" }, apply: { type: "boolean" }, no_redirects: { type: "boolean" },
    }, required: ["account", "project"] } },
  { name: "pages_special_files", description: "Read (no args besides account/project) or save the hub's copy of a project's _redirects/_headers, which pages_patch re-sends on every patch.",
    inputSchema: { type: "object", properties: { account: { type: "string" }, project: { type: "string" }, _redirects: { type: "string" }, _headers: { type: "string" } }, required: ["account", "project"] } },
];

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
  version: "0.6.4"
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
  if (name === "pages_patch" || name === "pages_special_files") {
    try {
      let c = client;
      if (authContext?.mode === "admin" && env.CLOUDFLARE_API_TOKEN_DOORS && args.account && pagesAccount(args.account) === "1d5fae607a857fc56cd575763bf8f3bc") c = new CloudflareClient({ token: env.CLOUDFLARE_API_TOKEN_DOORS });
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