import type { HealthAction } from "../../types";
import { runHealthAction as run } from "../../lib/status";
import { toast } from "../feedback/Toast";

/** Runs a HealthCondition action (CONTRACT §5.3) and reports a backend failure as a toast. */
export function runHealthAction(action: HealthAction | null | undefined): void {
  run(action).catch((e: unknown) => toast(`Action failed: ${e instanceof Error ? e.message : String(e)}`, "warn"));
}
