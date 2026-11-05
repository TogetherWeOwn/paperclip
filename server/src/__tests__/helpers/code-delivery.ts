import { eq } from "drizzle-orm";
import { codeDeliveryReadinessReceipts, issues, type Db } from "@paperclipai/db";

export async function insertTerminalDeliveryFixture(db: Db, issueId: string) {
  await db.transaction(async tx => {
    const [issue] = await tx.select().from(issues).where(eq(issues.id, issueId)).for("update");
    if (!issue) throw new Error("Missing terminal fixture issue");
    const preparedAt = new Date();
    await tx.insert(codeDeliveryReadinessReceipts).values({ companyId: issue.companyId, issueId,
      issueRevision: issue.codeDeliveryRevision, terminalStatus: "done", snapshotHash: "a".repeat(64),
      actorType: "user", actorId: "fixture", evidence: { kind: "synthetic_test_fixture_not_provider_evidence" },
      preparedAt, expiresAt: new Date(preparedAt.getTime() + 30_000) });
    await tx.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, issueId));
  });
}
