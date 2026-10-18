// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultGitHubReviewPolicy, githubChatConfigurationSchema } from "@paperclipai/shared";
import { githubChatApi, type GitHubConfigurationRecord } from "@/api/githubChat";
import { chatEndpointsApi, type ChatEndpoint } from "@/api/chatEndpoints";
import { GitHubBotManagement } from "./GitHubBotManagement";

vi.mock("@/api/githubChat", () => ({ githubChatApi: { configuration: vi.fn(), save: vi.fn() } }));
vi.mock("@/api/chatEndpoints", () => ({ chatEndpointsApi: { listResources: vi.fn() } }));
vi.mock("@/lib/router", async () => await import("react-router-dom"));

// Regression coverage of the existing UI: an unrelated complete-save must not
// silently erase API-configured routes. No shadow route editor is introduced.
describe("GitHub configuration round trip", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  });

  it("preserves disabled routes and revision when a user edits review policy and saves", async () => {
    const endpoint: ChatEndpoint = {
      id: "endpoint", companyId: "company", provider: "github", status: "active",
      assignedAgentId: "primary", assignedAgentName: "Primary", allowUnlinkedPeople: false,
    };
    const routes = [{ label: "candidate-low", agentId: "f0000000-0000-4000-8000-000000000001", enabled: false, sampleRate: 0.5 }];
    let stored: GitHubConfigurationRecord = {
      revision: 7,
      configuration: {
        version: 1, toolsEnabled: false, responsibleUserId: "owner", memberAccess: "all_linked",
        people: [], defaults: defaultGitHubReviewPolicy(), repositories: {}, shadowRoutes: routes,
      },
    };
    vi.mocked(githubChatApi.configuration).mockImplementation(async () => stored);
    vi.mocked(chatEndpointsApi.listResources).mockResolvedValue([]);
    vi.mocked(githubChatApi.save).mockImplementation(async (_id, revision, configuration) => {
      expect(revision).toBe(stored.revision);
      stored = { revision: revision + 1, configuration: githubChatConfigurationSchema.parse(configuration) };
      return stored;
    });
    client.setQueryData(["github-bot-configuration", endpoint.id], stored);
    client.setQueryData(["github-bot-repositories", endpoint.id], []);
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter><GitHubBotManagement endpoint={endpoint} view="settings" /></MemoryRouter>
      </QueryClientProvider>,
    ));
    const includeDrafts = container.querySelector<HTMLButtonElement>('[aria-label="Include draft PRs"]')!;
    expect(includeDrafts).not.toBeNull();
    await act(async () => includeDrafts.click());
    const save = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Save changes")!;
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    expect(stored.revision).toBe(8);
    expect(stored.configuration.defaults.reviewDrafts).toBe(true);
    expect(stored.configuration.shadowRoutes).toEqual(routes);
    expect(stored.configuration.shadow).toBeUndefined();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Configuration saved.");
  });
});
