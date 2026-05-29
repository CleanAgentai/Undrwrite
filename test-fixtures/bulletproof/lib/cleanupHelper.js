// Cleanup helper for bulletproof-tagged Supabase deals. Safety discipline:
// all delete operations REQUIRE bulletproof- prefix matching on MessageID/
// RUN_TAG pattern (prevents accidental production deletion).
//
// Mirrors r5-f4-quarantine-garbage-deals.js pattern but scoped to
// bulletproof-tagged synthetic deals only.

const BULLETPROOF_TAG_PATTERN = 'bulletproof-%';

// List all bulletproof-tagged deals (diagnostic; read-only)
const listBulletproofDeals = async (supabase) => {
  // Bulletproof deals identified by MessageID of first message starting with 'bulletproof-'
  const { data: msgs, error } = await supabase
    .from('messages')
    .select('deal_id, external_message_id, created_at')
    .ilike('external_message_id', BULLETPROOF_TAG_PATTERN)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`listBulletproofDeals: ${error.message}`);
  const dealIds = [...new Set((msgs || []).map(m => m.deal_id).filter(Boolean))];
  return dealIds;
};

// Delete deal + messages + documents. Two correlation modes per Sub-phase 5.2:
//   1. opts.dealId: explicit deal_id from runScenario return value (PRIMARY,
//      most reliable — bypasses MessageID pattern matching brittleness)
//   2. runTag string: fallback MessageID pattern matching (preserved for
//      cases where dealId is unavailable, e.g., scenario failed to create
//      a deal but left partial state)
//
// runTag format: 'bulletproof-{scenarioId}-{timestamp}'
const cleanupRun = async (supabase, runTag, opts = {}) => {
  const { verbose = false, dealId = null } = opts;
  if (!runTag || !runTag.startsWith('bulletproof-')) {
    throw new Error(`cleanupRun: refusing — runTag '${runTag}' must start with 'bulletproof-'`);
  }

  let dealIds = [];

  if (dealId) {
    // PRIMARY: explicit deal_id from runScenario (Sub-phase 5.2 patch)
    dealIds = [dealId];
  } else {
    // FALLBACK: MessageID pattern matching (legacy correlation)
    const tagPattern = `${runTag}%`;
    const { data: msgs, error: msgErr } = await supabase
      .from('messages')
      .select('id, deal_id, external_message_id')
      .ilike('external_message_id', tagPattern);
    if (msgErr) throw new Error(`cleanupRun lookup: ${msgErr.message}`);
    dealIds = [...new Set((msgs || []).map(m => m.deal_id).filter(Boolean))];
  }

  // BATCH-11 Phase 4: ALSO sweep deals whose email carries the runTag subaddress
  // (broker+runTag@domain). The dealId PRIMARY path cleaned only ONE deal, so any
  // SECOND deal a multi-turn correction created (the pre-Phase-1 correction-as-second-
  // deal leak — ~54 deals leaked in BATCH 8) or a deal that slipped dealId correlation
  // was never cleaned. Union by runTag email so cleanup is exhaustive per scenario.
  try {
    const { data: emailDeals } = await supabase.from('deals').select('id').ilike('email', `%${runTag}%`);
    for (const d of (emailDeals || [])) if (!dealIds.includes(d.id)) dealIds.push(d.id);
  } catch (e) {
    if (verbose) console.warn(`[cleanupRun] runTag-email sweep warning: ${e.message}`);
  }

  // Re-query messages for the deal(s) to get count for return-stats
  const { data: msgs } = await supabase
    .from('messages')
    .select('id')
    .in('deal_id', dealIds);

  if (dealIds.length === 0) {
    if (verbose) console.log(`[cleanupRun] no deals found for runTag '${runTag}' (dealId=${dealId})`);
    return { deletedDeals: 0, deletedMessages: 0, deletedDocs: 0 };
  }

  // Cascade delete: documents + messages + deals
  const { error: docsErr } = await supabase.from('documents').delete().in('deal_id', dealIds);
  if (docsErr && docsErr.code !== 'PGRST116') {
    if (verbose) console.warn(`[cleanupRun] documents delete: ${docsErr.message}`);
  }
  const { error: msgsErr } = await supabase.from('messages').delete().in('deal_id', dealIds);
  if (msgsErr) throw new Error(`cleanupRun messages delete: ${msgsErr.message}`);
  const { error: dealsErr } = await supabase.from('deals').delete().in('id', dealIds);
  if (dealsErr) throw new Error(`cleanupRun deals delete: ${dealsErr.message}`);

  const messageCount = msgs ? msgs.length : 0;
  if (verbose) {
    console.log(`[cleanupRun] runTag='${runTag}' dealId=${dealId} deleted ${dealIds.length} deal(s) + ${messageCount} message(s) + cascade-deleted documents`);
  }
  return { deletedDeals: dealIds.length, deletedMessages: messageCount };
};

// Admin command: delete ALL bulletproof-tagged deals. Requires explicit opts.confirm.
const cleanupAllBulletproof = async (supabase, opts = {}) => {
  const { confirm = false, verbose = false } = opts;
  if (!confirm) {
    throw new Error('cleanupAllBulletproof: refusing — pass { confirm: true } to authorize bulk delete');
  }
  const dealIds = await listBulletproofDeals(supabase);
  if (dealIds.length === 0) {
    if (verbose) console.log('[cleanupAllBulletproof] no bulletproof-tagged deals found');
    return { deletedDeals: 0 };
  }
  // Cascade delete
  await supabase.from('documents').delete().in('deal_id', dealIds);
  await supabase.from('messages').delete().in('deal_id', dealIds);
  const { error } = await supabase.from('deals').delete().in('id', dealIds);
  if (error) throw new Error(`cleanupAllBulletproof deals delete: ${error.message}`);
  if (verbose) console.log(`[cleanupAllBulletproof] deleted ${dealIds.length} bulletproof deal(s)`);
  return { deletedDeals: dealIds.length };
};

module.exports = {
  BULLETPROOF_TAG_PATTERN,
  listBulletproofDeals,
  cleanupRun,
  cleanupAllBulletproof,
};
