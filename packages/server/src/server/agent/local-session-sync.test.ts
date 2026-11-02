import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { StoredAgentRecord } from "./agent-storage.js";
import { startLocalSessionSync } from "./local-session-sync.js";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const CWD = "/repo";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface FakeSession {
  provider: "claude" | "codex";
  providerHandleId: string;
  cwd: string;
  title: string | null;
  lastActivityAt: Date;
  interactive?: boolean;
  firstPromptPreview: string | null;
  lastPromptPreview: string | null;
}

function session(id: string, minutesAgo: number, extra: Partial<FakeSession> = {}): FakeSession {
  return {
    provider: "claude",
    providerHandleId: id,
    cwd: CWD,
    title: `title ${id}`,
    lastActivityAt: new Date(NOW - minutesAgo * 60_000),
    firstPromptPreview: "hello",
    lastPromptPreview: "hello",
    ...extra,
  };
}

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-session-sync-"));
  dirs.push(dir);
  const records = new Map<string, StoredAgentRecord>();
  let sessions: FakeSession[] = [];
  const agentManager = {
    listImportableSessions: async () => ({ sessions, providerErrors: [] }),
    recordExternalSession: async (input: {
      provider: string;
      providerHandleId: string;
      cwd: string;
      workspaceId: string;
      title: string | null;
      lastActivityAt: Date;
    }) => {
      const at = input.lastActivityAt.toISOString();
      const record = {
        id: `agent-${input.providerHandleId}`,
        provider: input.provider,
        cwd: input.cwd,
        workspaceId: input.workspaceId,
        createdAt: at,
        updatedAt: at,
        lastActivityAt: at,
        title: input.title,
        labels: {},
        lastStatus: "closed",
        persistence: { provider: input.provider, sessionId: input.providerHandleId },
        archivedAt: at,
      } as StoredAgentRecord;
      records.set(record.id, record);
      return record;
    },
    refreshStoredActivity: async (
      agentId: string,
      update: { lastActivityAt: Date; title?: string | null },
    ) => {
      const record = records.get(agentId)!;
      const at = update.lastActivityAt.toISOString();
      records.set(agentId, {
        ...record,
        lastActivityAt: at,
        ...(update.title === undefined ? {} : { title: update.title }),
      });
    },
  };
  const sync = startLocalSessionSync({
    providers: ["claude"],
    agentManager: agentManager as never,
    agentStorage: { list: async () => Array.from(records.values()) },
    workspaces: async () => [
      { workspaceId: "ws", cwd: CWD, archivedAt: null },
      { workspaceId: "ws-same-dir", cwd: CWD, archivedAt: null },
    ],
    statePath: path.join(dir, "local-sessions.json"),
    logger: { info: () => undefined, warn: () => undefined },
    now: () => NOW,
    schedule: false,
  });
  return {
    records,
    sync: () => sync.sync(),
    setSessions: (next: FakeSession[]) => {
      sessions = next;
    },
  };
}

test("recent sessions a person started get one archived record each", async () => {
  const { records, sync, setSessions } = await setup();
  setSessions([
    session("a", 5),
    session("sdk", 5, { interactive: false }),
    session("old", 31 * 24 * 60),
    session("elsewhere", 5, { cwd: "/other" }),
    session("no-prompt", 5, { firstPromptPreview: null, lastPromptPreview: null }),
    session("meta", 5, {
      firstPromptPreview: "Generate metadata for a coding agent based on the user prompt.",
    }),
  ]);
  await sync();
  await sync();
  expect(Array.from(records.keys())).toEqual(["agent-a"]);
  expect(records.get("agent-a")).toMatchObject({ workspaceId: "ws", title: "title a" });
});

test("a deleted record returns only after a newer turn", async () => {
  const { records, sync, setSessions } = await setup();
  setSessions([session("a", 10)]);
  await sync();
  records.delete("agent-a");
  await sync();
  expect(records.size).toBe(0);
  setSessions([session("a", 1)]);
  await sync();
  expect(records.has("agent-a")).toBe(true);
});

test("the title follows the session until the agent is renamed in Paseo", async () => {
  const { records, sync, setSessions } = await setup();
  setSessions([session("a", 10, { title: "first prompt" })]);
  await sync();
  setSessions([session("a", 5, { title: "ai title" })]);
  await sync();
  expect(records.get("agent-a")?.title).toBe("ai title");
  records.set("agent-a", { ...records.get("agent-a")!, title: "renamed" });
  setSessions([session("a", 1, { title: "custom title" })]);
  await sync();
  expect(records.get("agent-a")).toMatchObject({
    title: "renamed",
    lastActivityAt: new Date(NOW - 60_000).toISOString(),
  });
});
