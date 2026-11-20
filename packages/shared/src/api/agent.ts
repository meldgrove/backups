import { z } from "zod";

/*
 * The backup-agent protocol, version 1 (meldgrove/backup-agent README,
 * "Protocol"): routes under /api/agent/v1 with the source's token. Change
 * both sides together.
 */

export const AGENT_TOKEN_PREFIX = "mgb_";
/** `mgb_` and 32 random bytes in base64url. */
export const AGENT_TOKEN = /^mgb_[A-Za-z0-9_-]{43}$/;

export const agentPollSchema = z.object({
  agent: z.object({ version: z.string().max(100) }),
  app: z.object({ name: z.string().max(100).default(""), image: z.string().max(300).default("") }),
  database: z.boolean(),
  volumes: z.array(z.string().max(200)).max(100),
  /** Sent by `backup-agent check`: answer as usual, but hand out no job. */
  check: z.boolean().optional(),
});
export type AgentPoll = z.infer<typeof agentPollSchema>;

export type AgentPollAnswer = {
  source: { id: string; name: string };
  pollSeconds: number;
  job: { id: string; partBytes: number } | null;
};

export const agentCompleteSchema = z.object({
  parts: z.number().int().min(0),
  bytes: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  warnings: z.array(z.string().max(500)).max(100).default([]),
});
export type AgentComplete = z.infer<typeof agentCompleteSchema>;

export const agentFailSchema = z.object({ message: z.string().max(500) });

/** While pg_dump runs (before the first part), every 5 minutes: the job is alive. */
export const agentProgressSchema = z.object({
  stage: z.string().max(50),
  bytes: z.number().int().min(0).optional(),
});
