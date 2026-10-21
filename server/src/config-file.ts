import fs from "node:fs";
import {
  DEPLOYMENT_MODES,
  findPaperclipConfigKeyWarnings,
  paperclipConfigSchema,
  type PaperclipConfig,
  type DeploymentMode,
} from "@paperclipai/shared";
import { ZodError } from "zod";
import { resolvePaperclipConfigPath } from "./paths.js";

function formatConfigValidationError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const issuePath = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${issuePath}: ${issue.message}`;
    })
    .join("; ");
}

function readConfigJson(configPath: string): unknown {
  if (!fs.existsSync(configPath)) return null;

  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Paperclip config at ${configPath}: failed to read or parse JSON: ${reason}`);
  }
}

/**
 * Pre-validation config for presence checks that zod defaults would mask
 * (e.g. logging.logDir). Returns null when no config file exists; throws on
 * unreadable/invalid JSON exactly like readConfigFile.
 */
export function readRawConfigFile(): unknown {
  return readConfigJson(resolvePaperclipConfigPath());
}

export function readConfigFile(): PaperclipConfig | null {
  const configPath = resolvePaperclipConfigPath();
  if (!fs.existsSync(configPath)) return null;
  const raw = readConfigJson(configPath);

  // A parsed null (file literally contains `null`) must NOT be treated as a
  // missing file: it falls through to schema validation below, which throws
  // Invalid Paperclip config like any other non-object JSON value.

  try {
    const config = paperclipConfigSchema.parse(raw);
    for (const warning of findPaperclipConfigKeyWarnings(config)) {
      console.warn(
        `Unknown config key ${warning.path}; did you mean ${warning.suggestion}? It will be preserved.`,
      );
    }
    return config;
  } catch (error) {
    if (error instanceof ZodError) {
      throw new Error(`Invalid Paperclip config at ${configPath}: ${formatConfigValidationError(error)}`);
    }

    throw error;
  }
}

/** Resolve the same deployment mode without loading config.ts's dotenv/startup side effects. */
export function resolveDeploymentMode(fileConfig = readConfigFile()): DeploymentMode {
  const fromEnv = process.env.PAPERCLIP_DEPLOYMENT_MODE;
  return fromEnv && DEPLOYMENT_MODES.includes(fromEnv as DeploymentMode)
    ? fromEnv as DeploymentMode
    : fileConfig?.server.deploymentMode ?? "local_trusted";
}
