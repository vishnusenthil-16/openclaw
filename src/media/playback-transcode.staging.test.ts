import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import {
  settlePlaybackTranscodeJobsForTest,
  waitForPlaybackTranscodeJobsForTest,
} from "./playback-transcode.test-support.js";

const { runFfmpeg } = vi.hoisted(() => ({
  runFfmpeg: vi.fn(),
}));
vi.mock("./ffmpeg-exec.js", () => ({ runFfmpeg }));
vi.mock("./media-probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./media-probe.js")>()),
  probePlaybackMediaFileDescriptor: vi.fn(async () => ({
    durationMs: 1000,
    audioCodec: "pcm_s16le",
    audioStreamIndex: 0,
  })),
}));

let playback: typeof import("./playback-transcode.js");
let tempHome: TempHomeEnv;

beforeAll(async () => {
  vi.resetModules();
  tempHome = await createTempHomeEnv("openclaw-playback-staging-");
  playback = await import("./playback-transcode.js");
});

afterAll(async () => {
  try {
    await tempHome.restore();
  } finally {
    vi.doUnmock("./ffmpeg-exec.js");
    vi.doUnmock("./media-probe.js");
    vi.resetModules();
  }
});

beforeEach(() => {
  runFfmpeg.mockReset();
});

async function createSource(fileName: string, contents: string | Buffer) {
  const fixturePath = path.join(tempHome.home, fileName);
  await fs.writeFile(fixturePath, contents);
  const sourcePath = await fs.realpath(fixturePath);
  const sourceStat = await fs.stat(sourcePath);
  return {
    sourcePath,
    sourceStat: {
      size: sourceStat.size,
      mtimeMs: sourceStat.mtimeMs,
      ctimeMs: sourceStat.ctimeMs,
      exactIdentity: await fs.stat(sourcePath, { bigint: true }),
    },
  };
}

describe("playback input staging", () => {
  it("passes every staged input byte to ffmpeg before publishing the rendition", async () => {
    const contents = Buffer.alloc(1024 * 1024 + 19);
    for (let index = 0; index < contents.length; index += 1) {
      contents[index] = index % 251;
    }
    const source = await createSource("complete-input.caf", contents);
    let inputPath: string | undefined;
    runFfmpeg.mockImplementationOnce(async (args: string[]) => {
      inputPath = args[args.indexOf("-i") + 1];
      expect(inputPath).toBeDefined();
      const stagedInput = await fs.readFile(inputPath!);
      expect(stagedInput).toHaveLength(contents.length);
      expect(stagedInput.equals(contents), "complete staged ffmpeg input").toBe(true);
      await fs.writeFile(args.at(-1) ?? "", "normalized-audio");
      return "";
    });
    try {
      const params = {
        ...source,
        mimeType: "audio/x-caf",
        kind: "audio" as const,
      };
      expect(await playback.resolvePlaybackTranscode(params)).toEqual({ kind: "preparing" });
      await waitForPlaybackTranscodeJobsForTest("all");
      expect(runFfmpeg).toHaveBeenCalledOnce();
      expect(await playback.resolvePlaybackTranscode(params)).toMatchObject({
        kind: "transcoded",
        contentType: "audio/mp4",
      });
      await expect(fs.stat(inputPath!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await settlePlaybackTranscodeJobsForTest();
    }
  });

  it.each(["grow", "truncate", "rewrite", "replace"] as const)(
    "rejects a source that changes after open via %s before starting ffmpeg",
    async (change) => {
      const source = await createSource(`changed-${change}.caf`, "stable-source");
      const params = {
        ...source,
        mimeType: "audio/x-caf",
        kind: "audio" as const,
      };
      await expect(playback.resolvePlaybackMetadataForSource(params)).resolves.toMatchObject({
        playback: "transcode",
      });
      let changed = false;
      __setFsSafeTestHooksForTest({
        afterOpenedPathIdentityCheck: async (filePath) => {
          if (filePath !== source.sourcePath || changed) {
            return;
          }
          changed = true;
          if (change === "grow") {
            await fs.appendFile(filePath, "growth");
          } else if (change === "truncate") {
            await fs.truncate(filePath, 1);
          } else if (change === "rewrite") {
            const beforeRewrite = await fs.stat(filePath);
            await fs.writeFile(filePath, "edited-source");
            await fs.utimes(
              filePath,
              beforeRewrite.atime,
              new Date(source.sourceStat.mtimeMs + 2000),
            );
            expect((await fs.stat(filePath)).mtimeMs).not.toBe(source.sourceStat.mtimeMs);
          } else {
            await fs.rename(filePath, `${filePath}.old`);
            await fs.writeFile(filePath, "stable-source");
          }
        },
      });
      try {
        expect(await playback.resolvePlaybackTranscode(params)).toEqual({ kind: "preparing" });
        await expect(waitForPlaybackTranscodeJobsForTest("all")).rejects.toThrow(
          change === "grow" ? /exceeds limit/ : /changed|mismatch/,
        );
        expect(changed).toBe(true);
        expect(runFfmpeg).not.toHaveBeenCalled();
        expect(await playback.resolvePlaybackTranscode(params)).toEqual({ kind: "fallback" });
      } finally {
        __setFsSafeTestHooksForTest(undefined);
        await settlePlaybackTranscodeJobsForTest();
      }
    },
  );

  it("does not publish a cache entry when workspace cleanup fails", async () => {
    const source = await createSource("cleanup-failed.caf", "stable-source");
    const cleanupError = new Error("synthetic workspace cleanup failure");
    let quarantine: string | undefined;
    __setFsSafeTestHooksForTest({
      beforeTempWorkspaceNativeRemoval: (target) => {
        quarantine = target;
        throw cleanupError;
      },
    });
    runFfmpeg.mockImplementationOnce(async (args: string[]) => {
      await fs.writeFile(args.at(-1) ?? "", "normalized-audio");
      return "";
    });
    try {
      const params = {
        ...source,
        mimeType: "audio/x-caf",
        kind: "audio" as const,
      };
      expect(await playback.resolvePlaybackTranscode(params)).toEqual({ kind: "preparing" });
      await expect(waitForPlaybackTranscodeJobsForTest("all")).rejects.toBe(cleanupError);
      expect(runFfmpeg).toHaveBeenCalledOnce();
      expect(quarantine).toBeDefined();
      expect(await playback.resolvePlaybackTranscode(params)).toEqual({ kind: "fallback" });
    } finally {
      __setFsSafeTestHooksForTest(undefined);
      await settlePlaybackTranscodeJobsForTest();
      if (quarantine) {
        await fs.rm(quarantine, { recursive: true, force: true });
      }
    }
  });
});
