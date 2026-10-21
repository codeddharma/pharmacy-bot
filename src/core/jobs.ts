import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

/** Deletes uploaded prescriptions older than the retention period. Returns how many were removed. */
export async function cleanupUploads(dataDir: string, retentionDays: number, now: Date): Promise<number> {
  const root = path.join(dataDir, "uploads");
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;

  let folders: string[];
  try {
    folders = await readdir(root);
  } catch {
    return 0;
  }
  for (const folder of folders) {
    const dir = path.join(root, folder);
    if (!(await stat(dir)).isDirectory()) continue;
    for (const file of await readdir(dir)) {
      const full = path.join(dir, file);
      if ((await stat(full)).mtimeMs < cutoff) {
        await rm(full);
        removed++;
      }
    }
  }
  return removed;
}
