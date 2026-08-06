/**
 * Typed in-process event bus.
 *
 * Architecture ref: §3.3.1.
 *
 * For the MVP every module runs inside one Fastify process, and the module
 * boundary is a directory plus this bus — not a network hop. When the API
 * scales past one instance the same events are mirrored over Redis Pub/Sub
 * (§3.3.2) without any module changing.
 */

import { EventEmitter } from 'node:events';

export interface ModuleEvents {
  // Entry module
  'entry.created': { org_id: string; entry_id: string; rodeo_id: string };
  'entry.confirmed': { org_id: string; entry_id: string; rodeo_id: string };
  'entry.scratched': { org_id: string; entry_id: string; reason?: string };

  // Scoring module
  'score.submitted': { org_id: string; score_id: string; rodeo_event_id: string };
  'score.finalized': { org_id: string; score_id: string; rodeo_event_id: string };
  'score.corrected': {
    org_id: string;
    score_id: string;
    field: string;
    from: unknown;
    to: unknown;
    by: string;
  };

  // Payout module
  'payout.calculated': {
    org_id: string;
    rodeo_event_id: string;
    net_purse_cents: number;
    lines: number;
  };
  'payout.disbursed': { org_id: string; transaction_id: string };

  // Results module
  'results.official': { org_id: string; rodeo_event_id: string };
  'standings.updated': { org_id: string; sanctioning_body: string; season: string };

  // Timer module
  'timer.time_received': {
    org_id: string;
    rodeo_event_id: string;
    raw_time: number;
    hardware_timestamp: number;
  };

  // Rodeo lifecycle
  'rodeo.status_changed': {
    org_id: string;
    rodeo_id: string;
    from: string;
    to: string;
  };
}

export type ModuleEventName = keyof ModuleEvents;

export class TypedEventBus {
  readonly #emitter = new EventEmitter({ captureRejections: true });

  constructor() {
    // A listener that throws must not take the process down mid-rodeo. The
    // emitter surfaces it; the caller's transaction has already committed.
    this.#emitter.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[event-bus] listener failed', err);
    });
  }

  emit<K extends ModuleEventName>(event: K, payload: ModuleEvents[K]): boolean {
    return this.#emitter.emit(event, payload);
  }

  on<K extends ModuleEventName>(
    event: K,
    listener: (payload: ModuleEvents[K]) => void | Promise<void>,
  ): this {
    this.#emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  once<K extends ModuleEventName>(
    event: K,
    listener: (payload: ModuleEvents[K]) => void | Promise<void>,
  ): this {
    this.#emitter.once(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<K extends ModuleEventName>(
    event: K,
    listener: (payload: ModuleEvents[K]) => void | Promise<void>,
  ): this {
    this.#emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }
}
