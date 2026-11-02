import { promises as fs } from "node:fs";
import type { Logger } from "pino";

import { writeJsonFileAtomic } from "../atomic-file.js";
import { createRealpathAwarePathMatcher } from "../../utils/path.js";
import type { AgentManager } from "./agent-manager.js";
import type { AgentProvider } from "./agent-sdk-types.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import { isMetadataGenerationSession } from "./import-sessions.js";

// Paseo lists only the agents it started or imported. This sync gives each recent provider
// session that a person started elsewhere in a Paseo workspace, such as a terminal or Claude
// Code's agent view, an archived record. History then lists it, and opening it resumes it with no
// import step. Nothing loads until someone opens one. A later turn outside Paseo moves the
// record's activity time on, and its title follows the session's until someone renames it in
// Paseo. A record someone deletes comes back only after the session has a newer turn.

const SYNC_INTERVAL_MS = 60_000;
const FIRST_SYNC_DELAY_MS = 5_000;
// History groups agents into today, yesterday, this week and this month.
const MAX_AGE_MS = 30 * 24 * 60 * 60_000;
// The first listing of a directory reaches back over the whole window. Later ones only need the
// sessions used since, which sort first.
const BACKFILL_LIMIT = 1000;
const RECENT_LIMIT = 50;

/** What the sync last saw of a session: its activity time and the title it gave the record. */
interface SeenSession {
  at: number;
  title: string | null;
}
type SeenSessions = Record<string, SeenSession>;

interface SyncWorkspace {
  workspaceId: string;
  cwd: string;
  archivedAt: string | null;
  background?: boolean;
}

/** Reads PASEO_LOCAL_SESSIONS, a comma-separated list of provider ids to sync. */
export function parseLocalSessionProviders(value: string | undefined): AgentProvider[] {
  return (value ?? "")
    .split(",")
    .map((provider) => provider.trim())
    .filter(Boolean) as AgentProvider[];
}

export function startLocalSessionSync(options: {
  providers: AgentProvider[];
  agentManager: Pick<
    AgentManager,
    "listImportableSessions" | "recordExternalSession" | "refreshStoredActivity"
  >;
  agentStorage: Pick<AgentStorage, "list">;
  workspaces: () => Promise<SyncWorkspace[]>;
  statePath: string;
  logger: Pick<Logger, "info" | "warn">;
  now?: () => number;
  schedule?: boolean;
}) {
  const now = options.now ?? Date.now;
  const providerFilter = new Set<string>(options.providers);
  const backfilledCwds = new Set<string>();
  let running: Promise<void> | null = null;
  let closed = false;

  async function syncOnce(): Promise<void> {
    const seen = await readSeenSessions(options.statePath);
    const before = JSON.stringify(seen);
    const since = now() - MAX_AGE_MS;
    for (const [key, entry] of Object.entries(seen)) {
      if (entry.at < since) delete seen[key];
    }
    const byHandle = indexByProviderHandle(await options.agentStorage.list());
    let added = 0;
    // Workspaces can share a directory. The first one listed gets that directory's sessions.
    const listedCwds = new Set<string>();
    for (const workspace of await options.workspaces()) {
      if (closed) break;
      if (workspace.archivedAt || workspace.background || listedCwds.has(workspace.cwd)) continue;
      listedCwds.add(workspace.cwd);
      const inWorkspace = createRealpathAwarePathMatcher(workspace.cwd);
      const { sessions, providerErrors } = await options.agentManager.listImportableSessions({
        cwd: workspace.cwd,
        limit: backfilledCwds.has(workspace.cwd) ? RECENT_LIMIT : BACKFILL_LIMIT,
        providerFilter,
      });
      if (providerErrors.length === 0) backfilledCwds.add(workspace.cwd);
      for (const session of sessions) {
        const at = session.lastActivityAt.getTime();
        if (
          closed ||
          at < since ||
          session.interactive === false ||
          // No typed prompt means no conversation, as in a session Claude Code continued under
          // a new id.
          !session.firstPromptPreview ||
          isMetadataGenerationSession(session) ||
          !inWorkspace(session.cwd)
        ) {
          continue;
        }
        const key = handleKey(session.provider, session.providerHandleId);
        const last = seen[key];
        const record = byHandle.get(key);
        if (record) {
          const title =
            last && record.title === last.title && session.title !== last.title
              ? session.title
              : undefined;
          await options.agentManager.refreshStoredActivity(record.id, {
            lastActivityAt: session.lastActivityAt,
            ...(title === undefined ? {} : { title }),
          });
          if (last) seen[key] = { at: Math.max(last.at, at), title: title ?? last.title };
          continue;
        }
        if (last && at <= last.at) continue;
        const created = await options.agentManager.recordExternalSession({
          provider: session.provider,
          providerHandleId: session.providerHandleId,
          cwd: session.cwd,
          workspaceId: workspace.workspaceId,
          title: session.title,
          lastActivityAt: session.lastActivityAt,
        });
        byHandle.set(key, created);
        seen[key] = { at, title: session.title };
        added += 1;
      }
    }
    if (JSON.stringify(seen) !== before) await writeJsonFileAtomic(options.statePath, seen);
    if (added > 0) options.logger.info({ added }, "Listed local provider sessions in History");
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
