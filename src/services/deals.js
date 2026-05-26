const supabase = require('../lib/supabase');
const pdfParse = require('pdf-parse');
const archiver = require('archiver');
const { extractFormValues } = require('../lib/pdfFormExtract');

const IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif'];

// Classify a document based on filename and extracted text content
const classifyDocument = (fileName, extractedText) => {
  const name = fileName.toLowerCase();
  const text = (extractedText || '').toLowerCase();

  // Filename patterns
  if (/application|loan.?app/i.test(name)) return 'loan_application';
  if (/pnw|personal.?net.?worth|net.?worth/i.test(name)) return 'pnw_statement';
  if (/appraisal/i.test(name)) return 'appraisal';
  if (/credit.?bureau|credit.?report|credit.?check|credit.?score|\bcb\b|beacon|fico/i.test(name)) return 'credit_report';
  if (/noa|notice.?of.?assessment/i.test(name)) return 'noa';
  if (/aml|anti.?money/i.test(name)) return 'aml';
  if (/pep|politically.?exposed/i.test(name)) return 'pep';
  if (/intake|checklist|borrower.?intake/i.test(name)) return 'intake_form';
  if (/passport|driver.?licen|license|gov.*(id|identification)/i.test(name)) return 'government_id';
  if (/income|pay.?stub|employment.?letter|t4|t1/i.test(name)) return 'income_proof';
  if (/bank.?statement|financial.?statement/i.test(name)) return 'financial_statement';
  if (/title.?search|title.?report/i.test(name)) return 'title_search';
  if (/insurance/i.test(name)) return 'insurance';
  if (/tax.?bill|property.?tax/i.test(name)) return 'property_tax';
  if (/survey/i.test(name)) return 'survey';
  if (/environmental/i.test(name)) return 'environmental';
  // Group OOO (S1.4): split mortgage docs into payout-vs-balance. Pre-OOO this was
  // a single 'mortgage_statement' bucket; production deal 9aa136aa accepted a
  // "TD_MortgageBalance_Grace_Paulson.pdf" as sufficient, marking the file complete
  // before broker had submitted the actual payout statement (which carries payoff
  // amount + prepayment penalty + interest-to-date + validity window — the balance
  // statement carries only current outstanding). Insufficient-first ordering: balance
  // patterns get caught before the payout fallthrough, so explicit "Balance" filenames
  // route to mortgage_balance_statement (insufficient).
  if (/mortgage.?balance|balance.?statement.*mortgage|current.?balance.*mortgage/i.test(name)) return 'mortgage_balance_statement';
  if (/payout.?statement|payout.?letter|mortgage.?payout|discharge.?statement|mortgage.?discharge|mortgage.?statement|current.?mortgage/i.test(name)) {
    // Sub-fix 1.5: ambiguous filename refinement. Generic "Mortgage_Statement.pdf"
    // without a balance cue would default to sufficient — but if the text body shows
    // balance-only content with no payoff/penalty/validity markers, downgrade to
    // mortgage_balance_statement so the file isn't prematurely marked complete.
    if (text) {
      const hasSufficientMarker = /payoff amount|payout amount|prepayment penalty|interest to.*date|validity (period|date|window)|discharge/i.test(text);
      const hasBalanceCue       = /current balance|outstanding balance|mortgage balance/i.test(text);
      if (hasBalanceCue && !hasSufficientMarker) return 'mortgage_balance_statement';
    }
    return 'mortgage_statement';
  }
  if (/corporate.?financial|corp.?financ/i.test(name)) return 'corporate_financials';
  if (/t1.?general|tax.?return/i.test(name)) return 'tax_return';
  if (/resume|cv|experience/i.test(name)) return 'borrower_resume';
  if (/purchase.?contract|purchase.?agreement|agreement.?of.?purchase|aps\b|sale.?agreement/i.test(name)) return 'purchase_contract';
  if (/down.?payment|deposit.?proof|proof.?of.?down/i.test(name)) return 'down_payment_proof';

  // Fall back to content analysis
  if (text) {
    if (/personal net worth|total assets.*total liabilities|net worth statement/i.test(text)) return 'pnw_statement';
    if (/loan application|borrower.*information.*property|mortgage application/i.test(text) && /loan amount|mortgage/i.test(text)) return 'loan_application';
    if (/apprais(al|ed value)|market value.*opinion|comparable.*sales/i.test(text)) return 'appraisal';
    if (/credit score|credit bureau|equifax|transunion|experian|beacon score/i.test(text)) return 'credit_report';
    if (/notice of assessment|canada revenue|income tax.*return/i.test(text)) return 'noa';
    if (/anti-money laundering|proceeds of crime|fintrac/i.test(text)) return 'aml';
    if (/politically exposed person/i.test(text)) return 'pep';
    // Group OOO: text-content layer mirrors the filename split. Sufficient-first
    // here — strong markers (payoff amount, prepayment penalty, interest-to-date,
    // validity, discharge) reliably indicate a real payout/discharge statement.
    // Balance-only content without those markers routes to mortgage_balance_statement.
    if (/payoff amount|payout amount|prepayment penalty|interest to.*date|validity (period|date|window)|payout statement|payout letter|mortgage payout|discharge statement|mortgage discharge/i.test(text)) return 'mortgage_statement';
    if (/mortgage balance|outstanding balance.*mortgage|current balance/i.test(text)) return 'mortgage_balance_statement';
    if (/corporate financial|balance sheet.*income statement|fiscal year/i.test(text) && /corporation|inc\.|ltd\.|corp\./i.test(text)) return 'corporate_financials';
    if (/t1 general|tax return|taxable income.*federal/i.test(text)) return 'tax_return';
    if (/resume|curriculum vitae|professional experience|building experience|development experience/i.test(text)) return 'borrower_resume';
    if (/agreement of purchase and sale|purchase price.*vendor|offer to purchase|purchase contract/i.test(text)) return 'purchase_contract';
  }

  return 'other';
};

module.exports = {
  // Find active deal by email (not completed or rejected)
  findActiveByEmail: async (email) => {
    const { data, error } = await supabase
      .from('deals')
      .select('*')
      .eq('email', email)
      .not('status', 'in', '("completed","rejected")')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code === 'PGRST116') return null; // No rows found
    if (error) throw error;
    return data;
  },

  // R9-F' (2026-05-26): cross-status duplicate detection. Catches the case
  // findActiveByEmail misses by design — when a previously-completed (or
  // rejected) deal exists for the same borrower and the broker re-submits.
  //
  // Returns { existingDeal: Deal | null, reason: string }:
  //   - null match: caller proceeds with create normally
  //   - non-null match: caller routes to admin-handoff (alert + skip create)
  //
  // Decision tree (Q1/Q2/Q3/Q3a/Q4 verdicts baked in):
  //   1. SELECT all deals for this email, ordered by created_at DESC
  //   2. If none: return null (no_match)
  //   3. Walk candidates by status priority (non-terminal first, then terminal):
  //      a. For terminal candidates: skip if updated_at > 90 days ago (Q4
  //         refinance carve-out)
  //      b. Property fuzzy match (Q2 FSA + street number):
  //         - if both properties present AND fuzzy-match → MATCH (return existingDeal)
  //         - if both properties present AND different → CONTINUE (Q2 different-property carve-out)
  //         - if property missing in EITHER side → CONTINUE (Q3a fail-open ambiguity)
  //   4. No candidate matched → return null
  //
  // Fail-open per Q3a: ambiguous cases (property missing) default to no-match
  // → new deal proceeds. Cost-asymmetry: false-positive dedup (rejecting
  // legitimate submission) > false-negative dedup (admin manually consolidates
  // via daily-summary surface).
  findExistingDealForBorrower: async (email, extractedFields) => {
    if (!email) return { existingDeal: null, reason: 'no_email' };

    const { data: candidates, error } = await supabase
      .from('deals')
      .select('*')
      .eq('email', email)
      .order('created_at', { ascending: false });

    if (error) throw error;
    // Delegate decision tree to the pure helper for testability + clean separation
    return decideExistingDealMatch(candidates, extractedFields);
  },

  // Create a new deal
  create: async ({ email, borrower_name }) => {
    const { data, error } = await supabase
      .from('deals')
      .insert({ email, borrower_name, status: 'active' })
      .select()
      .single();

    if (error) throw error;
    console.log('Deal created:', data.id);
    return data;
  },

  // Update deal fields
  update: async (dealId, updates) => {
    const { data, error } = await supabase
      .from('deals')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', dealId)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  // Get deal by ID
  get: async (dealId) => {
    const { data, error } = await supabase
      .from('deals')
      .select('*')
      .eq('id', dealId)
      .single();

    if (error) throw error;
    return data;
  },

  // Bug A (cron duplicate reminders): atomic per-deal lock for the cron reminder
  // path. Conditional UPDATE serializes concurrent workers via Postgres row lock —
  // only one worker successfully transitions reminder_count from `expectedCount`
  // to `newCount`; the others get 0 rows and skip. Production diagnosis: 9 cron
  // fires sent 9 emails to the same broker at 9 PM because the prior 20-hour
  // outbound check was non-atomic.
  claimReminderSlot: async (dealId, expectedCount, newCount) => {
    const { data, error } = await supabase
      .from('deals')
      .update({ reminder_count: newCount })
      .eq('id', dealId)
      .eq('reminder_count', expectedCount)
      .select('id');

    if (error) throw error;
    return { claimed: (data || []).length > 0 };
  },

  // Roll back a previously-claimed slot when the post-claim email send fails.
  // Conditional UPDATE — only decrements if reminder_count is still at the
  // claimed value (no other worker has changed it). Returns released=false if
  // someone else has already advanced the count; in that case we just log and
  // accept the broker missing one reminder (self-corrects on next cron via
  // MAX_REMINDERS check).
  releaseReminderSlot: async (dealId, claimedCount, rollbackTo) => {
    const { data, error } = await supabase
      .from('deals')
      .update({ reminder_count: rollbackTo })
      .eq('id', dealId)
      .eq('reminder_count', claimedCount)
      .select('id');

    if (error) throw error;
    return { released: (data || []).length > 0 };
  },

  // Save a message (inbound or outbound) linked to a deal
  saveMessage: async (dealId, direction, subject, body, externalMessageId = null) => {
    const row = { deal_id: dealId, direction, subject, body };
    if (externalMessageId) row.external_message_id = externalMessageId;

    const { data, error } = await supabase
      .from('messages')
      .insert(row)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  // Find deal by outbound message ID (for thread matching via In-Reply-To)
  findByMessageId: async (messageId) => {
    if (!messageId) return null;

    // Extract the Postmark UUID from various formats:
    // "41be2245-..." or "<41be2245-...@mtasv.net>" or "<41be2245-...>"
    const cleaned = messageId.replace(/^</, '').replace(/>$/, '').split('@')[0];
    console.log('findByMessageId — raw:', messageId, '→ cleaned:', cleaned);

    const { data, error } = await supabase
      .from('messages')
      .select('deal_id')
      .eq('external_message_id', cleaned)
      .eq('direction', 'outbound')
      .limit(1)
      .single();

    if (error && error.code === 'PGRST116') return null;
    if (error) throw error;
    if (!data) return null;

    // Fetch the full deal
    return module.exports.get(data.deal_id);
  },

  // Get all messages for a deal
  getMessages: async (dealId) => {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('deal_id', dealId)
      .order('created_at', { ascending: true });

    if (error) throw error;
    return data;
  },

  // Get the most recent inbound message for a deal
  getLastInboundMessage: async (dealId) => {
    const { data, error } = await supabase
      .from('messages')
      .select('created_at, subject, external_message_id')
      .eq('deal_id', dealId)
      .eq('direction', 'inbound')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code === 'PGRST116') return null;
    if (error) throw error;
    return data;
  },

  // Get the most recent outbound message ID for threading (In-Reply-To header)
  getLastOutboundMessageId: async (dealId) => {
    const { data, error } = await supabase
      .from('messages')
      .select('external_message_id')
      .eq('deal_id', dealId)
      .eq('direction', 'outbound')
      .not('external_message_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code === 'PGRST116') return null;
    if (error) throw error;
    return data?.external_message_id || null;
  },

  // Get every message ID on the deal in chronological order — used to build the References header
  // so the full conversation chain is preserved for Gmail / Outlook threading
  getAllMessageIdsForThread: async (dealId) => {
    const { data, error } = await supabase
      .from('messages')
      .select('external_message_id')
      .eq('deal_id', dealId)
      .not('external_message_id', 'is', null)
      .order('created_at', { ascending: true });

    if (error) throw error;
    return (data || []).map(row => row.external_message_id).filter(Boolean);
  },

  // Upload attachment to Supabase Storage and save record to documents table
  saveDocument: async (dealId, attachment) => {
    const buffer = Buffer.from(attachment.Content, 'base64');
    // Sanitize filename for Supabase Storage (remove $, [], commas, spaces, etc.)
    const safeName = attachment.Name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${dealId}/${Date.now()}-${safeName}`;

    // Extract text from PDF before uploading.
    // Two-step extraction: pdf-parse for the static text layer, pdf-lib for AcroForm field
    // values and annotation contents (which pdf-parse can't see). Combining both means a
    // filled fillable PDF or an annotation-marked PDF won't look "blank" to Claude.
    let extractedText = null;
    if (attachment.ContentType === 'application/pdf') {
      let baseText = '';
      let formText = '';
      try {
        const parsed = await pdfParse(buffer);
        if (parsed.text && parsed.text.trim().length > 0) {
          baseText = parsed.text.trim();
        }
      } catch (err) {
        console.log(`  pdf-parse failed for ${attachment.Name}:`, err.message);
      }
      try {
        formText = await extractFormValues(buffer);
      } catch (err) {
        console.log(`  pdf-lib form extraction failed for ${attachment.Name}:`, err.message);
      }
      const combined = (baseText + formText).trim();
      if (combined.length > 0) {
        extractedText = combined;
        const formNote = formText.length > 0 ? ` (incl. ${formText.length} chars of form fields/annotations)` : '';
        console.log(`  Extracted ${extractedText.length} chars from ${attachment.Name}${formNote}`);
      }
    }

    // Upload to storage bucket
    const { error: uploadError } = await supabase.storage
      .from('documents')
      .upload(storagePath, buffer, {
        contentType: attachment.ContentType,
        upsert: false,
      });

    if (uploadError) throw uploadError;
    console.log('Document uploaded:', storagePath);

    // Normalize MIME type to simple extension
    const mimeToExt = {
      'application/pdf': 'pdf',
      'image/jpeg': 'jpeg',
      'image/jpg': 'jpeg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/heic': 'heic',
      'image/heif': 'heif',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/msword': 'doc',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    };
    const fileType = mimeToExt[attachment.ContentType] || attachment.ContentType;

    // Classify document — use heuristic first, default images to government_id
    let classification = classifyDocument(attachment.Name, extractedText);
    if (classification === 'other' && IMAGE_TYPES.includes(attachment.ContentType)) {
      classification = 'government_id';
      console.log(`  Image "${attachment.Name}" — defaulting to government_id`);
    }

    // Save record to documents table with extracted text
    const { data, error: dbError } = await supabase
      .from('documents')
      .insert({
        deal_id: dealId,
        file_name: attachment.Name,
        file_type: fileType,
        storage_path: storagePath,
        classification,
        extracted_data: extractedText ? { text: extractedText } : null,
      })
      .select()
      .single();

    if (dbError) throw dbError;
    return data;
  },

  // Get all documents for a deal (with classifications)
  getDocumentsByDeal: async (dealId) => {
    const { data, error } = await supabase
      .from('documents')
      .select('id, file_name, file_type, classification, created_at')
      .eq('deal_id', dealId)
      .order('created_at', { ascending: true });

    if (error) throw error;
    return data || [];
  },

  // Get all documents for a deal including extracted text (for lead summary generation)
  getDocumentsWithText: async (dealId) => {
    const { data, error } = await supabase
      .from('documents')
      .select('id, file_name, file_type, classification, storage_path, extracted_data, created_at')
      .eq('deal_id', dealId)
      .order('created_at', { ascending: true });

    if (error) throw error;
    return data || [];
  },

  // Download all documents for a deal from Supabase Storage and return as a base64 zip
  downloadDocsAsZip: async (dealId, documents) => {
    const { PassThrough } = require('stream');
    const chunks = [];

    const archive = archiver('zip', { zlib: { level: 5 } });
    const passthrough = new PassThrough();

    passthrough.on('data', chunk => chunks.push(chunk));

    const done = new Promise((resolve, reject) => {
      passthrough.on('end', resolve);
      archive.on('error', reject);
    });

    archive.pipe(passthrough);

    for (const doc of documents) {
      try {
        const { data, error } = await supabase.storage
          .from('documents')
          .download(doc.storage_path);

        if (error) {
          console.error(`Failed to download ${doc.file_name}:`, error.message);
          continue;
        }

        const buffer = Buffer.from(await data.arrayBuffer());
        archive.append(buffer, { name: doc.file_name });
      } catch (err) {
        console.error(`Error downloading ${doc.file_name}:`, err.message);
      }
    }

    await archive.finalize();
    await done;

    const zipBuffer = Buffer.concat(chunks);
    console.log(`Zip created for deal ${dealId}: ${(zipBuffer.length / 1024).toFixed(0)} KB, ${documents.length} files`);
    return zipBuffer.toString('base64');
  },

  // Save all attachments from an email for a deal
  saveAttachments: async (dealId, attachments) => {
    if (!attachments || attachments.length === 0) return [];
    const results = [];
    for (const att of attachments) {
      try {
        const doc = await module.exports.saveDocument(dealId, att);
        results.push(doc);
      } catch (err) {
        console.error(`Failed to save document ${att.Name}:`, err.message);
      }
    }
    console.log(`Saved ${results.length}/${attachments.length} documents for deal ${dealId}`);
    return results;
  },

  // Get all active deals (not completed or rejected)
  getActiveDeals: async () => {
    const { data, error } = await supabase
      .from('deals')
      .select('*')
      .not('status', 'in', '("completed","rejected")')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  },

  // Group FFFF (S14.1): tear down an orphan deal scaffold created by the
  // new-client INITIAL branch when processInitialEmail throws. Pre-FFFF the
  // partial scaffold (empty extracted_data, wrong borrower_name fallback,
  // status=active) would shadow a retry via findActiveByEmail. Order: storage
  // files → documents rows → messages rows → deal row. Storage cleanup is
  // best-effort; DB rows must come down so the next email from the same
  // sender starts fresh.
  deleteDeal: async (dealId) => {
    const { data: docs } = await supabase
      .from('documents')
      .select('storage_path')
      .eq('deal_id', dealId);

    if (docs && docs.length > 0) {
      const paths = docs.map(d => d.storage_path).filter(Boolean);
      if (paths.length > 0) {
        try {
          await supabase.storage.from('documents').remove(paths);
        } catch (e) {
          console.error('deleteDeal: storage cleanup failed (continuing with DB cleanup):', e.message);
        }
      }
    }

    const { error: docErr } = await supabase.from('documents').delete().eq('deal_id', dealId);
    if (docErr) throw docErr;

    const { error: msgErr } = await supabase.from('messages').delete().eq('deal_id', dealId);
    if (msgErr) throw msgErr;

    const { error: dealErr } = await supabase.from('deals').delete().eq('id', dealId);
    if (dealErr) throw dealErr;
  },

  // Get all messages from the past N hours
  getRecentMessages: async (hours = 24) => {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('messages')
      .select('*, deals(borrower_name, email, status)')
      .gte('created_at', since)
      .order('created_at', { ascending: true });

    if (error) throw error;
    return data || [];
  },

  // R5 Cluster F Bug 2 (2026-05-21): atomic daily-summary slot claim. Mirrors
  // claimReminderSlot's pattern — UNIQUE constraint on daily_summaries
  // (date_edmonton) is the DB-layer race serializer. First worker / restart-
  // tick to INSERT for a given Edmonton-date wins; all subsequent INSERTs
  // collide on the UNIQUE and return zero rows via the .select() chain.
  // Caller skips silently when claimed=false.
  //
  // Two-vector coverage:
  //   Vector A: multiple Render workers each scheduling cron → simultaneous
  //     21:00 fires. INSERTs race; one wins, others get unique-violation =
  //     empty .select() = claimed=false.
  //   Vector B: Render restart between 21:00:00 and 21:00:59 → new app boots,
  //     schedules cron, in-window minute fires again. Same INSERT collision.
  //
  // Sequence: claim → send email → finalize (UPDATE status='sent' with
  // message_id + snapshot fields). If send fails, finalize writes status=
  // 'failed' + error_message. A crashed worker between claim and finalize
  // leaves status='pending' for that date — visible in audit queries.
  claimDailySummarySlot: async (dateEdmonton) => {
    const { data, error } = await supabase
      .from('daily_summaries')
      .insert({ date_edmonton: dateEdmonton })
      .select('id');

    // Postgres UNIQUE violation surfaces as a Supabase error with code 23505.
    // That's the expected "another worker won the race" path — convert to
    // claimed=false instead of throwing. Any OTHER error (network, auth,
    // schema) is a real problem and re-throws.
    if (error) {
      if (error.code === '23505') return { claimed: false, id: null };
      throw error;
    }
    return { claimed: true, id: (data || [])[0]?.id || null };
  },

  // Update a previously-claimed daily-summary row with terminal state.
  // status='sent' on successful send, status='failed' on caught send error.
  finalizeDailySummary: async (id, fields) => {
    const update = {
      status: fields.status,
      completed_at: new Date().toISOString(),
      ...(fields.messageId !== undefined ? { message_id: fields.messageId } : {}),
      ...(fields.htmlLength !== undefined ? { html_length: fields.htmlLength } : {}),
      ...(fields.activeDealsCount !== undefined ? { active_deals_count: fields.activeDealsCount } : {}),
      ...(fields.remindersSent !== undefined ? { reminders_sent: fields.remindersSent } : {}),
      ...(fields.errorMessage !== undefined ? { error_message: fields.errorMessage } : {}),
    };
    const { error } = await supabase
      .from('daily_summaries')
      .update(update)
      .eq('id', id);
    if (error) throw error;
  },
};

// R9-F' (2026-05-26): borrower-identity dedup helpers — pure functions
// for property fuzzy-match canonicalization + temporal carve-out threshold.
//
// Closes the cross-status duplicate-submission gap. Pre-R9-F', findActiveByEmail
// filtered out completed/rejected deals — so re-submitting after a deal closed
// silently created a new record. 89 of 95 production duplicates would have
// been caught by an "email-only, all-status" lookup (per R9-F' empirical).
//
// Architectural family: extends the 3rd template family (pre-create intake
// classification + data-model gate). R9-F classifyIntakeBorrower answers
// "is this a real deal at all?"; R9-F' findExistingDealForBorrower answers
// "is this real deal a duplicate of an existing one?" Same boundary, same
// alert-admin-skip pattern, same fail-open discipline on ambiguity.
//
// Property fuzzy-match policy (Q2 verdict): FSA (postal first-3) + street
// number anchor with whitespace + case + punctuation normalization.
// Calibrated to empirical noise pattern — Grace Paulson "T3..." truncation,
// Marcus Webb "T6R 3K2" vs no-postal variants, Derek Olsen, Ryan Callahan.
// FSA prefix matches across truncation; street number prevents same-FSA
// different-building false matches.
//
// Temporal carve-out (Q4 verdict): 90 days since last terminal-status closure.
// Covers typical refinance cycle without false-blocking quick re-submits.
const TEMPORAL_CARVEOUT_DAYS = 90;

// Canonicalize a property address string into a structured shape for fuzzy
// matching. Returns { postalPrefix, streetNumber, streetTokens } or null.
//   - postalPrefix: first 3 chars of Canadian postal code (FSA) — anchor signal
//   - streetNumber: first numeric token (e.g., "1142")
//   - streetTokens: first 3 tokens after street number, space-joined
const canonicalizeProperty = (addr) => {
  if (!addr || typeof addr !== 'string') return null;
  const s = addr.toLowerCase().replace(/[,.]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  // Canadian postal code (FSA + LDU): A1A 1A1 or A1A1A1
  const postalMatch = s.match(/\b([a-z]\d[a-z])\s*(\d[a-z]\d)?\b/);
  const postalPrefix = postalMatch ? postalMatch[1] : null;
  // Remove postal from the string for street-token extraction
  const noPostal = postalMatch ? s.replace(postalMatch[0], ' ').replace(/\s+/g, ' ').trim() : s;
  const tokens = noPostal.split(' ').filter(Boolean);
  const streetNumber = (tokens[0] && /^\d+$/.test(tokens[0])) ? tokens[0] : null;
  // first 3 tokens after street number — captures "street-name + suffix" for
  // moderate disambiguation when postal absent
  const remainingTokens = streetNumber ? tokens.slice(1) : tokens;
  const streetTokens = remainingTokens.slice(0, 3).join(' ');
  return { postalPrefix, streetNumber, streetTokens };
};

// Fuzzy match two property address strings. Returns true if both canonicalize
// to the same FSA + street number (preferred), OR same street number + street
// tokens (fallback when postal missing in either). Q3a (verdict): callers must
// fail-open on null input — propertyFuzzyMatch returns false on any null
// canonicalization, which the calling logic treats as "no carve-out signal
// available, fall through to next candidate" — NOT as "definite no-match".
const propertyFuzzyMatch = (a, b) => {
  const ca = canonicalizeProperty(a);
  const cb = canonicalizeProperty(b);
  if (!ca || !cb) return false;
  // Preferred path: both have postal FSA — anchor on FSA + street number
  if (ca.postalPrefix && cb.postalPrefix) {
    return ca.postalPrefix === cb.postalPrefix
      && !!ca.streetNumber && ca.streetNumber === cb.streetNumber;
  }
  // Fallback path: postal missing in either — anchor on street number + street tokens
  return !!ca.streetNumber && ca.streetNumber === cb.streetNumber
    && !!ca.streetTokens && ca.streetTokens === cb.streetTokens;
};

// Pure decision tree for findExistingDealForBorrower. Takes the candidate
// array (already SELECTed by email) + new submission's extracted fields,
// returns the same { existingDeal, reason } shape as findExistingDealForBorrower.
// Extracted as a pure function so test-trigger.js can exercise the full
// decision tree against fixture candidate arrays without stubbing supabase.
const decideExistingDealMatch = (candidates, extractedFields, now = Date.now()) => {
  if (!candidates || candidates.length === 0) {
    return { existingDeal: null, reason: 'no_match' };
  }
  const newProperty = extractedFields
    ? (extractedFields.subject_property_address || extractedFields.property_address)
    : null;

  // Priority: non-terminal candidates first (most likely an active duplicate),
  // then terminal candidates (potential refinance / resubmission).
  const nonTerminal = candidates.filter(d => d.status !== 'completed' && d.status !== 'rejected');
  const terminal = candidates.filter(d => d.status === 'completed' || d.status === 'rejected');
  const ordered = [...nonTerminal, ...terminal];

  for (const candidate of ordered) {
    const isTerminal = candidate.status === 'completed' || candidate.status === 'rejected';
    if (isTerminal) {
      const daysSince = (now - new Date(candidate.updated_at).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince > TEMPORAL_CARVEOUT_DAYS) {
        // Q4 refinance carve-out — terminal deal old enough that this is
        // legitimately a new transaction. Skip this candidate.
        continue;
      }
    }
    const candidateProperty = candidate.extracted_data
      ? (candidate.extracted_data.subject_property_address || candidate.extracted_data.property_address)
      : null;

    // Q3a fail-open: if property missing in either side, treat as ambiguous
    // → continue to next candidate (don't auto-match)
    if (!newProperty || !candidateProperty) continue;

    // Q2 propertyFuzzyMatch — FSA + street number anchor
    if (propertyFuzzyMatch(newProperty, candidateProperty)) {
      const reason = isTerminal ? 'property_match_recent_terminal' : 'property_match_active';
      return { existingDeal: candidate, reason };
    }
    // Q2 different-property carve-out — same email, different property =
    // new deal. Continue to next candidate (other candidates may match).
  }

  return { existingDeal: null, reason: 'no_property_match_or_carveout' };
};

// Test-only exposure for the deterministic classifier truth table (Group B).
// Production callers use the local const at module scope; this just makes the
// pure-regex predicate reachable from test-trigger.js without a DB roundtrip.
// R9-F' (2026-05-26): also expose canonicalizeProperty + propertyFuzzyMatch +
// TEMPORAL_CARVEOUT_DAYS + decideExistingDealMatch for the R9-F' truth-table
// matrices. decideExistingDealMatch is the pure decision tree; the async
// findExistingDealForBorrower wraps it with the supabase SELECT.
module.exports.__test__ = {
  classifyDocument,
  canonicalizeProperty,
  propertyFuzzyMatch,
  TEMPORAL_CARVEOUT_DAYS,
  decideExistingDealMatch,
};
