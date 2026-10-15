import { setImmediate as yieldToGateway } from "node:timers/promises";
import type { TranscriptProjectionPublicationOperations } from "./session-transcript-projection-publication.worker.js";

type ProjectionStatus = TranscriptProjectionPublicationOperations["preflight"]["output"];

/** Drain bounded batches; writer receipts never restart an unfinished cursor. */
export async function drainTranscriptIndexStatus<Status extends ProjectionStatus>(
  maintain: () => Promise<Status>,
): Promise<Status> {
  for (let batch = 0; ; batch++) {
    const result = await maintain();
    // At most 4,096 candidates per pass; the existing reconcile cadence resumes the cursor.
    if (!result.hasMore || result.traversalComplete || batch === 31) {
      return result;
    }
    await yieldToGateway();
  }
}
