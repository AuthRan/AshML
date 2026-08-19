/**
 * SQL for experiments.
 *
 * An experiment is the reproducibility record of a training run: the code (git commit),
 * the image (digest, not a mutable tag), the data (a dataset *version* id, which is
 * immutable), the hyperparameters, and the seed. Together those are what spec §34 asks
 * for — enough to rerun the thing and get the same answer.
 *
 * Names are not unique per project: re-running the same experiment is normal, and each
 * run deserves its own record rather than overwriting the last one. Experiments are
 * therefore addressed by id.
 */

function iso(value) {
  return value ? value.toISOString() : null;
}

const EXPERIMENT_COLUMNS = `
  e.id, e.name, e.git_commit, e.image_digest, e.hyperparameters, e.random_seed,
  e.started_at, e.ended_at, e.created_at,
  p.name  AS project_name,
  d.name  AS dataset_name,
  v.version AS dataset_version,
  v.id    AS dataset_version_id,
  (SELECT COUNT(*)::int FROM training_jobs j WHERE j.experiment_id = e.id) AS job_count
`;

const EXPERIMENT_FROM = `
  FROM experiments e
  JOIN projects p ON p.id = e.project_id
  LEFT JOIN dataset_versions v ON v.id = e.dataset_version_id
  LEFT JOIN datasets d ON d.id = v.dataset_id
`;

function toExperiment(row) {
  return {
    id: row.id,
    name: row.name,
    project: row.project_name,
    reproducibility: {
      git_commit: row.git_commit || null,
      image_digest: row.image_digest || null,
      dataset: row.dataset_version_id
        ? { name: row.dataset_name, version: row.dataset_version, version_id: row.dataset_version_id }
        : null,
      hyperparameters: row.hyperparameters,
      random_seed: row.random_seed,
    },
    job_count: row.job_count,
    started_at: iso(row.started_at),
    ended_at: iso(row.ended_at),
    created_at: iso(row.created_at),
  };
}

export async function insertExperiment(client, experiment) {
  const { rows } = await client.query(
    `INSERT INTO experiments
       (project_id, name, git_commit, image_digest, dataset_version_id,
        hyperparameters, random_seed)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      experiment.projectId,
      experiment.name,
      experiment.gitCommit,
      experiment.imageDigest,
      experiment.datasetVersionId,
      JSON.stringify(experiment.hyperparameters),
      experiment.randomSeed,
    ],
  );
  return rows[0].id;
}

export async function getExperimentById(client, id) {
  const { rows } = await client.query(
    `SELECT ${EXPERIMENT_COLUMNS} ${EXPERIMENT_FROM} WHERE e.id = $1`,
    [id],
  );
  return rows.length ? toExperiment(rows[0]) : null;
}

export async function listExperiments(client, { projectName = null, limit = 50 } = {}) {
  const { rows } = await client.query(
    `SELECT ${EXPERIMENT_COLUMNS} ${EXPERIMENT_FROM}
     WHERE ($1::text IS NULL OR p.name = $1)
     ORDER BY e.created_at DESC
     LIMIT $2`,
    [projectName, limit],
  );
  return rows.map(toExperiment);
}
