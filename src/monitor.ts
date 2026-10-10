import { Config, Pairing, Pending, type NetworkName } from "./config.js";
import { syncDojo, type SyncResult } from "./registrar.js";
import {
  connectPaired, notificationStatus, observeFunding,
  type FundingObservation,
} from "./setup.js";
import { Store } from "./store.js";

export interface MonitorState {
  lastAttempt?: string;
  lastSuccess?: string;
  lastError?: string;
  lastResult?: SyncResult;
  funding?: FundingObservation;
  // Undefined until the Dojo has shown the notification transaction.
  notificationConfirmations?: number;
}

/**
 * Background Dojo checks: funding and notification progress during setup,
 * address registration and payment status afterwards. Pages read only the
 * cached state, so no web request waits on Tor.
 */
export class Monitor {
  readonly state: MonitorState = {};
  #running: Promise<void> | undefined;
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

  async #check(): Promise<void> {
    const config = this.store.get("config", Config);
    if (!config || config.network !== this.network) return;
    if (!this.store.get("pairing", Pairing)) return;

    this.state.lastAttempt = new Date().toISOString();
    try {
      const api = await connectPaired(this.store, config);
      const pending = this.store.get("notification", Pending);
      if (!pending) {
        this.state.funding = await observeFunding(config, api);
      } else if (!this.state.notificationConfirmations) {
        try {
          this.state.notificationConfirmations =
            (await notificationStatus(api, pending)).confirmations;
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
