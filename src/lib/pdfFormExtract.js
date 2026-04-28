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

module.exports = { extractFormValues };
