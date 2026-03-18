const supabase = require('../lib/supabase');
const pdfParse = require('pdf-parse');
const archiver = require('archiver');

const IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif'];

// Classify a document based on filename and extracted text content
const classifyDocument = (fileName, extractedText) => {
  const name = fileName.toLowerCase();
  const text = (extractedText || '').toLowerCase();

  // Filename patterns
  if (/application|loan.?app/i.test(name)) return 'loan_application';
  if (/pnw|personal.?net.?worth|net.?worth/i.test(name)) return 'pnw_statement';
  if (/appraisal/i.test(name)) return 'appraisal';
  if (/credit.?bureau|credit.?report|equifax|transunion|experian/i.test(name)) return 'credit_report';
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
  if (/mortgage.?balance|mortgage.?statement|current.?mortgage/i.test(name)) return 'mortgage_statement';
  if (/corporate.?financial|corp.?financ/i.test(name)) return 'corporate_financials';
  if (/t1.?general|tax.?return/i.test(name)) return 'tax_return';
  if (/resume|cv|experience/i.test(name)) return 'borrower_resume';

  // Fall back to content analysis
  if (text) {
    if (/personal net worth|total assets.*total liabilities|net worth statement/i.test(text)) return 'pnw_statement';
    if (/loan application|borrower.*information.*property|mortgage application/i.test(text) && /loan amount|mortgage/i.test(text)) return 'loan_application';
    if (/apprais(al|ed value)|market value.*opinion|comparable.*sales/i.test(text)) return 'appraisal';
    if (/credit score|credit bureau|equifax|transunion|experian|beacon score/i.test(text)) return 'credit_report';
    if (/notice of assessment|canada revenue|income tax.*return/i.test(text)) return 'noa';
    if (/anti-money laundering|proceeds of crime|fintrac/i.test(text)) return 'aml';
    if (/politically exposed person/i.test(text)) return 'pep';
    if (/mortgage balance|mortgage statement|outstanding balance.*mortgage/i.test(text)) return 'mortgage_statement';
    if (/corporate financial|balance sheet.*income statement|fiscal year/i.test(text) && /corporation|inc\.|ltd\.|corp\./i.test(text)) return 'corporate_financials';
    if (/t1 general|tax return|taxable income.*federal/i.test(text)) return 'tax_return';
    if (/resume|curriculum vitae|professional experience|building experience|development experience/i.test(text)) return 'borrower_resume';
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
      .select('created_at')
      .eq('deal_id', dealId)
      .eq('direction', 'inbound')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code === 'PGRST116') return null;
    if (error) throw error;
    return data;
  },

  // Upload attachment to Supabase Storage and save record to documents table
  saveDocument: async (dealId, attachment) => {
    const buffer = Buffer.from(attachment.Content, 'base64');
    // Sanitize filename for Supabase Storage (remove $, [], commas, spaces, etc.)
    const safeName = attachment.Name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${dealId}/${Date.now()}-${safeName}`;

    // Extract text from PDF before uploading
    let extractedText = null;
    if (attachment.ContentType === 'application/pdf') {
      try {
        const parsed = await pdfParse(buffer);
        if (parsed.text && parsed.text.trim().length > 0) {
          extractedText = parsed.text.trim();
          console.log(`  Extracted ${extractedText.length} chars from ${attachment.Name}`);
        }
      } catch (err) {
        console.log(`  Could not extract text from ${attachment.Name}:`, err.message);
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
};
