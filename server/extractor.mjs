import { createRequire } from 'node:module';
import mammoth from 'mammoth';
import tesseract from 'tesseract.js';

const require = createRequire(import.meta.url);
const pdfParseModule = require('pdf-parse');
const PDFParse = pdfParseModule.PDFParse;

export async function extractTextFromPdf(buffer) {
  try {
    const parser = new PDFParse({ data: buffer });
    await parser.load();
    const result = await parser.getText();
    const cleanText = (result?.text || '').replace(/\u0000/g, '').trim();

    if (cleanText.length >= 20) {
      return {
        text: cleanText,
        pageCount: result?.total || result?.pages?.length || 1,
        method: 'pdf-parser',
      };
    }

    // Scanned PDF fallback: if text is empty or near-empty, run OCR if pages can be rendered or images found
    return {
      text: cleanText,
      pageCount: result?.total || 1,
      method: 'scanned-pdf',
      needsOcr: cleanText.length < 20,
    };
  } catch (err) {
    if (err?.name === 'PasswordException' || err?.message?.includes('password')) {
      throw new Error('PDF is password-protected. Please unlock the file before uploading.');
    }
    throw new Error(`Failed to parse PDF document: ${err.message || 'corrupted or invalid structure'}`);
  }
}

export async function extractTextFromDocx(buffer) {
  try {
    const result = await mammoth.extractRawText({ buffer });
    const cleanText = (result?.value || '').replace(/\u0000/g, '').trim();
    if (!cleanText) {
      throw new Error('DOCX document does not contain readable text.');
    }
    return {
      text: cleanText,
      pageCount: 1,
      method: 'docx-parser',
    };
  } catch (err) {
    throw new Error(`Failed to parse DOCX document: ${err.message || 'corrupted file'}`);
  }
}

export function extractTextFromTxt(buffer) {
  try {
    const text = buffer.toString('utf8').replace(/\u0000/g, '').trim();
    if (text.length === 0) {
      throw new Error('Text document is empty.');
    }
    return {
      text,
      pageCount: 1,
      method: 'txt-parser',
    };
  } catch (err) {
    throw new Error(`Failed to read text file: ${err.message}`);
  }
}

export async function extractTextFromImage(buffer) {
  try {
    const result = await tesseract.recognize(buffer, 'eng');
    const cleanText = (result?.data?.text || '').replace(/\u0000/g, '').trim();
    return {
      text: cleanText,
      pageCount: 1,
      method: 'ocr-tesseract',
    };
  } catch (err) {
    throw new Error(`OCR text extraction failed: ${err.message || 'image could not be processed'}`);
  }
}

export async function extractDocumentText({ buffer, fileType, filename = '' }) {
  if (!buffer || buffer.length === 0) {
    throw new Error('Cannot extract text from an empty file buffer.');
  }

  const type = (fileType || filename.split('.').pop() || '').toLowerCase();

  switch (type) {
    case 'pdf': {
      const res = await extractTextFromPdf(buffer);
      if (res.needsOcr && (!res.text || res.text.length < 20)) {
        // Fall back to OCR on the raw buffer if image-based
        try {
          const ocrRes = await extractTextFromImage(buffer);
          if (ocrRes.text && ocrRes.text.length >= 20) {
            return ocrRes;
          }
        } catch {
          // If image OCR also fails on the raw PDF bytes, proceed with whatever text was found
        }
      }
      return res;
    }
    case 'docx':
    case 'doc':
      return extractTextFromDocx(buffer);
    case 'txt':
      return extractTextFromTxt(buffer);
    case 'jpg':
    case 'jpeg':
    case 'png':
      return extractTextFromImage(buffer);
    default:
      throw new Error(`Unsupported document format for text extraction: "${type}".`);
  }
}

