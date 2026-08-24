/**
 * Reading the authorization audit trail.
 *
 * `PLATFORM_ADMIN`, and it has to be. The trail names people and the things they were
 * refused, so a project owner who could read it would learn which of their members had
 * been reaching for what — and a caller who could read *their own* refusals would have a
 * way to enumerate the boundary they had just been stopped at, one probe at a time. It
 * describes the platform's decisions, not any project's contents, which puts it beside
 * node inventory and quotas rather than beside jobs.
 */

import * as auditService from '../services/audit.js';
import { Permission } from '../domain/roles.js';

const denialSchema = {
  $id: 'AuthzDenial',
  type: 'object',
  required: ['id', 'occurred_at', 'principal', 'subject', 'permission', 'status'],
  properties: {
    id: { type: 'integer' },
    occurred_at: { type: 'string', format: 'date-time' },
    principal: { type: 'string', enum: ['USER', 'RUN', 'SERVING'] },
    subject: {
      type: 'string',
      description:
        'Who was refused, copied in at the time — an email, a run, a deployment. Still '
        + 'readable after the account it names has been deleted',
    },
    user_id: { type: ['string', 'null'], format: 'uuid' },
    job_id: { type: ['string', 'null'], format: 'uuid' },
    deployment_id: { type: ['string', 'null'], format: 'uuid' },
    permission: { type: 'string' },
    project_id: { type: ['string', 'null'], format: 'uuid' },
    project_name: { type: ['string', 'null'] },
    method: { type: 'string' },
    route: { type: 'string' },
    status: {
      type: 'integer',
      description:
        'What the caller was told. 404 rather than 403 where a truthful answer would '
        + 'have confirmed that the thing they asked about exists',
    },
    request_id: { type: ['string', 'null'], format: 'uuid' },
    remote_addr: { type: ['string', 'null'] },
  },
};

export async function registerAuditRoutes(app) {
  app.addSchema(denialSchema);

  app.get(
    '/api/v1/audit/denials',
    {
      config: { permission: Permission.PLATFORM_ADMIN },
      schema: {
        tags: ['audit'],
        summary: 'Requests that were refused, newest first',
        description:
          'Every refusal of a caller the platform could identify. Unauthenticated '
          + 'refusals are not here — they have no principal and no ceiling on their '
          + 'number, so they are counted in `ashml_auth_failures_total` instead.\n\n'
          + '`status` is what the caller was actually told, and it is allowed to '
          + 'disagree with the decision: a caller who asks about a project they are not '
          + 'a member of is answered 404 so that project names cannot be enumerated. '
          + 'The row records the refusal that really happened.',
        querystring: {
          type: 'object',
          properties: {
            user: { type: 'string', format: 'uuid', description: 'Only this account' },
            permission: { type: 'string', description: 'Only refusals of this permission' },
            since_hours: { type: 'integer', minimum: 1, maximum: 8760 },
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['denials'],
            properties: { denials: { type: 'array', items: { $ref: 'AuthzDenial#' } } },
          },
        },
      },
    },
    async (request) => {
      const { user, permission, since_hours: sinceHours, limit } = request.query;
      const denials = await auditService.listDenials(app.db, {
        userId: user ?? null,
        permission: permission ?? null,
        sinceHours: sinceHours ?? null,
        limit: limit ?? 50,
      });
      return { denials };
    },
  );

  app.get(
    '/api/v1/audit/summary',
    {
      config: { permission: Permission.PLATFORM_ADMIN },
      schema: {
        tags: ['audit'],
        summary: 'Who has been refused lately, and for what',
        description:
          'The question an audit log is usually opened to answer. One row per caller '
          + 'rather than one per refusal, because a single account with four hundred '
          + 'denials is the finding, and reading it off a list of four hundred rows is '
          + 'how it gets missed.',
        querystring: {
          type: 'object',
          properties: {
            since_hours: { type: 'integer', minimum: 1, maximum: 8760, default: 24 },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['callers'],
            properties: {
              callers: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    subject: { type: 'string' },
                    principal: { type: 'string' },
                    denials: { type: 'integer' },
                    last_seen: { type: 'string', format: 'date-time' },
                    permissions: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const callers = await auditService.summariseDenials(app.db, {
        sinceHours: request.query.since_hours ?? 24,
        limit: request.query.limit ?? 20,
      });
      return { callers };
    },
  );
}
