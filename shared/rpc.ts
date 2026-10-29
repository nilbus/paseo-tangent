import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const forkMethodSchema = z.enum(["native", "transcript"]);
export type ForkMethod = z.infer<typeof forkMethodSchema>;

// /fork reports its first answer back to the parent; /branch does not.
export const forkRpc = defineRpc({
  name: "tangent.fork",
  input: z.object({
    agentId: z.string(),
    prompt: z.string(),
    reportBack: z.boolean(),
  }),
  output: z.object({ agentId: z.string(), method: forkMethodSchema, opened: z.boolean() }),
});

// One selectable point in the parent's history: a user message a fork can start after.
export const forkAnchorSchema = z.object({
  id: z.string(),
  /** First line of the prompt, trimmed for a one-line list row. */
  preview: z.string(),
});
export type ForkAnchor = z.infer<typeof forkAnchorSchema>;

export const forkAnchorsRpc = defineRpc({
  name: "tangent.fork-anchors",
  input: z.object({ agentId: z.string() }),
  output: z.object({ anchors: z.array(forkAnchorSchema) }),
});

// Fork the conversation up to one message instead of cloning all of it. No prompt is sent:
// like Paseo's own Fork, the new tab waits for the user's next message.
export const forkAtRpc = defineRpc({
  name: "tangent.fork-at",
  input: z.object({
    agentId: z.string(),
    /** `messageId` or `clientMessageId` of the user message to cut after. */
    anchorId: z.string(),
    /** Shown in the new tab's title; the message the fork starts after. */
    preview: z.string(),
  }),
  output: z.object({ agentId: z.string(), method: forkMethodSchema, opened: z.boolean() }),
});

export const subtaskRpc = defineRpc({
  name: "tangent.subtask",
  input: z.object({ agentId: z.string(), prompt: z.string() }),
  output: z.object({ agentId: z.string() }),
});

// Omit threadAgentId to start a new /btw thread forked from the main agent.
export const btwRpc = defineRpc({
  name: "tangent.btw",
  input: z.object({
    agentId: z.string(),
    question: z.string(),
    threadAgentId: z.string().optional(),
  }),
  output: z.object({
    threadAgentId: z.string(),
    method: forkMethodSchema,
    answer: z.string(),
  }),
});

export const btwCloseRpc = defineRpc({
  name: "tangent.btw-close",
  input: z.object({ threadAgentId: z.string() }),
  output: z.object({ ok: z.boolean() }),
});
