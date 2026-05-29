#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { singleTurnIntake } = require('../../lib/conversationSynth');
const { BORROWERS, BROKERS, ADDRESSES } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const SCENARIO_ID = 'B10';

(async () => {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const broker = BROKERS.jason_mercer;
  const borrower = BORROWERS.patricia_simmons;
  const property = ADDRESSES.toronto_glencairn;

  const intake = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Refinance docs — ${borrower.fullName}`,
    textBody: `Hi Franco,\n\nSubmitting refinance for ${borrower.fullName}. Full document package is too large for email — uploaded to file.io: https://file.io/aB3xK9dF2qP\n\nDownload link valid for 7 days. Includes loan application, mortgage statement, appraisal, NOA, and ID docs.\n\nProperty: ${property.full}\nLoan amount: $460,000\nLTV: ~50%\n\nLet me know once you've grabbed the package.\n\nExit strategy: borrower intends to sell the property at end of term.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-intake@bulletproof.synthetic`,
    date: '2026-05-15T11:00:00.000Z',
    attachments: [],
  });

  fs.writeFileSync(path.join(FIXTURE_DIR, 'events.json'), JSON.stringify(singleTurnIntake(intake), null, 2));
  console.log(`[${SCENARIO_ID}] Generated 0 docs + 1-event sequence (file-hosting link in body)`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
