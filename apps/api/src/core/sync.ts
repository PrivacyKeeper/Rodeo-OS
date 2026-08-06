/**
 * Offline sync and the arena authority model.
 *
 * Architecture ref: §4.4.
 *
 * A secretary's laptop in a rural arena loses connectivity for hours. It keeps
 * taking scores. So does the judge's tablet, and the timer bridge. When the
 * link comes back, three devices have opinions about the same run and somebody
 * has to be right.
 *
 * The rule is authority, not recency: hardware beats a person, the secretary's
 * terminal beats other people, and contestant records come from the server
 * because entries were reconciled with PROCOM there. A last-write-wins clock
 * comparison would let a judge's stale tablet overwrite a hardware time.
 */

export type SyncEntityType = 'score' | 'entry' | 'result';
export type SyncAction = 'create' | 'update' | 'delete';
export type SyncSource = 'secretary' | 'judge' | 'timer';

export interface SyncChange {
  /** Client-generated UUID; also the idempotency key for the mutation. */
  id: string;
  entity_type: SyncEntityType;
  action: SyncAction;
  data: Record<string, unknown>;
  /** When the change was made on the device, ISO 8601. */
  timestamp: string;
  source: SyncSource;
  /** Server version the client believed it was editing, if any. */
  base_version?: number;
}

export interface SyncRequest {
  client_id: string;
  last_sync_at: string;
  changes: SyncChange[];
}

export interface SyncConflict {
  client_change_id: string;
  reason: 'version_conflict' | 'authority_override' | 'validation_error';
  server_version: Record<string, unknown>;
  resolution: 'server_wins' | 'client_wins' | 'manual_required';
  explanation: string;
}

export interface ServerChange {
  entity_type: SyncEntityType;
  entity_id: string;
  data: Record<string, unknown>;
  updated_at: string;
}

export interface SyncResponse {
  accepted: string[];
  rejected: SyncConflict[];
  server_changes: ServerChange[];
  sync_timestamp: string;
}

export interface ServerState {
  version?: number;
  updated_at?: string;
  /** Provenance of the value currently stored. */
  source?: string;
  [key: string]: unknown;
}

export interface Resolution {
  winner: 'client' | 'server' | 'manual';
  reason: string;
  explanation: string;
}

/** Authority ranking. Higher wins. */
const AUTHORITY: Record<string, number> = {
  timer_hardware: 40,
  timer_bridge: 40,
  web_serial: 35,
  secretary: 30,
  judge: 20,
  import: 10,
  manual: 10,
};

function authorityOf(source: string | undefined): number {
  return AUTHORITY[source ?? 'manual'] ?? 0;
}

/**
 * Decide one conflict.
 *
 * The architecture's version of this compares `clientChange.data.source` in
 * rule 1 but `clientChange.source` in rule 2 — two different fields for the
 * same concept, so a hardware time submitted by a judge's tablet matches
 * neither and falls through to manual. Both are read here, and the comparison
 * is against the authority of what is ALREADY stored rather than against a
 * fixed list, so a manual correction never silently overwrites a hardware time
 * and a hardware time always overwrites a manual guess.
 */
export function resolveConflict(
  change: SyncChange,
  serverState: ServerState | null,
): Resolution {
  // Nothing on the server: the client's create stands.
  if (!serverState) {
    return {
      winner: 'client',
      reason: 'no_server_record',
      explanation: 'The server has no record of this entity yet.',
    };
  }

  // Contestant records are reconciled against PROCOM server-side (§4.4 rule 3).
  if (change.entity_type === 'entry') {
    return {
      winner: 'server',
      reason: 'server_contestant_authority',
      explanation:
        'Entry data is reconciled with PROCOM on the server, which is the ' +
        'source of truth for who is entered.',
    };
  }

  if (change.entity_type === 'score') {
    const clientSource =
      (change.data.source as string | undefined) ?? change.source;
    const clientAuthority = authorityOf(clientSource);
    const serverAuthority = authorityOf(serverState.source);

    if (clientAuthority > serverAuthority) {
      return {
        winner: 'client',
        reason: 'higher_authority_source',
        explanation:
          `A '${clientSource}' reading outranks the stored ` +
          `'${serverState.source}' value.`,
      };
    }

    if (clientAuthority < serverAuthority) {
      return {
        winner: 'server',
        reason: 'lower_authority_source',
        explanation:
          `The stored value came from '${serverState.source}', which ` +
          `outranks this '${clientSource}' submission.`,
      };
    }

    // Same authority. If the client was editing the version the server still
    // holds, the edit applies; otherwise two people of equal standing changed
    // the same run and a human has to look at it.
    if (
      change.base_version !== undefined &&
      serverState.version !== undefined &&
      change.base_version === serverState.version
    ) {
      return {
        winner: 'client',
        reason: 'clean_version_match',
        explanation: 'The client edited the current server version.',
      };
    }

    return {
      winner: 'manual',
      reason: 'equal_authority_conflict',
      explanation:
        `Two '${clientSource}' sources changed this run independently. ` +
        'A secretary must choose.',
    };
  }

  // Results are derived, never authored offline: recompute them server-side.
  if (change.entity_type === 'result') {
    return {
      winner: 'server',
      reason: 'derived_entity',
      explanation:
        'Results are recalculated from scores; an offline edit to a result ' +
        'is discarded and the standings are recomputed.',
    };
  }

  return {
    winner: 'manual',
    reason: 'no_clear_authority',
    explanation: 'No authority rule covers this change.',
  };
}

/** Turn a losing resolution into the conflict record the client receives. */
export function toConflict(
  change: SyncChange,
  resolution: Resolution,
  serverState: ServerState,
): SyncConflict {
  return {
    client_change_id: change.id,
    reason:
      resolution.reason === 'clean_version_match'
        ? 'version_conflict'
        : 'authority_override',
    server_version: serverState,
    resolution: resolution.winner === 'manual' ? 'manual_required' : 'server_wins',
    explanation: resolution.explanation,
  };
}
