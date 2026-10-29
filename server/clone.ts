import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { PaseoAgentConfig, PaseoAgentHandle } from "@getpaseo/client";
import type { PaseoApi } from "@getpaseo/client";
import type { ForkAnchor, ForkMethod } from "../shared/rpc";
import {
  forkClaudeSession,
  forkCodexThread,
  forkOpenCodeSession,
  forkPiSessionFile,
  forkPiSessionUntil,
  type ForkSource,
} from "./native-forks";

const execFileAsync = promisify(execFile);
const LOG_PREFIX = "[tangent]";
const TRANSCRIPT_ENTRY_LIMIT = 200;
const PASEO_CLI_CANDIDATES = [
  process.env.PASEO_CLI,
  "/Applications/Paseo.app/Contents/Resources/bin/paseo",
  "paseo",
].filter((candidate): candidate is string => Boolean(candidate));

type ParentSnapshot = NonNullable<Awaited<ReturnType<PaseoAgentHandle["refresh"]>>>["agent"];

export interface CloneOptions {
  title: string;
  /** Starts the clone's first turn. Omit to leave a native fork idle. */
  prompt?: string;
  /** Tags the prompt so its reply can be found later with `replyTo`. */
  messageId?: string;
  labels?: Record<string, string>;
  /**
   * Create the clone as a child of the parent, which keeps it out of the tab bar, like a
   * subtask that never reports back.
   */
  asChild?: boolean;
  /** Claude tools the clone may not use. */
  disallowedTools?: string[];
  /**
   * Cut point in the parent's history: the `messageId`/`clientMessageId` of a user message
   * to end the copied conversation after. A native fork copies the whole session file, so an
   * anchored fork always goes through the transcript.
   */
  anchorMessageId?: string;
  /**
   * The prompt at the cut point. Providers that can truncate a session file use it to keep
   * the fork native; the rest fall back to the transcript.
   */
  anchorText?: string;
}

export interface CloneResult {
  agent: PaseoAgentHandle;
  method: ForkMethod;
}

export async function loadAgent(paseo: PaseoApi, agentId: string): Promise<ParentSnapshot> {
  const result = await paseo.agents.ref(agentId).refresh();
  if (!result) throw new Error(`Agent ${agentId} not found`);
  return result.agent;
}

export function providerConfig(agent: ParentSnapshot): PaseoAgentConfig {
  return {
    provider: agent.model ? `${agent.provider}/${agent.model}` : agent.provider,
    modeId: agent.currentModeId ?? undefined,
    thinkingOptionId: agent.thinkingOptionId ?? undefined,
  };
}

// Providers that can fork a session on disk get a true fork, imported as a new agent, so
// the clone keeps tool results and the prompt cache. Anything else, or any failure along the
// way, falls back to pasting the visible conversation into a fresh agent.
const NATIVE_FORKS: Record<string, (source: ForkSource) => Promise<string>> = {
  claude: forkClaudeSession,
  codex: forkCodexThread,
  opencode: forkOpenCodeSession,
  pi: forkPiSessionFile,
  omp: forkPiSessionFile,
};

// Providers whose session file can be cut at a prompt, giving an anchored fork the same
// fidelity as a plain one: tool results, file reads and the prompt cache all survive.
const SESSION_FILE_PROVIDERS = new Set(["pi", "omp"]);

export async function cloneAgent(
  paseo: PaseoApi,
  parentId: string,
  options: CloneOptions,
): Promise<CloneResult> {
  const parent = await loadAgent(paseo, parentId);
  // A session file can be cut, so the fork stays native whether or not a prompt was picked;
  // creating it inside the parent's workspace keeps it a tab instead of a new workspace.
  if (!options.asChild && SESSION_FILE_PROVIDERS.has(parent.provider)) {
    try {
      return { agent: await sessionFileFork(paseo, parent, options), method: "native" };
    } catch (error) {
      console.warn(`${LOG_PREFIX} native ${parent.provider} fork failed, using the previous path: ${String(error)}`);
    }
  }
  // A native fork copies the session file whole, so an anchored fork cannot use it.
  const fork = options.anchorMessageId || options.anchorText ? undefined : NATIVE_FORKS[parent.provider];
  // Only Claude can resume a forked session in a newly created child agent.
  if (fork && (!options.asChild || parent.provider === "claude")) {
    try {
      const agent = await nativeFork(paseo, parent, fork, options);
      return { agent, method: "native" };
    } catch (error) {
      console.warn(`${LOG_PREFIX} native ${parent.provider} fork failed, using transcript: ${String(error)}`);
    }
  }
  const agent = await transcriptFork(paseo, parent, options);
  return { agent, method: "transcript" };
}

// Pi keeps the session in one JSONL file, so a fork is a copy of that file: cut at the picked
// prompt when there is one. Starting the agent inside the parent's workspace is what makes it
// a tab; creating by cwd alone, or importing, opens a new workspace instead.
async function sessionFileFork(
  paseo: PaseoApi,
  parent: ParentSnapshot,
  options: CloneOptions,
): Promise<PaseoAgentHandle> {
  const sessionId = parent.runtimeInfo?.sessionId ?? parent.persistence?.sessionId;
  if (!sessionId) throw new Error(`parent has no ${parent.provider} session yet`);
  const source: ForkSource = {
    sessionId,
    nativeHandle: parent.persistence?.nativeHandle ?? null,
    cwd: parent.cwd,
    model: parent.model,
  };
  const forkPath = options.anchorText
    ? await forkPiSessionUntil(source, options.anchorText)
    : await forkPiSessionFile(source);

  // Paseo's Pi provider options are strict and carry no way to open an existing session file,
  // so an agent cannot be created onto the copy. Create it empty in the parent's workspace
  // (that is what makes it a tab), write the copy over its own session file, and restart the
  // process so Pi loads it. Every step is checked; a miss archives the agent and falls back.
  const shared = { config: providerConfig(parent), title: options.title, labels: options.labels };
  const agent = parent.workspaceId
    ? await paseo.workspaces.ref(parent.workspaceId).agents.create(shared)
    : await paseo.agents.create({ cwd: parent.cwd, ...shared });
  try {
    const target = await waitForSessionFile(paseo, agent.id);
    await writeForkedSession(forkPath, target);
    await runPaseoCli(["agent", "reload", agent.id, "--json"]);
    if (!(await hasHistory(paseo, agent.id))) throw new Error("reload did not restore the copied history");
  } catch (error) {
    await agent.archive().catch(() => undefined);
    throw error;
  }
  if (options.prompt) await agent.send(options.prompt, { messageId: options.messageId });
  return agent;
}

// Pi writes the session file when the agent starts, and Paseo reports the path only once it
// does, so give it a few seconds.
async function waitForSessionFile(
  paseo: PaseoApi,
  agentId: string,
): Promise<{ nativeHandle: string; sessionId: string }> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const refreshed = await paseo.agents.ref(agentId).refresh();
    const agent = refreshed?.agent;
    const persistence = agent?.persistence;
    const sessionId = agent?.runtimeInfo?.sessionId ?? persistence?.sessionId;
    if (persistence?.nativeHandle && sessionId) {
      return { nativeHandle: persistence.nativeHandle, sessionId };
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  throw new Error(`agent ${agentId} never reported a session file`);
}

// The copy carries its own session id; the agent only loads it under its own.
async function writeForkedSession(
  forkPath: string,
  target: { nativeHandle: string; sessionId: string },
): Promise<void> {
  const lines = (await readFile(forkPath, "utf8")).split("\n");
  let rewritten = false;
  const out = lines.map((line) => {
    if (rewritten || !line.includes('"session"')) return line;
    try {
      const entry = JSON.parse(line);
      if (entry?.type !== "session") return line;
      entry.id = target.sessionId;
      rewritten = true;
      return JSON.stringify(entry);
    } catch {
      return line;
    }
  });
  if (!rewritten) throw new Error(`no session header in ${forkPath}`);
  await writeFile(target.nativeHandle, out.join("\n"), "utf8");
}

async function hasHistory(paseo: PaseoApi, agentId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const entries = await fetchEntries(paseo, agentId);
    if (entries.some(({ item }) => item.type === "user_message")) return true;
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  return false;
}

async function nativeFork(
  paseo: PaseoApi,
  parent: ParentSnapshot,
  fork: (source: ForkSource) => Promise<string>,
  options: CloneOptions,
): Promise<PaseoAgentHandle> {
  const sessionId = parent.runtimeInfo?.sessionId ?? parent.persistence?.sessionId;
  if (!sessionId) throw new Error(`parent has no ${parent.provider} session yet`);
  const forkId = await fork({
    sessionId,
    nativeHandle: parent.persistence?.nativeHandle ?? null,
    cwd: parent.cwd,
    model: parent.model,
  });

  if (options.asChild) {
    return paseo.agents.create({
      cwd: parent.cwd,
      parent: parent.id,
      config: {
        ...providerConfig(parent),
        options: {
          extraArgs: { resume: forkId },
          ...(options.disallowedTools ? { disallowedTools: options.disallowedTools } : {}),
        },
      },
      title: options.title,
      labels: options.labels,
      prompt: options.prompt,
      clientMessageId: options.messageId,
    });
  }

  // Import has no way to pick a workspace, so a cwd with several lands the fork in the
  // oldest one instead of the parent's. Only Claude can resume a forked session inside a
  // newly created agent, so the others keep the import and its workspace limitation.
  if (parent.provider === "claude") {
    return claudeRootFork(paseo, parent, forkId, options);
  }

  const agentId = await importSession(parent.provider, forkId, parent.cwd, options.labels);
  await inheritSettings(agentId, parent, options.title);
  const agent = paseo.agents.ref(agentId);
  if (options.prompt) await agent.send(options.prompt, { messageId: options.messageId });
  return agent;
}

// A root Claude fork resumes the copied session through the CLI's --resume flag, on an agent
// created inside the parent's workspace — that placement is what makes the fork a tab there.
// An idle agent has no Claude process and no session id; setting the mode does not start one
// reliably either, but a message does. So the fork starts with the prompt itself (or a
// one-line acknowledgement when there is none), which launches Claude with --resume; once the
// resumed session id shows up, a reload replays the fork's history into the new tab's timeline.
// Every step is checked; a miss archives the agent and falls back to a transcript fork.
const BRANCH_ACK_PROMPT =
  "[This tab was forked from the conversation above. Reply with a one-line acknowledgement " +
  "and wait for my next message.]";

async function claudeRootFork(
  paseo: PaseoApi,
  parent: ParentSnapshot,
  forkId: string,
  options: CloneOptions,
): Promise<PaseoAgentHandle> {
  const shared = { title: options.title, labels: options.labels };
  const config: PaseoAgentConfig = {
    ...providerConfig(parent),
    options: { extraArgs: { resume: forkId } },
  };
  const create = parent.workspaceId
    ? paseo.workspaces.ref(parent.workspaceId).agents.create({ ...shared, config })
    : paseo.agents.create({ cwd: parent.cwd, ...shared, config });
  const agent = await create;
  try {
    if (parent.thinkingOptionId) {
      await runPaseoCli(["agent", "update", agent.id, "--thinking", parent.thinkingOptionId, "--json"]);
    }
    // The ACK message is what starts Claude (with --resume) on an idle agent. It answers in
    // seconds, so the wait before the reload stays short; the reload kills the process, and a
    // queued or running turn would be lost with it. The real prompt is only sent after the
    // reload restored the history, so it can never be cut short by the reload.
    await agent.send(BRANCH_ACK_PROMPT, { messageId: options.messageId });
    const resumed = await waitForSessionId(paseo, agent.id);
    if (resumed !== forkId) {
      throw new Error(`agent resumed session ${resumed ?? "(none)"} instead of the fork ${forkId}`);
    }
    if (!(await waitForIdle(paseo, agent.id))) {
      throw new Error("the fork's first turn did not settle before the reload");
    }
    await runPaseoCli(["agent", "reload", agent.id, "--json"]);
    if (!(await hasHistory(paseo, agent.id))) throw new Error("reload did not restore the copied history");
    if (options.prompt) {
      await agent.send(options.prompt);
    }
  } catch (error) {
    await agent.archive().catch(() => undefined);
    throw error;
  }
  return agent;
}

// Claude reports its session id once the process starts and the init message arrives; the
// message that starts it is what resume picks up, so this waits for that id.
async function waitForSessionId(paseo: PaseoApi, agentId: string): Promise<string | null> {
  for (let attempt = 0; attempt < 25; attempt++) {
    const refreshed = await paseo.agents.ref(agentId).refresh();
    const agent = refreshed?.agent;
    const sessionId = agent?.runtimeInfo?.sessionId ?? agent?.persistence?.sessionId ?? null;
    if (sessionId) return sessionId;
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  return null;
}

// The turn answering the first prompt must end before the reload, or it is killed mid-flight
// and its messages never reach the timeline. Give it a generous window: the answer to the
// fork's opening prompt can legitimately take a while.
async function waitForIdle(paseo: PaseoApi, agentId: string, timeoutMs = 10 * 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const refreshed = await paseo.agents.ref(agentId).refresh();
    const lifecycle = refreshed?.agent?.status;
    if (lifecycle === "idle" || lifecycle === "error" || lifecycle === "closed") return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

// The plugin SDK cannot import sessions or change thinking and mode, so these go through
// the CLI, which can.
export async function runPaseoCli(args: string[]): Promise<string> {
  let lastError: unknown;
  for (const cli of PASEO_CLI_CANDIDATES) {
    try {
      const { stdout } = await execFileAsync(cli, args, { timeout: 60_000 });
      return stdout;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function importSession(
  provider: string,
  sessionId: string,
  cwd: string,
  labels: Record<string, string> = {},
): Promise<string> {
  const args = ["import", sessionId, "--provider", provider, "--cwd", cwd, "--json"];
  for (const [key, value] of Object.entries(labels)) args.push("--label", `${key}=${value}`);
  const stdout = await runPaseoCli(args);
  const agentId = parseImportedAgentId(stdout);
  if (!agentId) throw new Error(`no agent id in import output: ${stdout.slice(0, 200)}`);
  return agentId;
}

// An imported session starts with Paseo's defaults. Failures here leave a usable fork with
// default settings, so they are logged rather than thrown.
async function inheritSettings(agentId: string, parent: ParentSnapshot, title: string) {
  // The CLI rejects --thinking combined with --name, so they are separate updates.
  const steps = [["agent", "update", agentId, "--name", title]];
  if (parent.thinkingOptionId) steps.push(["agent", "update", agentId, "--thinking", parent.thinkingOptionId]);
  if (parent.currentModeId) steps.push(["agent", "mode", agentId, parent.currentModeId]);
  for (const args of steps) {
    try {
      await runPaseoCli([...args, "--json"]);
    } catch (error) {
      console.warn(`${LOG_PREFIX} ${args.slice(0, 2).join(" ")} failed for fork ${agentId}: ${String(error)}`);
    }
  }
}

function parseImportedAgentId(stdout: string): string | null {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  const parsed = JSON.parse(stdout.slice(start));
  return parsed.agentId ?? parsed.id ?? parsed.agent?.id ?? null;
}

async function transcriptFork(
  paseo: PaseoApi,
  parent: ParentSnapshot,
  options: CloneOptions,
): Promise<PaseoAgentHandle> {
  const entries = await fetchEntries(paseo, parent.id);
  const end = options.anchorMessageId ? anchorIndex(entries, options.anchorMessageId) : entries.length - 1;
  if (end < 0) throw new Error(`anchor ${options.anchorMessageId} is not in the copied history`);
  const lines = [`Conversation so far with "${parent.title ?? parent.id}" (cloned):`];
  for (const { item } of entries.slice(0, end + 1)) {
    if (item.type === "user_message") lines.push(`User: ${item.text}`);
    else if (item.type === "assistant_message") lines.push(`Assistant: ${item.text}`);
  }
  if (options.anchorMessageId) lines.push("(The conversation was copied up to this point and continues from here.)");

  const shared = {
    ...(options.asChild ? { parent: parent.id } : {}),
    config: providerConfig(parent),
    title: options.title,
    labels: options.labels,
    clientMessageId: options.messageId,
    prompt:
      options.prompt ??
      "The attached transcript is our conversation so far. Reply with a one-line acknowledgement and wait for my next message.",
    attachments: [
      {
        type: "text" as const,
        mimeType: "text/plain" as const,
        title: `Transcript of ${parent.title ?? parent.id}`,
        text: lines.join("\n\n"),
      },
    ],
  };
  // Creating by cwd alone lands the clone in a new workspace. A tab belongs to the parent's
  // workspace, so ask that workspace for the agent when the parent names one.
  return !options.asChild && parent.workspaceId
    ? paseo.workspaces.ref(parent.workspaceId).agents.create(shared)
    : paseo.agents.create({ cwd: parent.cwd, ...shared });
}

type TimelineEntries = Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["timeline"]["refetch"]>>["entries"];

function fetchEntries(paseo: PaseoApi, agentId: string) {
  return paseo.agents.ref(agentId).timeline.refetch({
    direction: "tail",
    limit: TRANSCRIPT_ENTRY_LIMIT,
    projection: "canonical",
  }).then((page) => page.entries);
}

function entryAnchorId(item: TimelineEntries[number]["item"]): string | null {
  return item.type === "user_message" ? item.messageId ?? item.clientMessageId ?? null : null;
}

function anchorIndex(entries: TimelineEntries, anchorId: string): number {
  return entries.findIndex((entry) => entryAnchorId(entry.item) === anchorId);
}

// The points a user can fork from: prompts in the copied window that carry an id. Assistant
// replies are left out: a fork cut after one of those is the same conversation.
export async function listForkAnchors(paseo: PaseoApi, agentId: string): Promise<ForkAnchor[]> {
  const entries = await fetchEntries(paseo, agentId);
  const anchors: ForkAnchor[] = [];
  for (const { item } of entries) {
    if (item.type !== "user_message") continue;
    const id = entryAnchorId(item);
    if (!id) continue;
    anchors.push({ id, preview: preview(item.text) });
  }
  return anchors;
}

function preview(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 100 ? `${line.slice(0, 97)}...` : line;
}

export async function lastAssistantMessage(paseo: PaseoApi, agentId: string): Promise<string | null> {
  const page = await paseo.agents.ref(agentId).timeline.refetch({
    direction: "tail",
    limit: 50,
    projection: "canonical",
  });
  for (let i = page.entries.length - 1; i >= 0; i--) {
    const { item } = page.entries[i];
    if (item.type === "assistant_message" && item.text.trim()) return item.text;
  }
  return null;
}

export interface Reply {
  /** The last assistant text answering the message, or null if it produced none. */
  text: string | null;
  /** A later user message followed, so the turn answering this one is over. */
  superseded: boolean;
}

// Finds the reply to one tagged user message, ignoring turns the user started afterwards
// in the agent's own tab. Null when the message is not in the timeline yet.
export async function replyTo(paseo: PaseoApi, agentId: string, messageId: string): Promise<Reply | null> {
  const page = await paseo.agents.ref(agentId).timeline.refetch({
    direction: "tail",
    limit: 200,
    projection: "canonical",
  });
  const start = page.entries.findIndex(
    ({ item }) =>
      item.type === "user_message" && (item.messageId === messageId || item.clientMessageId === messageId),
  );
  if (start < 0) return null;

  let text: string | null = null;
  for (const { item } of page.entries.slice(start + 1)) {
    if (item.type === "user_message") return { text, superseded: true };
    if (item.type === "assistant_message" && item.text.trim()) text = item.text;
  }
  return { text, superseded: false };
}
