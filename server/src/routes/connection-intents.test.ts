import { describe, expect, it, vi } from "vitest";
import {
  CONNECTION_REQUEST_TOOL_DESCRIPTION,
  CONNECTIONS_SEARCH_TOOL_DESCRIPTION,
  RUNTIME_TOOL_NAMES,
} from "@paperclipai/shared";
import {
  RUNTIME_CONNECTION_TOOL_DEFINITIONS,
  wakeConnectionIntentAfterResolution,
} from "./connection-intents.js";

describe("runtime connection MCP contract", () => {
  it("advertises all canonical runtime tools with narrow schemas", () => {
    expect(
      RUNTIME_CONNECTION_TOOL_DEFINITIONS.map((tool) => tool.name),
    ).toEqual(RUNTIME_TOOL_NAMES);
    expect(RUNTIME_CONNECTION_TOOL_DEFINITIONS).toEqual([
      {
        name: "connections_search",
        description: CONNECTIONS_SEARCH_TOOL_DESCRIPTION,
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            retryProviderChoice: {
              type: "boolean",
              description: "Only when the user explicitly asks to reconsider a previous provider choice or decline",
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: "connection_request",
        description: CONNECTION_REQUEST_TOOL_DESCRIPTION,
        inputSchema: {
          type: "object",
          properties: {
            service: { type: "string" },
            targetService: { type: "string", description: "App slug returned by search only when the user explicitly named this external provider" },
            selectionInteractionId: {
              type: "string",
              description: "Saved answered provider-choice interaction ID for aggregator routes",
            },
          },
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
            repositoryId: { type: "string", enum: ["1396224242", "1396224001", "1319564297"] },
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
            repositoryId: { type: "string", enum: ["1396224242", "1396224001", "1319564297"] },
          },
          required: ["repositoryId"],
          additionalProperties: false,
        },
      },
    ]);
  });

  it("does not accept run identity, task identity, users, or credentials from tool input", () => {
    const serialized = JSON.stringify(
      RUNTIME_CONNECTION_TOOL_DEFINITIONS.map(
        (definition) => definition.inputSchema,
      ),
    );
    expect(serialized).not.toMatch(
      /companyId|agentId|runId|issueId|responsibleUserId|credential|token/i,
    );
  });
});

describe("connection intent continuation wake contract", () => {
  it.each([
    ["accepted", "connected"],
    ["rejected", "declined"],
  ])(
    "emits one idempotent continuation wake for %s intents",
    async (status) => {
      const wakeup = vi.fn().mockResolvedValue(undefined);

      await wakeConnectionIntentAfterResolution({ wakeup } as never, {
        loaded: {
          issue: {
            id: "issue-123",
            assigneeAgentId: "agent-123",
            status: "in_progress",
          },
          interaction: { id: "interaction-123" },
        },
        status,
        actorId: "user-123",
      });

      expect(wakeup).toHaveBeenCalledTimes(1);
      expect(wakeup).toHaveBeenCalledWith(
        "agent-123",
        expect.objectContaining({
          idempotencyKey: `connection-intent:interaction-123:${status}`,
          requestedByActorType: "user",
          requestedByActorId: "user-123",
          contextSnapshot: expect.objectContaining({
            issueId: "issue-123",
            interactionId: "interaction-123",
            interactionStatus: status,
            forceFreshSession: true,
          }),
        }),
      );
    },
  );

  it.each(["backlog", "todo", "done", "blocked", "cancelled"])(
    "does not wake a parked or closed %s task",
    async (issueStatus) => {
      const wakeup = vi.fn().mockResolvedValue(undefined);

      await wakeConnectionIntentAfterResolution({ wakeup } as never, {
        loaded: {
          issue: {
            id: "issue-closed",
            assigneeAgentId: "agent-123",
            status: issueStatus,
          },
          interaction: { id: "interaction-123" },
        },
        status: "accepted",
        actorId: "user-123",
      });

      expect(wakeup).not.toHaveBeenCalled();
    },
  );
});
