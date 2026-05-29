#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { singleTurnIntake } = require('../../lib/conversationSynth');
const { BORROWERS, BROKERS, ADDRESSES } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const SCENARIO_ID = 'F20';

(async () => {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const broker = BROKERS.jonathan_ferrara, borrower = BORROWERS.sarah_chen;
  const property = ADDRESSES.vancouver_kingsway;
  const intake = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Refinance — ${borrower.fullName}`,
    textBody: `Hi Franco,\n\nRefi for ${borrower.fullName} at ${property.full}. 65% LTV, $525k requested.\n\nFull document package is ~95MB — hosted on Google Drive:\nhttps://drive.google.com/drive/folders/1aBcDe-fGhIjKlMnOpQrStUvWxYz0123\n\nLink permission set to anyone-with-link can view. Includes loan app, statements, appraisal, NOA, ID.\n\nExit strategy: borrower intends to sell the property at end of term.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-intake@bulletproof.synthetic`,
    date: '2026-05-15T11:00:00.000Z',
    attachments: [],
  });
  fs.writeFileSync(path.join(FIXTURE_DIR, 'events.json'), JSON.stringify(singleTurnIntake(intake), null, 2));
  console.log(`[${SCENARIO_ID}] Generated 0 docs + 1-event sequence (Google Drive link)`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
