import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createChatReconciliationCoordinator,
  shouldEnablePrivateHostnameGuard,
} from "../app.ts";
import { CHAT_RUN_MILESTONE_SWEEP_DEFAULT_LIMIT } from "../services/chat-run-publications.js";

describe("createChatReconciliationCoordinator", () => {
  it.each([false, true])(
    "keeps later inbound sweeps independent of GitHub recovery and joins shutdown (rejects: %s)",
    async (rejects) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const failure = new Error("GitHub recovery unavailable");
      const processFailedGitHubWebhookDeliveries = vi.fn(async () => {
        await held;
        if (rejects) throw failure;
      });
      const processPendingDeliveries = vi.fn(async () => undefined);
      const flushPublications = vi.fn(async () => undefined);
      const onError = vi.fn();
      const input = {
        processFailedGitHubWebhookDeliveries,
        processPendingDeliveries,
        flushPublications,
        reconcileProviderRuntimes: async () => undefined,
        projectRunMilestones: async () => 0,
        processPendingSlackFileUploadReceipts: async () => undefined,
        processPendingSlackSessionSyncs: async () => undefined,
        onError,
      };
      const coordinator = createChatReconciliationCoordinator(input);
      let draining: Promise<void> | undefined;
      try {
        coordinator.reconcile();
        await vi.waitFor(() => {
          expect(processFailedGitHubWebhookDeliveries).toHaveBeenCalledOnce();
          expect(processPendingDeliveries).toHaveBeenCalledTimes(1);
        });
        // A second sweep must admit work arriving AFTER the first sweep while
        // remote GitHub recovery remains held. Same-sweep parallelism is not enough.
        coordinator.reconcile();
        await vi.waitFor(() => {
          expect(processPendingDeliveries).toHaveBeenCalledTimes(2);
          expect(flushPublications).toHaveBeenCalledTimes(2);
        });
        expect(processFailedGitHubWebhookDeliveries).toHaveBeenCalledOnce();
        coordinator.stop();
        let drained = false;
        draining = coordinator.drain().then(() => {
          drained = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(drained).toBe(false);
        coordinator.reconcile();
        release();
        await draining;
        expect(drained).toBe(true);
        expect(processFailedGitHubWebhookDeliveries).toHaveBeenCalledOnce();
        expect(processPendingDeliveries).toHaveBeenCalledTimes(2);
        expect(onError).toHaveBeenCalledTimes(rejects ? 1 : 0);
        if (rejects)
          expect(onError).toHaveBeenCalledWith(
            "GitHub webhook recovery",
            failure,
          );
      } finally {
        release();
        coordinator.stop();
        await (draining ?? coordinator.drain());
      }
    },
  );

  it("wires GitHub recovery into its independent lane", () => {
    const source = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    expect(source).toContain(
      "chatChannels.processFailedGitHubWebhookDeliveries()",
    );
    const service = readFileSync(
      new URL("../services/chat-channels.ts", import.meta.url),
      "utf8",
    );
    const ordinary = service.slice(
      service.indexOf("async function processPendingDeliveries("),
      service.indexOf("async function listResources("),
    );
    expect(ordinary).not.toContain("processFailedGitHubWebhookDeliveries()");
  });

  it("wires bounded publication refill to commit workers and isolates periodic maintenance", () => {
    const source = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    expect(source).toContain("registerChatDeliveryWork(deliveryWork, chatChannels,");
    expect(source).toContain("registerChatActionWork(deliveryWork, chatChannels,");
    const maintenance = source.slice(
      source.indexOf("const reconcileChatPublicationMaintenance ="),
      source.indexOf("const chatReconciliation ="),
    );
    expect(maintenance).toContain("chatChannels.processPublicationMaintenance()");
    expect(maintenance).not.toContain("chatChannels.schedulePendingPublications()");
    expect(maintenance).not.toContain("chatChannels.processPendingPublications()");
    const workers = readFileSync(new URL("../services/chat-delivery-work.ts", import.meta.url), "utf8");
    expect(workers).toContain("run: service.scheduleQueuedPublications");
    // The service integration tests hold real publication workers while this
    // scheduled method returns; app shutdown must also join those workers.
    expect(source).toContain("await chatChannels.shutdown()");
    expect(source).not.toContain("chatChannels.processPendingSlackSessionSyncs()");
    const service = readFileSync(new URL("../services/chat-channels.ts", import.meta.url), "utf8");
    const actionMaintenance = service.slice(service.indexOf("async function processPendingChatMaintenance("),
      service.indexOf("async function processPendingDeliveries("));
    expect(actionMaintenance).not.toContain("processPendingProviderEffects(");
    expect(actionMaintenance).not.toContain("processPendingGitHubWebhookIngress(");
    // Idle milestone recovery is on its own slow cadence while commit
    // signals still wake it immediately.
    expect(source).toContain("CHAT_MILESTONE_RECONCILIATION_INTERVAL_MS");
    expect(source).toContain("chatReconciliation.reconcileMilestones()");
  });

  it.each([false, true])(
    "isolates a blocked milestone projector and joins its completion (rejects: %s)",
    async (rejects) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const failure = new Error("milestone projection failed");
      const projectRunMilestones = vi
        .fn(async () => 0)
        .mockImplementationOnce(async () => {
          await held;
          if (rejects) throw failure;
          return 1;
        });
      const flushPublications = vi.fn(async () => undefined);
      const onError = vi.fn();
      const coordinator = createChatReconciliationCoordinator({
        projectRunMilestones,
        reconcileProviderRuntimes: async () => undefined,
        processPendingDeliveries: async () => undefined,
        flushPublications,
        processPendingSlackFileUploadReceipts: async () => undefined,
        processPendingSlackSessionSyncs: async () => undefined,
        onError,
      });
      try {
        coordinator.reconcile();
        coordinator.reconcileMilestones();
        await vi.waitFor(() => {
          expect(projectRunMilestones).toHaveBeenCalledTimes(1);
          expect(flushPublications).toHaveBeenCalledTimes(1);
        });
        // A newly committed final/question must dispatch even while a different
        // issue's projection is blocked. Repeated signals leave one dirty retry.
        coordinator.notifyPublications();
        coordinator.notifyPublications();
        await vi.waitFor(() =>
          expect(flushPublications).toHaveBeenCalledTimes(2),
        );
        expect(projectRunMilestones).toHaveBeenCalledTimes(1);
        let drained = false;
        const draining = coordinator.drain().then(() => {
          drained = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(drained).toBe(false);
        release();
        await draining;
        expect(projectRunMilestones).toHaveBeenCalledTimes(2);
        expect(onError).toHaveBeenCalledTimes(rejects ? 1 : 0);
        if (rejects)
          expect(onError).toHaveBeenCalledWith("run milestones", failure);
        const completedCounts = [
          projectRunMilestones.mock.calls.length,
          flushPublications.mock.calls.length,
        ];
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect([
          projectRunMilestones.mock.calls.length,
          flushPublications.mock.calls.length,
        ]).toEqual(completedCounts);
      } finally {
        release();
        coordinator.stop();
        await coordinator.drain();
      }
    },
  );

  it("joins a blocked milestone projector at shutdown without starting dirty follow-ups", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const projectRunMilestones = vi.fn(async () => {
      await held;
      return 1;
    });
    const flushPublications = vi.fn(async () => undefined);
    const coordinator = createChatReconciliationCoordinator({
      projectRunMilestones,
      flushPublications,
      reconcileProviderRuntimes: async () => undefined,
      processPendingDeliveries: async () => undefined,
      processPendingSlackFileUploadReceipts: async () => undefined,
      processPendingSlackSessionSyncs: async () => undefined,
      onError: vi.fn(),
    });
    try {
      coordinator.reconcile();
      coordinator.reconcileMilestones();
      await vi.waitFor(() => {
        expect(projectRunMilestones).toHaveBeenCalledOnce();
        expect(flushPublications).toHaveBeenCalledOnce();
      });
      coordinator.notifyPublications();
      coordinator.stop();
      let drained = false;
      const draining = coordinator.drain().then(() => {
        drained = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(drained).toBe(false);
      release();
      await draining;
      expect(projectRunMilestones).toHaveBeenCalledOnce();
      expect(flushPublications).toHaveBeenCalledOnce();
    } finally {
      release();
      coordinator.stop();
      await coordinator.drain();
    }
  });

  it("keeps slow optional recovery from suppressing later publication sweeps", async () => {
    let releaseDelivery!: () => void;
    let releaseSlackStatus!: () => void;
    const deliveryReleased = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const slackStatusReleased = new Promise<void>((resolve) => {
      releaseSlackStatus = resolve;
    });
    const reconcileProviderRuntimes = vi.fn(async () => undefined);
    const processPendingDeliveries = vi.fn(async () => deliveryReleased);
    const flushPublications = vi.fn(async () => undefined);
    const processPendingSlackFileUploadReceipts = vi.fn(async () => undefined);
    const processPendingSlackSessionSyncs = vi.fn(
      async () => slackStatusReleased,
    );
    const onError = vi.fn();
    const coordinator = createChatReconciliationCoordinator({
      projectRunMilestones: async () => 0,
      reconcileProviderRuntimes,
      processPendingDeliveries,
      flushPublications,
      processPendingSlackFileUploadReceipts,
      processPendingSlackSessionSyncs,
      onError,
    });

    coordinator.reconcile();
    await vi.waitFor(() => {
      expect(reconcileProviderRuntimes).toHaveBeenCalledTimes(1);
      expect(processPendingDeliveries).toHaveBeenCalledTimes(1);
      expect(flushPublications).toHaveBeenCalledTimes(1);
      expect(processPendingSlackFileUploadReceipts).toHaveBeenCalledTimes(1);
      expect(processPendingSlackSessionSyncs).toHaveBeenCalledTimes(1);
    });
    coordinator.reconcile();
    await vi.waitFor(() => {
      expect(reconcileProviderRuntimes).toHaveBeenCalledTimes(2);
      expect(flushPublications).toHaveBeenCalledTimes(2);
      expect(processPendingSlackFileUploadReceipts).toHaveBeenCalledTimes(2);
    });
    expect(processPendingDeliveries).toHaveBeenCalledTimes(1);
    expect(processPendingSlackSessionSyncs).toHaveBeenCalledTimes(1);

    releaseDelivery();
    releaseSlackStatus();
    await coordinator.drain();
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "joins the independent Slack file receipt lane at shutdown (rejects: %s)",
    async (rejects) => {
      let releaseReceipt!: () => void;
      const receiptReleased = new Promise<void>((resolve) => {
        releaseReceipt = resolve;
      });
      const lookupError = new Error("receipt lookup failed");
      const processPendingSlackFileUploadReceipts = vi
        .fn(async () => undefined)
        .mockImplementationOnce(async () => {
          await receiptReleased;
          if (rejects) throw lookupError;
        });
      const reconcileProviderRuntimes = vi.fn(async () => undefined);
      const processPendingDeliveries = vi.fn(async () => undefined);
      const flushPublications = vi.fn(async () => undefined);
      const processPendingSlackSessionSyncs = vi.fn(async () => undefined);
      const onError = vi.fn();
      const coordinator = createChatReconciliationCoordinator({
        projectRunMilestones: async () => 0,
        reconcileProviderRuntimes,
        processPendingDeliveries,
        flushPublications,
        processPendingSlackFileUploadReceipts,
        processPendingSlackSessionSyncs,
        onError,
      });
      let draining: Promise<void> | undefined;
      try {
        coordinator.reconcile();
        await vi.waitFor(() => {
          expect(processPendingSlackFileUploadReceipts).toHaveBeenCalledTimes(
            1,
          );
          expect(flushPublications).toHaveBeenCalledTimes(1);
        });
        coordinator.reconcile();
        await vi.waitFor(() => {
          expect(reconcileProviderRuntimes).toHaveBeenCalledTimes(2);
          expect(processPendingDeliveries).toHaveBeenCalledTimes(2);
          expect(flushPublications).toHaveBeenCalledTimes(2);
          expect(processPendingSlackSessionSyncs).toHaveBeenCalledTimes(2);
        });
        expect(processPendingSlackFileUploadReceipts).toHaveBeenCalledTimes(1);

        let drained = false;
        draining = coordinator.drain().then(() => {
          drained = true;
        });
        // Flush the promise queue, not a wall-clock delay: the held receipt
        // must still be part of shutdown's joined work after other lanes end.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(drained).toBe(false);
        expect(onError).not.toHaveBeenCalled();

        releaseReceipt();
        await draining;
        expect(drained).toBe(true);
        expect(onError).toHaveBeenCalledTimes(rejects ? 1 : 0);
        if (rejects) {
          expect(onError).toHaveBeenCalledWith(
            "Slack file receipts",
            lookupError,
          );
        }

        // A completed or failed lookup releases only its own single-flight
        // slot; the next ordinary reconciliation can recover another receipt.
        coordinator.reconcile();
        await coordinator.drain();
        expect(processPendingSlackFileUploadReceipts).toHaveBeenCalledTimes(2);
        expect(onError).toHaveBeenCalledTimes(rejects ? 1 : 0);
      } finally {
        releaseReceipt();
        await draining;
        await coordinator.drain();
      }
    },
  );

  it("keeps the milestone sweep off the fast idle poll", async () => {
    const projectRunMilestones = vi.fn(async () => 0);
    const flushPublications = vi.fn(async () => undefined);
    const coordinator = createChatReconciliationCoordinator({
      projectRunMilestones,
      reconcileProviderRuntimes: async () => undefined,
      processPendingDeliveries: async () => undefined,
      flushPublications,
      processPendingSlackFileUploadReceipts: async () => undefined,
      processPendingSlackSessionSyncs: async () => undefined,
      onError: vi.fn(),
    });
    try {
      coordinator.reconcile();
      await coordinator.drain();
      expect(flushPublications).toHaveBeenCalledTimes(1);
      expect(projectRunMilestones).not.toHaveBeenCalled();
      coordinator.reconcileMilestones();
      await coordinator.drain();
      expect(projectRunMilestones).toHaveBeenCalledTimes(1);
      coordinator.notifyPublications();
      await coordinator.drain();
      expect(projectRunMilestones).toHaveBeenCalledTimes(2);
    } finally {
      coordinator.stop();
      await coordinator.drain();
    }
  });

  it("threads a steady-state delta window into later milestone sweeps", async () => {
    const projectRunMilestones = vi.fn(async (_since?: Date) => 0);
    const coordinator = createChatReconciliationCoordinator({
      projectRunMilestones,
      reconcileProviderRuntimes: async () => undefined,
      processPendingDeliveries: async () => undefined,
      flushPublications: async () => undefined,
      processPendingSlackFileUploadReceipts: async () => undefined,
      processPendingSlackSessionSyncs: async () => undefined,
      onError: vi.fn(),
    });
    try {
      coordinator.reconcileMilestones();
      await coordinator.drain();
      expect(projectRunMilestones).toHaveBeenCalledTimes(1);
      // Cold sweep scans the trailing recovery window (no delta bound).
      expect(projectRunMilestones.mock.calls[0]![0]).toBeUndefined();
      coordinator.reconcileMilestones();
      await coordinator.drain();
      expect(projectRunMilestones).toHaveBeenCalledTimes(2);
      // Steady-state sweep scans only the delta since the previous sweep.
      const since = projectRunMilestones.mock.calls[1]![0];
      expect(since).toBeInstanceOf(Date);
      const ageMs = Date.now() - (since as Date).getTime();
      expect(ageMs).toBeGreaterThan(4 * 60_000);
      expect(ageMs).toBeLessThan(6 * 60_000);
    } finally {
      coordinator.stop();
      await coordinator.drain();
    }
  });

  it("holds the milestone watermark when a sweep hits its insert limit", async () => {
    // A truncated pass leaves unprojected runs in the same window; the next
    // sweep must re-scan it instead of advancing past the backlog.
    const projectRunMilestones = vi.fn(async (_since?: Date) => 0);
    projectRunMilestones.mockImplementationOnce(async () => 0);
    projectRunMilestones.mockImplementationOnce(
      async () => CHAT_RUN_MILESTONE_SWEEP_DEFAULT_LIMIT,
    );
    const coordinator = createChatReconciliationCoordinator({
      projectRunMilestones,
      reconcileProviderRuntimes: async () => undefined,
      processPendingDeliveries: async () => undefined,
      flushPublications: async () => undefined,
      processPendingSlackFileUploadReceipts: async () => undefined,
      processPendingSlackSessionSyncs: async () => undefined,
      onError: vi.fn(),
    });
    try {
      coordinator.reconcileMilestones();
      await coordinator.drain();
      coordinator.reconcileMilestones();
      await coordinator.drain();
      expect(projectRunMilestones).toHaveBeenCalledTimes(2);
      const secondSince = projectRunMilestones.mock.calls[1]![0] as Date;
      expect(secondSince).toBeInstanceOf(Date);
      // Truncated pass: the watermark must not advance.
      coordinator.reconcileMilestones();
      await coordinator.drain();
      expect(projectRunMilestones).toHaveBeenCalledTimes(3);
      const thirdSince = projectRunMilestones.mock.calls[2]![0] as Date;
      expect(thirdSince).toBeInstanceOf(Date);
      expect(thirdSince.getTime()).toBe(secondSince.getTime());
    } finally {
      coordinator.stop();
      await coordinator.drain();
    }
  });

  it("holds a cold watermark when the first sweep hits its insert limit", async () => {
    const projectRunMilestones = vi.fn(
      async (_since?: Date) => CHAT_RUN_MILESTONE_SWEEP_DEFAULT_LIMIT,
    );
    const coordinator = createChatReconciliationCoordinator({
      projectRunMilestones,
      reconcileProviderRuntimes: async () => undefined,
      processPendingDeliveries: async () => undefined,
      flushPublications: async () => undefined,
      processPendingSlackFileUploadReceipts: async () => undefined,
      processPendingSlackSessionSyncs: async () => undefined,
      onError: vi.fn(),
    });
    try {
      coordinator.reconcileMilestones();
      await coordinator.drain();
      coordinator.reconcileMilestones();
      await coordinator.drain();
      expect(projectRunMilestones).toHaveBeenCalledTimes(2);
      // Cold sweep scans the trailing recovery window (no delta bound); a
      // truncated cold pass must retry it, not advance past the backlog.
      expect(projectRunMilestones.mock.calls[0]![0]).toBeUndefined();
      expect(projectRunMilestones.mock.calls[1]![0]).toBeUndefined();
    } finally {
      coordinator.stop();
      await coordinator.drain();
    }
  });
});

describe("shouldEnablePrivateHostnameGuard", () => {
  it("enables the hostname guard for local_trusted private deployments", () => {
    expect(
      shouldEnablePrivateHostnameGuard({
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
      }),
    ).toBe(true);
  });

  it("does not enable the hostname guard for local_trusted public deployments", () => {
    expect(
      shouldEnablePrivateHostnameGuard({
        deploymentMode: "local_trusted",
        deploymentExposure: "public",
      }),
    ).toBe(false);
  });

  it("enables the hostname guard for authenticated private deployments", () => {
    expect(
      shouldEnablePrivateHostnameGuard({
        deploymentMode: "authenticated",
        deploymentExposure: "private",
      }),
    ).toBe(true);
  });

  it("does not enable the hostname guard for authenticated public deployments", () => {
    expect(
      shouldEnablePrivateHostnameGuard({
        deploymentMode: "authenticated",
        deploymentExposure: "public",
      }),
    ).toBe(false);
  });
});
