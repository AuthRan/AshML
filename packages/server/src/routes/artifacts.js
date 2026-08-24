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
import { Permission } from '../domain/roles.js';
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
    verified: {
      type: ['boolean', 'null'],
      description:
        'Whether AshML asked the store and found the bytes. false means it could not '
        + 'ask — no store configured, or a URI outside it — not that the check failed. '
        + 'null until the artifact is completed.',
    },
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
      config: { authorization: 'handler' },
      schema: {
        tags: ['artifacts'],
        summary: 'Register an artifact a run is about to write',
        description:
          'Returns a PENDING artifact and, unless the caller supplied its own `uri`, a '
          + 'presigned PUT to write the bytes with. Upload, then confirm with '
          + 'POST /api/v1/artifacts/{id}/complete. An artifact cannot be registered as '
          + 'READY: this API cannot see the bytes, so it will not claim they exist.',
        params: idParam,
        body: {
          type: 'object',
          required: ['kind', 'name'],
          additionalProperties: false,
          properties: {
            kind: { type: 'string', minLength: 1, maxLength: 50 },
            name: { type: 'string', minLength: 1, maxLength: 200 },
            uri: {
              type: 'string',
              minLength: 1,
              maxLength: 1000,
              description:
                'Only when the run has arranged its own storage. Omit it and AshML '
                + 'allocates a location and returns a presigned upload.',
            },
            step: { type: 'integer', minimum: 0 },
            metadata: { type: 'object', additionalProperties: true },
          },
        },
        response: {
          201: {
            type: 'object',
            required: ['artifact'],
            properties: {
              artifact: { $ref: 'Artifact#' },
              upload: {
                type: ['object', 'null'],
                description:
                  'How to write the bytes. Null when the caller supplied its own `uri`. '
                  + 'The URL is time-limited and is not stored — register again to get '
                  + 'a fresh one.',
                properties: {
                  method: { type: 'string' },
                  url: { type: 'string' },
                  expires_at: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
          400: { $ref: 'Error#' },
          404: { $ref: 'Error#' },
          409: { $ref: 'Error#' },
        },
      },
    },
    async (request, reply) => {
      // The run declaring what it produced. Same rule as metrics: a person may not
      // author a run's output record.
      await app.requireJob(request, request.params.id, Permission.RUN_REPORT);

      const body = request.body;
      const result = await artifactService.registerArtifact(
        app.db,
        app.artifactStore,
        request.params.id,
        {
          kind: body.kind,
          name: body.name,
          uri: body.uri ?? null,
          step: body.step ?? null,
          metadata: body.metadata ?? {},
        },
      );
      request.log.info(
        {
          artifact_id: result.artifact.id,
          job_id: request.params.id,
          kind: result.artifact.kind,
          presigned: result.upload !== null,
        },
        'artifact registered',
      );
      // The upload URL is deliberately absent from every other representation: it is a
      // credential, and it does not belong in a list anyone can read.
      return reply.status(201).send({ artifact: result.artifact, upload: result.upload });
    },
  );

  app.post(
    '/api/v1/artifacts/:id/complete',
    {
      config: { authorization: 'handler' },
      schema: {
        tags: ['artifacts'],
        summary: 'Confirm an artifact’s bytes have landed',
        description:
          'Moves PENDING to READY. AshML asks the store whether the object is actually '
          + 'there and how big it is: an upload that never landed is refused, and so is '
          + 'a size that disagrees with what is stored. Where the URI is outside the '
          + 'configured store the artifact still completes, marked `verified: false`.',
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
      // Confirming an upload is part of producing it, so it belongs to the run. The
      // artifact is addressed by its own id, and `requireArtifact` resolves that to the
      // job that produced it — which is what RUN_REPORT is then checked against, so one
      // run cannot confirm another's upload.
      await app.requireArtifact(request, request.params.id, Permission.RUN_REPORT);

      const artifact = await artifactService.completeArtifact(
        app.db,
        app.artifactStore,
        request.params.id,
        {
          digest: request.body.digest,
          sizeBytes: request.body.size_bytes,
          metadata: request.body.metadata ?? {},
        },
      );
      request.log.info(
        { artifact_id: artifact.id, size_bytes: artifact.size_bytes, verified: artifact.verified },
        'artifact ready',
      );
      return artifact;
    },
  );

  app.post(
    '/api/v1/artifacts/:id/fail',
    {
      config: { authorization: 'handler' },
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
    async (request) => {
      await app.requireArtifact(request, request.params.id, Permission.RUN_REPORT);
      return artifactService.failArtifact(app.db, request.params.id, {
        reason: request.body?.reason ?? 'upload abandoned',
      });
    },
  );

  app.get(
    '/api/v1/artifacts/:id/download',
    {
      config: { authorization: 'handler' },
      schema: {
        tags: ['artifacts'],
        summary: 'Get a time-limited URL to read an artifact',
        description:
          'The bytes are served by object storage, not by this API. Only READY '
          + 'artifacts can be signed for: a link to a PENDING one would resolve to '
          + 'nothing, or worse, to a partial checkpoint that loads.',
        params: idParam,
        response: {
          200: {
            type: 'object',
            required: ['url', 'expires_at'],
            properties: {
              artifact_id: { type: 'string', format: 'uuid' },
              uri: { type: 'string' },
              url: { type: 'string' },
              expires_at: { type: 'string', format: 'date-time' },
            },
          },
          400: { $ref: 'Error#' },
          404: { $ref: 'Error#' },
          409: { $ref: 'Error#' },
        },
      },
    },
    async (request) => {
      // The one permission three unrelated principals hold: a person browsing, a
      // training pod resuming from a checkpoint, and a model server fetching its own
      // weights (domain/roles.js).
      await app.requireArtifact(request, request.params.id, Permission.ARTIFACT_FETCH);
      return artifactService.presignDownload(app.db, app.artifactStore, request.params.id);
    },
  );

  app.get(
    '/api/v1/artifacts/:id',
    {
      config: { authorization: 'handler' },
      schema: {
        tags: ['artifacts'],
        summary: 'Get an artifact',
        params: idParam,
        response: { 200: { $ref: 'Artifact#' }, 404: { $ref: 'Error#' } },
      },
    },
    async (request) => {
      await app.requireArtifact(request, request.params.id, Permission.ARTIFACT_FETCH);
      return artifactService.getArtifact(app.db, request.params.id);
    },
  );

  app.get(
    '/api/v1/jobs/:id/artifacts',
    {
      config: { authorization: 'handler' },
      schema: {
        tags: ['artifacts'],
        summary: 'List what a job produced',
        params: idParam,
        querystring: listFilters,
        response: { 200: listResponse, 404: { $ref: 'Error#' } },
      },
    },
    async (request) => {
      await app.requireJob(request, request.params.id, Permission.PROJECT_READ);
      return {
        artifacts: await artifactService.listJobArtifacts(app.db, request.params.id, {
          kind: request.query.kind ?? null,
          status: request.query.status ?? null,
        }),
      };
    },
  );

  app.get(
    '/api/v1/experiments/:id/artifacts',
    {
      config: { authorization: 'handler' },
      schema: {
        tags: ['artifacts'],
        summary: 'List what every run of an experiment produced',
        params: idParam,
        querystring: listFilters,
        response: { 200: listResponse, 404: { $ref: 'Error#' } },
      },
    },
    async (request) => {
      await app.requireExperiment(request, request.params.id, Permission.PROJECT_READ);
      return {
        artifacts: await artifactService.listExperimentArtifacts(app.db, request.params.id, {
          kind: request.query.kind ?? null,
          status: request.query.status ?? null,
        }),
      };
    },
  );
}
