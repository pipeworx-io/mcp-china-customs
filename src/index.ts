interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities$shared(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities$shared(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * China Customs (GACC English) — monthly merchandise trade statistics.
 *
 * China's General Administration of Customs (GACC) publishes its monthly
 * trade tables on english.customs.gov.cn as plain server-rendered HTML — no
 * XLS/CSV, no JSON API. The mainland Chinese statistics database
 * (stats.customs.gov.cn) 412-blocks requests from a US IP; this English site
 * does not, and it turns out to carry real, dated, machine-parseable tables
 * (proven 2026-09-07 by fetching the raw HTML and parsing a July-2026 row —
 * this was NOT obvious from the index pages' rendered text alone, which is
 * why a prior probe reported the tables looked unparseable).
 *
 * The three index pages this pack reads:
 *   - /statics/report/monthly.html      "final" revised monthly tables (USD only)
 *   - /statics/report/preliminary.html  flash "preliminary" release (USD + CNY,
 *                                        with official month-on-month / year-on-year %)
 *   - /statics/report/trade.html        trade indices (unit value / quantum / value,
 *                                        same month of prior year = 100)
 *
 * Each index page is a table of report categories; each category's row links
 * to ONE report page per calendar month it has published (an unlinked
 * <span>Aug.</span> instead of an <a href>Aug.</a> means that month is not out
 * yet). Those per-month report pages carry a real HTML <table> with the
 * dated figures. Critically, the linked GUID pages are NOT derivable from the
 * date — they must be read off the index page every time, so every tool here
 * re-parses the relevant index page (cached) to find the right link before
 * fetching the report itself.
 *
 * 中国海关总署（GACC）英文网站月度进出口统计 — 数据来源于英文站点的月度/初步/贸易指数报表，
 * 用于规避中文站（stats.customs.gov.cn）对境外 IP 的 412 拦截。
 *
 * hosting-claims-ok: this file only describes GACC's own published pages —
 * every string below attributes the data to GACC, never to us.
 */


const UA = 'pipeworx-mcp-china-customs/1.0 (+https://pipeworx.io)';
const UPSTREAM_NAME = 'GACC (english.customs.gov.cn)';

// The site answers plain HTTP; HTTPS resets the connection from this
// environment (checked 2026-09-07).
const BASE = 'http://english.customs.gov.cn';
const IDX = {
  monthly: `${BASE}/statics/report/monthly.html`,
  preliminary: `${BASE}/statics/report/preliminary.html`,
  trade: `${BASE}/statics/report/trade.html`,
};

async function pwFetch(url: string): Promise<Response> {
  return fetchWithTimeout(url, { headers: { 'User-Agent': UA } }, UPSTREAM_NAME);
}

// ── caching ─────────────────────────────────────────────────────────
// Index pages and per-month report pages only change when GACC publishes a
// new release (monthly cadence) — re-fetching per call is pure waste. Short
// enough TTL that a same-day republish (rare, but GACC does correct pages)
// is picked up within a work day.
const htmlCache = new Map<string, { at: number; html: string }>();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

async function fetchCachedHtml(url: string): Promise<string> {
  const hit = htmlCache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.html;
  const res = await pwFetch(url);
  if (!res.ok) {
    throw new Error(`upstream_down: ${UPSTREAM_NAME} returned HTTP ${res.status} for ${url}.`);
  }
  const html = await res.text();
  htmlCache.set(url, { at: Date.now(), html });
  return html;
}

// ── HTML helpers ────────────────────────────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#40;/g, '(')
    .replace(/&#41;/g, ')')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cells wrapped in bare <span>...</span> — the layout used by monthly.html
 *  and preliminary.html's data tables. */
function spanCells(rowHtml: string): string[] {
  const matches = rowHtml.match(/<span>[\s\S]*?<\/span>/g) ?? [];
  return matches.map((s) => decodeEntities(s.replace(/^<span>/, '').replace(/<\/span>$/, '').replace(/<[^>]+>/g, '')));
}

/** Cells built from <td>...<p>...</p>...</td> — the Word-pasted layout used
 *  by trade.html's index tables. Joins multiple <p> lines within one <td>
 *  (used for the bilingual header rows) with a space. */
function pCells(rowHtml: string): string[] {
  const tds = rowHtml.match(/<td[^>]*>[\s\S]*?<\/td>/gi) ?? [];
  return tds.map((td) => {
    const ps = td.match(/<p[^>]*>[\s\S]*?<\/p>/gi) ?? [];
    if (ps.length) {
      return ps
        .map((p) => decodeEntities(p.replace(/<[^>]+>/g, '')))
        .filter(Boolean)
        .join(' ');
    }
    return decodeEntities(td.replace(/<[^>]+>/g, ''));
  });
}

function num(s: string | undefined): number | null {
  if (s == null) return null;
  const cleaned = s.replace(/,/g, '').trim();
  if (cleaned === '' || cleaned === '-' || cleaned === '—' || cleaned === '－') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface MonthLink {
  monthNum: number;
  url: string;
}

/** Find the row on a report-INDEX page whose title matches `titleTest`, and
 *  return every {monthNum, url} it links (an unlinked month name means "not
 *  published yet", so it's skipped by construction — only <a href> counts). */
function parseReportRow(html: string, titleTest: (title: string) => boolean): MonthLink[] {
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
  if (!tableMatch) return [];
  const rows = tableMatch[0].match(/<tr>[\s\S]*?<\/tr>/gi) ?? [];
  for (const row of rows) {
    const titleMatch = row.match(/<td>([\s\S]*?)<\/td>/i);
    if (!titleMatch) continue;
    const title = decodeEntities(titleMatch[1].replace(/<[^>]+>/g, ''));
    if (!title || !titleTest(title)) continue;
    const links: MonthLink[] = [];
    const re = /href=([^ >]+)>\s*([A-Za-z]{3})\./g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(row))) {
      const idx = MONTH_ABBR.indexOf(m[2]);
      if (idx >= 0) links.push({ monthNum: idx + 1, url: m[1] });
    }
    if (links.length) return links;
  }
  return [];
}

async function getRowLinks(indexUrl: string, titleTest: (title: string) => boolean, rowDesc: string): Promise<MonthLink[]> {
  const html = await fetchCachedHtml(indexUrl);
  const links = parseReportRow(html, titleTest);
  if (!links.length) {
    throw new Error(
      `upstream_down: ${UPSTREAM_NAME}'s index page (${indexUrl}) has no published link right now for "${rowDesc}" — the site layout may have changed.`,
    );
  }
  return links;
}

interface MonthArg {
  year: number;
  monthNum: number;
}

function parseMonthArg(month: unknown): MonthArg | null {
  if (month == null || month === '') return null;
  const s = String(month).trim();
  const m = s.match(/^(\d{4})-(\d{1,2})$/);
  if (!m) throw new Error('user_error: `month` must be "YYYY-MM", e.g. "2026-07".');
  const year = Number(m[1]);
  const monthNum = Number(m[2]);
  if (monthNum < 1 || monthNum > 12) throw new Error('user_error: `month` must have a month between 01 and 12.');
  return { year, monthNum };
}

/** Pick the link matching the requested month, or the latest published link
 *  when none was requested. Only `monthNum` is matched against the index page
 *  (which never states a year) — the ACTUAL period is always read back out of
 *  the fetched report page itself, so a wrong-year guess surfaces as a visible
 *  mismatch in the response rather than a silent mislabel. */
function resolveLink(links: MonthLink[], monthArg: MonthArg | null): MonthLink {
  if (!monthArg) {
    return links.reduce((a, b) => (b.monthNum > a.monthNum ? b : a));
  }
  const hit = links.find((l) => l.monthNum === monthArg.monthNum);
  if (!hit) {
    const avail = links.map((l) => MONTH_ABBR[l.monthNum - 1]).join(', ');
    throw new Error(
      `user_error: ${UPSTREAM_NAME} currently links these months for this table: ${avail}. ` +
        `Requested month ${monthArg.year}-${String(monthArg.monthNum).padStart(2, '0')} is out of range — ` +
        `omit \`month\` for the latest, or pick one from the available list.`,
    );
  }
  return hit;
}

// ── (1) preliminary summary — USD + CNY, official MoM/YoY % ───────────

interface PrelimLine {
  month: number | null;
  ytd: number | null;
  mom_pct: number | null;
  yoy_pct: number | null;
  ytd_yoy_pct: number | null;
}

interface PrelimTable {
  period_label: string;
  unit: string;
  rows: Record<'total' | 'exports' | 'imports' | 'balance', PrelimLine | undefined>;
}

function parsePrelimTable(html: string): PrelimTable {
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
  if (!tableMatch) throw new Error(`parse_error: expected table not found on a ${UPSTREAM_NAME} preliminary report page.`);
  const rowsHtml = tableMatch[0].match(/<tr>[\s\S]*?<\/tr>/gi) ?? [];
  let periodLabel = '';
  let unit = '';
  const rows: PrelimTable['rows'] = { total: undefined, exports: undefined, imports: undefined, balance: undefined };
  for (const r of rowsHtml) {
    const cells = spanCells(r);
    if (!cells.length) continue;
    if (!periodLabel && /Export.*Import Values/i.test(cells[0])) {
      const m = cells[0].match(/,\s*([A-Za-z]{3,9}\.?\s+\d{4})/);
      periodLabel = m ? m[1].replace(/\s+/g, ' ') : cells[0];
      continue;
    }
    if (!unit && /^Unit:/i.test(cells[0])) {
      unit = cells[0].replace(/^Unit:\s*/i, '');
      continue;
    }
    if (cells.length < 6) continue;
    const label = cells[0];
    let key: 'total' | 'exports' | 'imports' | 'balance' | null = null;
    if (label.includes('& Import')) key = 'total';
    else if (label.includes('Balance')) key = 'balance';
    else if (label.includes('Export')) key = 'exports';
    else if (label.includes('Import')) key = 'imports';
    if (!key) continue;
    rows[key] = {
      month: num(cells[1]),
      ytd: num(cells[2]),
      mom_pct: num(cells[3]),
      yoy_pct: num(cells[4]),
      ytd_yoy_pct: num(cells[5]),
    };
  }
  if (!periodLabel || !rows.total) {
    throw new Error(`parse_error: ${UPSTREAM_NAME} preliminary table layout did not match the expected shape.`);
  }
  return { period_label: periodLabel, unit, rows };
}

async function tradeSummary(args: Record<string, unknown>): Promise<unknown> {
  const monthArg = parseMonthArg(args.month);
  const usdLinks = await getRowLinks(
    IDX.preliminary,
    (t) => /Export.*Import Values/i.test(t) && /in USD/i.test(t),
    "China's Total Export & Import Values (in USD)",
  );
  const cnyLinks = await getRowLinks(
    IDX.preliminary,
    (t) => /Export.*Import Values/i.test(t) && /in CNY/i.test(t),
    "China's Total Export & Import Values (in CNY)",
  );
  const usdLink = resolveLink(usdLinks, monthArg);
  const cnyLink = cnyLinks.find((l) => l.monthNum === usdLink.monthNum) ?? null;

  const usdHtml = await fetchCachedHtml(usdLink.url);
  const usdTable = parsePrelimTable(usdHtml);
  const cnyTable = cnyLink ? parsePrelimTable(await fetchCachedHtml(cnyLink.url)) : null;

  return {
    requested_month: monthArg ? `${monthArg.year}-${String(monthArg.monthNum).padStart(2, '0')}` : null,
    period_label: usdTable.period_label,
    publication:
      "GACC 'preliminary' flash release — a revised 'final' figure is typically published in GACC's next monthly cycle.",
    usd: { unit: usdTable.unit, ...usdTable.rows },
    cny: cnyTable ? { unit: cnyTable.unit, ...cnyTable.rows } : null,
    source: usdLink.url,
    available_months: usdLinks.map((l) => MONTH_ABBR[l.monthNum - 1]),
  };
}

// ── (2) by country/region — final monthly (USD) ────────────────────

interface CountryRow {
  region: string;
  is_subtotal: boolean;
  total_month: number | null;
  total_ytd: number | null;
  exports_month: number | null;
  exports_ytd: number | null;
  imports_month: number | null;
  imports_ytd: number | null;
  pct_change_total: number | null;
  pct_change_exports: number | null;
  pct_change_imports: number | null;
}

function parseCountryTable(html: string): { period_label: string; unit: string; rows: CountryRow[] } {
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
  if (!tableMatch) throw new Error(`parse_error: expected table not found on a ${UPSTREAM_NAME} country/region report page.`);
  const rowsHtml = tableMatch[0].match(/<tr>[\s\S]*?<\/tr>/gi) ?? [];
  let periodLabel = '';
  let unit = '';
  const rows: CountryRow[] = [];
  for (const r of rowsHtml) {
    const cells = spanCells(r);
    if (!cells.length) continue;
    if (!periodLabel && /Imports and Exports by Country/i.test(cells[0])) {
      const m = cells[0].match(/,\s*(\d{1,2}\.\d{4})/);
      periodLabel = m ? m[1] : cells[0];
      continue;
    }
    if (!unit && /^Unit:/i.test(cells[0])) {
      unit = cells[0].replace(/^Unit:\s*/i, '');
      continue;
    }
    if (cells.length !== 10) continue;
    const rawLabel = cells[0].trim();
    rows.push({
      region: rawLabel.replace(/[:：]\s*$/, ''),
      is_subtotal: rawLabel === 'TOTAL' || /[:：]\s*$/.test(rawLabel),
      total_month: num(cells[1]),
      total_ytd: num(cells[2]),
      exports_month: num(cells[3]),
      exports_ytd: num(cells[4]),
      imports_month: num(cells[5]),
      imports_ytd: num(cells[6]),
      pct_change_total: num(cells[7]),
      pct_change_exports: num(cells[8]),
      pct_change_imports: num(cells[9]),
    });
  }
  if (!periodLabel || !rows.length) {
    throw new Error(`parse_error: ${UPSTREAM_NAME} country/region table layout did not match the expected shape.`);
  }
  return { period_label: periodLabel, unit, rows };
}

async function tradeByCountry(args: Record<string, unknown>): Promise<unknown> {
  const monthArg = parseMonthArg(args.month);
  const partner = typeof args.partner === 'string' && args.partner.trim() ? args.partner.trim() : null;
  const links = await getRowLinks(
    IDX.monthly,
    (t) => /Imports and Exports by Country/i.test(t),
    'Imports and Exports by Country (Region) of Origin/Destination',
  );
  const link = resolveLink(links, monthArg);
  const table = parseCountryTable(await fetchCachedHtml(link.url));

  let rows = table.rows;
  if (partner) {
    const needle = partner.toLowerCase();
    rows = rows.filter((r) => r.region.toLowerCase().includes(needle));
    if (!rows.length) {
      throw new Error(
        `user_error: no country/region on ${UPSTREAM_NAME}'s ${table.period_label} report matches "${partner}". ` +
          `Try a shorter or differently-spelled name (e.g. "United States", "Korea", "Asia").`,
      );
    }
  }

  return {
    requested_month: monthArg ? `${monthArg.year}-${String(monthArg.monthNum).padStart(2, '0')}` : null,
    period_label: table.period_label,
    unit: table.unit,
    partner_filter: partner,
    count: rows.length,
    rows,
    source: link.url,
    available_months: links.map((l) => MONTH_ABBR[l.monthNum - 1]),
  };
}

// ── (3) by HS section/division — final monthly (USD) ────────────────

interface CommodityRow {
  code: string | null;
  section: string | null;
  label: string;
  is_total: boolean;
  is_section: boolean;
  exports_month: number | null;
  exports_ytd: number | null;
  imports_month: number | null;
  imports_ytd: number | null;
  pct_change_exports: number | null;
  pct_change_imports: number | null;
}

function parseCommodityTable(html: string): { period_label: string; unit: string; rows: CommodityRow[] } {
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
  if (!tableMatch) throw new Error(`parse_error: expected table not found on a ${UPSTREAM_NAME} HS-section report page.`);
  const rowsHtml = tableMatch[0].match(/<tr>[\s\S]*?<\/tr>/gi) ?? [];
  let periodLabel = '';
  let unit = '';
  const rows: CommodityRow[] = [];
  let currentSection: string | null = null;
  for (const r of rowsHtml) {
    const cells = spanCells(r);
    if (!cells.length) continue;
    if (!periodLabel && /by HS Section and Division/i.test(cells[0])) {
      const m = cells[0].match(/,\s*(\d{1,2}\.\d{4})/);
      periodLabel = m ? m[1] : cells[0];
      continue;
    }
    if (!unit && /^Unit:/i.test(cells[0])) {
      unit = cells[0].replace(/^Unit:\s*/i, '');
      continue;
    }
    if (cells.length !== 7) continue;
    const label = cells[0].trim();
    const divMatch = label.match(/^(\d{2})\s+(.+)$/);
    const row: CommodityRow = {
      code: divMatch ? divMatch[1] : null,
      section: divMatch ? currentSection : null,
      label: divMatch ? divMatch[2] : label,
      is_total: label === 'TOTAL',
      is_section: !divMatch && label !== 'TOTAL',
      exports_month: num(cells[1]),
      exports_ytd: num(cells[2]),
      imports_month: num(cells[3]),
      imports_ytd: num(cells[4]),
      pct_change_exports: num(cells[5]),
      pct_change_imports: num(cells[6]),
    };
    if (row.is_section) currentSection = row.label;
    rows.push(row);
  }
  if (!periodLabel || !rows.length) {
    throw new Error(`parse_error: ${UPSTREAM_NAME} HS-section table layout did not match the expected shape.`);
  }
  return { period_label: periodLabel, unit, rows };
}

async function tradeByCommodity(args: Record<string, unknown>): Promise<unknown> {
  const monthArg = parseMonthArg(args.month);
  const hsSection = typeof args.hs_section === 'string' && args.hs_section.trim() ? args.hs_section.trim() : null;
  const links = await getRowLinks(
    IDX.monthly,
    (t) => /by HS Section and Division/i.test(t),
    'Imports and Exports by HS Section and Division',
  );
  const link = resolveLink(links, monthArg);
  const table = parseCommodityTable(await fetchCachedHtml(link.url));

  let rows: CommodityRow[];
  if (hsSection) {
    const needle = hsSection.toLowerCase();
    const codeMatch = /^\d{1,2}$/.test(needle) ? needle.padStart(2, '0') : null;
    rows = table.rows.filter(
      (r) =>
        r.is_total ||
        (codeMatch !== null && r.code === codeMatch) ||
        r.label.toLowerCase().includes(needle) ||
        (r.section !== null && r.section.toLowerCase().includes(needle)),
    );
    if (rows.length <= 1) {
      throw new Error(
        `user_error: no HS section/chapter on ${UPSTREAM_NAME}'s ${table.period_label} report matches "${hsSection}". ` +
          `Pass a 2-digit HS chapter code (e.g. "84" for machinery), or free text from a section/chapter name (e.g. "machinery", "textiles", "live animals").`,
      );
    }
  } else {
    rows = table.rows.filter((r) => r.is_total || r.is_section);
  }

  return {
    requested_month: monthArg ? `${monthArg.year}-${String(monthArg.monthNum).padStart(2, '0')}` : null,
    period_label: table.period_label,
    unit: table.unit,
    hs_section_filter: hsSection,
    count: rows.length,
    rows,
    source: link.url,
    available_months: links.map((l) => MONTH_ABBR[l.monthNum - 1]),
  };
}

// ── (4) trade indices — unit value / quantum / value, base = prior-year month = 100

const SERIES_LABELS: Record<string, string> = {
  hs2: 'HS2',
  sitc2: 'SITC2',
  bec: 'BEC',
  industry: 'Industry',
  hs4: 'HS4',
  sitc3: 'SITC3',
};

function indicesTitleTest(direction: 'Exports' | 'Imports', seriesLabel: string, chained: boolean) {
  return (t: string) => {
    const trimmed = t.trim();
    const hasChained = /^Chained/i.test(trimmed);
    if (hasChained !== chained) return false;
    const re = new RegExp(`Index Number of ${direction} by ${seriesLabel}$`, 'i');
    return re.test(trimmed);
  };
}

interface IndexRow {
  code: string | null;
  section: string | null;
  label: string;
  is_total: boolean;
  is_section: boolean;
  unit_value_index: number | null;
  quantum_index: number | null;
  value_index: number | null;
}

function parseIndexTable(html: string): { period_label: string; rows: IndexRow[] } {
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
  if (!tableMatch) throw new Error(`parse_error: expected table not found on a ${UPSTREAM_NAME} trade-index report page.`);
  const rowsHtml = tableMatch[0].match(/<tr>[\s\S]*?<\/tr>/gi) ?? [];
  let periodLabel = '';
  const rows: IndexRow[] = [];
  let currentSection: string | null = null;
  for (const r of rowsHtml) {
    const cells = pCells(r);
    if (!cells.length) continue;
    if (!periodLabel && /^Table\s+1/i.test(cells[0]) && /Index Number/i.test(cells[0])) {
      const m = cells[0].match(/,\s*([A-Za-z]{3,9}\.?\s+\d{4})/);
      periodLabel = m ? m[1].replace(/\s+/g, ' ') : cells[0];
      continue;
    }
    if (cells.length !== 5) continue;
    const codeRaw = cells[0].trim();
    const label = cells[1].trim();
    if (!codeRaw && !label) continue;
    const unitValueIndex = num(cells[2]);
    const quantumIndex = num(cells[3]);
    const valueIndex = num(cells[4]);
    if (unitValueIndex === null && quantumIndex === null && valueIndex === null) continue; // bilingual header row
    const isTotal = /总指数/.test(label) || /总指数/.test(codeRaw);
    const divMatch = codeRaw.match(/^(\d{2})$/);
    const row: IndexRow = {
      code: divMatch ? divMatch[1] : null,
      section: divMatch ? currentSection : null,
      label,
      is_total: isTotal,
      is_section: !divMatch && !isTotal,
      unit_value_index: unitValueIndex,
      quantum_index: quantumIndex,
      value_index: valueIndex,
    };
    if (row.is_section) currentSection = label;
    rows.push(row);
  }
  if (!rows.length) throw new Error(`parse_error: ${UPSTREAM_NAME} trade-index table layout did not match the expected shape.`);
  return { period_label: periodLabel || '(unlabeled)', rows };
}

async function tradeIndices(args: Record<string, unknown>): Promise<unknown> {
  const monthArg = parseMonthArg(args.month);
  const direction: 'Exports' | 'Imports' = args.direction === 'imports' ? 'Imports' : 'Exports';
  const seriesArg = typeof args.series === 'string' ? args.series.toLowerCase() : 'hs2';
  const seriesLabel = SERIES_LABELS[seriesArg];
  if (!seriesLabel) {
    throw new Error(`user_error: \`series\` must be one of ${Object.keys(SERIES_LABELS).join(', ')}.`);
  }
  const chained = args.chained === true;
  const hs2 = typeof args.hs2 === 'string' && /^\d{1,2}$/.test(args.hs2.trim()) ? args.hs2.trim().padStart(2, '0') : null;

  const links = await getRowLinks(
    IDX.trade,
    indicesTitleTest(direction, seriesLabel, chained),
    `${chained ? 'Chained ' : ''}Index Number of ${direction} by ${seriesLabel}`,
  );
  const link = resolveLink(links, monthArg);
  const table = parseIndexTable(await fetchCachedHtml(link.url));

  let rows = table.rows.filter((r) => r.is_total || r.is_section);
  if (hs2) {
    const divisionRow = table.rows.find((r) => r.code === hs2);
    if (!divisionRow) {
      throw new Error(`user_error: no HS2 chapter "${hs2}" found on ${UPSTREAM_NAME}'s ${seriesLabel} index table for this month.`);
    }
    rows = [...rows.filter((r) => r.is_total), divisionRow];
  }

  return {
    requested_month: monthArg ? `${monthArg.year}-${String(monthArg.monthNum).padStart(2, '0')}` : null,
    period_label: table.period_label,
    direction: direction.toLowerCase(),
    series: seriesArg,
    chained,
    hs2_filter: hs2,
    base: 'same month of the prior year = 100',
    note:
      'Section/chapter labels in this GACC index table are Chinese-only; the numeric HS2 code is the reliable cross-reference into china_trade_by_commodity, which carries English labels.',
    count: rows.length,
    rows,
    source: link.url,
    available_months: links.map((l) => MONTH_ABBR[l.monthNum - 1]),
  };
}

// ── tool registry ───────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'china_trade_summary',
    description:
      "China's total monthly merchandise trade — exports, imports, balance — in both USD and CNY (unit: 100 million), " +
      'with official month-on-month and year-on-year percent changes, exactly as published by the General Administration ' +
      "of Customs (GACC) on its English site's 'preliminary' flash release. Defaults to the latest published month; pass " +
      '`month` ("YYYY-MM") for an earlier one within the currently-linked range (see `available_months` in the response). ' +
      "Published on roughly a 1-week-after-month-end lag; a revised 'final' figure follows in GACC's next monthly cycle. " +
      '中国海关总署（GACC）月度进出口总值（美元、人民币），含环比、同比百分比。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        month: { type: 'string', description: 'Month as "YYYY-MM", e.g. "2026-07". Omit for the latest published month.' },
      },
    },
  },
  {
    name: 'china_trade_by_country',
    description:
      "China's merchandise exports/imports/balance by trading partner country or region, for the month and " +
      "year-to-date, with year-on-year percent change — from GACC's English site 'final' monthly report. Optionally " +
      'filter to one partner (substring match, e.g. "United States", "Japan", "Asia"). Values in US$1,000. ' +
      '中国海关分国别（地区）进出口统计（美元）。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        month: { type: 'string', description: 'Month as "YYYY-MM", e.g. "2026-07". Omit for the latest published month.' },
        partner: { type: 'string', description: 'Optional country/region name filter, e.g. "United States", "Korea", "Asia".' },
      },
    },
  },
  {
    name: 'china_trade_by_commodity',
    description:
      "China's merchandise exports/imports by HS Section and 2-digit HS chapter (Division), for the month and " +
      "year-to-date, with year-on-year percent change — from GACC's English site 'final' monthly report. Without " +
      '`hs_section`, returns the 21 HS sections plus TOTAL; with it (a 2-digit HS chapter code like "84", or free ' +
      'text like "machinery"), also returns that section\'s individual chapters. Values in US$1,000. ' +
      '中国海关分商品类别（HS 分类）进出口统计（美元）。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        month: { type: 'string', description: 'Month as "YYYY-MM", e.g. "2026-07". Omit for the latest published month.' },
        hs_section: {
          type: 'string',
          description: 'Optional filter: a 2-digit HS chapter code (e.g. "84") or free text matching a section/chapter name (e.g. "machinery", "textiles").',
        },
      },
    },
  },
  {
    name: 'china_trade_indices',
    description:
      "China's trade indices — unit-value, quantum and value indices for exports or imports, base = same month of " +
      "the prior year = 100 — from GACC's English site trade-index tables. Choose a classification via `series` " +
      '(hs2, sitc2, bec, industry, hs4, sitc3) and `direction` (exports/imports); `chained` selects the chained-index ' +
      'variant. Returns TOTAL + section-level rows by default; pass a 2-digit HS2 `hs2` chapter code to drill into one ' +
      'chapter. NOTE: chapter/section labels in this specific GACC table are Chinese-only. ' +
      '中国海关进出口价格、数量、金额指数（上年同月=100）。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        month: { type: 'string', description: 'Month as "YYYY-MM", e.g. "2026-07". Omit for the latest published month.' },
        direction: { type: 'string', description: '"exports" (default) or "imports".' },
        series: { type: 'string', description: 'Classification: hs2 (default), sitc2, bec, industry, hs4, or sitc3.' },
        chained: { type: 'boolean', description: 'true for the chained-index variant. Default false.' },
        hs2: { type: 'string', description: 'Optional 2-digit HS chapter code to drill into, e.g. "84".' },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'china_trade_summary':
      return tradeSummary(args);
    case 'china_trade_by_country':
      return tradeByCountry(args);
    case 'china_trade_by_commodity':
      return tradeByCommodity(args);
    case 'china_trade_indices':
      return tradeIndices(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
