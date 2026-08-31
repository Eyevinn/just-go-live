/*
 * Just Go Live - Simple web app for quick live broadcasting
 *
 * Copyright (c) 2025 Eyevinn Technology AB
 * Licensed under the MIT License (see LICENSE file)
 */

// Guard for the billing path.
//
// The endpoint that removes an instance is the one that ends a charge. If it
// reports success when it does not know, the user is told the cost has stopped
// while the instance keeps running, and the record naming it has been deleted.
//
// So the rule under test is narrow: 404 and nothing else means "already gone".
//
// Plain assertions and no test runner, matching the other suites.

import assert from 'node:assert/strict';
import { classifyRemovalError } from '../lib/removal-outcome.js';

// Shaped like the FetchError thrown out of @osaas/client-core: an Error
// subclass carrying httpCode.
class FetchErrorLike extends Error {
  constructor(message, httpCode) {
    super(message);
    this.httpCode = httpCode;
  }
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('a 404 is the only thing that means already gone', () => {
  assert.equal(classifyRemovalError(new FetchErrorLike('Not Found', 404)), 'already-gone');
});

test('every other outcome is unknown, not gone', () => {
  // Each of these used to reach the same "already gone" branch through the
  // getInstance precheck this endpoint no longer uses.
  const notProof = [
    new FetchErrorLike('Internal Server Error', 500),
    new FetchErrorLike('Bad Gateway', 502),
    new FetchErrorLike('Service Unavailable', 503),
    new FetchErrorLike('Too Many Requests', 429),
    new FetchErrorLike('Unauthorized', 401),
    new FetchErrorLike('Forbidden', 403),
    new FetchErrorLike('socket hang up', undefined),
    new Error('getaddrinfo ENOTFOUND api.osaas.io'),
    new TypeError('fetch failed'),
    null,
    undefined
  ];
  for (const error of notProof) {
    assert.equal(
      classifyRemovalError(error),
      'unknown',
      `${error && error.message ? error.message : String(error)} was treated as proof the instance is gone`
    );
  }
});

test('a 404 from a different copy of the SDK is still a 404', () => {
  // The reason the check is on httpCode and not `instanceof FetchError`.
  // @osaas/client-services resolves its own nested @osaas/client-core, so the
  // error class it throws is not the class this app would import. An instanceof
  // test is false across that boundary, and every already-gone instance would
  // be misreported as an unknown failure.
  class FetchErrorFromAnotherRealm extends Error {
    constructor() {
      super('Not Found');
      this.httpCode = 404;
    }
  }
  const foreign = new FetchErrorFromAnotherRealm();
  assert.equal(foreign instanceof FetchErrorLike, false, 'fixture does not model the realm split');
  assert.equal(classifyRemovalError(foreign), 'already-gone');
});

test('a string httpCode is not mistaken for a 404', () => {
  assert.equal(classifyRemovalError(new FetchErrorLike('Not Found', '404')), 'unknown');
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok    ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL  ${name}`);
    console.error(`      ${error.message}`);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
