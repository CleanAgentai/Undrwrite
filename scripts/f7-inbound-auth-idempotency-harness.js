#!/usr/bin/env node
// F7 — Basic auth on POST /webhook/inbound (when INBOUND_WEBHOOK_AUTH is set) and durable
// inbound dedup (inbound Message-IDs stored and checked in the database).
process.env.INBOUND_WEBHOOK_AUTH = 'vienna:test-secret';
const fs = require('fs');
const { requireInboundAuth } = require('../src/routes/webhook').__test__;
let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };
const run = (authHeader) => {
  let status = 200, nextCalled = false;
  const res = { status: (c) => { status = c; return { json: () => {} }; } };
  requireInboundAuth({ headers: authHeader ? { authorization: authHeader } : {} }, res, () => { nextCalled = true; });
  return { status, nextCalled };
};
const b64 = (s) => 'Basic ' + Buffer.from(s).toString('base64');
ok('correct credentials pass', run(b64('vienna:test-secret')).nextCalled);
ok('wrong password → 401', run(b64('vienna:nope')).status === 401);
ok('missing header → 401', run(null).status === 401);
ok('non-Basic scheme → 401', run('Bearer vienna:test-secret').status === 401);

const wh = fs.readFileSync('src/routes/webhook.js', 'utf8');
const deals = fs.readFileSync('src/services/deals.js', 'utf8');
ok('every inbound save stores the provider Message-ID', (wh.match(/saveMessage\([^)]*'inbound', email\.subject, email\.textBody, email\.messageId\)/g) || []).length === 5 && !/'inbound', email\.subject, email\.textBody\);/.test(wh));
ok('handler checks the database before processing', /await dealsService\.inboundAlreadyProcessed\(email\.messageId\)/.test(wh));
ok('dedup lookup is inbound-only (never collides with outbound thread ids)', /inboundAlreadyProcessed[\s\S]{0,300}\.eq\('direction', 'inbound'\)/.test(deals));
ok('route is wrapped by the auth check', /router\.post\('\/inbound', requireInboundAuth, handleInbound\)/.test(wh));

console.log(`\n[f7-inbound-auth-idempotency] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
