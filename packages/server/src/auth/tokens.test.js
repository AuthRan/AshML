import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { TokenKind, mintToken, hashToken, parseBearer, kindOf } from './tokens.js';

describe('minting', () => {
  test('a token carries its kind in the clear', () => {
    assert.ok(mintToken(TokenKind.USER).token.startsWith('ashml_u_'));
    assert.ok(mintToken(TokenKind.WORKLOAD).token.startsWith('ashml_w_'));
  });

  test('tokens do not repeat', () => {
    const seen = new Set();
    for (let i = 0; i < 500; i += 1) seen.add(mintToken(TokenKind.USER).token);
    assert.equal(seen.size, 500);
  });

  test('carries at least 256 bits of entropy past the prefix', () => {
    const { token } = mintToken(TokenKind.USER);
    const body = token.slice(TokenKind.USER.prefix.length);
    // 32 bytes in base64url is 43 characters, unpadded.
    assert.equal(body.length, 43);
    assert.match(body, /^[A-Za-z0-9_-]+$/, 'must be shell- and URL-safe');
  });

  test('the stored hash is not the token', () => {
    const { token, hash } = mintToken(TokenKind.USER);
    assert.notEqual(hash, token);
    assert.ok(!hash.includes(token));
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  test('the display prefix identifies without authenticating', () => {
    const { token, prefix } = mintToken(TokenKind.USER);
    assert.equal(prefix.length, 12);
    assert.ok(token.startsWith(prefix));
    // The point of the length: the secret part must not be recoverable from what is
    // shown in `ash token list`.
    assert.ok(prefix.length < token.length / 3);
  });
});

describe('hashing', () => {
  test('is deterministic, so a presented token finds its row', () => {
    const { token, hash } = mintToken(TokenKind.USER);
    assert.equal(hashToken(token), hash);
    assert.equal(hashToken(token), hashToken(token));
  });

  test('different tokens hash differently', () => {
    assert.notEqual(hashToken('ashml_u_a'), hashToken('ashml_u_b'));
  });

  test('is sensitive to every character', () => {
    // Guards against a truncating or normalising hash, where a prefix of a real token
    // would authenticate as the token.
    const { token } = mintToken(TokenKind.USER);
    assert.notEqual(hashToken(token.slice(0, -1)), hashToken(token));
    assert.notEqual(hashToken(`${token} `), hashToken(token));
    assert.notEqual(hashToken(token.toUpperCase()), hashToken(token));
  });
});

describe('parsing the Authorization header', () => {
  test('accepts a well-formed bearer header', () => {
    assert.equal(parseBearer('Bearer abc123'), 'abc123');
    assert.equal(parseBearer('bearer abc123'), 'abc123', 'the scheme is case-insensitive');
    assert.equal(parseBearer('BEARER abc123'), 'abc123');
    assert.equal(parseBearer('  Bearer   abc123  '), 'abc123', 'tolerates surrounding space');
    assert.equal(parseBearer('Bearer\tabc123'), 'abc123');
  });

  test('refuses anything that is not exactly one bearer token', () => {
    for (const header of [
      undefined, null, '', '   ',
      'abc123',                 // no scheme
      'Basic abc123',           // wrong scheme
      'Bearer',                 // no token
      'Bearer ',
      'Bearer a b',             // two values: ambiguous, so refused rather than guessed
      'Token abc123',
      42, {}, [],
    ]) {
      assert.equal(parseBearer(header), null, JSON.stringify(header));
    }
  });
});

describe('recognising a kind before touching the database', () => {
  test('reports the kind a token claims', () => {
    assert.equal(kindOf(mintToken(TokenKind.USER).token), TokenKind.USER);
    assert.equal(kindOf(mintToken(TokenKind.WORKLOAD).token), TokenKind.WORKLOAD);
  });

  test('claims nothing for a token with no known prefix', () => {
    assert.equal(kindOf('nonsense'), null);
    assert.equal(kindOf('ashml_x_abc'), null);
    assert.equal(kindOf(''), null);
    assert.equal(kindOf(null), null);
  });

  test('the two prefixes cannot be confused for one another', () => {
    // A workload token presented to a user endpoint must be refusable on sight.
    assert.notEqual(TokenKind.USER.prefix, TokenKind.WORKLOAD.prefix);
    assert.ok(!TokenKind.USER.prefix.startsWith(TokenKind.WORKLOAD.prefix));
    assert.ok(!TokenKind.WORKLOAD.prefix.startsWith(TokenKind.USER.prefix));
  });
});
