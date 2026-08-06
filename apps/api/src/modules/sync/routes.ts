/**
 * Offline sync endpoint.
 *
 * Architecture ref: §4.4.
 */

import type { FastifyPluginAsync } from 'fastify';

import { requirePermission } from '../../core/auth.ts';
import {
  resolveConflict,
  toConflict,
  type ServerState,
  type SyncChange,
  type SyncConflict,
  type SyncRequest,
  type SyncResponse,
} from '../../core/sync.ts';

export const registerSyncModule: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: { org_id: string }; Body: SyncRequest }>(
    '/sync',
    {
      schema: {
        body: {
          type: 'object',
          required: ['client_id', 'last_sync_at', 'changes'],
          additionalProperties: false,
          properties: {
            client_id: { type: 'string', minLength: 8, maxLength: 128 },
            last_sync_at: { type: 'string', format: 'date-time' },
            changes: {
              type: 'array',
              // A device that has been offline all weekend still has to be
              // able to drain its queue, but not in one unbounded request.
              maxItems: 500,
              items: {
                type: 'object',
                required: ['id', 'entity_type', 'action', 'data', 'timestamp', 'source'],
                additionalProperties: false,
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  entity_type: { type: 'string', enum: ['score', 'entry', 'result'] },
                  action: { type: 'string', enum: ['create', 'update', 'delete'] },
                  data: { type: 'object' },
                  timestamp: { type: 'string', format: 'date-time' },
                  source: { type: 'string', enum: ['secretary', 'judge', 'timer'] },
                  base_version: { type: 'integer', minimum: 0 },
                },
              },
            },
          },
        },
      },
      preHandler: requirePermission('score.submit'),
    },
    async (request, reply) => {
      const { org_id } = request.params;
      const { changes, last_sync_at } = request.body;

      const accepted: string[] = [];
      const rejected: SyncConflict[] = [];

      // Ordered by the client's own clock so that a device's own edits apply
      // in the order they were made. Ordering ACROSS devices is decided by
      // authority, not by timestamp.
      const ordered = [...changes].sort((a, b) =>
        a.timestamp.localeCompare(b.timestamp),
      );

      for (const change of ordered) {
        const serverState = await loadServerState(fastify, org_id, change);
        const resolution = resolveConflict(change, serverState);

        if (resolution.winner === 'client') {
          await applyChange(fastify, org_id, change, request.auth!.user.user_id);
          accepted.push(change.id);
        } else {
          rejected.push(
            toConflict(change, resolution, serverState ?? ({} as ServerState)),
          );
        }
      }

      const server_changes = await changesSince(fastify, org_id, last_sync_at);

      const response: SyncResponse = {
        accepted,
        rejected,
        server_changes,
        sync_timestamp: new Date().toISOString(),
      };

      return reply.send({
        data: response,
        meta: { request_id: request.id },
      });
    },
  );
};

// ---------------------------------------------------------------------------
// Storage seam
// ---------------------------------------------------------------------------

async function loadServerState(
  _fastify: unknown,
  _orgId: string,
  _change: SyncChange,
): Promise<ServerState | null> {
  throw new Error('not implemented: wire to core/database');
}

async function applyChange(
  _fastify: unknown,
  _orgId: string,
  _change: SyncChange,
  _actorId: string,
): Promise<void> {
  throw new Error('not implemented: wire to core/database');
}

async function changesSince(
  _fastify: unknown,
  _orgId: string,
  _since: string,
): Promise<SyncResponse['server_changes']> {
  throw new Error('not implemented: wire to core/database');
}
