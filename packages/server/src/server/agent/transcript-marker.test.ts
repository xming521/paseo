import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  findCodexRolloutFile,
  readClaudeTranscriptMarker,
  readCodexRolloutMarker,
} from "./transcript-marker.js";

const dirs: string[] = [];
async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "transcript-marker-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

test("Claude marker is the newest main-chain message across chunk boundaries", async () => {
  const file = path.join(await tempDir(), "session.jsonl");
  await writeFile(
    file,
    jsonl([
      { type: "user", uuid: "u1" },
      // Multi-byte text larger than one read chunk, so a boundary cuts a character.
      { type: "assistant", uuid: "a1", message: { content: "汉字".repeat(150_000) } },
      { type: "assistant", uuid: "side", isSidechain: true },
      { type: "user", uuid: "meta", isMeta: true },
      ...Array.from({ length: 30 }, () => ({ type: "api-request-blob", blob: "x".repeat(20_000) })),
      { type: "last-prompt", leafUuid: "a1" },
    ]),
  );
  expect(await readClaudeTranscriptMarker(file)).toBe("a1");
  expect(await readClaudeTranscriptMarker(`${file}.missing`)).toBeNull();
});

test("Codex marker is the newest message timestamp and rollouts are found by thread id", async () => {
  const home = await tempDir();
  const dir = path.join(home, "sessions", "2026", "11", "01");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "rollout-2026-11-01T13-16-16-thread-1.jsonl");
  await writeFile(
    file,
    jsonl([
      { type: "response_item", timestamp: "t1", payload: { type: "message", role: "user" } },
      { type: "response_item", timestamp: "t2", payload: { type: "message", role: "assistant" } },
      { type: "event_msg", timestamp: "t3", payload: { type: "token_count" } },
    ]),
  );
  expect(await findCodexRolloutFile(home, "thread-1")).toBe(file);
  expect(await findCodexRolloutFile(home, "thread-2")).toBeNull();
  expect(await readCodexRolloutMarker(file)).toBe("t2");
});
