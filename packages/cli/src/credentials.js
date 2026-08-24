/**
 * Where `ash` keeps its token, and how it finds one.
 *
 * `ash login` (spec §27) has no password to exchange — a token *is* the credential — so
 * logging in means storing one and proving it works. That leaves the interesting part
 * here: resolving which token a command should use, and not leaking it.
 *
 * Resolution order, highest first:
 *
 *   1. `--token` on the command line. Explicit beats everything.
 *   2. `ASHML_TOKEN` in the environment. This is what CI and the end-to-end scripts use.
 *   3. The stored credential for the endpoint being called.
 *
 * Stored credentials are keyed by endpoint, because a token is only meaningful to the
 * control plane that issued it. Keying by endpoint means `ash --endpoint staging ...`
 * cannot accidentally send a production token to a host that would then have seen it.
 */

import { readFile, writeFile, mkdir, chmod, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const CONFIG_PATH = process.env.ASHML_CONFIG
  ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'ashml', 'credentials.json');

/**
 * Endpoints are normalised before use as a key so that `http://host:8080` and
 * `http://host:8080/` are one entry rather than two, and a token stored under one form
 * is not invisible to a command that typed the other.
 */
function keyFor(endpoint) {
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.host}`;
  } catch {
    return endpoint;
  }
}

async function readStore() {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  } catch {
    // A missing or unparsable file means "not logged in", which is a state, not an
    // error. The commands that need a token say so themselves, with the endpoint in the
    // message; failing here would report a config problem for a plain missing login.
    return {};
  }
}

export async function storeToken(endpoint, token) {
  const store = await readStore();
  store[keyFor(endpoint)] = { token };

  await mkdir(dirname(CONFIG_PATH), { recursive: true });

  // Written to a temporary file and renamed over the target, rather than truncating the
  // target and filling it in. Truncate-then-write has a window in which the file is
  // empty, and a crash or a Ctrl-C inside it loses the token for *every* endpoint, not
  // just the one being set. `rename` within a directory is atomic: a reader sees either
  // the old file or the new one.
  //
  // Created 0600 rather than tightened afterwards, because the default umask would leave
  // a moment where a world-readable file holds a working credential.
  const temporary = `${CONFIG_PATH}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, CONFIG_PATH);

  return CONFIG_PATH;
}

export async function forgetToken(endpoint) {
  const store = await readStore();
  const key = keyFor(endpoint);
  if (!(key in store)) return false;
  delete store[key];
  const temporary = `${CONFIG_PATH}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, CONFIG_PATH);
  return true;
}

/** The token to use for `endpoint`, or null if there is none. */
export async function resolveToken(endpoint, { flag = null } = {}) {
  if (flag) return flag;
  if (process.env.ASHML_TOKEN) return process.env.ASHML_TOKEN;
  const store = await readStore();
  return store[keyFor(endpoint)]?.token ?? null;
}

export const credentialsPath = () => CONFIG_PATH;
