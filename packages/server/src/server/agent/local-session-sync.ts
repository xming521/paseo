import { promises as fs } from "node:fs";
import type { Logger } from "pino";

import { writeJsonFileAtomic } from "../atomic-file.js";
import { createRealpathAwarePathMatcher } from "../../utils/path.js";
import type { AgentManager } from "./agent-manager.js";
import type { AgentProvider, ImportableProviderSession } from "./agent-sdk-types.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import { isMetadataGenerationSession } from "./import-sessions.js";

// Paseo lists only the agents it started or imported. This sync brings in the provider sessions
// a person started elsewhere in a Paseo workspace's directory, such as a terminal or Claude
// Code's agent view, with no import step and without loading them.
// - A session with a prompt in the last week gets a workspace of its own, so it is a sidebar row
//   like a chat started in Paseo. A row whose session goes a week without a prompt is archived,
//   and returns with the session's next prompt.
// - An older session gets an archived agent in the directory's own workspace, so it lists only
//   under History. A new prompt gives it a row.
// Records follow prompts made outside Paseo, and titles follow the session's until someone renames
// them in Paseo. A row or record someone archives or deletes stays that way until the session has
// a newer prompt. Archiving here never archives the provider's own copy of a session.

const SYNC_INTERVAL_MS = 60_000;
const FIRST_SYNC_DELAY_MS = 5_000;
const DAY_MS = 24 * 60 * 60_000;
// History groups agents into today, yesterday, this week and this month.
const MAX_AGE_MS = 30 * DAY_MS;
const ROW_AGE_MS = 7 * DAY_MS;
// The first listing of a directory reaches back over the whole window. Later ones only need the
// sessions prompted since, which sort first.
const BACKFILL_LIMIT = 1000;
const RECENT_LIMIT = 50;

/** What the sync last did for a session. */
interface SeenSession {
  /** The latest prompt the sync has acted on. */
  at: number;
  /** The title the sync last gave the session's agent and row. */
  title: string | null;
  /** The row the sync made for the session. */
  workspaceId?: string;
  /** The sync archived the row for age, so a row someone restores stays. */
  aged?: boolean;
}
type SeenSessions = Record<string, SeenSession>;

export interface SyncWorkspace {
  workspaceId: string;
  projectId: string;
  cwd: string;
  title: string | null;
  createdAt: string;
  archivedAt: string | null;
  background?: boolean;
}

export interface SyncWorkspaces {
  list(): Promise<SyncWorkspace[]>;
  create(input: {
    projectId: string;
    cwd: string;
    title: string | null;
    createdAt: Date;
  }): Promise<SyncWorkspace>;
  setArchived(workspaceId: string, archived: boolean): Promise<void>;
  setTitle(workspaceId: string, title: string | null): Promise<void>;
}

type SyncAgentManager = Pick<
  AgentManager,
  "listImportableSessions" | "recordExternalSession" | "updateExternalSession" | "getAgent"
>;

/** Reads PASEO_LOCAL_SESSIONS, a comma-separated list of provider ids to sync. */
export function parseLocalSessionProviders(value: string | undefined): AgentProvider[] {
  return (value ?? "")
    .split(",")
    .map((provider) => provider.trim())
    .filter(Boolean) as AgentProvider[];
}

export function startLocalSessionSync(options: {
  providers: AgentProvider[];
  agentManager: SyncAgentManager;
  agentStorage: Pick<AgentStorage, "list">;
  workspaces: SyncWorkspaces;
  statePath: string;
  logger: Pick<Logger, "info" | "warn">;
  now?: () => number;
  schedule?: boolean;
}) {
  const { agentManager, workspaces } = options;
  const clock = options.now ?? Date.now;
  const providerFilter = new Set<string>(options.providers);
  const backfilledCwds = new Set<string>();
  let running: Promise<void> | null = null;
  let closed = false;

  async function syncOnce(): Promise<void> {
    const seen = await readSeenSessions(options.statePath);
    const before = JSON.stringify(seen);
    const now = clock();
    const workspaceList = await workspaces.list();
    const workspaceById = new Map(workspaceList.map((w) => [w.workspaceId, w] as const));
    const rowIds = new Set(Object.values(seen).flatMap((entry) => entry.workspaceId ?? []));
    const byHandle = indexByProviderHandle(await options.agentStorage.list());
    let added = 0;

    async function addRow(session: ImportableProviderSession, home: SyncWorkspace, at: number) {
      const row = await workspaces.create({
        projectId: home.projectId,
        cwd: home.cwd,
        title: session.title,
        createdAt: session.firstPromptAt ?? new Date(at),
      });
      workspaceById.set(row.workspaceId, row);
      return row;
    }

    async function syncSession(
      session: ImportableProviderSession & { provider: AgentProvider },
      home: SyncWorkspace,
      at: number,
    ): Promise<void> {
      const key = handleKey(session.provider, session.providerHandleId);
      const last = seen[key];
      const record = byHandle.get(key);
      const recent = at >= now - ROW_AGE_MS;

      if (!record) {
        if (last && at <= last.at) return;
        const row = recent ? await addRow(session, home, at) : null;
        const created = await agentManager.recordExternalSession({
          provider: session.provider,
          providerHandleId: session.providerHandleId,
          cwd: session.cwd,
          workspaceId: row?.workspaceId ?? home.workspaceId,
          title: session.title,
          lastActivityAt: new Date(at),
          archived: !row,
        });
        byHandle.set(key, created);
        seen[key] = { at, title: session.title, ...(row ? { workspaceId: row.workspaceId } : {}) };
        added += 1;
        return;
      }

      if (!last) {
        // Paseo started or imported this agent, so only its activity follows the session.
        await agentManager.updateExternalSession(record.id, { lastActivityAt: new Date(at) });
        return;
      }

      const entry: SeenSession = { ...last, at: Math.max(last.at, at) };
      const update: Parameters<SyncAgentManager["updateExternalSession"]>[1] = {
        lastActivityAt: new Date(at),
      };
      const titleChanged = session.title !== last.title;
      if (titleChanged && record.title === last.title) update.title = session.title;

      const row = last.workspaceId ? workspaceById.get(last.workspaceId) : undefined;
      if (row && record.workspaceId === row.workspaceId) {
        const archivedAt = Math.max(timeOf(row.archivedAt), timeOf(record.archivedAt));
        if (archivedAt > 0 && recent && at > Math.max(last.at, archivedAt)) {
          if (row.archivedAt) await workspaces.setArchived(row.workspaceId, false);
          update.archived = false;
          delete entry.aged;
        }
        if (titleChanged && row.title === last.title) {
          await workspaces.setTitle(row.workspaceId, session.title);
        }
        if (titleChanged) entry.title = session.title;
      } else if (recent && record.archivedAt && at > last.at) {
        const created = await addRow(session, home, at);
        update.workspaceId = created.workspaceId;
        update.archived = false;
        entry.workspaceId = created.workspaceId;
        entry.title = session.title;
        delete entry.aged;
      } else if (titleChanged && update.title !== undefined) {
        entry.title = session.title;
      }

      await agentManager.updateExternalSession(record.id, update);
      seen[key] = entry;
    }

    const listedCwds = new Set<string>();
    const byAge = [...workspaceList].sort((a, b) => timeOf(a.createdAt) - timeOf(b.createdAt));
    for (const home of byAge) {
      if (closed) break;
      // A directory's sessions belong to the first workspace a person made for it. Workspaces
      // can share a directory, and the rows this sync made are among them.
      if (home.archivedAt || home.background || rowIds.has(home.workspaceId)) continue;
      if (listedCwds.has(home.cwd)) continue;
      listedCwds.add(home.cwd);
      const inDirectory = createRealpathAwarePathMatcher(home.cwd);
      const { sessions, providerErrors } = await agentManager.listImportableSessions({
        cwd: home.cwd,
        limit: backfilledCwds.has(home.cwd) ? RECENT_LIMIT : BACKFILL_LIMIT,
        providerFilter,
      });
      if (providerErrors.length === 0) backfilledCwds.add(home.cwd);
      for (const session of sessions) {
        if (closed) break;
        const at = (session.lastPromptAt ?? session.lastActivityAt).getTime();
        if (
          at < now - MAX_AGE_MS ||
          session.interactive === false ||
          // A session with no typed prompt or no reply holds no conversation, as in one Claude
          // Code continued under a new id or one that only ran local commands.
          !session.firstPromptPreview ||
          session.replied === false ||
          isMetadataGenerationSession(session) ||
          !inDirectory(session.cwd)
        ) {
          continue;
        }
        await syncSession(session, home, at);
      }
    }

    // A session leaves the periodic listing once newer ones fill it, so rows age here, by the
    // last prompt the sync saw.
    for (const [key, entry] of Object.entries(seen)) {
      if (closed) break;
      if (!entry.workspaceId || entry.aged || entry.at >= now - ROW_AGE_MS) continue;
      const row = workspaceById.get(entry.workspaceId);
      const record = byHandle.get(key);
      if (!row || row.archivedAt || record?.workspaceId !== row.workspaceId) continue;
      if (agentManager.getAgent(record.id)) continue;
      await workspaces.setArchived(row.workspaceId, true);
      await agentManager.updateExternalSession(record.id, { archived: true });
      entry.aged = true;
    }

    if (JSON.stringify(seen) !== before) await writeJsonFileAtomic(options.statePath, seen);
    if (added > 0) options.logger.info({ added }, "Brought in local provider sessions");
  }

  function sync(): Promise<void> {
    running ??= syncOnce()
      .catch((error: unknown) => {
        options.logger.warn({ err: error }, "Local session sync failed");
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  let timers: NodeJS.Timeout[] = [];
  if (options.schedule !== false) {
    const first = setTimeout(() => void sync(), FIRST_SYNC_DELAY_MS);
    const interval = setInterval(() => void sync(), SYNC_INTERVAL_MS);
    first.unref();
    interval.unref();
    timers = [first, interval];
  }

  return {
    sync,
    async close(): Promise<void> {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      await running;
    },
  };
}

function timeOf(iso: string | null | undefined): number {
  return iso ? Date.parse(iso) : 0;
}

function handleKey(provider: string, handle: string): string {
  return `${provider}\0${handle}`;
}

function indexByProviderHandle(records: StoredAgentRecord[]): Map<string, StoredAgentRecord> {
  const byHandle = new Map<string, StoredAgentRecord>();
  for (const record of records) {
    const persistence = record.persistence;
    if (!persistence) continue;
    byHandle.set(handleKey(persistence.provider, persistence.sessionId), record);
    if (typeof persistence.nativeHandle === "string") {
      byHandle.set(handleKey(persistence.provider, persistence.nativeHandle), record);
    }
  }
  return byHandle;
}

async function readSeenSessions(file: string): Promise<SeenSessions> {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as SeenSessions)
      : {};
  } catch (error) {
    // A missing or unreadable file only forgets which records were deleted.
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}
