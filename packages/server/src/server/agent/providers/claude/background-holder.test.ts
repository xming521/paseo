import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { releaseClaudeBackgroundHolder } from "./background-holder.js";

const SESSION = "0EDFD774-da91-4797-9c18-3b85f71bd4c2";
const dirs: string[] = [];
const children: ReturnType<typeof spawn>[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function configWithJob(input: {
  status: string;
  tasks?: number;
  kind?: string;
  stateSession?: string;
}) {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "background-holder-"));
  dirs.push(configDir);
  const child = spawn("sleep", ["30"]);
  children.push(child);
  const pid = child.pid!;
  await mkdir(path.join(configDir, "sessions"));
  await mkdir(path.join(configDir, "jobs", "0edfd774"), { recursive: true });
  await writeFile(
    path.join(configDir, "sessions", `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: SESSION.toLowerCase(),
      kind: input.kind ?? "bg",
      jobId: "0edfd774",
      status: input.status,
    }),
  );
  await writeFile(
    path.join(configDir, "jobs", "0edfd774", "state.json"),
    JSON.stringify({
      sessionId: input.stateSession ?? SESSION.toLowerCase(),
      inFlight: { tasks: input.tasks ?? 0, queued: 0 },
    }),
  );
  const stopped: string[] = [];
  const stopJob = async (jobId: string) => {
    stopped.push(jobId);
    child.kill();
  };
  return { configDir, stopped, stopJob };
}

test("an idle background job is stopped before the resume", async () => {
  const { configDir, stopped, stopJob } = await configWithJob({ status: "idle" });
  await expect(
    releaseClaudeBackgroundHolder({ configDir, sessionId: SESSION, stopJob }),
  ).resolves.toBe("0edfd774");
  expect(stopped).toEqual(["0edfd774"]);
});

test("a working job, or one with background tasks, is left running", async () => {
  for (const job of [{ status: "busy" }, { status: "idle", tasks: 1 }]) {
    const { configDir, stopped, stopJob } = await configWithJob(job);
    await expect(
      releaseClaudeBackgroundHolder({ configDir, sessionId: SESSION, stopJob }),
    ).rejects.toThrow("claude stop 0edfd774");
    expect(stopped).toEqual([]);
  }
});

test("interactive holders and stale job ids are not stopped", async () => {
  for (const job of [
    { status: "idle", kind: "interactive" },
    { status: "idle", stateSession: "another-session" },
  ]) {
    const { configDir, stopped, stopJob } = await configWithJob(job);
    await expect(
      releaseClaudeBackgroundHolder({ configDir, sessionId: SESSION, stopJob }),
    ).resolves.toBeNull();
    expect(stopped).toEqual([]);
  }
});
