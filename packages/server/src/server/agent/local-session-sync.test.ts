import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { StoredAgentRecord } from "./agent-storage.js";
import { startLocalSessionSync, type SyncWorkspace } from "./local-session-sync.js";

const START = Date.parse("2026-11-02T12:00:00Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
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
  firstPromptAt?: Date;
  lastPromptAt?: Date;
  interactive?: boolean;
  replied?: boolean;
  firstPromptPreview: string | null;
  lastPromptPreview: string | null;
}

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-session-sync-"));
  dirs.push(dir);
  let now = START;
  let sessions: FakeSession[] = [];
  const records = new Map<string, StoredAgentRecord>();
  const loaded = new Set<string>();
  const workspace = (workspaceId: string, createdAt: number): SyncWorkspace => ({
    workspaceId,
    projectId: "p",
    cwd: CWD,
    title: null,
    createdAt: new Date(createdAt).toISOString(),
    archivedAt: null,
  });
  // Listed newest first: sessions still belong to the oldest workspace for the directory.
  const workspaces = new Map<string, SyncWorkspace>([
    ["home-2", workspace("home-2", START - DAY)],
    ["home", workspace("home", START - 2 * DAY)],
  ]);
  const iso = () => new Date(now).toISOString();

  const sync = startLocalSessionSync({
    providers: ["claude"],
    agentManager: {
      listImportableSessions: async () => ({ sessions, providerErrors: [] }),
      recordExternalSession: async (input) => {
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
          archivedAt: input.archived ? iso() : null,
        } as StoredAgentRecord;
        records.set(record.id, record);
        return record;
      },
      updateExternalSession: async (agentId, update) => {
        const record = records.get(agentId);
        if (!record || loaded.has(agentId)) return false;
        records.set(agentId, {
          ...record,
          ...(update.lastActivityAt ? { lastActivityAt: update.lastActivityAt.toISOString() } : {}),
          ...(update.title !== undefined ? { title: update.title } : {}),
          ...(update.workspaceId ? { workspaceId: update.workspaceId } : {}),
          ...(update.archived !== undefined ? { archivedAt: update.archived ? iso() : null } : {}),
        });
        return true;
      },
      getAgent: ((agentId: string) => (loaded.has(agentId) ? {} : null)) as never,
    } as never,
    agentStorage: { list: async () => Array.from(records.values()) },
    workspaces: {
      list: async () => Array.from(workspaces.values()),
      create: async ({ projectId, cwd, title, createdAt }) => {
        const workspace = {
          workspaceId: `row-${workspaces.size}`,
          projectId,
          cwd,
          title,
          archivedAt: null,
          createdAt: createdAt.toISOString(),
        };
        workspaces.set(workspace.workspaceId, workspace);
        return workspace;
      },
      setArchived: async (workspaceId, archived) => {
        workspaces.set(workspaceId, {
          ...workspaces.get(workspaceId)!,
          archivedAt: archived ? iso() : null,
        });
      },
      setTitle: async (workspaceId, title) => {
        workspaces.set(workspaceId, { ...workspaces.get(workspaceId)!, title });
      },
    },
    statePath: path.join(dir, "local-sessions.json"),
    logger: { info: () => undefined, warn: () => undefined },
    now: () => now,
    schedule: false,
  });

  return {
    records,
    workspaces,
    loaded,
    sync: () => sync.sync(),
    advance: (ms: number) => {
      now += ms;
    },
    /** A session whose latest prompt was `ago` ms before the current time. */
    session(id: string, ago: number, extra: Partial<FakeSession> = {}): FakeSession {
      return {
        provider: "claude",
        providerHandleId: id,
        cwd: CWD,
        title: `title ${id}`,
        lastActivityAt: new Date(now - ago),
        firstPromptAt: new Date(now - ago - MINUTE),
        lastPromptAt: new Date(now - ago),
        firstPromptPreview: "hello",
        lastPromptPreview: "hello",
        ...extra,
      };
    },
    setSessions: (next: FakeSession[]) => {
      sessions = next;
    },
    row: (agentId: string) => workspaces.get(records.get(agentId)!.workspaceId!)!,
  };
}

test("a session prompted this week gets its own row, an older one lists only in History", async () => {
  const t = await setup();
  t.setSessions([
    t.session("recent", DAY),
    t.session("older", 10 * DAY),
    t.session("sdk", DAY, { interactive: false }),
    t.session("too-old", 31 * DAY),
    t.session("elsewhere", DAY, { cwd: "/other" }),
    t.session("no-prompt", DAY, { firstPromptPreview: null, lastPromptPreview: null }),
    t.session("no-reply", DAY, { replied: false }),
    t.session("meta", DAY, {
      firstPromptPreview: "Generate metadata for a coding agent based on the user prompt.",
    }),
  ]);
  await t.sync();
  await t.sync();

  expect(Array.from(t.records.keys()).sort()).toEqual(["agent-older", "agent-recent"]);
  expect(t.records.get("agent-recent")).toMatchObject({ archivedAt: null });
  expect(t.row("agent-recent")).toMatchObject({
    title: "title recent",
    archivedAt: null,
    createdAt: new Date(START - DAY - MINUTE).toISOString(),
  });
  expect(t.records.get("agent-older")).toMatchObject({ workspaceId: "home" });
  expect(t.records.get("agent-older")?.archivedAt).toBeTruthy();
  expect(t.workspaces.size).toBe(3);
});

test("a row leaves the sidebar after a week without a prompt and returns with the next", async () => {
  const t = await setup();
  t.setSessions([t.session("a", MINUTE)]);
  await t.sync();
  // The session drops out of the listing once newer sessions fill it.
  t.setSessions([]);
  t.advance(7 * DAY);
  await t.sync();
  expect(t.row("agent-a").archivedAt).toBeTruthy();
  expect(t.records.get("agent-a")?.archivedAt).toBeTruthy();

  t.advance(DAY);
  t.setSessions([t.session("a", MINUTE)]);
  await t.sync();
  expect(t.row("agent-a").archivedAt).toBeNull();
  expect(t.records.get("agent-a")?.archivedAt).toBeNull();
});

test("a row stays where a person left it until the session's next prompt", async () => {
  const t = await setup();
  t.setSessions([t.session("a", 2 * MINUTE)]);
  await t.sync();
  // Archived after a prompt the sync has not seen yet: that prompt does not restore it.
  const prompt = t.session("a", 0);
  t.advance(MINUTE);
  t.workspaces.set(t.row("agent-a").workspaceId, {
    ...t.row("agent-a"),
    archivedAt: new Date(START + MINUTE).toISOString(),
  });
  t.setSessions([prompt]);
  await t.sync();
  expect(t.row("agent-a").archivedAt).toBeTruthy();

  t.advance(MINUTE);
  t.setSessions([t.session("a", 0)]);
  await t.sync();
  expect(t.row("agent-a").archivedAt).toBeNull();
});

test("a row someone restores is not aged again", async () => {
  const t = await setup();
  t.setSessions([t.session("a", MINUTE)]);
  await t.sync();
  t.advance(8 * DAY);
  await t.sync();
  t.workspaces.set(t.row("agent-a").workspaceId, { ...t.row("agent-a"), archivedAt: null });
  t.advance(DAY);
  await t.sync();
  expect(t.row("agent-a").archivedAt).toBeNull();
});

test("an open agent is not aged until it is released", async () => {
  const t = await setup();
  t.setSessions([t.session("a", MINUTE)]);
  await t.sync();
  t.loaded.add("agent-a");
  t.advance(8 * DAY);
  await t.sync();
  expect(t.row("agent-a").archivedAt).toBeNull();
  t.loaded.delete("agent-a");
  await t.sync();
  expect(t.row("agent-a").archivedAt).toBeTruthy();
});

test("an older session gets a row with its next prompt", async () => {
  const t = await setup();
  t.setSessions([t.session("a", 10 * DAY)]);
  await t.sync();
  expect(t.records.get("agent-a")).toMatchObject({ workspaceId: "home" });

  t.setSessions([t.session("a", MINUTE)]);
  await t.sync();
  expect(t.records.get("agent-a")).toMatchObject({ archivedAt: null });
  expect(t.row("agent-a")).toMatchObject({ workspaceId: "row-2", title: "title a" });
});

test("a deleted record returns only after a newer prompt", async () => {
  const t = await setup();
  t.setSessions([t.session("a", 10 * MINUTE)]);
  await t.sync();
  t.records.delete("agent-a");
  await t.sync();
  expect(t.records.size).toBe(0);
  t.setSessions([t.session("a", MINUTE)]);
  await t.sync();
  expect(t.records.has("agent-a")).toBe(true);
});

test("titles follow the session until they are renamed in Paseo", async () => {
  const t = await setup();
  t.setSessions([t.session("a", 10 * MINUTE, { title: "first prompt" })]);
  await t.sync();
  t.setSessions([t.session("a", 5 * MINUTE, { title: "ai title" })]);
  await t.sync();
  expect(t.records.get("agent-a")?.title).toBe("ai title");
  expect(t.row("agent-a").title).toBe("ai title");

  t.workspaces.set(t.row("agent-a").workspaceId, { ...t.row("agent-a"), title: "renamed" });
  t.setSessions([t.session("a", MINUTE, { title: "custom title" })]);
  await t.sync();
  expect(t.row("agent-a").title).toBe("renamed");
  expect(t.records.get("agent-a")?.title).toBe("custom title");
});

test("an agent Paseo started only follows the session's activity", async () => {
  const t = await setup();
  t.records.set("own", {
    id: "own",
    provider: "claude",
    cwd: CWD,
    workspaceId: "home-2",
    createdAt: new Date(START - DAY).toISOString(),
    updatedAt: new Date(START - DAY).toISOString(),
    lastActivityAt: new Date(START - DAY).toISOString(),
    title: "mine",
    labels: {},
    lastStatus: "closed",
    persistence: { provider: "claude", sessionId: "a" },
  } as StoredAgentRecord);
  t.setSessions([t.session("a", MINUTE, { title: "other" })]);
  await t.sync();
  expect(t.records.get("own")).toMatchObject({
    title: "mine",
    workspaceId: "home-2",
    lastActivityAt: new Date(START - MINUTE).toISOString(),
  });
  expect(t.workspaces.size).toBe(2);
});
