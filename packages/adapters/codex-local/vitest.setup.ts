import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

// Suites that run the real adapter resolve the managed Codex home and the auth
// cache under the Paperclip instance root. Left to the environment, that root is
// the developer's (or the live server's) own instance, and every run would leave
// `companies/<id>/codex-home` and `codex-auth-cache` directories in it. Point
// PAPERCLIP_HOME at a throwaway directory for each test file instead; suites
// that need a specific home still set their own and restore this one.
const testPaperclipHome = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-vitest-home-"));
process.env.PAPERCLIP_HOME = testPaperclipHome;

afterAll(() => {
  fs.rmSync(testPaperclipHome, { recursive: true, force: true });
});
