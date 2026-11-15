import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyField,
  generateGroundedAnswer,
  kindToVaultKey,
  matchOption,
  extractBranchFromDegree,
} from '../src/lib/classifier.ts';
import { vaultForCollection, vaultRecord, type DemoVaultValue, type DemoCollection } from '../src/lib/vault.ts';

const testVault: DemoVaultValue[] = [
  { key: 'personal.fullName', label: 'Full name', value: 'Arunraj V.', source: 'Resume_Arunraj_V.pdf', confidence: 98, category: 'Personal' },
  { key: 'personal.firstName', label: 'First name', value: 'Arunraj', source: 'Resume_Arunraj_V.pdf', confidence: 98, category: 'Personal' },
  { key: 'education.degree', label: 'Degree', value: 'B.Tech in Computer Science and Engineering', source: 'Degree_Certificate_2025.pdf', confidence: 98, category: 'Education' },
  { key: 'employment.employer', label: 'Employer', value: 'Northstar Labs', source: 'Employment_Offer_Letter_2025.pdf', confidence: 93, category: 'Employment' },
  { key: 'employment.jobTitle', label: 'Job title', value: 'Software Engineer', source: 'Employment_Offer_Letter_2025.pdf', confidence: 92, category: 'Employment' },
  { key: 'contact.email', label: 'Email address', value: 'arun@example.com', source: 'Resume_Arunraj_V.pdf', confidence: 99, category: 'Contact' },
  { key: 'identification.number', label: 'Passport number', value: 'P•••••482', source: 'Passport_Bio_Page_Scan.pdf', confidence: 90, sensitive: true, category: 'Identity' },
];

const testCollections: DemoCollection[] = [
  { id: 'all', name: 'All', description: '', sources: [] },
  { id: 'col_job', name: 'Job applications', description: 'Resume', sources: ['Resume_Arunraj_V.pdf', 'Employment_Offer_Letter_2025.pdf'] },
  { id: 'col_identity', name: 'Identity & travel', description: 'Passport', sources: ['Passport_Bio_Page_Scan.pdf'] },
];

test('classifies common form labels deterministically', () => {
  assert.equal(classifyField({ label: 'Email address', type: 'text' }).kind, 'email');
  assert.equal(classifyField({ label: 'Date of birth', type: 'text' }).sensitive, true);
  assert.equal(classifyField({ label: 'First name' }).kind, 'firstName');
  assert.equal(classifyField({ label: 'Passport number' }).sensitive, true);
  assert.equal(classifyField({ label: 'Registration number' }).kind, 'registrationNumber');
  assert.equal(classifyField({ label: 'Why are you interested in this role?' }).kind, 'longAnswer');
});

test('unknown fields are not falsely matched', () => {
  const result = classifyField({ label: 'Favourite colour', name: 'favourite_colour' });
  assert.equal(result.kind, 'unknown');
  assert.equal(kindToVaultKey[result.kind], undefined);
});

test('collection scoping filters values by source document', () => {
  const job = vaultForCollection('col_job', testVault, testCollections);
  assert.ok(job.every((item) => ['Resume_Arunraj_V.pdf', 'Employment_Offer_Letter_2025.pdf'].includes(item.source)));
  assert.ok(job.some((item) => item.key === 'employment.employer'));
  const identity = vaultForCollection('col_identity', testVault, testCollections);
  assert.ok(identity.every((item) => item.source === 'Passport_Bio_Page_Scan.pdf'));
});

test('grounded long answers use only stored values', () => {
  const answer = generateGroundedAnswer('longAnswer', vaultRecord(testVault));
  assert.ok(answer?.includes('B.Tech in Computer Science'));
  assert.ok(answer?.includes('Northstar Labs'));
  assert.equal(generateGroundedAnswer('longAnswer', {}), null);
});

test('classifies branch, semester, and institution questions', () => {
  assert.equal(classifyField({ label: 'Branch' }).kind, 'branch');
  assert.equal(classifyField({ label: 'Select your major / department' }).kind, 'branch');
  assert.equal(classifyField({ label: 'Select your semester' }).kind, 'semester');
  assert.equal(classifyField({ label: 'College' }).kind, 'university');
  assert.equal(classifyField({ label: 'Institution' }).kind, 'university');
});

test('extracts branch from degree string', () => {
  assert.equal(extractBranchFromDegree('B.Tech in Computer Science and Engineering'), 'Computer Science and Engineering');
  assert.equal(extractBranchFromDegree('Bachelor of Electrical Engineering from MIT'), 'Electrical Engineering');
});

test('semantically matches branch acronym options without fabrication', () => {
  const options = ['CT', 'CM', 'EC', 'EE', 'EEE'];
  const match = matchOption('Computer Science and Engineering', options, 'branch');
  assert.ok(match !== null);
  assert.equal(match.match, 'CT');
  assert.ok(match.confidence >= 90);

  // Exact match
  assert.equal(matchOption('EC', options, 'branch')?.match, 'EC');

  // Stored branch not in options -> must be null (no fabrication!)
  const civilMatch = matchOption('Civil Engineering', options, 'branch');
  assert.equal(civilMatch, null);
});

test('semantically matches semester options', () => {
  const options = [
    'Semester 1', 'Semester 2', 'Semester 3', 'Semester 4',
    'Semester 5', 'Semester 6', 'Semester 7', 'Semester 8',
  ];
  assert.equal(matchOption('Semester 6', options, 'semester')?.match, 'Semester 6');
  assert.equal(matchOption('6th Sem', options, 'semester')?.match, 'Semester 6');
  assert.equal(matchOption('VI', options, 'semester')?.match, 'Semester 6');
  assert.equal(matchOption('6', options, 'semester')?.match, 'Semester 6');

  // Ambiguous / out of range
  assert.equal(matchOption('Semester 10', options, 'semester'), null);
});

