import fs from "node:fs/promises";
import path from "node:path";

// A transcript marker names the newest conversation message a provider CLI wrote to its
// on-disk session. The agent manager compares markers to notice that another client, such as
// the same CLI in a terminal, continued the session while Paseo was not looking.

const CHUNK_BYTES = 256 * 1024;

type JsonRecord = Record<string, unknown>;

/** Returns the last JSONL record that satisfies `accept`, reading the file from its end. */
export async function readLastJsonlRecord(
  file: string,
  accept: (record: JsonRecord) => boolean,
): Promise<JsonRecord | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    let end = size;
    // Bytes of a line cut by the previous chunk boundary, prepended to the next (earlier) chunk.
    let carry = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - CHUNK_BYTES);
      const chunk = Buffer.alloc(end - start);
      await handle.read(chunk, 0, chunk.length, start);
      const buffer = Buffer.concat([chunk, carry]);
      // Before the first newline sits the tail of a line that starts in an earlier chunk.
      // It is carried as raw bytes so a multi-byte character cut at the boundary survives.
      const firstNewline = start === 0 ? -1 : buffer.indexOf(0x0a);
      if (start > 0 && firstNewline === -1) {
        carry = buffer;
        end = start;
        continue;
      }
      const lines = buffer.subarray(firstNewline + 1).toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const record = parseRecord(lines[i]);
        if (record && accept(record)) return record;
      }
      carry = start === 0 ? Buffer.alloc(0) : buffer.subarray(0, firstNewline);
      end = start;
    }
    return null;
  } finally {
    await handle.close();
  }
}

function parseRecord(line: string | undefined): JsonRecord | null {
  if (!line || !line.trim()) return null;
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as JsonRecord)
      : null;
  } catch {
    return null;
  }
}

/** Claude Code: uuid of the newest main-chain user or assistant entry. */
export async function readClaudeTranscriptMarker(file: string): Promise<string | null> {
  const record = await readLastJsonlRecord(
    file,
    (entry) =>
      (entry.type === "user" || entry.type === "assistant") &&
      entry.isSidechain !== true &&
      entry.isMeta !== true &&
      typeof entry.uuid === "string",
  );
  return record ? (record.uuid as string) : null;
}

/** Codex: timestamp of the newest user or assistant message in the thread's rollout. */
export async function readCodexRolloutMarker(file: string): Promise<string | null> {
  const record = await readLastJsonlRecord(file, (entry) => {
    if (entry.type !== "response_item") return false;
    const payload = entry.payload as JsonRecord | undefined;
    return (
      payload?.type === "message" && (payload.role === "user" || payload.role === "assistant")
    );
  });
  return record && typeof record.timestamp === "string" ? record.timestamp : null;
}

/** Finds a thread's rollout file under CODEX_HOME, active sessions first. */
export async function findCodexRolloutFile(
  codexHome: string,
  threadId: string,
): Promise<string | null> {
  const suffix = `-${threadId}.jsonl`;
  for (const dir of ["sessions", "archived_sessions"]) {
    let entries: string[];
    try {
      entries = await fs.readdir(path.join(codexHome, dir), { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const match = entries.find((entry) => entry.endsWith(suffix));
    if (match) return path.join(codexHome, dir, match);
  }
  return null;
}
