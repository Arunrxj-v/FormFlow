import type { VaultCategory } from './types';

export interface FieldDefinition {
  key: string;
  label: string;
  category: VaultCategory;
  sensitive?: boolean;
  synonyms: string[];
  valueHint?: 'text' | 'email' | 'phone' | 'date' | 'number' | 'longtext' | 'url';
}

/**
 * Canonical vault field catalogue. Deterministic matching and extraction both use
 * this single source of truth. Keys remain compatible with the previous FormFlow vault.
 */
export const FIELD_CATALOG: FieldDefinition[] = [
  { key: 'personal.fullName', label: 'Full name', category: 'personal', valueHint: 'text', synonyms: ['full name', 'name', 'your name', 'applicant name', 'candidate name', 'student name', 'name of applicant', "applicant's complete name", 'complete name', 'legal name', 'name as per certificate', 'name as per records'] },
  { key: 'personal.firstName', label: 'First name', category: 'personal', valueHint: 'text', synonyms: ['first name', 'given name', 'forename', 'fname'] },
  { key: 'personal.middleName', label: 'Middle name', category: 'personal', valueHint: 'text', synonyms: ['middle name', 'middle initial', 'mname'] },
  { key: 'personal.lastName', label: 'Last name', category: 'personal', valueHint: 'text', synonyms: ['last name', 'surname', 'family name', 'lname'] },
  { key: 'personal.dateOfBirth', label: 'Date of birth', category: 'personal', sensitive: true, valueHint: 'date', synonyms: ['date of birth', 'birth date', 'dob', 'birthday', 'date born'] },
  { key: 'personal.gender', label: 'Gender', category: 'personal', valueHint: 'text', synonyms: ['gender', 'sex', 'gender identity'] },
  { key: 'personal.nationality', label: 'Nationality', category: 'personal', valueHint: 'text', synonyms: ['nationality', 'citizenship', 'country of citizenship'] },
  { key: 'personal.maritalStatus', label: 'Marital status', category: 'personal', valueHint: 'text', synonyms: ['marital status', 'married status', 'civil status'] },
  { key: 'contact.email', label: 'Email address', category: 'contact', valueHint: 'email', synonyms: ['email', 'email address', 'e-mail', 'mail address', 'primary email', 'contact email'] },
  { key: 'contact.phone', label: 'Phone number', category: 'contact', valueHint: 'phone', synonyms: ['phone', 'phone number', 'mobile', 'mobile number', 'telephone', 'contact number', 'cell', 'whatsapp'] },
  { key: 'contact.alternatePhone', label: 'Alternate phone', category: 'contact', valueHint: 'phone', synonyms: ['alternate phone', 'alternative phone', 'secondary phone', 'other phone', 'alternate mobile'] },
  { key: 'contact.website', label: 'Website', category: 'contact', valueHint: 'url', synonyms: ['website', 'portfolio', 'personal website', 'web address'] },
  { key: 'contact.addressLine1', label: 'Address line 1', category: 'address', sensitive: true, valueHint: 'text', synonyms: ['address', 'address line 1', 'street address', 'residential address', 'mailing address', 'permanent address', 'current address', 'house name', 'door no', 'building'] },
  { key: 'contact.addressLine2', label: 'Address line 2', category: 'address', sensitive: true, valueHint: 'text', synonyms: ['address line 2', 'apartment', 'street', 'locality', 'area', 'landmark'] },
  { key: 'contact.city', label: 'City', category: 'address', sensitive: true, valueHint: 'text', synonyms: ['city', 'town', 'municipality'] },
  { key: 'contact.district', label: 'District', category: 'address', sensitive: true, valueHint: 'text', synonyms: ['district', 'county'] },
  { key: 'contact.state', label: 'State / province', category: 'address', sensitive: true, valueHint: 'text', synonyms: ['state', 'province', 'region', 'state or province'] },
  { key: 'contact.country', label: 'Country', category: 'address', valueHint: 'text', synonyms: ['country', 'country of residence', 'nation'] },
  { key: 'contact.postalCode', label: 'Postal code', category: 'address', sensitive: true, valueHint: 'text', synonyms: ['postal code', 'zip', 'zip code', 'pin code', 'pincode', 'postcode'] },
  { key: 'education.institution', label: 'Institution', category: 'education', valueHint: 'text', synonyms: ['institution', 'college', 'college name', 'school', 'school name', 'institute', 'institution name', 'name of institution', 'undergraduate institution', 'institution where you studied'] },
  { key: 'education.university', label: 'University', category: 'education', valueHint: 'text', synonyms: ['university', 'university name', 'awarding university', 'board', 'affiliating university', 'name of university'] },
  { key: 'education.degree', label: 'Degree', category: 'education', valueHint: 'text', synonyms: ['degree', 'qualification', 'course', 'course name', 'programme', 'program', 'degree obtained', 'highest qualification', 'undergraduate degree'] },
  { key: 'education.department', label: 'Department', category: 'education', valueHint: 'text', synonyms: ['department', 'dept', 'faculty'] },
  { key: 'education.branch', label: 'Branch / major', category: 'education', valueHint: 'text', synonyms: ['branch', 'major', 'discipline', 'field of study', 'stream', 'specialization', 'subject', 'area of study'] },
  { key: 'education.semester', label: 'Semester', category: 'education', valueHint: 'text', synonyms: ['semester', 'sem', 'current semester', 'year of study', 'term'] },
  { key: 'education.graduationYear', label: 'Graduation year', category: 'education', valueHint: 'number', synonyms: ['graduation year', 'year of graduation', 'year of passing', 'passing year', 'year completed', 'completion year', 'year of completion'] },
  { key: 'education.cgpa', label: 'CGPA / GPA', category: 'education', valueHint: 'number', synonyms: ['cgpa', 'gpa', 'grade point average', 'cumulative gpa'] },
  { key: 'education.percentage', label: 'Percentage', category: 'education', valueHint: 'number', synonyms: ['percentage', 'marks obtained', 'aggregate percentage', 'score percentage'] },
  { key: 'education.registrationNumber', label: 'Registration number', category: 'education', sensitive: true, valueHint: 'text', synonyms: ['registration number', 'registration no', 'roll number', 'roll no', 'enrolment number', 'enrollment number', 'student id', 'matriculation number'] },
  { key: 'employment.employer', label: 'Employer', category: 'employment', valueHint: 'text', synonyms: ['employer', 'company', 'company name', 'organization', 'organisation', 'current company', 'current employer', 'name of employer'] },
  { key: 'employment.jobTitle', label: 'Job title', category: 'employment', valueHint: 'text', synonyms: ['job title', 'designation', 'position', 'role', 'current title', 'current position', 'title'] },
  { key: 'employment.employmentType', label: 'Employment type', category: 'employment', valueHint: 'text', synonyms: ['employment type', 'job type', 'full time', 'part time', 'work type'] },
  { key: 'employment.startDate', label: 'Employment start date', category: 'employment', valueHint: 'date', synonyms: ['employment start date', 'start date', 'joined on', 'date of joining'] },
  { key: 'employment.endDate', label: 'Employment end date', category: 'employment', valueHint: 'date', synonyms: ['employment end date', 'end date', 'date of leaving', 'last working day'] },
  { key: 'employment.experience', label: 'Total experience', category: 'employment', valueHint: 'text', synonyms: ['total experience', 'years of experience', 'work experience', 'experience'] },
  { key: 'employment.responsibilities', label: 'Responsibilities', category: 'employment', valueHint: 'longtext', synonyms: ['responsibilities', 'job responsibilities', 'duties', 'work description'] },
  { key: 'skills.technical', label: 'Technical skills', category: 'skills', valueHint: 'longtext', synonyms: ['skills', 'technical skills', 'key skills', 'competencies', 'expertise', 'programming languages', 'technologies known'] },
  { key: 'certifications.name', label: 'Certification', category: 'certifications', valueHint: 'text', synonyms: ['certification', 'certificate', 'certification name', 'professional certificate'] },
  { key: 'certifications.issuer', label: 'Issuing authority', category: 'certifications', valueHint: 'text', synonyms: ['issuing authority', 'issuer', 'issued by', 'certifying authority'] },
  { key: 'certifications.issueDate', label: 'Certification issue date', category: 'certifications', valueHint: 'date', synonyms: ['issue date', 'date of issue'] },
  { key: 'certifications.expiryDate', label: 'Certification expiry date', category: 'certifications', valueHint: 'date', synonyms: ['expiry date', 'expiration date', 'valid until'] },
  { key: 'identification.number', label: 'Identification number', category: 'identification', sensitive: true, valueHint: 'text', synonyms: ['passport number', 'aadhaar', 'aadhar', 'social security number', 'ssn', 'national id', 'identity number', 'id number', 'government id'] },
  { key: 'identification.type', label: 'Identification type', category: 'identification', sensitive: true, valueHint: 'text', synonyms: ['identification type', 'id type', 'document type'] },
  { key: 'projects.title', label: 'Project title', category: 'projects', valueHint: 'text', synonyms: ['project title', 'project name'] },
  { key: 'projects.description', label: 'Project description', category: 'projects', valueHint: 'longtext', synonyms: ['project description', 'describe your project', 'project details'] },
  { key: 'projects.technologies', label: 'Project technologies', category: 'projects', valueHint: 'text', synonyms: ['technologies used', 'project technologies', 'tech stack'] },
  { key: 'other.summary', label: 'Professional summary', category: 'other', valueHint: 'longtext', synonyms: ['professional summary', 'summary', 'about you', 'personal statement', 'bio'] },
  { key: 'other.achievements', label: 'Achievements', category: 'other', valueHint: 'longtext', synonyms: ['achievements', 'awards', 'honors'] },
];

export const FIELD_BY_KEY: Record<string, FieldDefinition> = Object.fromEntries(
  FIELD_CATALOG.map((field) => [field.key, field]),
);

export const SENSITIVE_KEYS = new Set(
  FIELD_CATALOG.filter((field) => field.sensitive).map((field) => field.key),
);

export function labelForKey(key: string): string {
  return FIELD_BY_KEY[key]?.label ?? key.split('.').slice(-1)[0]?.replace(/([A-Z])/g, ' $1').trim() ?? key;
}

export function categoryForKey(key: string): VaultCategory {
  return FIELD_BY_KEY[key]?.category ?? (key.split('.')[0] as VaultCategory) ?? 'other';
}
