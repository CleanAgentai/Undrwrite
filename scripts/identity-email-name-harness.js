#!/usr/bin/env node
// Identity clash from a name read off an email address (Round-9 Bug 7) must not fire when
// the address is initial+surname or tagged — found live in Franco's Scenario 5
// ("mchen.yyc@" → "Mchen Yyc" vs broker's "Margaret Lynn Chen").
const { isIdentityClashByAbsence: f } = require('../src/services/ai');
let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };
const doc = (text) => [{ file_name: 'LoanApplication.pdf', text }];
ok('S5: mchen.yyc@ vs Margaret Lynn Chen → no clash', f('New Mortgage Submission — Margaret Lynn Chen', 'Borrower: Margaret Lynn Chen', doc('Email: mchen.yyc@gmail.com')) === null);
ok('jsmith.home@ vs John Smith → no clash', f('Refi — John Smith', 'Borrower: John Smith', doc('john: jsmith.home@x.ca')) === null);
ok('Bug 7 kept: grace.paulson@ vs Anna Bergstrom → clash', !!f('New submission — Anna Bergstrom', 'Borrower: Anna Bergstrom', doc('Email: grace.paulson@gmail.com')));
ok('labelled doc name clash unchanged', !!f('x', 'Borrower: Anna Bergstrom', doc('Borrower Name: Grace Paulson')));
ok('labelled doc name match unchanged', f('x', 'Borrower: Grace Paulson', doc('Borrower Name: Grace Paulson')) === null);
console.log(`\n[identity-email-name] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
