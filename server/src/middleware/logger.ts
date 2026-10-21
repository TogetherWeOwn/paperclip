import pino from "pino";
import type { DestinationStream, Logger } from "pino";
import { pinoHttp } from "pino-http";
import { HTTP_LOG_REDACT_PATHS } from "./http-log-redaction.js";
import {
  isPrivateWebhookHttpRequest,
  isSecretSensitiveHttpRequest,
  isPrivateAgentCommentaryHttpRequest,
  requestLogUrl,
  shouldSilenceHttpSuccessLog,
} from "./http-log-policy.js";
import { redactSensitive } from "./redact-sensitive.js";
import { getFileLogging } from "./file-logging.js";

const sharedOpts = {
  translateTime: "SYS:HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

const isProduction = process.env.NODE_ENV === "production";

// Retained copy of every pino line under the instance logs dir (see
// file-logging.ts). Stdout keeps working exactly as before; when the file
// sink is unavailable the logger below is built without it.
const fileLogStream = (() => {
  try {
    const sink = getFileLogging().serverSink;
    return sink ? { write: (chunk: string) => sink.write(chunk) } : null;
  } catch {
    return null;
  }
})();

function withFileCopy(stream: DestinationStream): DestinationStream {
  if (!fileLogStream) return stream;
  // Each leg gets the same serialized JSON chunk; the pretty transport
  // formats its copy for stdout while the file keeps greppable JSON.
  // Both legs pin level trace: multistream defaults a leg without a level
  // to info, which would silently drop debug/trace lines from stdout AND
  // the file (dev defaults to debug). The logger level alone governs.
  return pino.multistream([
    { level: "trace", stream },
    { level: "trace", stream: fileLogStream },
  ]);
}

export const logger = isProduction
  ? fileLogStream
    ? pino(
        {
          level: process.env.PAPERCLIP_LOG_LEVEL?.trim() || "info",
          redact: [...HTTP_LOG_REDACT_PATHS],
        },
        withFileCopy(process.stdout),
      )
    : pino({
        level: process.env.PAPERCLIP_LOG_LEVEL?.trim() || "info",
        redact: [...HTTP_LOG_REDACT_PATHS],
      })
  : pino(
      {
        level: process.env.PAPERCLIP_LOG_LEVEL?.trim() || "debug",
        redact: [...HTTP_LOG_REDACT_PATHS],
      },
      withFileCopy(
        pino.transport({
          target: "pino-pretty",
          options: {
            ...sharedOpts,
            ignore: "pid,hostname,req,res,responseTime",
            colorize: true,
            destination: 1,
          },
        }),
      ),
    );

if (fileLogStream) {
  try {
    const { config, serverSink, accessSink } = getFileLogging();
    logger.info(
      {
        logDir: config.dir,
        serverLog: serverSink?.path,
        accessLog: accessSink?.path ?? null,
      },
      "retained file logging enabled",
    );
  } catch {
    // The startup line is informational; never fail boot for it.
  }
}

function requestClassificationUrl(req: {
  originalUrl?: unknown;
  url?: unknown;
}): string | undefined {
  return typeof req.originalUrl === "string"
    ? req.originalUrl
    : typeof req.url === "string"
      ? req.url
      : undefined;
}

function isPrivateWebhook(req: {
  method?: string;
  originalUrl?: unknown;
  url?: unknown;
}) {
  return isPrivateWebhookHttpRequest(
    req.method,
    requestClassificationUrl(req),
  );
}

export function createHttpLogger(baseLogger: Logger) {
  return pinoHttp({
    logger: baseLogger,
    serializers: {
      req(req: Record<string, unknown> & { url?: unknown }) {
        if (isPrivateAgentCommentaryHttpRequest(typeof req.url === "string" ? req.url : undefined)) {
          return { id: req.id, method: req.method, url: stripSecretBearingUrlParts(req.url as string) };
        }
        if (
          isPrivateWebhook({
            method: typeof req.method === "string" ? req.method : undefined,
            url: req.url,
          })
        ) {
          // pino's standard request serializer has already selected originalUrl.
          // A closed projection also excludes params, arbitrary headers and any
          // parser/SDK-added body copies, including Buffer numeric byte keys.
          return {
            id: req.id,
            method: req.method,
            url: requestLogUrl({
              method: typeof req.method === "string" ? req.method : undefined,
              url: req.url,
            }),
          };
        }
        return {
          ...req,
          // Same shared policy as the log messages (query strip plus bearer
          // token-in-path collapse), so serialized request URLs can never
          // persist an invite/board-claim token the message redacted.
          url: requestLogUrl({
            method: typeof req.method === "string" ? req.method : undefined,
            originalUrl: req.originalUrl,
            url: req.url,
          }),
          // The URL policy intentionally drops all query parameters. The default
          // serializer also exposes the parsed query separately, so omit that
          // duplicate path instead of letting credentials bypass the URL scrub.
          query: undefined,
        };
      },
      res(
        res: Record<string, unknown> & {
          raw?: {
            req?: { method?: string; originalUrl?: unknown; url?: unknown };
          };
        },
      ) {
        // A provider error may also be reflected in response headers. Keep the
        // same content-free contract on both sides of a webhook request.
        return res.raw?.req && (isPrivateWebhook(res.raw.req) || isPrivateAgentCommentaryHttpRequest(requestClassificationUrl(res.raw.req)))
          ? { statusCode: res.statusCode }
          : res;
      },
    },
    customLogLevel(_req, res, err) {
      if (shouldSilenceHttpSuccessLog(_req.method, _req.url, res.statusCode)) {
        return "silent";
      }
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    customSuccessMessage(req, res) {
      return `${req.method} ${requestLogUrl(req)} ${res.statusCode}`;
    },
    customErrorMessage(req, res, err) {
      if (
        isSecretSensitiveHttpRequest(req.method, requestClassificationUrl(req))
      ) {
        return `${req.method} ${requestLogUrl(req)} ${res.statusCode} — request failed`;
      }
      const ctx = (res as any).__errorContext;
      const errMsg =
        ctx?.error?.message ||
        err?.message ||
        (res as any).err?.message ||
        "unknown error";
      return `${req.method} ${requestLogUrl(req)} ${res.statusCode} — ${errMsg}`;
    },
    customErrorObject(req, _res, _err, value) {
      if (isPrivateAgentCommentaryHttpRequest(requestClassificationUrl(req))) {
        return { ...value, err: { type: "Error", message: "Feedback request failed" } };
      }
      // pino-http serializes res.err independently of customProps/errorContext.
      // Do not rely on a particular error handler having sanitized an SDK Error.
      return isPrivateWebhook(req)
        ? {
            ...value,
            err: { type: "Error", message: "Chat webhook request failed" },
          }
        : value;
    },
    customProps(req, res) {
      if (res.statusCode >= 400) {
        const ctx = (res as any).__errorContext;
        if (/^\/mcp\/(?:oauth|paperclip)(?:\/|$)/.test(requestClassificationUrl(req) ?? "")) {
          return { reqBody: "[REDACTED]", ...(ctx ? { errorContext: { name: "Error" } } : {}) };
        }
        if (isPrivateWebhook(req) || isPrivateAgentCommentaryHttpRequest(requestClassificationUrl(req))) {
          // Omit, rather than recursively redact, the entire provider payload.
          // This applies equally before/after parsing and with/without context.
          return {
            reqBody: "[REDACTED]",
            ...(ctx || (res as any).err
              ? { errorContext: { name: "Error" } }
              : {}),
          };
        }
        if (ctx) {
          const secretSensitiveRoute = isSecretSensitiveHttpRequest(
            req.method,
            requestClassificationUrl(req),
          );
          return {
            // Provider SDK and validation errors sometimes echo the supplied
            // credential in their prose. Keep only a non-sensitive type marker
            // for setup routes; the status, route, and redacted body remain.
            errorContext: secretSensitiveRoute
              ? { name: "Error" }
              : redactSensitive(ctx.error),
            reqBody: redactSensitive(ctx.reqBody),
            reqParams: redactSensitive(ctx.reqParams),
          };
        }
        const props: Record<string, unknown> = {};
        const { body, params } = req as any;
        if (body && typeof body === "object" && Object.keys(body).length > 0) {
          props.reqBody = redactSensitive(body);
        }
        if (
          params &&
          typeof params === "object" &&
          Object.keys(params).length > 0
        ) {
          props.reqParams = redactSensitive(params);
        }
        if ((req as any).route?.path) {
          props.routePath = (req as any).route.path;
        }
        return props;
      }
      return {};
    },
  });
}

export const httpLogger = createHttpLogger(logger);
