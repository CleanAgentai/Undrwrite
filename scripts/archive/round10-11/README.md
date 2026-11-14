# Retired Round-10/11 mini-harnesses (2026-11-14)

These were point-in-time verification scripts for Franco's Round 10/11 retests (May 2026).
They no longer run green on unchanged behaviour, for two reasons:

- **Production-deal replay**: r10b, r10d, r10e, r10g, r11b and r11c load specific production deals
  (Donna 45bd01df, Patricia a0caddfb, Ethan c95f3a20, Marcus 8c404ae0). Those rows were later
  deleted from Supabase by test cleanup, so the harness fails at load time.
- **Source-text pinning**: r10a, r10c, r10f, r10h and r10i assert exact source text, call-site counts or
  line numbers (e.g. "swept at 2 call sites", "helper signature at L3092", "sendCompletionHandoff
  invokes composeBrokerLenderPackageEmail") that later fixes legitimately changed. r10i asserts the broker
  lender package that was deliberately removed in 3cbd82b.

The behaviours they guarded are covered by the current suite (scripts/*harness*.js: bug1–bug7,
franco-q1…q11, batch11/12, r9e, r9fprime, r11a, round9-missing-docs-honesty) and by the deployed replay of Franco's
15 scenarios (test-scenarios/). They are kept here for history and are not run by scripts/run-harnesses.js.
