import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";

// Each function forks a provider session on disk and returns the new session id, ready
// for `paseo import`. None of them start a turn.

export interface ForkSource {
  sessionId: string;
  /** Provider-native handle; Pi and Oh My Pi store the session file path here. */
  nativeHandle: string | null;
  cwd: string;
  model: string | null;
}

const FORK_TIMEOUT_MS = 30_000;

function binaryCandidates(envName: string, name: string, extra: string[]): string[] {
  return [process.env[envName], ...extra, name].filter((candidate): candidate is string => Boolean(candidate));
}

// Claude Code has no fork call outside a live query, so this copies the transcript under a
// new session id.
export async function forkClaudeSession({ sessionId, cwd }: ForkSource): Promise<string> {
  const source = await findClaudeTranscript(sessionId, cwd);
  const forkId = randomUUID();
  await writeFile(
    path.join(path.dirname(source), `${forkId}.jsonl`),
    rewriteSessionId(await readFile(source, "utf8"), sessionId, forkId),
    "utf8",
  );
  return forkId;
}

async function findClaudeTranscript(sessionId: string, cwd: string): Promise<string> {
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude"), "projects");
  // Claude Code names a project folder after its cwd with every non-alphanumeric replaced.
  const expected = path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
  if (existsSync(expected)) return expected;

  for (const folder of await readdir(projects)) {
    const candidate = path.join(projects, folder, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`transcript for session ${sessionId} not found under ${projects}`);
}

function rewriteSessionId(text: string, from: string, to: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (!line.trim()) return line;
      try {
        const entry = JSON.parse(line);
        if (entry && entry.sessionId === from) entry.sessionId = to;
        return JSON.stringify(entry);
      } catch {
        return line;
      }
    })
    .join("\n");
}

// Pi and Oh My Pi keep each session in one JSONL file whose `session` header carries the id,
// and import by file path. A copy with a new header id is a fork. Oh My Pi may write title
// lines before the header, so the first `session` entry is rewritten wherever it is.
export async function forkPiSessionFile({ sessionId, nativeHandle }: ForkSource): Promise<string> {
  if (!nativeHandle || !existsSync(nativeHandle)) throw new Error(`session file not found: ${nativeHandle}`);
  const forkId = randomUUID();
  let rewritten = false;
  const lines = (await readFile(nativeHandle, "utf8")).split("\n").map((line) => {
    if (rewritten || !line.includes('"session"')) return line;
    try {
      const entry = JSON.parse(line);
      if (entry?.type !== "session") return line;
      entry.id = forkId;
      rewritten = true;
      return JSON.stringify(entry);
    } catch {
      return line;
    }
  });
  if (!rewritten) throw new Error(`no session header in ${nativeHandle}`);

  const base = path.basename(nativeHandle);
  const name = base.includes(sessionId) ? base.replace(sessionId, forkId) : `${forkId}.jsonl`;
  const forkPath = path.join(path.dirname(nativeHandle), name);
  await writeFile(forkPath, lines.join("\n"), "utf8");
  return forkPath;
}

// A fork can also stop early. Every Pi message is one JSONL entry, and a user entry's text is
// what the timeline shows, so the prompt the user picked identifies the cut: keep the session
// file through the reply that answered it, and drop everything after.
export async function forkPiSessionUntil(source: ForkSource, stopPrefix: string): Promise<string> {
  const { sessionId, nativeHandle } = source;
  if (!nativeHandle || !existsSync(nativeHandle)) throw new Error(`session file not found: ${nativeHandle}`);
  const lines = (await readFile(nativeHandle, "utf8")).split("\n");
  const keep = cutAfterPrompt(lines, stopPrefix);
  if (keep === null) throw new Error(`prompt not found in the session file: ${stopPrefix.slice(0, 40)}`);

  const forkId = randomUUID();
  let rewritten = false;
  const forked = lines.slice(0, keep).map((line) => {
    if (rewritten || !line.includes('"session"')) return line;
    try {
      const entry = JSON.parse(line);
      if (entry?.type !== "session") return line;
      entry.id = forkId;
      rewritten = true;
      return JSON.stringify(entry);
    } catch {
      return line;
    }
  });
  if (!rewritten) throw new Error(`no session header in ${nativeHandle}`);

  const base = path.basename(nativeHandle);
  const name = base.includes(sessionId) ? base.replace(sessionId, forkId) : `${forkId}.jsonl`;
  const forkPath = path.join(path.dirname(nativeHandle), name);
  await writeFile(forkPath, forked.join("\n"), "utf8");
  return forkPath;
}

// The text of a Pi user message, or null for any other entry.
function promptText(line: string): string | null {
  if (!line.trim()) return null;
  try {
    const entry = JSON.parse(line);
    if (entry?.type !== "message" || entry?.message?.role !== "user") return null;
    const content = entry.message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return null;
    return content
      .filter((part: { type?: string }) => part?.type === "text")
      .map((part: { text?: string }) => part.text ?? "")
      .join("");
  } catch {
    return null;
  }
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/\.\.\.$/, "").trim();
}

// How many lines to keep: through the turn that answered the prompt, before the next prompt.
function cutAfterPrompt(lines: string[], stopPrefix: string): number | null {
  const needle = normalize(stopPrefix);
  if (!needle) return null;
  let match = -1;
  for (let i = 0; i < lines.length; i++) {
    const text = promptText(lines[i]);
    if (text !== null && normalize(text).startsWith(needle)) match = i;
  }
  if (match < 0) return null;
  for (let i = match + 1; i < lines.length; i++) {
    if (promptText(lines[i]) !== null) return i;
  }
  return lines.length;
}

// Codex forks through its app-server's `thread/fork`, the call Paseo uses for rewind. A
// short-lived app-server is enough; the fork is written to Codex's session store.
export async function forkCodexThread({ sessionId, cwd, model }: ForkSource): Promise<string> {
  const bins = binaryCandidates("TANGENT_CODEX_BIN", "codex", ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"]);
  const child = spawnFirst(bins, ["app-server"], cwd);
  try {
    const rpc = jsonlRpc(child);
    await rpc.request("initialize", {
      clientInfo: { name: "tangent", title: "Tangent", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    rpc.notify("initialized", {});
    // Codex does not carry the parent's config into a fork, so the model is passed again.
    const result = await rpc.request("thread/fork", {
      threadId: sessionId,
      cwd,
      model,
      excludeTurns: false,
      persistExtendedHistory: true,
    });
    const threadId = result?.thread?.id;
    if (typeof threadId !== "string") throw new Error(`unexpected thread/fork result: ${JSON.stringify(result)}`);
    return threadId;
  } finally {
    child.kill();
  }
}

// OpenCode forks over its HTTP server. Paseo's own server is not reachable from a plugin, so
// this starts one on a free port; both read the same session store.
export async function forkOpenCodeSession({ sessionId, cwd }: ForkSource): Promise<string> {
  const bins = binaryCandidates("TANGENT_OPENCODE_BIN", "opencode", [
    path.join(homedir(), ".opencode", "bin", "opencode"),
    "/opt/homebrew/bin/opencode",
  ]);
  const port = await freePort();
  const child = spawnFirst(bins, ["serve", "--port", String(port)], cwd);
  try {
    const url = `http://127.0.0.1:${port}`;
    await waitForServer(url, child);
    const response = await fetch(
      `${url}/session/${encodeURIComponent(sessionId)}/fork?directory=${encodeURIComponent(cwd)}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    if (!response.ok) throw new Error(`fork returned ${response.status}: ${await response.text()}`);
    const session = (await response.json()) as { id?: unknown };
    if (typeof session.id !== "string") throw new Error(`unexpected fork result: ${JSON.stringify(session)}`);
    return session.id;
  } finally {
    child.kill();
  }
}

function spawnFirst(bins: string[], args: string[], cwd: string): ChildProcess {
  const bin = bins.find((candidate) => !candidate.includes("/") || existsSync(candidate));
  if (!bin) throw new Error(`none of ${bins.join(", ")} found`);
  return spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
}

function jsonlRpc(child: ChildProcess) {
  let nextId = 1;
  let buffer = "";
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const failAll = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  child.on("error", failAll);
  child.on("exit", (code) => failAll(new Error(`process exited with ${code}`)));
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = typeof message.id === "number" ? pending.get(message.id) : undefined;
      if (!waiter || message.method) continue;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
  });

  return {
    request(method: string, params: unknown): Promise<any> {
      const id = nextId++;
      child.stdin!.write(`${JSON.stringify({ id, method, params })}\n`);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, FORK_TIMEOUT_MS);
        pending.set(id, {
          resolve: (value) => (clearTimeout(timer), resolve(value)),
          reject: (error) => (clearTimeout(timer), reject(error)),
        });
      });
    },
    notify(method: string, params: unknown) {
      child.stdin!.write(`${JSON.stringify({ method, params })}\n`);
    },
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

async function waitForServer(url: string, child: ChildProcess) {
  const deadline = Date.now() + FORK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`opencode serve exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/config`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("opencode serve did not start");
}
