// Real process-adapter rendezvous. Only disposable run identities are reported;
// credentials remain in the child environment and are never sent or printed.
const control = process.env.SIGNOFF_HTTP_CONTROL;
if (!control || new URL(control).hostname !== "127.0.0.1") {
  throw new Error("A loopback-only diagnostic control URL is required");
}
const identity = {
  companyId: process.env.PAPERCLIP_COMPANY_ID,
  agentId: process.env.PAPERCLIP_AGENT_ID,
  runId: process.env.PAPERCLIP_RUN_ID,
};
async function rendezvous(phase) {
  const response = await fetch(`${control}/${phase}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(identity),
  });
  if (!response.ok) throw new Error(`Rendezvous failed: ${response.status}`);
}
process.once("SIGTERM", () => {
  void rendezvous("cancel").then(() => process.exit(0));
});
await rendezvous("adapter");
process.stdout.write("diagnostic adapter released\n");
