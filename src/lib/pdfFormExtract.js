const { PDFDocument, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList } = require('pdf-lib');

// Extract values that pdf-parse misses:
//  - AcroForm field values (Adobe-style fillable fields stored as form metadata)
//  - Annotation contents (FreeText / Text annotations users add via Preview, Adobe markup, etc.)
// pdf-parse only sees the static text layer — it cannot read either of these.
// Returns a formatted string of "label: value" lines, or an empty string if nothing found.
const extractFormValues = async (buffer) => {
  const lines = [];

  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  } catch (err) {
    // Encrypted, corrupt, or non-PDF — give up silently
    return '';
  }

  // 1. AcroForm fields
  try {
    const form = pdfDoc.getForm();
    const fields = form.getFields();
    for (const field of fields) {
      const name = field.getName();
      let value = null;

      if (field instanceof PDFTextField) {
        value = field.getText();
      } else if (field instanceof PDFCheckBox) {
        value = field.isChecked() ? 'Yes' : 'No';
      } else if (field instanceof PDFRadioGroup) {
        value = field.getSelected();
      } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
        const selected = field.getSelected();
        value = Array.isArray(selected) ? selected.join(', ') : selected;
      }

      if (value !== null && value !== undefined && String(value).trim().length > 0) {
        lines.push(`${name}: ${value}`);
      }
    }
  } catch (err) {
    // No form / read error — ignore and try annotations
  }

  // 2. Annotation contents (text the user typed on top of the page via markup tools)
  try {
    const pages = pdfDoc.getPages();
    pages.forEach((page, pageIdx) => {
      const annots = page.node.Annots && page.node.Annots();
      if (!annots) return;

      const arr = annots.asArray ? annots.asArray() : [];
      arr.forEach((annotRef) => {
        try {
          const annot = pdfDoc.context.lookup(annotRef);
          if (!annot || typeof annot.get !== 'function') return;
          // Annotation "Contents" entry holds the user's typed text for FreeText/Text annotations
          const contentsObj = annot.get(require('pdf-lib').PDFName.of('Contents'));
          if (!contentsObj) return;
          const text = typeof contentsObj.decodeText === 'function'
            ? contentsObj.decodeText()
            : (contentsObj.value && contentsObj.value()) || String(contentsObj);
          if (text && String(text).trim().length > 0) {
            lines.push(`[Page ${pageIdx + 1} annotation] ${String(text).trim()}`);
          }
        } catch (innerErr) {
          // Skip malformed annotation
        }
      });
    });
  } catch (err) {
    // No annotations / read error
  }

  if (lines.length === 0) return '';
  return `\n\n=== Form fields and annotations (extracted via pdf-lib) ===\n${lines.join('\n')}`;
};

// BLANK-FORM GATE (Bug-1 fix): count the FILLED DATA fields in an AcroForm — i.e. the
// fields that carry real submitted content. Checkboxes are EXCLUDED: a blank template
// emits "No" for every unchecked box, so counting them would mask a blank form. A form
// with zero filled data fields is an UNFILLED template — it must NOT be sent to the
// vision model for "field reading" (the model hallucinates plausible values for the
// empty fields). Returns { dataFields, hasAcroForm }. On any read error, returns
// { dataFields: -1 } so callers can FAIL OPEN (treat as filled / send to vision) and
// never block a genuine submission.
const countFilledDataFields = async (buffer) => {
  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  } catch (err) {
    return { dataFields: -1, hasAcroForm: false }; // unreadable → fail open
  }

  let dataFields = 0;
  let hasAcroForm = false;

  // AcroForm text / dropdown / radio / option-list values (NOT checkboxes)
  try {
    const form = pdfDoc.getForm();
    const fields = form.getFields();
    hasAcroForm = fields.length > 0;
    for (const field of fields) {
      let value = null;
      if (field instanceof PDFTextField) {
        value = field.getText();
      } else if (field instanceof PDFRadioGroup) {
        value = field.getSelected();
      } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
        const selected = field.getSelected();
        value = Array.isArray(selected) ? selected.join(', ') : selected;
      }
      // PDFCheckBox intentionally excluded — see docblock.
      if (value !== null && value !== undefined && String(value).trim().length > 0) {
        dataFields++;
      }
    }
  } catch (err) {
    // no form / read error — continue to annotations
  }

  // Non-empty annotation contents also count as real submitted data
  try {
    const pages = pdfDoc.getPages();
    pages.forEach((page) => {
      const annots = page.node.Annots && page.node.Annots();
      if (!annots) return;
      const arr = annots.asArray ? annots.asArray() : [];
      arr.forEach((annotRef) => {
        try {
          const annot = pdfDoc.context.lookup(annotRef);
          if (!annot || typeof annot.get !== 'function') return;
          const contentsObj = annot.get(require('pdf-lib').PDFName.of('Contents'));
          if (!contentsObj) return;
          const text = typeof contentsObj.decodeText === 'function'
            ? contentsObj.decodeText()
            : (contentsObj.value && contentsObj.value()) || String(contentsObj);
          if (text && String(text).trim().length > 0) dataFields++;
        } catch (innerErr) {
          // skip malformed annotation
        }
      });
    });
  } catch (err) {
    // no annotations / read error
  }

  return { dataFields, hasAcroForm };
};

module.exports = { extractFormValues, countFilledDataFields };
