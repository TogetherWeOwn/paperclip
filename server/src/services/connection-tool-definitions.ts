import { CONNECTION_REQUEST_TOOL_DESCRIPTION, CONNECTIONS_SEARCH_TOOL_DESCRIPTION } from "@paperclipai/shared";
import { GITHUB_DIAGNOSTIC_REPOSITORY_IDS } from "./github-read-operations.js";

export const RUNTIME_CONNECTION_TOOL_DEFINITIONS = [
  {
    name: "connections_search",
    description: CONNECTIONS_SEARCH_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, retryProviderChoice: { type: "boolean", description: "Only when the user explicitly asks to reconsider a previous provider choice or decline" } },
      additionalProperties: false,
    },
  },
  {
    name: "connection_request",
    description: CONNECTION_REQUEST_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { service: { type: "string" }, targetService: { type: "string", description: "App slug returned by search only when the user explicitly named this external provider" }, selectionInteractionId: { type: "string", description: "Saved answered provider-choice interaction ID for aggregator routes" } },
      required: ["service"],
      additionalProperties: false,
    },
  },
  {
    name: "github_actions_job_logs",
    description:
      "Read bounded, sanitized Actions job logs from a server-pinned repository. Only an immutable repositoryId and positive numeric jobId are accepted; no owner, repository name, URL, path, or method can be supplied. GitHub credentials stay server-side.",
    inputSchema: {
      type: "object",
      properties: {
        repositoryId: { type: "string", enum: [...GITHUB_DIAGNOSTIC_REPOSITORY_IDS] },
        jobId: { type: "string", pattern: "^[1-9][0-9]{0,19}$" },
      },
      required: ["repositoryId", "jobId"],
      additionalProperties: false,
    },
  },
  {
    name: "github_repository_webhooks",
    description:
      "List sanitized webhook metadata for a server-pinned repository. Only an immutable repositoryId is accepted; URLs, webhook configuration secrets, owner, repository name, paths, and methods are never returned or caller-selected.",
    inputSchema: {
      type: "object",
      properties: {
        repositoryId: { type: "string", enum: [...GITHUB_DIAGNOSTIC_REPOSITORY_IDS] },
      },
      required: ["repositoryId"],
      additionalProperties: false,
    },
  },
] as const;

