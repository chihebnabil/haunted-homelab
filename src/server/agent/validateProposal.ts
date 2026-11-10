import { z } from "zod";
import type { ActionKind, Snapshot } from "../../shared/types.js";

/** The action fields accepted from an untrusted LLM response before store registration. */
export interface ValidatedProposal {
  action: ActionKind;
  container: string;
  reason: string;
}

export const LlmProposalSchema = z.object({
  action: z.enum(["restart", "stop"]),
  container: z.string(),
  reason: z.string().refine((value) => value.trim().length > 0),
}) satisfies z.ZodType<ValidatedProposal>;

/**
 * Validates an untrusted LLM proposal against its shape and the current snapshot.
 * Invalid proposals are dropped rather than allowed to interrupt the chat response.
 */
export function validateProposal(input: unknown, snapshot: Snapshot): ValidatedProposal | null {
  const parsed = LlmProposalSchema.safeParse(input);
  if (!parsed.success) return null;

  const exists = snapshot.containers.some(({ name }) => name === parsed.data.container);
  return exists ? parsed.data : null;
}
