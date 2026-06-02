#!/usr/bin/env node
// BUG-2 harness — admin-name leak guard (Layer 2) keyed to ADMIN_EMAIL.
// Leak shapes (admin-as-decision-maker) are redacted to role language; the intentional
// broker-facing uses (calendar, contact pointer, forms, casual "with <admin>") are preserved.
require('dotenv').config();
const config = require('../src/config');
const ai = require('../src/services/ai');
const A = (config.adminEmail || 'franco@x').split('@')[0].split(/[._+-]/)[0]; // first name, e.g. "Franco"
const Cap = A.charAt(0).toUpperCase() + A.slice(1);
const sweep = (s) => ai.enforceNoRoutingLeak(s).swept;
let pass = 0, fail = 0;
const redacted = (label, input) => { const out = sweep(input); const ok = !new RegExp(`\\b${Cap}\\b`, 'i').test(out) || !/\b(will|can|makes?|decide|decides|reviewed|approved|'s\s+(call|decision|review|approval))\b/i.test(out); console.log(`  ${ok ? 'PASS' : 'FAIL'}  REDACT  ${label}\n          "${input}"\n       →  "${out}"`); ok ? pass++ : fail++; };
const preserved = (label, input) => { const out = sweep(input); const ok = out === input; console.log(`  ${ok ? 'PASS' : 'FAIL'}  PRESERVE  ${label}${ok ? '' : `\n          got: "${out}"`}`); ok ? pass++ : fail++; };

console.log(`(admin first name from ADMIN_EMAIL: "${Cap}")`);
console.log('— LEAK shapes must be redacted —');
redacted('"X will make the final call"', `${Cap} will make the final call.`);
redacted('"X makes that call"', `Rejection language — ${Cap} makes that call, not Vienna.`);
redacted('"X\'s call"', `Any promise of approval — ${Cap}'s call.`);
redacted('"requires X\'s review"', `This requires ${Cap}'s review before we proceed.`);
redacted('"after X decides"', `Documents will follow after ${Cap} decides whether the deal is workable.`);
redacted('"X approved the deal" (injected drift)', `Good news — ${Cap} approved the deal and we can move forward.`);

console.log('— PRESERVED broker-facing features must be untouched —');
preserved('calendar — "book a 15-minute call with X here: <link>"', `Feel free to book a quick 15-minute call with ${Cap} here: https://calendar.app.google/rxr46kh4rzJgZpFx6.`);
preserved('contact pointer — "contact X at <email>"', `Please direct any further questions to ${Cap} at ${config.adminEmail || 'franco@privatemortgagelink.com'}.`);
preserved('forms — "use their own or X\'s template"', `Loan Application Form (if not received — mention they can use their own or ${Cap}'s template).`);
preserved('scheduling — "speak with X" / "with X here"', `If you'd like to chat about your options, you can book a call with ${Cap} here.`);
preserved('"X\'s template" (noun not in decision set)', `You can use ${Cap}'s template if you prefer.`);

console.log(`\nBUG-2 harness: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
