/**
 * What the CLI actually does with the arguments it is given.
 *
 * These run the real binary in a subprocess rather than importing anything, because the
 * defect they exist for lived entirely in argument parsing — before any code this repo
 * wrote was reached. `ash deployment rollout <name> --version 2 --traffic 10` matched
 * *commander's* `--version` on the program, printed the client version, and exited 0.
 * The rollout never happened and the shell saw success.
 *
 * Three subcommands take a `--version`, and it is the spec's §21 command, so that one
 * collision took out every version-shifting operation the CLI has. Nothing caught it:
 * the service layer underneath is thoroughly tested and was never called.
 *
 * The endpoint is a closed port on purpose. What is under test is whether the command
 * got as far as making a request with the arguments it was given, and "cannot reach
 * AshML" proves that far better than a success would — it needs no server, and it can
 * only be printed by code that parsed the options and ran the action.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL('./index.js', import.meta.url));

/** Nothing listens on port 1, anywhere. */
const DEAD = 'http://127.0.0.1:1';

async function ash(...args) {
  try {
    const { stdout, stderr } = await exec('node', [CLI, ...args], {
      env: { ...process.env, ASHML_ENDPOINT: DEAD, ASHML_PROJECT: 'vision' },
    });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    return { code: err.code ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

describe('the CLI parses the arguments it documents', () => {
  for (const [command, args] of [
    ['rollout', ['deployment', 'rollout', 'demo', '--version', '2', '--traffic', '10']],
    ['promote', ['deployment', 'promote', 'demo', '--version', '2']],
    ['retire', ['deployment', 'retire', 'demo', '--version', '2']],
  ]) {
    test(`\`ash deployment ${command} --version\` reaches the API, not the version flag`, async () => {
      const { code, out } = await ash(...args);

      assert.ok(
        !/^0\.\d+\.\d+\s*$/.test(out),
        `printed the client version and stopped: the program's --version ate the `
        + `subcommand's, so this command silently did nothing (output: ${JSON.stringify(out)})`,
      );
      assert.match(
        out, /cannot reach AshML/,
        'the command should have tried to talk to the API with the options it was given',
      );
      assert.notEqual(code, 0, 'a command that could not do what was asked must not exit 0');
    });
  }

  test('the argument order does not change what a command means', async () => {
    // The collision was order-independent, and so is the fix; asserting it keeps a
    // future fix that only works one way from looking correct.
    const { out } = await ash('deployment', 'rollout', 'demo', '--traffic', '10', '--version', '2');
    assert.match(out, /cannot reach AshML/);
  });

  test('`ash --version` still answers, before any subcommand', async () => {
    const { code, out } = await ash('--version');
    assert.equal(code, 0);
    assert.match(out, /^\d+\.\d+\.\d+/, 'the program keeps its own --version');
  });

  test('`ash job submit --project` is accepted, and overrides the manifest', async () => {
    // The override the §50 journey needs: an example manifest names `project: vision`,
    // and the same file has to be submittable into a throwaway project. Reaching the API
    // is all this can check from here — that the option parsed and the action ran; that
    // it actually *lands* in the named project is asserted by `make journey`, whose
    // step 2 fails with EXPERIMENT_PROJECT_MISMATCH if the manifest wins.
    const { code, out } = await ash(
      'job', 'submit', 'examples/training/sdk-smoke.yaml', '--project', 'somewhere-else',
    );
    assert.match(out, /cannot reach AshML/, `unexpected output: ${JSON.stringify(out)}`);
    assert.notEqual(code, 0);
  });

  test('a missing required option is refused rather than defaulted', async () => {
    // `--traffic` decides how much live traffic moves. Guessing a value for it is the
    // one thing worse than refusing.
    const { code, out } = await ash('deployment', 'rollout', 'demo', '--version', '2');
    assert.notEqual(code, 0);
    assert.match(out, /--traffic/);
  });
});
