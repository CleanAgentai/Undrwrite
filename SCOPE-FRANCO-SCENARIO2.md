# Scope — Franco Scenario 2 retest (held; NOT implemented)

Prep-work scope for the two root-caused findings on deal `9da89a81` (Emily Strand /
Laura Michelle Chen). **No implementation, no commits.** Held pending Franco's complete
bug report; fixes will be bundled and pushed together after Porter review.

---

## FIX 1 — Path B gap: doc-completion existing-balance populates → false `[UPDATED]` re-fire

### Confirmed mechanism (Render log 02:21:30)
> `Path B: [UPDATED] prelim re-fired — material change on a doc-bearing turn (existing first mortgage balance 0→350000)`

`q10ParsePriorFromPrelim` ([webhook.js:1640-1651](src/routes/webhook.js#L1640)) derives the
prior `existing_mortgage_balance` from the prior prelim's **"Combined LTV"** line, which
renders **`$0`** under the R11-A paid-off carve-out (refi: existing 1st treated as paid
off). So the parsed prior is `0`. When the BMO payout statement arrives at turn 1, the
updated summary's `existing_mortgage_balance` populates `→ 350000`. The change-detector
([webhook.js:1625-1633](src/routes/webhook.js#L1625)) skips fields where `prior == null`,
but the prior is `0` (not null), so `0 !== 350000` registers as a material correction and
the `[UPDATED]` prelim fires. **It is a doc-completion field population, not a broker
correction** — exactly what Path B exists to suppress.

This same parse feeds BOTH call sites:
- [webhook.js:3879](src/routes/webhook.js#L3879) — Path B `preliminary-update` (Finding 1, full `[UPDATED]` prelim)
- [webhook.js:3848](src/routes/webhook.js#L3848) — `text-only-noop` Q10 delta-notice (would mis-fire the same way; this is OBS-2's territory)

A centralized fix covers both.

### Option (a) — RECOMMENDED — treat a prior `0` existing-balance as "not yet known"
**Change:** in `q10DetectMaterialChanges` ([webhook.js:1630-1631](src/routes/webhook.js#L1630)),
for `existing_mortgage_balance` only, treat `priorSnapshot[f] === 0` like `null` (absent)
so a `0 → value` transition is not counted as a material change. One added predicate in the
`.filter(...)`.

- **File:line:** webhook.js:1630-1631 (detector filter). No call-site changes — both 3848 and 3879 inherit it.
- **Scope:** ~2 lines. Self-contained in the Q10 detector that Path B already owns.
- **Regression risk:** LOW. Preserves genuine corrections on every other field (loan amount,
  property value, address, loan_type) and on existing-balance where the prior was a real
  positive number (2nd-mortgage deals: Combined LTV renders `($350,000 + $X)`, prior parses
  > 0, real corrections still detected). Only the `0 → value` population case is suppressed.
- **Documented residual (extreme edge):** a genuinely free-&-clear property (existing balance
  truly `$0`) where the broker later corrects to a real positive balance would also be
  suppressed from re-firing. Vanishingly rare for a refi; acceptable. Note in code comment.

### Option (b) — parse prior existing balance from a non-paid-off-display source — NOT recommended
The prelim body has **no truthful existing-balance figure** for a paid-off refi — the
Combined LTV `$0` IS the only existing-balance signal, and it is structurally `$0`. Option (b)
would require either (i) adding a truthful "Existing 1st Balance" row to the prelim Snapshot
and parsing that, or (ii) reverting the prior source to `extracted_data` — which Q10 v2
deliberately moved away from to avoid the "snapshot clobber" ([webhook.js:1608, 1635](src/routes/webhook.js#L1608)).
Both are larger surface and reintroduce risk Q10 v2 already designed out. **Reject in favor of (a).**

### Fixture coverage needed (none exists today)
No current fixture exercises a **doc-completes-existing-balance** turn under Path B (the
existing Path B / Q10 fixtures are all broker money/lender corrections, not a payout statement
arriving at turn 1 to populate a previously-unknown existing balance). Add one bulletproof
scenario:
- **Turn 0:** refi intake, NO payout statement → existing balance unknown → prelim fires, Combined LTV `$0`.
- **Turn 1:** payout statement arrives (existing balance now extractable) + no broker money change.
- **Assert:** NO second `[UPDATED]` prelim (Path B suppresses); deal state reflects the balance; exactly ONE prelim.
This is the regression lock for Fix 1. (Mirror Laura Chen 9da89a81's shape.)

---

## FIX 2 — Address extractor drops the house number on Alberta-grid numbered streets

### Confirmed mechanism
`ADDR_LINE_RE` ([canonical-fields.js:220](src/services/canonical-fields.js#L220)) requires the
street-**name** token to start with `[A-Za-z]`. For grid addresses where the street name is
numeric ("116 Street" = 116th Street), the regex skips the true house number `4412` and anchors
the captured number on `116`, taking `Street NW` as suffix → `"116 Street NW"`. `normalizeAddress`
then lowercases it → **`"116 street nw"`** in the Snapshot Property Address row. Canonical
`extracted_data.property_address` and the Collateral narrative (LLM-sourced) keep the full,
correct address — only the Snapshot row (regex-sourced) is wrong.

### Proposed regex change (tested — Pattern B)
Allow a single numeric token in the **immediately-pre-suffix slot** (the numbered-street name)
and accept a hyphen as the house/street separator. Bounding the numeric to that one slot avoids
leaking a unit/range number into the captured house number.

**Current:**
```js
/\b(\d{1,5})\s+((?:[A-Za-z][A-Za-z'\-]*\s+){0,6}?(?:Boulevard|Drive|Street|Avenue|Road|Circle|Court|Lane|Place|Crescent|Way|Square|Terrace|Close|Highway|Parkway|Trail|Park|Heights|Hill|Hills|Mews|Park|Pointe|Promenade|Ridge|Run|Walk)(?:\s+(?:NW|NE|SW|SE|N|S|E|W))?)\b/i
```
**Proposed:**
```js
/\b(\d{1,5})[\s-]+((?:[A-Za-z][A-Za-z'\-]*\s+){0,5}?(?:\d{1,4}\s+)?(?:Boulevard|Drive|Street|Avenue|Road|Circle|Court|Lane|Place|Crescent|Way|Square|Terrace|Close|Highway|Parkway|Trail|Park|Heights|Hill|Hills|Mews|Park|Pointe|Promenade|Ridge|Run|Walk)(?:\s+(?:NW|NE|SW|SE|N|S|E|W))?)\b/i
```
Two edits: (1) `\s+` → `[\s-]+` after the house number (hyphenated `4412-116` form); (2) insert
`(?:\d{1,4}\s+)?` as an optional pre-suffix numeric token; alpha quantifier `{0,6}?` → `{0,5}?`
(the numeric slot absorbs one position).

### Verification cases (all pass with Pattern B)
| Input | Current (bug) | Proposed | Note |
|---|---|---|---|
| `4412 116 Street NW, Edmonton, AB T6J 1P9` | `116 Street NW` | `4412 116 Street NW` | Franco's deal |
| `4412-116 Street NW, Edmonton, AB` | `116 Street NW` | `4412 116 Street NW` | hyphen form |
| `10446 122 Street NW, Edmonton` | `122 Street NW` | `10446 122 Street NW` | Franco's own sig address |
| `6324 106 Street NW, Edmonton` | `106 Street NW` | `6324 106 Street NW` | prior deal 7757c2e2 |
| `412 Windermere Close SW, Edmonton` | `412 Windermere Close SW` | `412 Windermere Close SW` | named-street regression ✅ |
| `1142 Tory Road NW, Calgary` | `1142 Tory Road NW` | `1142 Tory Road NW` | named-street regression ✅ |
| `Unit 5 1234 Jasper Avenue NW` | `1234 Jasper Avenue NW` | `1234 Jasper Avenue NW` | unit-number guard ✅ |

### Consumer / regression map (narrower than first reported)
`ADDR_LINE_RE` / `extractAddressLine` is consumed **only inside canonical-fields.js** (email +
each doc → `subject_property_address` tuples). Those tuples feed exactly two things:
1. **The Snapshot Property Address row** (`renderSnapshotRow`, [discrepancy-engine.js:693](src/services/discrepancy-engine.js#L693)) — the fix target.
2. **Cross-source address discrepancy grouping** — `renderSnapshotRow` shows `(per source)` when
   sources yield distinct values.

**Correction to the preliminary report:** the **misattached-doc check (Group JJJJ)** and the
**dedup / address-change comparison** ([webhook.js:685-688](src/routes/webhook.js#L685),
[deals.js:699/719](src/services/deals.js#L699)) use the **LLM-extracted full `property_address`**,
NOT `ADDR_LINE_RE`. So the regex fix does **not** touch misattached-doc detection or dedup.

- **Regression risk:** LOW-MODERATE, confined to #2. Pre-fix, all sources collapsed to the
  house-number-less form and thus matched. Post-fix, if one source carries the house number and
  another omits it, the Snapshot could show a new `(per source)` split. Mitigation: all sources
  run through the SAME fixed extractor; synthetic fixtures carry one consistent address. **Verify**
  against any bulletproof fixture using a numbered-street address + re-run the address fixtures to
  confirm named-street extraction is byte-identical. Address discrepancy is display-only (no
  escalation/blocking), so even a regression here is low-severity.

### Fixture coverage needed
- Re-run existing address/canonical-fields fixtures (named-street byte-equivalence).
- Add a numbered-street fixture (`4412 116 Street NW` shape) asserting the Snapshot row carries the house number.

---

## READINESS — response cadence when Franco's complete report lands

1. **Triage** the full set; map each item to a finding (these two are pre-root-caused).
2. **Implement all together** (bundle) — Fix 1 (Option a, webhook.js:1630) + Fix 2 (Pattern B,
   canonical-fields.js:220) + their two fixtures. Do NOT fire one-at-a-time; match his batching.
3. **Verify against his ACTUAL deals** via `scripts/trace-deal-extraction.js` (and a staging
   replay of the Laura-Chen 2-turn shape for Fix 1's suppression + Fix 2's Snapshot address).
4. **Hold** the bundled commit for Porter review; push only after sign-off.
5. Update memory + POST-CLOSURE on closure.

Both fixes are small, centralized, and tested in isolation here — ready to implement immediately
on Porter's go.
