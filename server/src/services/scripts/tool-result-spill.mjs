// Controller-owned program. Result bytes arrive on stdin, never in argv or logs.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const { root, runId, invocationId, text, remote } = JSON.parse(input);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!path.isAbsolute(root) || !uuid.test(runId) || !uuid.test(invocationId) || typeof text !== "string") {
  throw new Error("Invalid tool-result spill binding");
}
const uid = process.getuid?.();
if (uid === undefined) throw new Error("Private tool-result spills require POSIX ownership");
const canonicalRoot = await fs.realpath(root);
let directory = canonicalRoot;
const segments = remote ? [".paperclip-runtime", "tool-results", runId] : ["tool-results", runId];
for (const segment of segments) {
  directory = path.join(directory, segment);
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid) {
    throw new Error("Unsafe tool-result spill directory");
  }
  // An existing workspace runtime root can be shared with other runtime files.
  // Only the spill subtree must be owner-private; do not chmod another feature.
  if (segment !== ".paperclip-runtime" && (stat.mode & 0o077) !== 0) {
    throw new Error("Tool-result spill directory is not private");
  }
}
const file = path.join(directory, `${invocationId}.txt`);
const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
try {
  await handle.writeFile(text, "utf8");
} finally {
  await handle.close();
}
process.stdout.write(JSON.stringify({ path: file, sizeBytes: Buffer.byteLength(text, "utf8") }));
