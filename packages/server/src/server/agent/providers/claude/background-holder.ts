import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Claude Code refuses to resume a session that one of its background jobs holds: a session
// dispatched from agent view, started with `claude --bg`, or moved there with /bg. Its own advice
// is to stop that job first. The conversation stays on disk and agent view reopens it later.
// Paseo does that for a job waiting for input and refuses one that is still working, because
// stopping it would end its turn or the background tasks it runs.

const STOP_WAIT_MS = 10_000;

type JsonRecord = Record<string, unknown>;

export interface ClaudeBackgroundHolder {
  jobId: string;
  pid: number;
  /** Why stopping the job would lose work, or null when it waits for input. */
  busy: string | null;
}

/** Finds the live Claude Code background job that holds `sessionId`. */
export async function findClaudeBackgroundHolder(
  configDir: string,
  sessionId: string,
): Promise<ClaudeBackgroundHolder | null> {
  const sessionsDir = path.join(configDir, "sessions");
  let names: string[];
  try {
    names = await fs.readdir(sessionsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const target = sessionId.toLowerCase();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = await readJson(path.join(sessionsDir, name));
    if (
      !record ||
      !sameId(record.sessionId, target) ||
      record.kind === "interactive" ||
      typeof record.jobId !== "string" ||
      typeof record.pid !== "number" ||
      !isAlive(record.pid)
    ) {
      continue;
    }
    // A registry entry can outlive its job, so the job's own state must name the session too.
    const state = await readJson(path.join(configDir, "jobs", record.jobId, "state.json"));
    if (!state || !(sameId(state.sessionId, target) || sameId(state.resumeSessionId, target))) {
      continue;
    }
    return { jobId: record.jobId, pid: record.pid, busy: describeBusy(record, state) };
  }
  return null;
}

/** Stops the background job holding `sessionId`, if any, and returns its id. */
export async function releaseClaudeBackgroundHolder(input: {
  configDir: string;
  sessionId: string;
  stopJob: (jobId: string) => Promise<void>;
}): Promise<string | null> {
  const holder = await findClaudeBackgroundHolder(input.configDir, input.sessionId);
  if (!holder) return null;
  if (holder.busy) {
    throw new Error(
      `This conversation is still running in Claude Code background session ${holder.jobId} (${holder.busy}). Let it finish there, or run \`claude stop ${holder.jobId}\`, then send again.`,
    );
  }
  await input.stopJob(holder.jobId);
  // Claude Code only checks whether the holder's process is alive.
  const deadline = Date.now() + STOP_WAIT_MS;
  while (isAlive(holder.pid)) {
    if (Date.now() > deadline) {
      throw new Error(`Claude Code background session ${holder.jobId} did not stop`);
    }
    await delay(100);
  }
  return holder.jobId;
}

function describeBusy(record: JsonRecord, state: JsonRecord): string | null {
  if (record.status !== "idle") return `status: ${String(record.status)}`;
  // `inFlight.queued` keeps the count from before the job went idle, so only tasks count.
  const inFlight = state.inFlight as JsonRecord | undefined;
  if (Number(inFlight?.tasks ?? 0) > 0) return "background tasks still running";
  return null;
}

function sameId(value: unknown, target: string): boolean {
  return typeof value === "string" && value.toLowerCase() === target;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readJson(file: string): Promise<JsonRecord | null> {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as JsonRecord)
      : null;
  } catch {
    return null;
  }
}
