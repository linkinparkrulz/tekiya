import { Approval, Pending, requireCondition, type Config } from "./config.js";
import { verifyIdentity } from "./bitcoin.js";
import { Store } from "./store.js";

export function requireApproval(store: Store, config: Config): Pending {
  const pending = store.get("notification", Pending);
  const approval = store.get("approval", Approval);
  requireCondition(pending && approval, "Merchant connection is not approved");
  requireCondition(
    approval.txid === pending.txid &&
      verifyIdentity(config, pending, approval.signature),
    "Merchant approval is invalid",
  );
  return pending;
}
