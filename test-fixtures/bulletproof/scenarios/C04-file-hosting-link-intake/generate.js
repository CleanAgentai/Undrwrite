#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { singleTurnIntake } = require('../../lib/conversationSynth');
const { BORROWERS, BROKERS, ADDRESSES } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const SCENARIO_ID = 'C04';

(async () => {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const broker = BROKERS.jonathan_ferrara;
  const borrower = BORROWERS.david_okafor;
  const property = ADDRESSES.mississauga_winston;

  const intake = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Submission package — ${borrower.fullName}`,
    textBody: `Hi Franco,\n\nFull package for ${borrower.fullName} (refi) is hosted on WeTransfer — package is ~80MB with scanned NOA, ID, mortgage statement, appraisal, and supporting documents.\n\nDownload link: https://wetransfer.com/downloads/3f2a9c8b1d4e5f6789abcdef01234567/abcd1234\n\nLink expires in 7 days.\n\nProperty: ${property.full}\nLoan amount: $390,000 (LTV ~54%)\n\nExit strategy: borrower intends to sell the property at end of term.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-intake@bulletproof.synthetic`,
    date: '2026-05-15T13:30:00.000Z',
    attachments: [],
  });

  fs.writeFileSync(path.join(FIXTURE_DIR, 'events.json'), JSON.stringify(singleTurnIntake(intake), null, 2));
  console.log(`[${SCENARIO_ID}] Generated 0 docs + 1-event sequence (wetransfer link in body)`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
