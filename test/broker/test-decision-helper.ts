import {
  decide,
  PermissionBrokerRequest,
  PermissionDecision,
} from "../../lib/broker/permission-broker";

/**
 * Test-only helper to obtain a fixed decision for tests that require
 * testing specific decision outcomes without request.decision in production.
 * Calls the broker's real decide() function with chosen request fields that
 * the broker's policy allows or rejects.
 */
export function decideWithFixedDecision(
  request: PermissionBrokerRequest,
  fixedDecision: "allow_once" | "reject_once" | "allow" | "reject",
  matchedRule?: string
): PermissionDecision {
  const allowed = fixedDecision === "allow_once" || fixedDecision === "allow";
  const req: PermissionBrokerRequest = {
    ...request,
    ...(allowed
      ? {
          role: "Planner",
          capability: "mcp",
          target: "necromancer/ask",
          fallbackChosen: false,
          probeP6: undefined,
          permissionForm: undefined,
        }
      : {
          capability: "shell",
        }),
  };
  const decision = decide(req);
  if (matchedRule !== undefined) {
    decision.rule = matchedRule;
    if (decision.event?.data) {
      decision.event.data.rule = matchedRule;
    }
  }
  return decision;
}
