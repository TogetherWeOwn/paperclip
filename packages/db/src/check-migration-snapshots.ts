import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const metaDir = fileURLToPath(new URL("./migrations/meta", import.meta.url));
const journalPath = fileURLToPath(
  new URL("./migrations/meta/_journal.json", import.meta.url),
);

type JournalFile = {
  entries?: Array<{
    idx?: number;
    tag?: string;
  }>;
};

type SnapshotFile = {
  id?: unknown;
  prevId?: unknown;
  version?: unknown;
  dialect?: unknown;
};

const MAX_SNAPSHOTS = 5;

function migrationNumber(value: string): string | null {
  const match = value.match(/^(\d{4})_/);
  return match ? match[1] : null;
}

async function main() {
  const rawJournal = await readFile(journalPath, "utf8");
  const journal = JSON.parse(rawJournal) as JournalFile;
  const entries = journal.entries ?? [];
  if (entries.length === 0) {
    throw new Error("Migration journal has no entries");
  }

  const tags: string[] = [];
  for (const [index, entry] of entries.entries()) {
    if (typeof entry.tag !== "string" || entry.tag.length === 0) {
      throw new Error(`Migration journal entry ${index} is missing a tag`);
    }
    if (typeof entry.idx !== "number" || !Number.isInteger(entry.idx)) {
      throw new Error(
        `Migration journal entry ${entry.tag} is missing an integer idx`,
      );
    }
    // NOTE: historical idx values are not asserted monotonic here. The
    // journal carries a pre-existing duplicate idx (0178), and idx is the
    // id drizzle records in __drizzle_migrations, so rewriting history is
    // not an option. Ordering is enforced on tags (and files) by
    // check-migration-numbering.ts; below pins the newest idx to the
    // newest snapshot, which is the linkage the drift test relies on.
    tags.push(entry.tag);
  }
  const journalNumbers = new Set(
    tags.map((tag) => {
      const number = migrationNumber(tag);
      if (!number) {
        throw new Error(`Migration journal tag has no 4-digit number: ${tag}`);
      }
      return number;
    }),
  );

  const snapshotFiles = (await readdir(metaDir))
    .filter((entry) => entry.endsWith("_snapshot.json"))
    .sort();
  if (snapshotFiles.length === 0) {
    throw new Error("No migration snapshots found in meta/");
  }
  if (snapshotFiles.length > MAX_SNAPSHOTS) {
    throw new Error(
      `Too many migration snapshots: found ${snapshotFiles.length}, policy keeps the newest ${MAX_SNAPSHOTS} (run pnpm --filter @paperclipai/db generate to prune)`,
    );
  }

  const seenIds = new Map<string, string>();
  for (const file of snapshotFiles) {
    const number = migrationNumber(file);
    if (!number) {
      throw new Error(`Snapshot file has no 4-digit number: ${file}`);
    }
    if (!journalNumbers.has(number)) {
      throw new Error(
        `Snapshot ${file} has no matching journal entry (orphaned by a renumber?)`,
      );
    }
    const snapshot = JSON.parse(
      await readFile(path.join(metaDir, file), "utf8"),
    ) as SnapshotFile;
    if (typeof snapshot.id !== "string" || snapshot.id.length === 0) {
      throw new Error(`Snapshot ${file} is missing its id hash`);
    }
    const previous = seenIds.get(snapshot.id);
    if (previous) {
      throw new Error(
        `Duplicate snapshot id ${snapshot.id} in ${previous} and ${file}`,
      );
    }
    seenIds.set(snapshot.id, file);
  }

  const newestEntry = entries[entries.length - 1] as { idx: number; tag: string };
  const newestTag = newestEntry.tag;
  const newestNumber = migrationNumber(newestTag) as string;
  const newestIdx = String(newestEntry.idx).padStart(4, "0");
  if (newestIdx !== newestNumber) {
    throw new Error(
      `Newest journal entry ${newestTag} has idx ${newestEntry.idx}, expected ${newestNumber} (idx drift breaks the snapshot lookup)`,
    );
  }
  // migration-snapshot-drift.test.ts resolves the newest snapshot from the
  // journal idx, so require exactly that file here with a clear error.
  const newestSnapshot = `${newestIdx}_snapshot.json`;
  if (!snapshotFiles.includes(newestSnapshot)) {
    throw new Error(
      `Newest migration ${newestTag} has no snapshot: expected meta/${newestSnapshot} (migration-snapshot-drift.test.ts diffs the schema against it)`,
    );
  }

  console.log(
    `Migration snapshot check passed: ${snapshotFiles.length} snapshot(s), newest is ${newestSnapshot}.`,
  );
}

await main();
