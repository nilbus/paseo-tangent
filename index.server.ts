import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import { btwCloseRpc, btwRpc, forkAnchorsRpc, forkAtRpc, forkRpc, subtaskRpc } from "./shared/rpc";
import { randomUUID } from "node:crypto";
import { cloneAgent, lastAssistantMessage, listForkAnchors, loadAgent, providerConfig, replyTo, runPaseoCli } from "./server/clone";

const LOG_PREFIX = "[tangent]";
const BTW_TIMEOUT_MS = 5 * 60_000;
// Claude's /btw answers without tools; these are the ones that act or change things.
const BTW_DISALLOWED_TOOLS = ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "Agent", "Task"];
const BTW_PREAMBLE =
  "[You are a /btw side thread forked from the conversation above, not the main session. " +
  "The question below comes from the user via the side panel. Answer from what you already " +
  "know in this conversation. Do not use tools or change anything. Be brief.]\n\n";

interface PendingReport {
  parentId: string;
  kind: "fork" | "subtask";
  title: string;
  /** The parent's prompt; only the turn answering it is reported. */
  messageId: string;
}

// Children that wake their parent once the turn answering the parent's prompt ends, like
// Claude's background agents. Turns the user starts in the child's tab are not reported.
// In memory only, so a daemon restart drops reports that are still pending.
const pendingReports = new Map<string, PendingReport>();

function shortTitle(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}

async function report(paseo: PaseoApi, childId: string, pending: PendingReport, body: string) {
  const tag = pending.kind === "subtask" ? "subtask-result" : "fork-result";
  const message = `<${tag} agent="${childId}" title="${pending.title}">\n${body}\n</${tag}>`;
  await paseo.agents.ref(pending.parentId).send(message, { activeTurnBehavior: "steer" });
}

// Opens the agent in a Paseo Desktop tab. Other clients, or a failure, leave it to the
// client's panel fallback.
async function openInDesktop(agentId: string): Promise<boolean> {
  try {
    await runPaseoCli(["agent", "open", agentId, "--json"]);
    return true;
  } catch (error) {
    console.warn(`${LOG_PREFIX} agent open failed for ${agentId}: ${String(error)}`);
    return false;
  }
}

export default function contribute(server: PluginServerContext) {
  server.handle(forkRpc, async ({ agentId, prompt, reportBack }, { paseo }) => {
    const title = prompt.trim() ? `Fork: ${shortTitle(prompt)}` : "Branch";
    const messageId = randomUUID();
    const { agent, method } = await cloneAgent(paseo, agentId, {
      title,
      prompt: prompt.trim() || undefined,
      messageId,
    });
    if (reportBack && prompt.trim()) {
      pendingReports.set(agent.id, { parentId: agentId, kind: "fork", title, messageId });
    }
    return { agentId: agent.id, method, opened: await openInDesktop(agent.id) };
  });

  server.handle(forkAnchorsRpc, async ({ agentId }, { paseo }) => ({
    anchors: await listForkAnchors(paseo, agentId),
  }));

  // Same result as /fork, but the copy ends at the picked message and the tab stays idle.
  server.handle(forkAtRpc, async ({ agentId, anchorId, preview }, { paseo }) => {
    const title = preview.trim() ? `Fork at: ${shortTitle(preview)}` : "Fork at picked message";
    const { agent, method } = await cloneAgent(paseo, agentId, {
      title,
      anchorMessageId: anchorId,
      anchorText: preview,
    });
    return { agentId: agent.id, method, opened: await openInDesktop(agent.id) };
  });

  server.handle(subtaskRpc, async ({ agentId, prompt }, { paseo }) => {
    const parent = await loadAgent(paseo, agentId);
    const title = `Subtask: ${shortTitle(prompt)}`;
    const messageId = randomUUID();
    const child = await paseo.agents.create({
      cwd: parent.cwd,
      parent: agentId,
      config: providerConfig(parent),
      title,
      prompt,
      clientMessageId: messageId,
    });
    pendingReports.set(child.id, { parentId: agentId, kind: "subtask", title, messageId });
    return { agentId: child.id };
  });

  server.handle(btwRpc, async ({ agentId, question, threadAgentId }, { paseo }) => {
    const prompt = BTW_PREAMBLE + question;
    let thread;
    let method: "native" | "transcript" = "native";
    if (threadAgentId) {
      thread = paseo.agents.ref(threadAgentId);
      await thread.send(prompt);
    } else {
      ({ agent: thread, method } = await cloneAgent(paseo, agentId, {
        title: `btw: ${shortTitle(question)}`,
        prompt,
        labels: { tangent: "btw" },
        asChild: true,
        disallowedTools: BTW_DISALLOWED_TOOLS,
      }));
    }
    const result = await thread.waitForFinish(BTW_TIMEOUT_MS);
    const answer =
      result.status === "idle"
        ? (await lastAssistantMessage(paseo, thread.id)) ?? result.lastMessage ?? "(no answer)"
        : `(${result.status}${result.error ? `: ${result.error}` : ""})`;
    return { threadAgentId: thread.id, method, answer };
  });

  server.handle(btwCloseRpc, async ({ threadAgentId }, { paseo }) => {
    await paseo.agents.ref(threadAgentId).archive();
    return { ok: true };
  });

  server.on("agent.turn_ended", async (event, { paseo }) => {
    const pending = pendingReports.get(event.agent.id);
    if (!pending) return;
    try {
      const reply = await replyTo(paseo, event.agent.id, pending.messageId);
      // A turn that ended before the parent's prompt arrived is not the one to report.
      if (!reply) return;
      pendingReports.delete(event.agent.id);
      const outcome = event.outcome;
      const body =
        reply.superseded || outcome.kind === "completed"
          ? reply.text ?? "(finished without a reply)"
          : outcome.kind === "failed"
            ? `(failed: ${outcome.error.message})`
            : `(canceled: ${outcome.reason})`;
      await report(paseo, event.agent.id, pending, body);
    } catch (error) {
      console.error(`${LOG_PREFIX} report to ${pending.parentId} failed: ${String(error)}`);
    }
  });

  server.on("agent.closed", (event) => {
    pendingReports.delete(event.agent.id);
  });

  console.log(`${LOG_PREFIX} server ready`);
  return () => pendingReports.clear();
}
