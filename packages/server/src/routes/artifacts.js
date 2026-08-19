/**
 * Artifact registration and lifecycle.
 *
 * Two calls, not one: register before writing, confirm after (see
 * `services/artifacts.js`). The confirm endpoints are separate verbs rather than a
 * PATCH of `status`, because "the bytes landed and here is their digest" and "the
 * upload was abandoned" are different events, and a generic status write would let a
 * caller move an artifact to READY without saying what it hashed to.
 */

import * as artifactService from '../services/artifacts.js';
import { ALL_STATUSES } from '../domain/artifact-status.js';

const artifactSchema = {
  $id: 'Artifact',
  type: 'object',
  required: ['id', 'kind', 'name', 'uri', 'status', 'created_at'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    kind: {
      type: 'string',
      description: 'What this is — `checkpoint`, `model`, or whatever the run calls it',
    },
    name: { type: 'string' },
    uri: { type: 'string', description: 'Where the bytes are; object storage, not this API' },
    status: {
      type: 'string',
      enum: ALL_STATUSES,
      description:
        'PENDING until the upload is confirmed. Only READY means the bytes exist — '
        + 'nothing may resume from or serve an artifact in any other status.',
    },
    digest: { type: ['string', 'null'], description: 'Computed by the run as it wrote' },
    size_bytes: { type: 'integer' },
    step: { type: ['integer', 'null'], description: 'Training step, for a checkpoint' },
    metadata: { type: 'object', additionalProperties: true },
    job: {
      type: ['object', 'null'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
      },
    },
    project: { type: ['string', 'null'] },
    experiment_id: { type: ['string', 'null'], format: 'uuid' },
    created_at: { type: 'string', format: 'date-time' },
  },
};

const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
};

const listFilters = {
  type: 'object',
  properties: {
    kind: { type: 'string' },
    status: { type: 'string', enum: ALL_STATUSES },
  },
};

const listResponse = {
  type: 'object',
  required: ['artifacts'],
  properties: { artifacts: { type: 'array', items: { $ref: 'Artifact#' } } },
};

export async function registerArtifactRoutes(app) {
  app.addSchema(artifactSchema);

  app.post(
    '/api/v1/jobs/:id/artifacts',
    {
      schema: {
        tags: ['artifacts'],
        summary: 'Register an artifact a run is about to write',
        description:
          'Returns a PENDING artifact. Upload the bytes to `uri`, then confirm with '
          + 'POST /api/v1/artifacts/{id}/complete. An artifact cannot be registered as '
          + 'READY: this API cannot see the bytes, so it will not claim they exist.',
        params: idParam,
        body: {
          type: 'object',
          required: ['kind', 'name', 'uri'],
          additionalProperties: false,
          properties: {
            kind: { type: 'string', minLength: 1, maxLength: 50 },
            name: { type: 'string', minLength: 1, maxLength: 200 },
            uri: { type: 'string', minLength: 1, maxLength: 1000 },
            step: { type: 'integer', minimum: 0 },
            metadata: { type: 'object', additionalProperties: true },
          },
        },
        response: {
          201: { $ref: 'Artifact#' },
          400: { $ref: 'Error#' },
          404: { $ref: 'Error#' },
          409: { $ref: 'Error#' },
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const artifact = await artifactService.registerArtifact(app.db, request.params.id, {
        kind: body.kind,
        name: body.name,
        uri: body.uri,
        step: body.step ?? null,
        metadata: body.metadata ?? {},
      });
      request.log.info(
        { artifact_id: artifact.id, job_id: request.params.id, kind: artifact.kind },
        'artifact registered',
      );
      return reply.status(201).send(artifact);
    },
  );

  app.post(
    '/api/v1/artifacts/:id/complete',
    {
      schema: {
        tags: ['artifacts'],
        summary: 'Confirm an artifact’s bytes have landed',
        description:
          'Moves PENDING to READY. The digest is required: it is the whole of what '
          + 'makes a stored checkpoint trustworthy later.',
        params: idParam,
        body: {
          type: 'object',
          required: ['digest', 'size_bytes'],
          additionalProperties: false,
          properties: {
            digest: { type: 'string', minLength: 1, maxLength: 200 },
            size_bytes: { type: 'integer', minimum: 0 },
            metadata: {
              type: 'object',
              additionalProperties: true,
              description: 'Merged into what registration recorded, not replacing it',
            },
          },
        },
        response: {
          200: { $ref: 'Artifact#' },
          400: { $ref: 'Error#' },
          404: { $ref: 'Error#' },
          409: { $ref: 'Error#' },
        },
      },
    },
    async (request) => {
      const artifact = await artifactService.completeArtifact(app.db, request.params.id, {
        digest: request.body.digest,
        sizeBytes: request.body.size_bytes,
        metadata: request.body.metadata ?? {},
      });
      request.log.info(
        { artifact_id: artifact.id, size_bytes: artifact.size_bytes },
        'artifact ready',
      );
      return artifact;
    },
  );

  app.post(
    '/api/v1/artifacts/:id/fail',
    {
      schema: {
        tags: ['artifacts'],
        summary: 'Record that an artifact’s upload was abandoned',
        description:
          'Moves PENDING to FAILED. The row is kept, so a checkpoint the run meant to '
          + 'write and did not stays visible rather than looking like it was never tried.',
        params: idParam,
        body: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: { reason: { type: 'string', maxLength: 500 } },
        },
        response: {
          200: { $ref: 'Artifact#' },
          404: { $ref: 'Error#' },
          409: { $ref: 'Error#' },
        },
      },
    },
    async (request) => artifactService.failArtifact(app.db, request.params.id, {
      reason: request.body?.reason ?? 'upload abandoned',
    }),
  );

  app.get(
    '/api/v1/artifacts/:id',
    {
      schema: {
        tags: ['artifacts'],
        summary: 'Get an artifact',
        params: idParam,
        response: { 200: { $ref: 'Artifact#' }, 404: { $ref: 'Error#' } },
      },
    },
    async (request) => artifactService.getArtifact(app.db, request.params.id),
  );

  app.get(
    '/api/v1/jobs/:id/artifacts',
    {
      schema: {
        tags: ['artifacts'],
        summary: 'List what a job produced',
        params: idParam,
        querystring: listFilters,
        response: { 200: listResponse, 404: { $ref: 'Error#' } },
      },
    },
    async (request) => ({
      artifacts: await artifactService.listJobArtifacts(app.db, request.params.id, {
        kind: request.query.kind ?? null,
        status: request.query.status ?? null,
      }),
    }),
  );

  app.get(
    '/api/v1/experiments/:id/artifacts',
    {
      schema: {
        tags: ['artifacts'],
        summary: 'List what every run of an experiment produced',
        params: idParam,
        querystring: listFilters,
        response: { 200: listResponse, 404: { $ref: 'Error#' } },
      },
    },
    async (request) => ({
      artifacts: await artifactService.listExperimentArtifacts(app.db, request.params.id, {
        kind: request.query.kind ?? null,
        status: request.query.status ?? null,
      }),
    }),
  );
}
