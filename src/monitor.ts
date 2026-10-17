import { Config, Pairing, Pending, type NetworkName } from "./config.js";
import { syncDojo, type SyncResult } from "./registrar.js";
import {
  connectPaired, recordNotificationStatus, observeFunding,
  recordNotificationConfirmed,
  type FundingObservation,
} from "./setup.js";
import { paynymComplete, registerPaynym } from "./paynym.js";
import { Store } from "./store.js";

const PAYNYM_RETRY_MS = 10 * 60 * 1000;

export interface MonitorState {
  lastAttempt?: string;
  lastSuccess?: string;
  lastError?: string;
  lastResult?: SyncResult;
  funding?: FundingObservation;
  // Undefined until the Dojo has shown the notification transaction.
  notificationConfirmations?: number;
  paynymError?: string;
  paynymAttempt?: string;
}

/**
 * Background checks: the dispenser's PayNym claim and merchant follow,
 * funding and notification progress during setup, address registration and
 * payment status afterwards. Pages read only the cached state, so no web
 * request waits on Tor.
 */
export class Monitor {
  readonly state: MonitorState = {};
  #running: Promise<void> | undefined;
  #paynym: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: Store,
    private readonly network: NetworkName,
  ) {}

  // Joins a check already in progress instead of starting another.
  run(): Promise<void> {
    this.#running ??= this.#check().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  start(intervalMs: number): void {
    void this.run();
    this.#timer = setInterval(() => void this.run(), intervalMs);
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  // Claims the PayNym now, regardless of the retry delay; joins an attempt
  // already in progress.
  registerPaynym(): Promise<void> {
    this.#paynym ??= this.#registerPaynym().finally(() => {
      this.#paynym = undefined;
    });
    return this.#paynym;
  }

  async #registerPaynym(): Promise<void> {
    const config = this.store.get("config", Config);
    if (!config || paynymComplete(this.store)) return;
    this.state.paynymAttempt = new Date().toISOString();
    try {
      await registerPaynym(this.store, config);
      delete this.state.paynymError;
    } catch (error) {
      this.state.paynymError =
        error instanceof Error ? error.message : "unknown error";
      console.error(`PayNym registration: ${this.state.paynymError}`);
    }
  }

  async #check(): Promise<void> {
    const config = this.store.get("config", Config);
    if (!config || config.network !== this.network) return;
    const last = this.state.paynymAttempt;
    if (
      !paynymComplete(this.store) &&
      (!last || !this.state.paynymError ||
        Date.now() - Date.parse(last) > PAYNYM_RETRY_MS)
    ) {
      // Runs alongside the Dojo checks; a slow directory never delays them.
      void this.registerPaynym();
    }

    if (!this.store.get("pairing", Pairing)) return;

    this.state.lastAttempt = new Date().toISOString();
    try {
      const api = await connectPaired(this.store, config);
      const pending = this.store.get("notification", Pending);
      if (!pending) {
        this.state.funding = await observeFunding(config, api);
      } else {
        try {
          this.state.notificationConfirmations =
            (await recordNotificationStatus(this.store, api, pending)).confirmations;
          if (this.state.notificationConfirmations > 0) {
            recordNotificationConfirmed(this.store);
          }
        } catch {
          delete this.state.notificationConfirmations;
        }
      }

      const result = await syncDojo(this.store, config, api);
      if (result.halted) console.error(result.halted);
      this.state.lastResult = result;
      this.state.lastSuccess = new Date().toISOString();
      delete this.state.lastError;
    } catch (error) {
      this.state.lastError =
        error instanceof Error ? error.message : "unknown error";
      console.error(`Dojo check failed: ${this.state.lastError}`);
    }
  }
}
