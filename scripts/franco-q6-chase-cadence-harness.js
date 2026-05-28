#!/usr/bin/env node
// FRANCO-Q6 unit harness — chase cadence 3→4, escalate-to-admin (no auto-close).
// Source-invariant checks (dailySummary.js schedules cron on require, so we read
// source rather than import): MAX_REMINDERS=4, gate uses >=, no auto-close in the
// reminder loop, at_max_reminders flagging preserved; ai.js tone has a #4 tier
// with NO "close this file" claim, and the "of 4" summary label.

const fs = require('fs');
let pass = 0, fail = 0;
const ok = (label, cond) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}`); };

const root = fs.existsSync('src/cron/dailySummary.js') ? '.' : '..';
const ds = fs.readFileSync(`${root}/src/cron/dailySummary.js`, 'utf8');
const ai = fs.readFileSync(`${root}/src/services/ai.js`, 'utf8');

console.log('\n[1] cadence constant');
ok('MAX_REMINDERS = 4', /const MAX_REMINDERS = 4\b/.test(ds));
ok('gate uses >= MAX_REMINDERS (4th sends, 5th blocked)', /reminderCount >= MAX_REMINDERS/.test(ds));
ok('interval left at 2 days', /FOLLOW_UP_AFTER_DAYS = REMINDER_TESTING_MODE \? \(1 \/ 24\) : 2/.test(ds));

console.log('\n[2] escalate-to-admin, NOT auto-close');
const loop = ds.slice(ds.indexOf('const runFollowUpReminders'), ds.indexOf('const runFollowUpReminders') + 12000);
ok('no status→closed/rejected in reminder loop', !/status:\s*['"](closed|rejected|archived)['"]/.test(loop));
ok('at_max_reminders flagging preserved', /at_max_reminders/.test(ds));

console.log('\n[3] reminder tone — 4 tiers, no closure claim');
ok('Reminder #4 tier present', /Reminder #4:/.test(ai));
ok('Reminder #3 no longer the "close this file" closer', !/Reminder #3:[^\n]*close this file/.test(ai));
// Slice the reminder tone block by stable ASCII anchors (avoid em-dash matching).
const startIdx = ai.indexOf('Reminder #1:');
const endIdx = ai.indexOf('BANNED OPENERS — these are too casual or filler-y');
const toneBlock = (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) ? ai.slice(startIdx, endIdx) : '';
ok('tone block sliced (non-empty)', toneBlock.length > 0);
ok('reminder tone block makes no "close this/the file" claim to broker', !/clos(e|ing) (this |the )?file/i.test(toneBlock));
ok('reminder tone block instructs NOT to say closed', /do NOT (say|mention)|NOT.{0,30}clos/i.test(toneBlock));

console.log('\n[4] summary label');
ok('"Reminder #N of 4" label', /Reminder #2 of 4/.test(ai) && !/Reminder #2 of 3/.test(ai));

console.log(`\n[franco-q6-harness] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
