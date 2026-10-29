import type { PluginRpcContract } from "@getpaseo/plugin";
import { btwCloseRpc, btwRpc, forkAnchorsRpc, forkAtRpc, type ForkAnchor } from "../shared/rpc";

type Rpc = <C extends PluginRpcContract>(contract: C, input: unknown) => Promise<any>;

export interface BtwExchange {
  question: string;
  answer: string | null;
}

export interface BtwThread {
  threadAgentId: string | null;
  method: "native" | "transcript" | null;
  exchanges: BtwExchange[];
  busy: boolean;
}

// Shared by the slash commands and the sidebar panel. Requests run here rather than in the
// panel so an answer still lands if the panel is closed meanwhile.
const threads = new Map<string, BtwThread>();
export interface AnchorListState {
  status: "idle" | "loading" | "ready" | "error";
  anchors: ForkAnchor[];
  error: string | null;
  /** The anchor a fork is running for, so its row can show progress. */
  busyId: string | null;
}

const anchors = new Map<string, AnchorListState>();
const pendingOpens: string[] = [];
const listeners = new Set<() => void>();
let rpc: Rpc | null = null;
let version = 0;

function emit() {
  version++;
  for (const listener of listeners) listener();
}

export const store = {
  init(nextRpc: Rpc) {
    rpc = nextRpc;
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  version: () => version,
  thread(agentId: string): BtwThread | undefined {
    return threads.get(agentId);
  },

  anchors(agentId: string): AnchorListState {
    return anchors.get(agentId) ?? { status: "idle", anchors: [], error: null, busyId: null };
  },

  async loadAnchors(agentId: string) {
    if (!rpc) return;
    anchors.set(agentId, { ...this.anchors(agentId), status: "loading", error: null });
    emit();
    try {
      const result = await rpc(forkAnchorsRpc, { agentId });
      anchors.set(agentId, { status: "ready", anchors: result.anchors, error: null, busyId: null });
    } catch (error) {
      anchors.set(agentId, { status: "error", anchors: [], error: String(error), busyId: null });
    }
    emit();
  },

  // Returns the fork's agent and whether the desktop already opened it, or null on failure.
  async forkAt(agentId: string, anchorId: string, preview: string): Promise<{ agentId: string; opened: boolean } | null> {
    if (!rpc) return null;
    const state = this.anchors(agentId);
    if (state.busyId) return null;
    anchors.set(agentId, { ...state, busyId: anchorId, error: null });
    emit();
    try {
      const result = await rpc(forkAtRpc, { agentId, anchorId, preview });
      anchors.set(agentId, { ...this.anchors(agentId), busyId: null });
      emit();
      return { agentId: result.agentId as string, opened: Boolean(result.opened) };
    } catch (error) {
      anchors.set(agentId, { ...this.anchors(agentId), busyId: null, error: String(error) });
      emit();
      return null;
    }
  },

  async ask(agentId: string, question: string) {
    if (!rpc) return;
    const thread = threads.get(agentId) ?? { threadAgentId: null, method: null, exchanges: [], busy: false };
    if (thread.busy) return;
    const exchange: BtwExchange = { question, answer: null };
    threads.set(agentId, { ...thread, busy: true, exchanges: [...thread.exchanges, exchange] });
    emit();
    try {
      const result = await rpc(btwRpc, {
        agentId,
        question,
        threadAgentId: thread.threadAgentId ?? undefined,
      });
      exchange.answer = result.answer;
      threads.set(agentId, { ...threads.get(agentId)!, ...result, busy: false });
    } catch (error) {
      exchange.answer = `(error: ${String(error)})`;
      threads.set(agentId, { ...threads.get(agentId)!, busy: false });
    }
    emit();
  },

  async reset(agentId: string) {
    const thread = threads.get(agentId);
    threads.delete(agentId);
    emit();
    if (rpc && thread?.threadAgentId) await rpc(btwCloseRpc, { threadAgentId: thread.threadAgentId }).catch(() => {});
  },

  // Slash commands cannot navigate, so they queue an agent for the panel to open.
  requestOpen(agentId: string) {
    pendingOpens.push(agentId);
    emit();
  },
  takePendingOpens(): string[] {
    return pendingOpens.splice(0);
  },
};
