/**
 * Identity, tokens, and project membership.
 *
 * `ash login` (spec §27) is a client-side act, not an endpoint: there is no password to
 * exchange, because a token *is* the credential. What the CLI actually does is store a
 * token and call `/whoami` to prove it works, which is why that endpoint exists and is
 * the only thing here that any authenticated caller may reach.
 */

import * as authService from '../services/auth.js';
import { Permission, Role, PrincipalKind } from '../domain/roles.js';
import { ForbiddenError } from '../services/auth.js';

const tokenSchema = {
  $id: 'ApiToken',
  type: 'object',
  required: ['id', 'name', 'prefix', 'created_at'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    // The visible fragment of the token, so a row can be identified. Not a credential.
    prefix: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
    last_used_at: { type: ['string', 'null'], format: 'date-time' },
    expires_at: { type: ['string', 'null'], format: 'date-time' },
  },
};

const memberSchema = {
  $id: 'ProjectMember',
  type: 'object',
  required: ['email', 'role'],
  properties: {
    user_id: { type: 'string', format: 'uuid' },
    email: { type: 'string' },
    display_name: { type: 'string' },
    role: { type: 'string', enum: Object.keys(Role) },
    created_at: { type: 'string', format: 'date-time' },
  },
};

/** Token management belongs to people. A pod's credential may not touch it. */
function requireHuman(request) {
  if (request.principal.kind !== PrincipalKind.USER) {
    throw new ForbiddenError('a workload token may not manage API tokens');
  }
}

export async function registerAuthRoutes(app) {
  app.addSchema(tokenSchema);
  app.addSchema(memberSchema);

  app.get(
    '/api/v1/auth/whoami',
    {
      config: { authenticatedOnly: true },
      schema: {
        tags: ['auth'],
        summary: 'Who this token belongs to, and what it can reach',
        response: {
          200: {
            type: 'object',
            required: ['kind'],
            properties: {
              kind: { type: 'string', enum: ['USER', 'RUN', 'SERVING'] },
              user_id: { type: 'string' },
              email: { type: 'string' },
              is_admin: { type: 'boolean' },
              projects: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    project_id: { type: 'string' },
                    role: { type: 'string' },
                  },
                },
              },
              // Present for a run token, which belongs to a job rather than a person.
              job_id: { type: 'string' },
              attempt: { type: 'integer' },
              deployment_id: { type: 'string' },
            },
          },
          401: { $ref: 'Error#' },
        },
      },
    },
    async (request) => {
      const p = request.principal;
      if (p.kind === PrincipalKind.RUN) {
        return { kind: p.kind, job_id: p.jobId, attempt: p.attempt };
      }
      if (p.kind === PrincipalKind.SERVING) {
        return { kind: p.kind, deployment_id: p.deploymentId };
      }
      return {
        kind: p.kind,
        user_id: p.userId,
        email: p.email,
        is_admin: p.isAdmin,
        projects: [...p.memberships].map(([project_id, role]) => ({ project_id, role })),
      };
    },
  );

  app.post(
    '/api/v1/auth/tokens',
    {
      config: { authorization: 'handler' },
      schema: {
        tags: ['auth'],
        summary: 'Create an API token',
        description:
          'The plaintext token is returned once, in this response, and is never '
          + 'retrievable again — only its SHA-256 hash is stored.',
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 100 },
            expires_in_days: { type: 'integer', minimum: 1, maximum: 3650 },
          },
        },
        response: {
          201: {
            type: 'object',
            required: ['token', 'name', 'prefix'],
            properties: {
              token: { type: 'string', description: 'Shown once. Store it now.' },
              id: { type: 'string' },
              name: { type: 'string' },
              prefix: { type: 'string' },
              created_at: { type: 'string' },
              expires_at: { type: ['string', 'null'] },
            },
          },
          401: { $ref: 'Error#' },
          403: { $ref: 'Error#' },
          409: { $ref: 'Error#' },
        },
      },
    },
    async (request, reply) => {
      // A workload token must not be able to mint a user token: that would turn a
      // credential scoped to one pod into a durable credential scoped to a person.
      requireHuman(request);

      const { name, expires_in_days: days } = request.body;
      const expiresAt = days ? new Date(Date.now() + days * 86_400_000) : null;

      const token = await authService.createToken(app.db, request.principal.userId, {
        name, expiresAt,
      });
      request.log.info({ token_name: name, prefix: token.prefix }, 'api token created');
      return reply.status(201).send(token);
    },
  );

  app.get(
    '/api/v1/auth/tokens',
    {
      config: { authorization: 'handler' },
      schema: {
        tags: ['auth'],
        summary: 'List your live API tokens',
        response: {
          200: {
            type: 'object',
            required: ['tokens'],
            properties: { tokens: { type: 'array', items: { $ref: 'ApiToken#' } } },
          },
          401: { $ref: 'Error#' },
        },
      },
    },
    async (request) => {
      requireHuman(request);
      return { tokens: await authService.listTokens(app.db, request.principal.userId) };
    },
  );

  app.delete(
    '/api/v1/auth/tokens/:token',
    {
      config: { authorization: 'handler' },
      schema: {
        tags: ['auth'],
        summary: 'Revoke one of your API tokens',
        params: {
          type: 'object',
          required: ['token'],
          properties: { token: { type: 'string', description: 'The token\'s name' } },
        },
        response: {
          204: { type: 'null' },
          401: { $ref: 'Error#' },
          404: { $ref: 'Error#' },
        },
      },
    },
    async (request, reply) => {
      requireHuman(request);
      await authService.revokeToken(app.db, request.principal.userId, request.params.token);
      request.log.info({ token_name: request.params.token }, 'api token revoked');
      return reply.status(204).send();
    },
  );

  // ---- users ---------------------------------------------------------------------

  app.post(
    '/api/v1/users',
    {
      config: { permission: Permission.PLATFORM_ADMIN },
      schema: {
        tags: ['auth'],
        summary: 'Create a user (platform administrators only)',
        body: {
          type: 'object',
          required: ['email', 'display_name'],
          additionalProperties: false,
          properties: {
            email: { type: 'string', minLength: 3, maxLength: 320 },
            display_name: { type: 'string', minLength: 1, maxLength: 200 },
            is_admin: { type: 'boolean', default: false },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              email: { type: 'string' },
              display_name: { type: 'string' },
              is_admin: { type: 'boolean' },
            },
          },
          403: { $ref: 'Error#' },
          409: { $ref: 'Error#' },
        },
      },
    },
    async (request, reply) => {
      const user = await authService.createUser(app.db, {
        email: request.body.email,
        displayName: request.body.display_name,
        isAdmin: request.body.is_admin ?? false,
      });
      return reply.status(201).send(user);
    },
  );

  // ---- membership ----------------------------------------------------------------

  app.get(
    '/api/v1/projects/:name/members',
    {
      config: { permission: Permission.PROJECT_READ },
      schema: {
        tags: ['auth'],
        summary: 'Who can reach this project',
        params: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
        response: {
          200: {
            type: 'object',
            required: ['members'],
            properties: { members: { type: 'array', items: { $ref: 'ProjectMember#' } } },
          },
          404: { $ref: 'Error#' },
        },
      },
    },
    async (request) => {
      const project = await app.readableProject(request, request.params.name);
      return { members: await authService.listMembers(app.db, project.id) };
    },
  );

  app.put(
    '/api/v1/projects/:name/members/:email',
    {
      config: { permission: Permission.PROJECT_ADMIN },
      schema: {
        tags: ['auth'],
        summary: 'Add a member, or change their role',
        params: {
          type: 'object',
          required: ['name', 'email'],
          properties: { name: { type: 'string' }, email: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['role'],
          additionalProperties: false,
          properties: { role: { type: 'string', enum: Object.keys(Role) } },
        },
        response: {
          200: { $ref: 'ProjectMember#' },
          403: { $ref: 'Error#' },
          404: { $ref: 'Error#' },
          409: { $ref: 'Error#' },
        },
      },
    },
    async (request) => {
      const project = await app.requireProject(
        request, request.params.name, Permission.PROJECT_ADMIN,
      );
      const member = await authService.setMember(
        app.db, project.id, request.params.email, request.body.role,
      );
      request.log.info(
        { project: project.name, member: request.params.email, role: request.body.role },
        'project membership changed',
      );
      return member;
    },
  );

  app.delete(
    '/api/v1/projects/:name/members/:email',
    {
      config: { permission: Permission.PROJECT_ADMIN },
      schema: {
        tags: ['auth'],
        summary: 'Remove a member',
        params: {
          type: 'object',
          required: ['name', 'email'],
          properties: { name: { type: 'string' }, email: { type: 'string' } },
        },
        response: {
          204: { type: 'null' },
          403: { $ref: 'Error#' },
          404: { $ref: 'Error#' },
          409: { $ref: 'Error#' },
        },
      },
    },
    async (request, reply) => {
      const project = await app.requireProject(
        request, request.params.name, Permission.PROJECT_ADMIN,
      );
      await authService.removeMember(app.db, project.id, request.params.email);
      request.log.info(
        { project: project.name, member: request.params.email }, 'project member removed',
      );
      return reply.status(204).send();
    },
  );
}
