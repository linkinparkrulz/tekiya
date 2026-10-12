import { Config, Pairing, Pending, type NetworkName } from "./config.js";
import { syncDojo, type SyncResult } from "./registrar.js";
import {
  connectPaired, notificationConfirmed, notificationStatus, observeFunding,
  recordNotificationConfirmed,
  type FundingObservation,
} from "./setup.js";
import { paynymComplete, registerPaynym } from "./paynym.js";
import { moneroSettings, syncMonero } from "./monero.js";
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
  moneroHeight?: number;
  moneroChecked?: string;
  moneroError?: string;
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
  #monero: Promise<void> | undefined;
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

  // Refreshes Monero payments; joins a refresh already in progress.
  syncMonero(): Promise<void> {
    this.#monero ??= this.#syncMonero().finally(() => {
      this.#monero = undefined;
    });
    return this.#monero;
  }

  async #syncMonero(): Promise<void> {
    if (!moneroSettings(this.store)) return;
    try {
      const result = await syncMonero(this.store);
      if (result) this.state.moneroHeight = result.height;
      this.state.moneroChecked = new Date().toISOString();
      delete this.state.moneroError;
    } catch (error) {
      this.state.moneroError =
        error instanceof Error ? error.message : "unknown error";
      console.error(`Monero check failed: ${this.state.moneroError}`);
    }
  }

  async #check(): Promise<void> {
    const config = this.store.get("config", Config);
    if (!config || config.network !== this.network) return;
    // Independent of the Dojo; a slow Monero node never delays it.
    void this.syncMonero();

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
      } else if (!notificationConfirmed(this.store)) {
        try {
          this.state.notificationConfirmations =
            (await notificationStatus(api, pending)).confirmations;
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
