import type { DocumentCategory, ExtractionMethod, VaultCategory } from '@shared/types';
import { FIELD_BY_KEY, labelForKey, categoryForKey } from '@shared/field-catalog';
import { collapseWhitespace, isValidEmail, isValidPhone, normalizeDate, normalizeValue, validateValueForKey, valueAppearsInSource } from './normalize';

export interface ExtractedCandidate {
  key: string;
  label: string;
  value: string;
  normalizedValue: string;
  category: VaultCategory;
  page?: number;
  confidence: number;
  method: ExtractionMethod;
  sensitive: boolean;
  needsReview: boolean;
  reason: string;
  supportingText?: string;
  sourceBlockId?: string;
  modelVersion?: string;
}

export interface DocumentClassification {
  category: DocumentCategory;
  subcategory: string;
  documentType:
    | 'resume'
    | 'degree_certificate'
    | 'identity_document'
    | 'employment_letter'
    | 'address_proof'
    | 'certificate'
    | 'financial_document'
    | 'other';
  confidence: number;
  reasons: string[];
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
const URL_RE = /https?:\/\/[^\s<>()]+|(?:www\.)[^\s<>()]+/gi;

const DEGREE_RE = /\b(?:B\.?\s?Tech|B\.?\s?E\.?|B\.?\s?Sc|B\.?\s?S\.?|M\.?\s?Tech|M\.?\s?E\.?|M\.?\s?Sc|M\.?\s?S\.?|MBA|MCA|BCA|B\.?\s?Com|M\.?\s?Com|Ph\.?\s?D|Bachelor(?:'s)?|Master(?:'s)?|Diploma|Associate(?:'s)?)\b[^\n]{0,120}/i;
const INSTITUTION_RE = /\b(?:[A-Z][A-Za-z&.'-]+\s+){1,6}(?:University|College|Institute|School|Academy|Polytechnic)\b[^\n]{0,80}/;
const DATE_RE = /\b(?:\d{1,2}[./-]\d{1,2}[./-]\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})\b/i;
const YEAR_RE = /\b(19|20)\d{2}\b/;

export function classifyDocument(text: string, fileName: string): DocumentClassification {
  const haystack = `${fileName}\n${text}`.toLowerCase();
  const reasons: string[] = [];
  let documentType: DocumentClassification['documentType'] = 'other';
  let category: DocumentCategory = 'Other';
  let subcategory = 'Other / General';
  let score = 0;

  const signals: Array<{ type: DocumentClassification['documentType']; category: DocumentCategory; words: string[]; weight: number }> = [
    { type: 'resume', category: 'Resumes', words: ['curriculum vitae', 'resume', 'work experience', 'professional summary', 'technical skills', 'education'], weight: 4 },
    { type: 'degree_certificate', category: 'Education', words: ['degree certificate', 'bachelor', 'master', 'university', 'college', 'graduation', 'cgpa', 'semester', 'convocation'], weight: 4 },
    { type: 'identity_document', category: 'Identity', words: ['passport', 'aadhaar', 'aadhar', 'national id', 'identification', 'date of birth', 'place of birth', 'government of india'], weight: 5 },
    { type: 'employment_letter', category: 'Employment', words: ['employment', 'offer letter', 'experience letter', 'designation', 'employer', 'joining', 'salary', 'human resources'], weight: 4 },
    { type: 'address_proof', category: 'Address proofs', words: ['electricity bill', 'utility bill', 'address proof', 'residential address', 'postal code', 'pin code'], weight: 4 },
    { type: 'certificate', category: 'Certifications', words: ['certificate of completion', 'certification', 'awarded to', 'has successfully completed'], weight: 3 },
    { type: 'financial_document', category: 'Financial', words: ['invoice', 'bank statement', 'account number', 'tax', 'salary slip', 'payslip'], weight: 4 },
  ];

  for (const signal of signals) {
    let hits = 0;
    for (const word of signal.words) if (haystack.includes(word)) hits += 1;
    if (hits > 0) {
      reasons.push(`${signal.category}: ${hits} keyword${hits === 1 ? '' : 's'}`);
      const value = Math.min(95, signal.weight * 12 + hits * 5);
      if (value > score) {
        score = value;
        documentType = signal.type;
        category = signal.category;
      }
    }
  }

  if (category === 'Resumes') subcategory = 'Resumes / Candidate CV';
  else if (category === 'Education') subcategory = 'Education / Academic certificate';
  else if (category === 'Identity') subcategory = 'Identity / Government ID';
  else if (category === 'Employment') subcategory = 'Employment / Employment record';
  else if (category === 'Address proofs') subcategory = 'Address proofs / Residence';
  else if (category === 'Certifications') subcategory = 'Certifications / Professional';
  else if (category === 'Financial') subcategory = 'Financial / Statement or invoice';

  return {
    category,
    subcategory,
    documentType,
    confidence: Math.max(35, score),
    reasons,
  };
}

function pageContaining(pages: string[], value: string): number | undefined {
  const needle = value.toLowerCase();
  const index = pages.findIndex((page) => page.toLowerCase().includes(needle));
  return index >= 0 ? index + 1 : undefined;
}

function firstMatch(text: string, regex: RegExp): RegExpExecArray | null {
  regex.lastIndex = 0;
  return regex.exec(text);
}

function lineValue(text: string, labels: string[], maxLength = 120): string | null {
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    for (const label of labels) {
      const regex = new RegExp(`^${label}\\s*[:\\-–]\\s*(.+)$`, 'i');
      const match = line.match(regex);
      if (match?.[1]) return collapseWhitespace(match[1]).slice(0, maxLength);
      const inline = line.match(new RegExp(`${label}\\s*[:\\-–]\\s*([^|,;]{2,${maxLength}})`, 'i'));
      if (inline?.[1]) return collapseWhitespace(inline[1]);
    }
  }
  return null;
}

function sectionText(text: string, headings: string[]): string | null {
  const lines = text.split(/\n+/);
  let collecting = false;
  const collected: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const normalized = trimmed.replace(/[:\s]+$/, '').toLowerCase();
    if (headings.some((heading) => normalized === heading.toLowerCase() || normalized === `${heading.toLowerCase()}:`)) {
      collecting = true;
      continue;
    }
    if (collecting) {
      if (/^[A-Z][A-Za-z ]{2,40}:?$/.test(trimmed) && trimmed.length < 42 && !/[,.]/.test(trimmed)) break;
      collected.push(trimmed);
      if (collected.join(' ').length > 500) break;
    }
  }
  return collected.length ? collapseWhitespace(collected.join(', ')).slice(0, 800) : null;
}

export function extractDeterministic(
  text: string,
  pages: string[],
  classification: DocumentClassification,
  fileName: string,
): ExtractedCandidate[] {
  const candidates: ExtractedCandidate[] = [];
  const seen = new Set<string>();

  const add = (
    key: string,
    rawValue: string | null | undefined,
    options: { page?: number; confidence: number; method?: ExtractionMethod; needsReview?: boolean; reason: string },
  ) => {
    if (!rawValue) return;
    const value = collapseWhitespace(rawValue).replace(/^[,;:.\-\s]+|[,;:.\-\s]+$/g, '');
    if (!value || value.length > 2000) return;
    if (seen.has(key)) return;
    const validation = validateValueForKey(key, value);
    if (!validation.ok) return;
    if (!valueAppearsInSource(value, text)) return;
    const definition = FIELD_BY_KEY[key];
    seen.add(key);
    candidates.push({
      key,
      label: definition?.label ?? labelForKey(key),
      value,
      normalizedValue: normalizeValue(key, value),
      category: definition?.category ?? categoryForKey(key),
      page: options.page ?? pageContaining(pages, value),
      confidence: Math.min(99, options.confidence),
      method: options.method ?? 'deterministic',
      sensitive: Boolean(definition?.sensitive),
      needsReview: options.needsReview ?? options.confidence < 80,
      reason: options.reason,
    });
  };

  // Contact information
  const email = firstMatch(text, EMAIL_RE)?.[0];
  if (email && isValidEmail(email)) add('contact.email', email, { confidence: 99, reason: 'Matched a valid email address pattern.' });

  const urls = Array.from(text.matchAll(URL_RE)).map((match) => match[0]);
  if (urls[0] && urls[0] !== email) add('contact.website', urls[0], { confidence: 90, reason: 'Matched a URL pattern.' });

  const phoneContext = text.match(/(?:phone|mobile|contact|tel(?:ephone)?|whatsapp)\s*[:\-–]?\s*(\+?\d[\d\s().-]{7,}\d)/i)?.[1];
  const phone = phoneContext ?? firstMatch(text, PHONE_RE)?.[0];
  if (phone && isValidPhone(phone) && !YEAR_RE.test(phone) && phone.replace(/\D/g, '').length >= 8) {
    add('contact.phone', phone.trim(), { confidence: phoneContext ? 94 : 76, needsReview: !phoneContext, reason: phoneContext ? 'Phone number appeared beside a phone label.' : 'Matched a phone-like number without a label.' });
  }

  // Personal information
  const name = lineValue(text, ['full name', 'name', 'candidate name', 'applicant name', 'student name', 'name of the student']);
  if (name && name.split(/\s+/).length >= 2 && name.split(/\s+/).length <= 6) {
    add('personal.fullName', name, { confidence: 88, reason: 'Found a labelled name.' });
  } else if (classification.documentType === 'resume') {
    const firstLine = text.split(/\n+/).map((line) => line.trim()).find((line) => line.length > 2 && line.length < 60 && !/[@\d]/.test(line));
    if (firstLine && firstLine.split(/\s+/).length >= 2) {
      add('personal.fullName', firstLine, { confidence: 68, needsReview: true, reason: 'Used the first line of the resume as a candidate name.' });
    }
  }
  if (name) {
    const parts = name.split(/\s+/);
    if (parts.length >= 2) {
      add('personal.firstName', parts[0], { confidence: 80, needsReview: true, reason: 'Derived from the extracted full name.' });
      add('personal.lastName', parts.slice(1).join(' '), { confidence: 72, needsReview: true, reason: 'Derived from the extracted full name.' });
    }
  }

  const dob = lineValue(text, ['date of birth', 'dob', 'birth date', 'birthday']);
  if (dob && normalizeDate(dob)) add('personal.dateOfBirth', dob, { page: pageContaining(pages, dob), confidence: 92, method: 'deterministic', reason: 'Found a labelled date of birth.' });
  const gender = lineValue(text, ['gender', 'sex']);
  if (gender) add('personal.gender', gender, { confidence: 85, reason: 'Found a labelled gender value.' });
  const nationality = lineValue(text, ['nationality', 'citizenship']);
  if (nationality) add('personal.nationality', nationality, { confidence: 90, reason: 'Found a labelled nationality.' });

  // Address
  const address = lineValue(text, ['address', 'residential address', 'permanent address', 'mailing address', 'address line 1'], 240);
  if (address) add('contact.addressLine1', address, { confidence: 86, reason: 'Found a labelled address.' });
  const city = lineValue(text, ['city', 'town']);
  if (city) add('contact.city', city, { confidence: 85, reason: 'Found a labelled city.' });
  const state = lineValue(text, ['state', 'province']);
  if (state) add('contact.state', state, { confidence: 82, reason: 'Found a labelled state.' });
  const country = lineValue(text, ['country']);
  if (country) add('contact.country', country, { confidence: 85, reason: 'Found a labelled country.' });
  const postal = text.match(/(?:postal code|pin code|pincode|zip(?: code)?)\s*[:\-–]?\s*([A-Z0-9][A-Z0-9 -]{3,10})/i)?.[1];
  if (postal) add('contact.postalCode', postal, { confidence: 88, reason: 'Found a labelled postal code.' });

  // Education
  const degree = lineValue(text, ['degree', 'qualification', 'course', 'programme', 'program']) ?? firstMatch(text, DEGREE_RE)?.[0];
  if (degree) add('education.degree', degree, { confidence: lineValue(text, ['degree', 'qualification']) ? 90 : 72, needsReview: !lineValue(text, ['degree', 'qualification']), reason: 'Found a degree or qualification.' });
  const institution = lineValue(text, ['institution', 'college', 'school', 'institute']) ?? firstMatch(text, INSTITUTION_RE)?.[0];
  if (institution) add('education.institution', institution, { confidence: 82, reason: 'Found an educational institution name.' });
  const university = lineValue(text, ['university', 'board', 'affiliating university']);
  if (university) add('education.university', university, { confidence: 84, reason: 'Found an awarding university.' });
  const branch = lineValue(text, ['branch', 'major', 'specialization', 'stream', 'field of study']);
  if (branch) add('education.branch', branch, { confidence: 82, reason: 'Found a branch or specialization.' });
  const gradYear = text.match(/(?:graduat(?:ion|ed)|passing|completion|completed)\D{0,30}((?:19|20)\d{2})/i)?.[1];
  if (gradYear) add('education.graduationYear', gradYear, { confidence: 85, reason: 'Found a graduation year near graduation wording.' });
  const cgpa = text.match(/\b(?:CGPA|GPA|grade point average)\s*[:\-–]?\s*(\d{1,2}(?:\.\d{1,2})?)\s*(?:\/\s*(\d{1,2}(?:\.\d{1,2})?))?/i);
  if (cgpa) add('education.cgpa', `${cgpa[1]}${cgpa[2] ? `/${cgpa[2]}` : ''}`, { confidence: 90, reason: 'Found a labelled CGPA/GPA.' });
  const percentage = text.match(/\b(?:percentage|aggregate)\s*[:\-–]?\s*(\d{1,3}(?:\.\d{1,2})?)\s*%/i);
  if (percentage) add('education.percentage', `${percentage[1]}%`, { confidence: 88, reason: 'Found a labelled percentage.' });
  const registration = lineValue(text, ['registration number', 'registration no', 'roll number', 'roll no', 'enrolment number', 'enrollment number', 'student id']);
  if (registration) add('education.registrationNumber', registration, { confidence: 88, reason: 'Found a labelled registration number.' });

  // Employment
  const employer = lineValue(text, ['employer', 'company', 'organization', 'organisation', 'current company']);
  if (employer) add('employment.employer', employer, { confidence: 82, reason: 'Found a labelled employer.' });
  const jobTitle = lineValue(text, ['job title', 'designation', 'position', 'role']);
  if (jobTitle) add('employment.jobTitle', jobTitle, { confidence: 80, reason: 'Found a labelled job title.' });
  const responsibilities = sectionText(text, ['responsibilities', 'key responsibilities', 'duties']);
  if (responsibilities) add('employment.responsibilities', responsibilities, { confidence: 70, needsReview: true, reason: 'Captured a responsibilities section.' });
  const experience = text.match(/(?:total\s+)?(?:work\s+)?experience\s*[:\-–]?\s*(\d{1,2}(?:\.\d)?\s*(?:\+)?\s*(?:years?|yrs?)[^\n.]{0,30})/i)?.[1];
  if (experience) add('employment.experience', experience, { confidence: 82, reason: 'Found a labelled experience figure.' });

  // Skills
  const skills = sectionText(text, ['skills', 'technical skills', 'key skills', 'core competencies', 'technologies']);
  if (skills) add('skills.technical', skills, { confidence: 74, needsReview: true, reason: 'Captured a skills section.' });
  const certification = lineValue(text, ['certification', 'certificate']);
  if (certification) add('certifications.name', certification, { confidence: 76, needsReview: true, reason: 'Found a certification line.' });

  // Identification (only for identity-ish documents)
  if (classification.category === 'Identity' || /passport|aadhaar|aadhar|national id|identity/i.test(fileName)) {
    const passport = text.match(/\b[A-Z][0-9]{7}\b/)?.[0];
    const aadhaar = text.match(/\b\d{4}\s?\d{4}\s?\d{4}\b/)?.[0];
    const idNumber = lineValue(text, ['passport number', 'aadhaar number', 'aadhar number', 'national id', 'id number', 'identity number']) ?? passport ?? aadhaar;
    if (idNumber) add('identification.number', idNumber, { confidence: 86, reason: 'Found an identification number pattern.' });
    const idType = /passport/i.test(text) ? 'Passport' : /aadhaar|aadhar/i.test(text) ? 'Aadhaar' : null;
    if (idType) add('identification.type', idType, { confidence: 88, reason: 'Inferred identification type from document text.' });
  }

  return candidates;
}

export function candidateToField(candidate: ExtractedCandidate) {
  return {
    key: candidate.key,
    label: candidate.label,
    value: candidate.value,
    normalizedValue: candidate.normalizedValue,
    category: candidate.category,
    sourcePage: candidate.page,
    confidence: candidate.confidence,
    extractionMethod: candidate.method,
    verificationStatus: 'extracted' as const,
    sensitive: candidate.sensitive,
    userModified: false,
    ...(candidate.supportingText ? { evidence: candidate.supportingText } : {}),
    ...(candidate.sourceBlockId ? { sourceBlockId: candidate.sourceBlockId } : {}),
    ...(candidate.modelVersion ? { modelVersion: candidate.modelVersion } : {}),
  };
}
