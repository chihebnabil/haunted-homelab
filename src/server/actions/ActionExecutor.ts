/**
 * Runs a confirmed Action_Proposal through the Data_Source (Requirement 11.4).
 *
 * Only `ProposalStore` holds an instance of this class (design decision 5, Requirement 11.5).
 * Do not construct or call it from routes, the Agent, or any other module.
 */

import type { DataSource } from "../datasource/types.js";
import type { ActionProposal, ActionResult } from "./types.js";

export class ActionExecutor {
  readonly #ds: DataSource;

  constructor(ds: DataSource) {
    this.#ds = ds;
  }

  /** Never throws. A Data_Source failure becomes `{ ok: false, error }` with the error message verbatim (11.7). */
  async run(p: Pick<ActionProposal, "action" | "container">): Promise<ActionResult> {
    try {
      switch (p.action) {
        case "restart":
          await this.#ds.restart(p.container);
          break;
        case "stop":
          await this.#ds.stop(p.container);
          break;
        default: {
          const unsupported: never = p.action;
          return { ok: false, error: `Unsupported action: ${String(unsupported)}` };
        }
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message.length > 0) return err.message;
  if (typeof err === "string" && err.length > 0) return err;
  if (err instanceof Error) return err.name;
  return "Unknown error";
}
