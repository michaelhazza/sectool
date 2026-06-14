#!/usr/bin/env node
// GIT_ASKPASS helper — echoes the token from the scoped spawn env.
// Git invokes this script for each credential prompt.
// The token lives ONLY in the spawn env of the authenticated git call
// (never on process.env of the server process).
'use strict';
process.stdout.write((process.env['AUDIT_GIT_ASKPASS_TOKEN'] ?? '') + '\n');
