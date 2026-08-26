'use strict';

// Canonical client-trust normalizer - single source of truth for server and browser.
// Server-side: require('../shared/client-trust') (re-exported from server/core/request-trust)
// Browser-side: shared/client-trust.esm.mjs, served as ESM via GET /shared/client-trust.mjs
//
// The twins are deliberately ASYMMETRIC. The server only ever needs to LABEL a connection, so this
// side stops at the normalizer; deciding which server-machine actions to offer is presentation the
// browser alone performs, and lives only in the ESM twin. Keep normalizeClientTrust itself identical
// in both.

// 'local' is the machine Glissa runs on, 'remote' a paired device reaching the second listener.
// Anything else, including a connection remote mode never stamped (remote mode off) or a server too
// old to send the label at all, is local by definition.
function normalizeClientTrust(trust) {
  return trust === 'remote' ? 'remote' : 'local';
}

module.exports = { normalizeClientTrust };
