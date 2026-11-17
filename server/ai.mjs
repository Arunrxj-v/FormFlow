import { randomUUID } from 'node:crypto';
import { db } from './db.mjs';

const FIELD_META = {
  'personal.fullName': { label: 'Full name', category: 'personal' },
  'personal.firstName': { label: 'First name', category: 'personal' },
  'personal.lastName': { label: 'Last name', category: 'personal' },
  'personal.dateOfBirth': { label: 'Date of birth', category: 'personal', sensitive: true },
  'personal.nationality': { label: 'Nationality', category: 'personal' },
  'contact.email': { label: 'Email address', category: 'contact' },
  'contact.phone': { label: 'Phone number', category: 'contact' },
  'contact.addressLine1': { label: 'Address line 1', category: 'contact' },
  'contact.city': { label: 'City', category: 'contact' },
  'contact.state': { label: 'State', category: 'contact' },
  'contact.postalCode': { label: 'Postal code', category: 'contact' },
  'contact.country': { label: 'Country', category: 'contact' },
  'education.degree': { label: 'Degree', category: 'education' },
  'education.university': { label: 'University', category: 'education' },
  'education.registrationNumber': { label: 'Registration number', category: 'education', sensitive: true },
  'education.graduationYear': { label: 'Graduation year', category: 'education' },
  'education.cgpa': { label: 'CGPA', category: 'education' },
  'employment.employer': { label: 'Employer', category: 'employment' },
  'employment.jobTitle': { label: 'Job title', category: 'employment' },
  'identification.number': { label: 'Identification number', category: 'identification', sensitive: true },
  'other.skills': { label: 'Professional skills', category: 'other' },
};

function now() {
  return new Date().toISOString();
}

function normalizeValue(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function confidenceFor(pattern, value) {
  const base = pattern >= 0.9 ? 0.82 : 0.7;
  const quality = Math.min(0.1, value.length / 300);
  return Math.min(0.98, Number((base + quality).toFixed(2)));
}

export class RuleBasedProvider {
  name = 'local-rules';
  model = 'deterministic-v1';

  async extract({ text }) {
    const facts = [];
    const add = (key, value, pattern = 0.9, sourcePage = 1) => {
      const normalized = normalizeValue(value);
      if (!normalized || normalized.length > 300) return;
      const meta = FIELD_META[key];
      if (!meta) return;
      if (facts.some((fact) => fact.key === key)) return;
      facts.push({ key, label: meta.label, value: normalized, normalizedValue: normalized, category: meta.category, sensitive: Boolean(meta.sensitive), confidence: confidenceFor(pattern, normalized), sourcePage });
    };

    const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (email) add('contact.email', email[0], 0.99);

    const phone = text.match(/(?:\+?\d{1,3}[\s-]?)?(?:\(?\d{3,5}\)?[\s-]?)\d{3,5}[\s-]?\d{3,5}/);
    if (phone && phone[0].replace(/\D/g, '').length >= 8) add('contact.phone', phone[0], 0.82);

    const dob = text.match(/(?:date of birth|dob|born)[:\s-]*([0-9]{1,2}[ /.-][A-Za-z]{3,9}[ /.-][0-9]{4}|[0-9]{4}-[0-9]{2}-[0-9]{2})/i);
    if (dob) add('personal.dateOfBirth', dob[1], 0.94);

    const name = text.match(/(?:^|\n)\s*(?:name|full name)[:\s-]+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,4})/i);
    if (name) add('personal.fullName', name[1], 0.9);

    const passport = text.match(/\b[A-Z][0-9]{7}\b/);
    if (passport) add('identification.number', passport[0], 0.93);

    const degree = text.match(/\b(B\.?Tech|Bachelor(?: of [A-Za-z ]+)?|Master(?: of [A-Za-z ]+)?|M\.?Tech|B\.?Sc|M\.?Sc|MBA|B\.?Com|M\.?Com)\b[^\n]{0,90}/i);
    if (degree) add('education.degree', degree[0], 0.88);

    const university = text.match(/(?:[A-Z][A-Za-z.'-]+\s+){1,6}(?:University|College|Institute)[^\n]{0,60}/);
    if (university) add('education.university', university[0], 0.86);

    const registration = text.match(/(?:registration|register|reg\.?)\s*(?:no\.?|number)?[:\s-]*([A-Z0-9/-]{6,24})/i);
    if (registration) add('education.registrationNumber', registration[1], 0.92);

    const year = text.match(/(?:graduation|graduated|year of passing|passing year)[:\s-]*((?:19|20)\d{2})/i);
    if (year) add('education.graduationYear', year[1], 0.9);

    const cgpa = text.match(/(?:cgpa|gpa|percentage)[:\s-]*([0-9]{1,3}(?:\.[0-9]{1,2})?\s*(?:\/\s*[0-9]{1,3}(?:\.[0-9]{1,2})?|%))/i);
    if (cgpa) add('education.cgpa', cgpa[1], 0.9);

    const nationality = text.match(/(?:nationality|citizenship)[:\s-]+([A-Za-z ]{3,30})/i);
    if (nationality) add('personal.nationality', nationality[1], 0.9);

    const city = text.match(/(?:city|town)[:\s-]+([A-Za-z .'-]{2,40})/i);
    if (city) add('contact.city', city[1], 0.84);

    const postal = text.match(/(?:postal code|pin code|pincode|zip)[:\s-]*([0-9]{4,10})/i);
    if (postal) add('contact.postalCode', postal[1], 0.92);

    const employer = text.match(/(?:employer|company|organization|organisation)[:\s-]+([A-Za-z0-9 .,&'-]{2,60})/i);
    if (employer) add('employment.employer', employer[1], 0.86);

    const title = text.match(/(?:job title|designation|position|role)[:\s-]+([A-Za-z0-9 .,&'-]{2,60})/i);
    if (title) add('employment.jobTitle', title[1], 0.85);

    const skills = text.match(/(?:skills|technical skills)[:\s-]+([A-Za-z0-9+#., /-]{4,160})/i);
    if (skills) add('other.skills', skills[1], 0.8);

    return facts;
  }
}

export function createProvider() {
  // FormFlow runs extraction locally. No external AI provider is selected or
  // contacted by this legacy development server.
  return new RuleBasedProvider();
}

function recordUsage(userId, provider, inputChars, outputFacts) {
  db.prepare('INSERT INTO ai_usage (id,user_id,provider,model,input_tokens,output_tokens,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(randomUUID(), userId, provider.name, provider.model, Math.ceil(inputChars / 4), outputFacts * 20, now());
}

export async function processDocument({ userId, documentId, text, provider = createProvider() }) {
  const document = db.prepare('SELECT * FROM documents WHERE id = ? AND user_id = ?').get(documentId, userId);
  if (!document) throw new Error('Document not found.');
  const clean = String(text ?? '').replace(/\u0000/g, '').trim();
  if (clean.length < 20) throw new Error('Extracted text is too short to process.');
  if (clean.length > 500000) throw new Error('Document text exceeds the processing limit.');

  db.prepare("UPDATE documents SET status = 'extracting_information', processing_error = '', updated_at = ? WHERE id = ? AND user_id = ?").run(now(), documentId, userId);
  let facts;
  try {
    facts = await provider.extract({ text: clean, documentId });
    if (!Array.isArray(facts)) throw new Error('Invalid structured output received from the local extractor.');
  } catch (error) {
    db.prepare("UPDATE documents SET status = 'failed', processing_error = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(error.message || 'Local extraction failed', now(), documentId, userId);
    throw error;
  }

  let created = 0;
  let conflicts = 0;
  for (const fact of facts) {
    if (!FIELD_META[fact.key] || !fact.value) continue;
    const existing = db.prepare('SELECT * FROM fields WHERE user_id = ? AND field_key = ?').get(userId, fact.key);
    if (!existing) {
      db.prepare(`INSERT INTO fields (id,user_id,field_key,label,value,normalized_value,category,source_document_id,source_page,confidence,verification_status,sensitive,extracted_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        randomUUID(), userId, fact.key, fact.label, fact.value, fact.normalizedValue, fact.category,
        documentId, fact.sourcePage, fact.confidence, 'extracted', fact.sensitive ? 1 : 0, now(), now(),
      );
      created += 1;
      continue;
    }
    if (existing.value === fact.value) {
      db.prepare('UPDATE fields SET confidence = MAX(confidence, ?), updated_at = ? WHERE id = ?').run(fact.confidence, now(), existing.id);
      continue;
    }
    if (existing.verification_status === 'user_verified') continue;
    const duplicate = db.prepare('SELECT id FROM field_conflicts WHERE field_id = ? AND value = ?').get(existing.id, fact.value);
    if (!duplicate) {
      db.prepare('INSERT INTO field_conflicts (id,field_id,value,source_document_id,source_page,confidence,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(randomUUID(), existing.id, fact.value, documentId, fact.sourcePage, fact.confidence, now());
      conflicts += 1;
    }
  }

  db.prepare("UPDATE documents SET status = 'completed', extracted_text = ?, processing_error = '', processed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(clean.slice(0, 500000), now(), now(), documentId, userId);
  db.prepare('INSERT INTO activity (id,user_id,type,title,detail,created_at) VALUES (?,?,?,?,?,?)')
    .run(randomUUID(), userId, 'document_processed', document.name, `${document.category} · ${created} new fields · ${conflicts} conflicts`, now());
  recordUsage(userId, provider, clean.length, facts.length);

  return { provider: provider.name, model: provider.model, facts: facts.length, created, conflicts };
}
