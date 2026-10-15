// Keep this child independent of SQLite and the shared runtime import graph.
import { SQLITE_READONLY_CHILD_ARG } from "./runtime-process-entrypoints.js";
import {
  readStableSqliteFileGeneration,
  serializeSqliteFileGeneration,
} from "./sqlite-file-generation.js";
import type { SqliteReadOnlyWorkerResult } from "./sqlite-readonly-worker-protocol.js";

if (process.argv[2] === SQLITE_READONLY_CHILD_ARG) {
  let result: SqliteReadOnlyWorkerResult;
  try {
    const pathname = process.argv[4];
    const mode = process.argv[3];
    if (mode !== "file-generation" || !pathname) {
      throw new Error("SQLite file generation observation requires its mode and source path");
    }
    result = {
      ok: true,
      generation: serializeSqliteFileGeneration(readStableSqliteFileGeneration(pathname)),
    };
  } catch (error) {
    process.exitCode = 1;
    result = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  process.stdout.write(JSON.stringify(result));
}
