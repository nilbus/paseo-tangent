import type { PluginAgentCommandContext, PluginClientContext } from "@getpaseo/plugin/client";
import { BtwPanel } from "./client/btw-panel";
import { ForkPanel } from "./client/fork-panel";
import { store } from "./client/store";
import { forkRpc, subtaskRpc } from "./shared/rpc";

const PANEL_ID = "btw";
const FORK_PANEL_ID = "fork";
const LOG_PREFIX = "[tangent]";

type CommandContext = PluginAgentCommandContext & { args: string };

async function fork(context: CommandContext, reportBack: boolean) {
  try {
    const { agentId, opened } = await context.rpc(forkRpc, {
      agentId: context.agent.id,
      prompt: context.args,
      reportBack,
    });
    if (opened) return;
    // Only panels can navigate; the panel opens queued agents as tabs when it mounts.
    store.requestOpen(agentId);
    context.openPanel(PANEL_ID, { location: "explorer" });
  } catch (error) {
    console.error(`${LOG_PREFIX} fork failed: ${String(error)}`);
  }
}

export default function contribute(client: PluginClientContext) {
  store.init(client.rpc as never);
  const cleanups = [
    client.addAgentPanel({
      id: PANEL_ID,
      title: "BTW",
      icon: "MessageCircleQuestion",
      locations: ["explorer"],
      Component: BtwPanel,
    }),
    client.addSlashCommand({
      name: "btw",
      description: "Ask a side question without interrupting the agent",
      argumentHint: "<question>",
      context: "agent",
      onSubmit(context) {
        if (context.args.trim()) void store.ask(context.agent.id, context.args.trim());
        context.openPanel(PANEL_ID, { location: "explorer" });
      },
    }),
    client.addSlashCommand({
      name: "subtask",
      description: "Run a task in a background agent that reports back here",
      argumentHint: "<task>",
      context: "agent",
      async onSubmit(context) {
        if (!context.args.trim()) return;
        try {
          await context.rpc(subtaskRpc, { agentId: context.agent.id, prompt: context.args });
        } catch (error) {
          console.error(`${LOG_PREFIX} subtask failed: ${String(error)}`);
        }
      },
    }),
    client.addAgentPanel({
      id: FORK_PANEL_ID,
      title: "Fork",
      icon: "GitFork",
      locations: ["explorer"],
      Component: ForkPanel,
    }),
    client.addSlashCommand({
      name: "fork",
      description: "Fork this conversation into a new tab; with no prompt, pick the message first",
      argumentHint: "[prompt]",
      context: "agent",
      onSubmit(context) {
        // Without a prompt the cut point is the point: let the panel show the history first.
        if (context.args.trim()) return fork(context, true);
        store.loadAnchors(context.agent.id);
        context.openPanel(FORK_PANEL_ID, { location: "explorer" });
      },
    }),
    client.addSlashCommand({
      name: "branch",
      description: "Branch this conversation into a new tab",
      argumentHint: "[prompt]",
      context: "agent",
      onSubmit: (context) => fork(context, false),
    }),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
