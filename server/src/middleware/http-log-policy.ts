import { stripSecretBearingUrlParts } from "./redact-sensitive.js";

const SILENCED_SUCCESS_METHODS = new Set(["GET", "HEAD"]);

const SILENCED_SUCCESS_API_PATHS = [
  /^\/api\/health(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/activity(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/dashboard(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/heartbeat-runs(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/issues(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/live-runs(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/sidebar-badges(?:\/|$)/,
  /^\/api\/heartbeat-runs\/[^/]+\/log(?:\/|$)/,
];

const SILENCED_SUCCESS_STATIC_PREFIXES = [
  "/@fs/",
  "/@id/",
  "/@react-refresh",
  "/@vite/",
  "/_plugins/",
  "/assets/",
  "/node_modules/",
  "/src/",
];

const SILENCED_SUCCESS_STATIC_PATHS = new Set([
  "/",
  "/index.html",
  "/favicon.ico",
  "/site.webmanifest",
  "/sw.js",
]);

function normalizePath(url: string): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) return "/";
  const pathname = trimmed.split("?")[0]?.trim() ?? "/";
  return pathname.length > 0 ? pathname : "/";
}

const SECRET_SENSITIVE_HTTP_PATHS = [
  /^\/api\/chat-endpoints\/[^/]+\/setup(?:-secret)?(?:\/|$)/,
];
const SECRET_SENSITIVE_HTTP_METHODS = new Set(["POST", "PUT", "PATCH"]);

/** Provider payloads are private even when a method/signature is rejected. */
export function isPrivateWebhookHttpRequest(
  method: string | undefined,
  url: string | undefined,
): boolean {
  if (!method || !url) return false;
  let pathname = normalizePath(url);
  if (/^https?:\/\//i.test(pathname)) {
    // Do not let URL dot-segment normalization erase an explicitly supplied
    // ingress namespace on a malformed absolute-form callback.
    const rawPath = pathname.replace(/^https?:\/\/[^/]*/i, "");
    if (/^\/api\/(?:chat-webhooks|routine-triggers\/public)(?:\/|$)/i.test(rawPath)) return true;
    try {
      pathname = new URL(url).pathname;
    } catch {
      return false;
    }
  }
  // This namespace is reserved for provider ingress, including malformed or
  // unknown callback paths. Rejecting a route must not make its payload public.
  return /^\/api\/(?:chat-webhooks|routine-triggers\/public)(?:\/|$)/i.test(pathname);
}

/**
 * These routes accept or create one-time connector credentials. A provider or
 * validation error can echo credential material in its message even after the
 * structured request body has been redacted, so HTTP failure logs use generic
 * error metadata for the whole route. Webhook failures also use generic error
 * metadata: raw provider text/files/credentials cannot be named-field redacted.
 */
export function isSecretSensitiveHttpRequest(
  method: string | undefined,
  url: string | undefined,
): boolean {
  if (isPrivateWebhookHttpRequest(method, url)) return true;
  if (!method || !url) return false;
  if (!SECRET_SENSITIVE_HTTP_METHODS.has(method.toUpperCase())) return false;
  const pathname = normalizePath(url);
  return SECRET_SENSITIVE_HTTP_PATHS.some((pattern) => pattern.test(pathname));
}

function privateWebhookLogUrl(url: unknown) {
  return typeof url === "string" && /\/routine-triggers\/public(?:\/|$)/i.test(url)
    ? "/api/routine-triggers/public/:publicId/fire"
    : "/api/chat-webhooks/:publicId/:provider";
}

/**
 * Bearer tokens carried in path segments must never persist in logs: the raw
 * invite / board-claim token is the credential itself (only its hash is
 * stored, and the raw value is shown once at creation), so anyone able to
 * read a retained log could otherwise replay an unexpired link. Collapse the
 * token segment to `:token` and keep any sub-path (accept, logo, claim, …)
 * for forensics. Other `:id`-style segments (company, token, session, key
 * ids) are resource identifiers, not bearer secrets, and stay as-is.
 */
function collapseTokenInPath(url: string): string {
  return url
    .replace(/\/api\/invites\/[^/?#]+/i, "/api/invites/:token")
    .replace(/\/api\/board-claim\/[^/?#]+/i, "/api/board-claim/:token")
    // Mount-relative forms: a logger that only sees the stripped remainder
    // (Express rewrites req.url when a request passes a mounted router, and
    // some callers pass url without originalUrl) must collapse the token too.
    // These run after the /api-anchored replaces, so full paths keep their
    // prefix and only the bare remainder collapses here.
    .replace(/\/invites\/[^/?#]+/i, "/invites/:token")
    .replace(/\/board-claim\/[^/?#]+/i, "/board-claim/:token");
}

/**
 * The single URL form every HTTP log line uses: provider webhooks collapse
 * to a content-free route template, bearer tokens in path segments collapse
 * to `:token`, and everything else keeps its path with secret-bearing parts
 * (credentials, query) stripped. Shared by the pino-http messages and the
 * retained access log so both stay greppable with the same patterns.
 */
export function requestLogUrl(req: {
  method?: string;
  originalUrl?: unknown;
  url?: unknown;
}): string {
  const url =
    typeof req.originalUrl === "string"
      ? req.originalUrl
      : typeof req.url === "string"
        ? req.url
        : undefined;
  if (isPrivateWebhookHttpRequest(req.method, url)) {
    return privateWebhookLogUrl(url);
  }
  // Use the originalUrl-preferred form, never bare req.url: mounted routers
  // strip req.url (at finish time /api/invites/<token> reads as
  // /invites/<token>), which would bypass the /api-anchored token collapse
  // and persist the raw bearer token in the pino msg field.
  return collapseTokenInPath(stripSecretBearingUrlParts(url ?? ""));
}

export function shouldSilenceHttpSuccessLog(
  method: string | undefined,
  url: string | undefined,
  statusCode: number,
): boolean {
  if (statusCode >= 400) return false;
  if (statusCode === 304) return true;
  if (!method || !url) return false;
  if (!SILENCED_SUCCESS_METHODS.has(method.toUpperCase())) return false;

  const pathname = normalizePath(url);
  if (SILENCED_SUCCESS_STATIC_PATHS.has(pathname)) return true;
  if (
    SILENCED_SUCCESS_STATIC_PREFIXES.some((prefix) =>
      pathname.startsWith(prefix),
    )
  )
    return true;
  return SILENCED_SUCCESS_API_PATHS.some((pattern) => pattern.test(pathname));
}
