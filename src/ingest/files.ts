import { Database } from "bun:sqlite";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

type StoredState = {
  path: string;
  inode: string | null;
  offset: number;
  size: number;
  mtime: number;
  parser: string;
  state: string;
  error: string | null;
  updated_at: number;
};

export type JsonlContext = {
  path: string;
  line: number;
  lineOffset: number;
  parserState: Record<string, any>;
};

export async function walkFiles(
  root: string,
  suffix = ".jsonl",
): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.name.startsWith(".")) return;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile() && entry.name.endsWith(suffix)) result.push(path);
      }),
    );
  }
  await visit(root);
  return result.sort();
}

function readState(db: Database, path: string): StoredState | null {
  return db
    .query(
      `SELECT path, inode, offset, size, mtime, parser, state, error, updated_at
       FROM file_state WHERE path = ?`,
    )
    .get(path) as StoredState | null;
}

function saveState(db: Database, state: StoredState): void {
  db.query(`INSERT INTO file_state
    (path, inode, offset, size, mtime, parser, state, error, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      inode=excluded.inode, offset=excluded.offset, size=excluded.size,
      mtime=excluded.mtime, parser=excluded.parser, state=excluded.state,
      error=excluded.error, updated_at=excluded.updated_at`).run(
    state.path,
    state.inode,
    state.offset,
    state.size,
    state.mtime,
    state.parser,
    state.state,
    state.error,
    state.updated_at,
  );
}

/**
 * Read complete newline-terminated lines from a file. Tracks a byte offset and a
 * parser-specific JSON state so Codex's cumulative usage counters can be turned
 * into deltas without rereading the whole session on every poll.
 */
export async function ingestJsonl(
  db: Database,
  path: string,
  parser: string,
  onLine: (value: any, ctx: JsonlContext) => void | Promise<void>,
): Promise<{ lines: number; bytes: number }> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return { lines: 0, bytes: 0 };
  }
  const previous = readState(db, path);
  const inode = String(info.ino);
  const reset = !previous || previous.inode !== inode || info.size < previous.offset;
  let offset = reset ? 0 : previous!.offset;
  let parserState: Record<string, any> = reset ? {} : safeJson(previous!.state);
  if (info.size === offset && previous?.mtime === info.mtimeMs) {
    return { lines: 0, bytes: 0 };
  }

  let processedBytes = 0;
  const startLine = reset ? 0 : Number(parserState.__lineNumber ?? 0);
  let lineNumber = startLine;
  let pending = "";
  let error: string | null = null;
  const decoder = new StringDecoder("utf8");
  const stream = createReadStream(path, { start: offset });

  try {
    for await (const chunk of stream) {
      pending += decoder.write(chunk as Buffer);
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const raw = pending.slice(0, newline).replace(/\r$/, "");
        const lineOffset = offset + processedBytes;
        processedBytes += Buffer.byteLength(pending.slice(0, newline + 1), "utf8");
        pending = pending.slice(newline + 1);
        lineNumber++;
        if (raw.trim()) {
          let value: any;
          try {
            value = JSON.parse(raw);
          } catch {
            value = null;
          }
          if (value) {
            try {
              await onLine(value, {
                path,
                line: lineNumber,
                lineOffset,
                parserState,
              });
            } catch (lineError: any) {
              error = `${lineError?.message ?? lineError}`;
            }
          }
        }
        newline = pending.indexOf("\n");
      }
    }
    pending += decoder.end();
  } catch (streamError: any) {
    error = `${streamError?.message ?? streamError}`;
  }

  parserState.__lineNumber = lineNumber;
  saveState(db, {
    path,
    inode,
    offset: offset + processedBytes,
    size: info.size,
    mtime: info.mtimeMs,
    parser,
    state: JSON.stringify(parserState),
    error,
    updated_at: Date.now(),
  });
  return { lines: lineNumber - startLine, bytes: processedBytes };
}

function safeJson(value: string | undefined): Record<string, any> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
