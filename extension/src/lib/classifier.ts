import type { FieldKind } from '../../../shared/form-fields.ts';
import { KIND_TO_VAULT_KEY } from '../../../shared/form-fields.ts';

export type { FieldKind } from '../../../shared/form-fields.ts';

export interface ClassifiedField {
  kind: FieldKind;
  confidence: number;
  sensitive: boolean;
}

const rules: Array<{ kind: FieldKind; sensitive?: boolean; patterns: RegExp[]; weight: number }> = [
  { kind: 'email', patterns: [/\bemail\b/i, /e-mail/i, /courriel/i, /email address/i], weight: 98 },
  { kind: 'phone', patterns: [/\bphone\b/i, /mobile/i, /telephone/i, /contact number/i, /whatsapp/i], weight: 96 },
  { kind: 'firstName', patterns: [/first name/i, /given name/i, /\bfname\b/i], weight: 97 },
  { kind: 'lastName', patterns: [/last name/i, /family name/i, /surname/i, /\blname\b/i], weight: 97 },
  { kind: 'fullName', patterns: [/full name/i, /your name/i, /applicant name/i, /candidate name/i, /student name/i], weight: 95 },
  { kind: 'dateOfBirth', sensitive: true, patterns: [/date of birth/i, /\bdob\b/i, /birth date/i, /birthday/i], weight: 98 },
  { kind: 'gender', patterns: [/\bgender\b/i, /\bsex\b/i], weight: 95 },
  { kind: 'nationality', patterns: [/nationality/i, /citizenship/i], weight: 96 },
  { kind: 'address', patterns: [/address line 1/i, /street address/i, /^address$/i, /residential address/i, /mailing address/i], weight: 94 },
  { kind: 'city', patterns: [/\bcity\b/i, /\btown\b/i, /\bdistrict\b/i], weight: 94 },
  { kind: 'state', patterns: [/\bstate\b/i, /\bprovince\b/i, /\bregion\b/i], weight: 92 },
  { kind: 'postalCode', patterns: [/postal code/i, /zip code/i, /\bzip\b/i, /pin code/i, /pincode/i], weight: 96 },
  { kind: 'country', patterns: [/\bcountry\b/i, /\bnation\b/i], weight: 92 },
  { kind: 'branch', patterns: [/\bbranch\b/i, /\bmajor\b/i, /\bdepartment\b/i, /\bdiscipline\b/i, /field of study/i, /stream/i, /specialization/i], weight: 96 },
  { kind: 'semester', patterns: [/\bsemester\b/i, /\bsem\b/i, /year of study/i, /current term/i, /trimester/i], weight: 96 },
  { kind: 'registrationNumber', sensitive: true, patterns: [/registration number/i, /registration no/i, /roll number/i, /roll no/i, /enrolment/i, /enrollment/i, /student id/i, /matriculation/i], weight: 94 },
  { kind: 'degree', patterns: [/degree/i, /qualification/i, /course name/i, /programme/i, /program name/i], weight: 92 },
  { kind: 'university', patterns: [/university/i, /college/i, /institution/i, /board/i, /school name/i, /institute/i, /alma mater/i], weight: 94 },
  { kind: 'graduationYear', patterns: [/graduation year/i, /year of passing/i, /passing year/i, /year completed/i, /completion year/i], weight: 95 },
  { kind: 'cgpa', patterns: [/\bcgpa\b/i, /\bgpa\b/i, /percentage/i, /marks obtained/i, /grade point/i], weight: 94 },
  { kind: 'employer', patterns: [/employer/i, /company name/i, /organization/i, /organisation/i, /current company/i], weight: 94 },
  { kind: 'jobTitle', patterns: [/job title/i, /designation/i, /^position$/i, /^role$/i, /current title/i], weight: 92 },
  { kind: 'skills', patterns: [/skills/i, /technical skills/i, /competencies/i, /expertise/i, /programming languages/i], weight: 91 },
  { kind: 'identificationNumber', sensitive: true, patterns: [/passport number/i, /aadhaar/i, /social security/i, /\bssn\b/i, /national id/i, /identity number/i, /id number/i], weight: 97 },
  { kind: 'longAnswer', patterns: [/describe/i, /explain/i, /why are you/i, /tell us/i, /statement of purpose/i, /cover letter/i, /motivation/i, /academic background/i, /project experience/i, /brief summary/i], weight: 88 },
];

export const kindToVaultKey = KIND_TO_VAULT_KEY;

export function classifyField(input: {
  label?: string;
  name?: string;
  id?: string;
  placeholder?: string;
  ariaLabel?: string;
  autocomplete?: string;
  type?: string;
  tag?: string;
}): ClassifiedField {
  const haystack = [input.label, input.name, input.id, input.placeholder, input.ariaLabel, input.autocomplete]
    .filter(Boolean)
    .join(' ')
    .replace(/[_\-[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (input.type === 'email') return { kind: 'email', confidence: 99, sensitive: false };
  if (input.type === 'tel') return { kind: 'phone', confidence: 99, sensitive: false };
  if ((input.label ?? '').trim().toLowerCase() === 'name') {
    return { kind: 'fullName', confidence: 95, sensitive: false };
  }

  let best: { kind: FieldKind; confidence: number; sensitive: boolean } = { kind: 'unknown', confidence: 0, sensitive: false };
  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      if (pattern.test(haystack)) {
        if (rule.weight > best.confidence) {
          best = { kind: rule.kind, confidence: rule.weight, sensitive: Boolean(rule.sensitive) };
        }
        break;
      }
    }
  }

  if (best.kind === 'unknown' && (input.tag === 'textarea' || input.type === 'textarea')) {
    return { kind: 'longAnswer', confidence: 60, sensitive: false };
  }

  return best;
}

export function generateGroundedAnswer(kind: FieldKind, vault: Record<string, string>): string | null {
  if (kind !== 'longAnswer') return null;
  const degree = vault['education.degree'];
  const university = vault['education.university'];
  const branch = vault['education.branch'] || extractBranchFromDegree(degree);
  const year = vault['education.graduationYear'];
  const cgpa = vault['education.cgpa'];
  const employer = vault['employment.employer'];
  const title = vault['employment.jobTitle'];
  const skills = vault['skills.technical'] ?? vault['other.skills'];
  if (!degree && !employer) return null;
  const parts = [
    degree ? `I hold a ${degree}${branch && !degree.toLowerCase().includes(branch.toLowerCase()) ? ` in ${branch}` : ''}${university ? ` from ${university}` : ''}${year ? `, completed in ${year}` : ''}${cgpa ? ` with a CGPA of ${cgpa}` : ''}.` : '',
    employer && title ? `I currently work as a ${title} at ${employer}.` : '',
    skills ? `My technical toolkit includes ${skills}.` : '',
    'I would bring this background to the opportunity while continuing to learn and contribute carefully.',
  ].filter(Boolean);
  return parts.join(' ');
}

/**
 * Extracts branch/major from degree strings like "B.Tech in Computer Science and Engineering"
 */
export function extractBranchFromDegree(degree?: string): string {
  if (!degree) return '';
  const match = degree.match(/(?:in|of)\s+([A-Za-z\s&,]+?)(?:\s+from|\s*\(|$)/i);
  if (match?.[1]) return match[1].trim();
  return '';
}

/**
 * Common engineering branch acronym synonyms and mappings
 */
const BRANCH_SYNONYMS: Record<string, string[]> = {
  'computer science and engineering': ['cse', 'cs', 'ct', 'cm', 'computer science', 'computer engineering', 'computer technology'],
  'computer science': ['cs', 'cse', 'ct', 'cm', 'computer engineering', 'computer technology'],
  'computer engineering': ['ce', 'cse', 'cs', 'ct', 'cm', 'computer science'],
  'electronics and communication engineering': ['ece', 'ec', 'electronics and communication', 'electronics & communication', 'electronics'],
  'electronics & communication engineering': ['ece', 'ec', 'electronics and communication', 'electronics & communication'],
  'electrical and electronics engineering': ['eee', 'ee', 'electrical and electronics', 'electrical & electronics', 'electrical engineering', 'electrical'],
  'electrical engineering': ['ee', 'eee', 'electrical'],
  'mechanical engineering': ['me', 'mech', 'mechanical'],
  'civil engineering': ['ce', 'civil'],
  'information technology': ['it', 'infotech'],
  'biotechnology': ['bt', 'biotech'],
  'chemical engineering': ['che', 'chem', 'chemical'],
  'artificial intelligence and data science': ['ai&ds', 'aids', 'ai', 'ds', 'artificial intelligence', 'data science'],
  'data science': ['ds', 'data science'],
};

/**
 * Roman numerals to numbers (for semester matching)
 */
const ROMAN_NUMERALS: Record<string, number> = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
};

/**
 * Semantics-aware option matcher
 * Compares a stored vault value against a list of options available on the form.
 * Returns the exact matching option string or null if ambiguous/not found.
 */
export function normalizeOptionText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function optionMatches(optionText: string, storedValue: string): boolean {
  const option = normalizeOptionText(optionText);
  const target = normalizeOptionText(storedValue);
  if (!option || !target) return false;
  return option === target || option.replace(/\s+/g, '') === target.replace(/\s+/g, '');
}

function containsAsWords(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(haystack);
}

export function matchOption(
  storedValue: string,
  options: string[],
  kind?: FieldKind
): { match: string; confidence: number } | null {
  if (!storedValue || !options || options.length === 0) return null;

  const rawTarget = storedValue.trim();
  const lowerTarget = rawTarget.toLowerCase();

  // 1. Exact match (case insensitive)
  for (const opt of options) {
    if (opt.trim().toLowerCase() === lowerTarget) {
      return { match: opt, confidence: 100 };
    }
  }

  // 2. Normalized alphanumeric match
  const cleanTarget = lowerTarget.replace(/[^a-z0-9]/g, '');
  for (const opt of options) {
    const cleanOpt = opt.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (cleanOpt && cleanOpt === cleanTarget) {
      return { match: opt, confidence: 98 };
    }
  }

  // 3. Branch / Department matching with engineering acronyms
  if (kind === 'branch' || isBranchLike(lowerTarget)) {
    const branchKey = findBranchKey(lowerTarget);
    const synonyms = branchKey ? BRANCH_SYNONYMS[branchKey] || [] : [];
    const allCandidates = branchKey ? [branchKey, ...synonyms] : [];

    for (const opt of options) {
      const lowerOpt = opt.trim().toLowerCase();
      const cleanOpt = lowerOpt.replace(/[^a-z0-9]/g, '');

      // Direct acronym or synonym check
      if (allCandidates.some((c) => c === lowerOpt || c.replace(/[^a-z0-9]/g, '') === cleanOpt)) {
        return { match: opt, confidence: 95 };
      }

      // Word set containment
      if (branchKey && wordOverlapMatch(branchKey, lowerOpt)) {
        return { match: opt, confidence: 92 };
      }
    }
  }

  // 4. Semester matching (e.g., "Semester 6", "6th Sem", "VI", "6")
  if (kind === 'semester' || isSemesterLike(lowerTarget)) {
    const semNumber = extractSemesterNumber(lowerTarget);
    if (semNumber !== null) {
      for (const opt of options) {
        const optNumber = extractSemesterNumber(opt.trim().toLowerCase());
        if (optNumber === semNumber) {
          return { match: opt, confidence: 96 };
        }
      }
    }
    // Semester matching is strictly numerical; do not fall through to loose word matching on "semester"
    return null;
  }

  // 5. Word set / Substring containment (minimum word length 3 to avoid false positive "a", "in")
  const targetWords = lowerTarget.split(/\s+/).filter((w) => w.length >= 3);
  let bestMatch: { match: string; score: number } | null = null;

  for (const opt of options) {
    const lowerOpt = opt.trim().toLowerCase();
    const optWords = lowerOpt.split(/\s+/).filter((w) => w.length >= 3);

    // If option contains full target string or target contains full option string
    if (containsAsWords(lowerTarget, lowerOpt) && lowerOpt.length >= 4) {
      const score = lowerOpt.length / lowerTarget.length;
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { match: opt, score };
      }
    } else if (containsAsWords(lowerOpt, lowerTarget) && lowerTarget.length >= 4) {
      const score = lowerTarget.length / lowerOpt.length;
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { match: opt, score };
      }
    } else if (targetWords.length > 0 && optWords.length > 0) {
      const matchingWords = targetWords.filter((w) => optWords.includes(w));
      const overlap = matchingWords.length / Math.max(targetWords.length, optWords.length);
      if (overlap >= 0.6) {
        if (!bestMatch || overlap > bestMatch.score) {
          bestMatch = { match: opt, score: overlap };
        }
      }
    }
  }

  if (bestMatch && bestMatch.score >= 0.6) {
    return { match: bestMatch.match, confidence: Math.round(bestMatch.score * 90) };
  }

  return null;
}

function isBranchLike(str: string): boolean {
  return /engineering|science|technology|computer|electronics|electrical|mechanical|civil/i.test(str);
}

function findBranchKey(target: string): string | null {
  for (const key of Object.keys(BRANCH_SYNONYMS)) {
    if (target.includes(key) || key.includes(target)) return key;
    if (BRANCH_SYNONYMS[key].includes(target)) return key;
  }
  return null;
}

function wordOverlapMatch(branch: string, option: string): boolean {
  const bWords = branch.split(/\s+/).filter((w) => !['and', 'of', 'in', '&'].includes(w));
  const oWords = option.split(/\s+/).filter((w) => !['and', 'of', 'in', '&'].includes(w));
  if (bWords.length === 0 || oWords.length === 0) return false;
  const common = bWords.filter((w) => oWords.includes(w));
  return common.length >= 2 || (bWords.length === 1 && common.length === 1);
}

function isSemesterLike(str: string): boolean {
  return /sem|semester|year|term/i.test(str) || /^[0-9ivx]+$/i.test(str.trim());
}

function extractSemesterNumber(str: string): number | null {
  const numMatch = str.match(/\b([1-8])(?:st|nd|rd|th)?\b/);
  if (numMatch) return parseInt(numMatch[1], 10);
  const romanMatch = str.match(/\b(viii|vii|vi|iv|v|iii|ii|i)\b/);
  if (romanMatch) return ROMAN_NUMERALS[romanMatch[1]] ?? null;
  const sMatch = str.match(/\bs([1-8])\b/);
  if (sMatch) return parseInt(sMatch[1], 10);
  return null;
}
