import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionWorkspaceCloseDialog } from "./ExecutionWorkspaceCloseDialog";

const { useQueryMock } = vi.hoisted(() => ({ useQueryMock: vi.fn() }));

vi.mock("@tanstack/react-query", () => ({
  useQuery: useQueryMock,
  useQueryClient: () => ({}),
  useMutation: () => ({ isPending: false }),
}));
vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
}));
vi.mock("./ui/dialog", () => {
  const Container = ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  );
  return {
    Dialog: Container,
    DialogContent: Container,
    DialogDescription: Container,
    DialogFooter: Container,
    DialogHeader: Container,
    DialogTitle: Container,
  };
});

describe("execution workspace close guidance", () => {
  beforeEach(() => useQueryMock.mockReset());

  it.each([
    { isSharedWorkspace: true, git: null, isProjectPrimaryWorkspace: false },
    { isSharedWorkspace: false, git: null, isProjectPrimaryWorkspace: false },
    { isSharedWorkspace: false, git: null, isProjectPrimaryWorkspace: true },
    {
      isSharedWorkspace: false,
      git: { workspacePath: "/checkout", repoRoot: "/repo" },
      isProjectPrimaryWorkspace: false,
    },
  ])("does not advertise archival when close is blocked: %j", (workspace) => {
    useQueryMock.mockReturnValue({
      isLoading: false,
      data: {
        ...workspace,
        state: "blocked",
        blockingReasons: ["Workspace preservation is unproved."],
        warnings: [],
        linkedIssues: [],
        plannedActions: [],
        runtimeServices: [],
        isDestructiveCloseAllowed: false,
      },
    });
    const html = renderToStaticMarkup(
      <ExecutionWorkspaceCloseDialog
        workspaceId="workspace"
        workspaceName="Retained checkout"
        currentStatus="active"
        open
        onOpenChange={() => undefined}
      />,
    );
    expect(html).toContain("Close is blocked");
    expect(html).toContain(
      "The workspace and its resources will remain in place while close is blocked.",
    );
    expect(html).not.toContain("can be archived");
    expect(html).not.toContain("disposable");
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>Close workspace<\/button>/,
    );
  });
});
