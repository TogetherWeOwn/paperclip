import { eq } from "drizzle-orm";
import { companies, type Db } from "@paperclipai/db";
import { readConfigFile } from "../config-file.js";
import {
  runtimeCanonicalOrigin,
  runtimePublicOrigin,
} from "./cloud-runtime-identity.js";
import {
  sanitizeExternalChatUrl,
  type InternalReferenceScope,
} from "./chat-publication-projection.js";

/** Omit unusable board links without weakening external publication safety. */
export function safeChatTaskUrl(
  baseUrl: string | null | undefined,
  issueId: string,
): string | null {
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    url.pathname = `/issues/${encodeURIComponent(issueId)}`;
    url.search = "";
    url.hash = "";
    return sanitizeExternalChatUrl(url.toString());
  } catch {
    return null;
  }
}

/** Resolve at use time so a claimed Cloud instance never advertises its pool URL. */
export function publicChatTaskUrl(issueId: string): string | null {
  const configured =
    runtimeCanonicalOrigin() ||
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL?.trim() ||
    process.env.BETTER_AUTH_URL?.trim() ||
    process.env.BETTER_AUTH_BASE_URL?.trim() ||
    process.env.PAPERCLIP_PUBLIC_URL?.trim() ||
    readConfigFile()?.auth?.publicBaseUrl?.trim() ||
    process.env.PAPERCLIP_MANAGED_RUNTIME_PUBLIC_URL?.trim();
  return safeChatTaskUrl(configured, issueId);
}

/** This runtime's own origins; links to them must never reach a public provider. */
export function internalChatOrigins(): string[] {
  return [
    runtimePublicOrigin(),
    runtimeCanonicalOrigin(),
    process.env.PAPERCLIP_PUBLIC_URL,
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL,
    process.env.PAPERCLIP_MANAGED_RUNTIME_PUBLIC_URL,
    process.env.BETTER_AUTH_URL,
    process.env.BETTER_AUTH_BASE_URL,
    readConfigFile()?.auth?.publicBaseUrl,
  ].filter((origin): origin is string => Boolean(origin?.trim()));
}

export async function githubEgressReferenceScope(
  db: Db,
  companyId: string,
  taskBaseUrl: string | null | undefined,
): Promise<InternalReferenceScope> {
  const [company] = await db
    .select({ issuePrefix: companies.issuePrefix })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return {
    internalOrigins: [taskBaseUrl, ...internalChatOrigins()].filter(
      (origin): origin is string => Boolean(origin),
    ),
    trackerPrefixes: company ? [company.issuePrefix] : [],
  };
}
