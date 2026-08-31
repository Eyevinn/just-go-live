/*
 * Just Go Live - Simple web app for quick live broadcasting
 *
 * Copyright (c) 2025 Eyevinn Technology AB
 * Licensed under the MIT License (see LICENSE file)
 */

// What a failed instance removal actually tells us.
//
// Only a 404 proves the instance is not there. A 500, a 429, a timeout, a DNS
// failure or an expired token all mean we could not find out, and "could not
// find out" must never be reported to the user as "removed": the instance is
// still running and still billing, and saying otherwise while deleting the
// local record leaves nothing that names it.
//
// The test is on the httpCode property and deliberately NOT
// `error instanceof FetchError`. @osaas/client-services resolves its own nested
// copy of @osaas/client-core, so the FetchError thrown out of a removal is a
// different class object from the FetchError this app would import from
// @osaas/client-core. instanceof is false across that boundary, so the 404
// branch would never be taken and every already-gone instance would be reported
// as an unknown failure.
//
// This is also why the removal is called unconditionally rather than after a
// getInstance precheck: getInstance swallows every error except 401 into a bare
// `return undefined`, so it cannot tell "gone" from "could not ask". removeInstance
// has no such catch and propagates the status code intact.
export function classifyRemovalError(error) {
  return error && error.httpCode === 404 ? 'already-gone' : 'unknown';
}
