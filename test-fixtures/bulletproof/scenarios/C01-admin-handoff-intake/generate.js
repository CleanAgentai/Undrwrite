#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { singleTurnIntake } = require('../../lib/conversationSynth');
const { BORROWERS, ADDRESSES } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const SCENARIO_ID = 'C01';

(async () => {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const borrower = BORROWERS.marcus_webb;
  const property = ADDRESSES.edmonton_tory;

  // Admin-direction message — Franco (acting as admin on the lender side)
  // forwards a deal or replies to Vienna with admin-facing subject pattern.
  const adminMessage = buildPostmarkPayload({
    from: 'admin@privatemortgagelink.com', fromName: 'Admin',
    subject: `Draft Email Preview — ${borrower.fullName}`,
    textBody: `Vienna,\n\nThe draft for ${borrower.fullName} looks good. Send as-is once the broker confirms NOA. Property at ${property.full}.\n\nAdmin`,
    messageId: `${SCENARIO_ID}-admin-msg@bulletproof.synthetic`,
    date: '2026-05-15T09:30:00.000Z',
  });

  fs.writeFileSync(path.join(FIXTURE_DIR, 'events.json'), JSON.stringify(singleTurnIntake(adminMessage), null, 2));
  console.log(`[${SCENARIO_ID}] Generated 0 docs + 1-event sequence (admin-direction message)`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
