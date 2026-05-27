// Multi-turn conversation sequencing helpers. A scenario's events.json is a
// temporal array of Postmark payloads; replay harness (Phase 5) POSTs them in
// order with configured delays. Vienna threads messages via Supabase's
// messages table — replay needs to reuse MessageID/InReplyTo conventions so
// thread reconstruction works.

const buildEvent = (opts) => {
  const {
    sequenceIndex,
    delayFromPreviousMs = 0,
    kind, // broker_intake | broker_correction | broker_followup | admin_handoff_reply | franco_outbound (rare; for race scenarios)
    postmark,
  } = opts;
  return { sequenceIndex, delayFromPreviousMs, kind, postmark };
};

// Single-turn intake: simple one-event sequence (Group C-style baseline)
const singleTurnIntake = (postmark) => ([
  buildEvent({ sequenceIndex: 0, delayFromPreviousMs: 0, kind: 'broker_intake', postmark }),
]);

// Linear multi-turn: intake then N follow-ups with default 24h spacing
const linearTurns = (turns) => turns.map((postmark, i) => buildEvent({
  sequenceIndex: i,
  delayFromPreviousMs: i === 0 ? 0 : 86400000, // 24h default
  kind: i === 0 ? 'broker_intake' : 'broker_followup',
  postmark,
}));

// Broker-correction sequence: intake → correction (typically with reply-quote
// of Vienna's previous message). Used for R10-G push-machinery scenarios.
const correctionSequence = ({ intake, correction, correctionDelayMs = 86400000 }) => ([
  buildEvent({ sequenceIndex: 0, delayFromPreviousMs: 0, kind: 'broker_intake', postmark: intake }),
  buildEvent({ sequenceIndex: 1, delayFromPreviousMs: correctionDelayMs, kind: 'broker_correction', postmark: correction }),
]);

// Multi-correction race: same broker corrects field A, then field B, then
// re-corrects field A — surfaces last-write-wins question (Layer 3 #21)
const multiCorrectionSequence = (postmarks) => postmarks.map((postmark, i) => buildEvent({
  sequenceIndex: i,
  delayFromPreviousMs: i === 0 ? 0 : 3600000, // 1h spacing for race scenarios
  kind: i === 0 ? 'broker_intake' : 'broker_correction',
  postmark,
}));

// Broker-silent: single intake, no follow-up; harness drives the silence by
// running chase-email-cron with synthetic timestamps offset.
const silentSequence = (intake) => ([
  buildEvent({ sequenceIndex: 0, delayFromPreviousMs: 0, kind: 'broker_intake', postmark: intake }),
]);

module.exports = {
  buildEvent,
  singleTurnIntake,
  linearTurns,
  correctionSequence,
  multiCorrectionSequence,
  silentSequence,
};
