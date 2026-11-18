import test from 'node:test';
import assert from 'node:assert/strict';
import { augmentAmbiguousWithAi } from '../../extension/src/lib/ai-matcher';
import { buildSuggestions } from '../../extension/src/lib/matcher';
import type { ScanFieldPayload } from '../../shared/messages';
import type { VaultField } from '../../shared/types';

const fields: VaultField[] = [
  {
    id: 'val_email',
    key: 'contact.email',
    label: 'Email address',
    value: 'arun@example.com',
    category: 'contact',
    source: { documentId: 'doc_1', documentName: 'resume.txt' },
    confidence: 99,
    verificationStatus: 'user_verified',
  },
  {
    id: 'val_degree',
    key: 'education.degree',
    label: 'Degree',
    value: 'B.Tech Computer Science',
    category: 'education',
    source: { documentId: 'doc_1', documentName: 'degree.pdf' },
    confidence: 88,
    verificationStatus: 'extracted',
  },
  {
    id: 'val_branch',
    key: 'education.branch',
    label: 'Branch',
    value: 'CSE',
    category: 'education',
    source: { documentId: 'doc_1', documentName: 'degree.pdf' },
    confidence: 84,
    verificationStatus: 'extracted',
  },
];

function scanField(index: number, label: string, kind: ScanFieldPayload['kind'], options?: string[]): ScanFieldPayload {
  return {
    index,
    label,
    kind,
    confidence: 0,
    sensitive: false,
    tag: 'input',
    type: 'text',
    required: false,
    currentValue: '',
    ...(options ? { options } : {}),
  };
}

test('AI matching only fills ambiguous fields and never overrides deterministic matches', async () => {
  const scan = [
    scanField(0, 'Email address', 'email'),
    scanField(1, 'Academic programme', 'unknown'),
    scanField(2, 'Stream', 'unknown', ['CSE', 'ECE', 'Mechanical']),
  ];
  const suggestions = buildSuggestions(fields, scan);
  assert.equal(suggestions[0]?.value, 'arun@example.com');
  assert.equal(suggestions[1]?.value, '');
  const calls: string[] = [];
  const outcome = await augmentAmbiguousWithAi(fields, scan, suggestions, async (messages) => {
    calls.push(messages.map((message) => message.content).join('\n'));
    return {
      text: JSON.stringify({
        matches: [
          { index: 0, key: 'education.degree', confidence: 90 },
          { index: 1, key: 'education.degree', confidence: 80, reason: 'programme means degree' },
          { index: 2, key: 'education.branch', confidence: 75, reason: 'stream means branch' },
        ],
      }),
    };
  });
  assert.equal(calls.length, 1);
  assert.equal(outcome.matched, 2);
  assert.equal(outcome.suggestions[0]?.value, 'arun@example.com');
  assert.equal(outcome.suggestions[0]?.method, 'deterministic');
  assert.equal(outcome.suggestions[1]?.value, 'B.Tech Computer Science');
  assert.equal(outcome.suggestions[1]?.method, 'ai');
  assert.equal(outcome.suggestions[1]?.needsReview, true);
  assert.equal(outcome.suggestions[2]?.value, 'CSE', 'option matching is deterministic');
  assert.ok(outcome.suggestions[2]?.needsReview);
});

test('scan-level sensitive classification cannot be downgraded by vault metadata', () => {
  const scan = [{ ...scanField(0, 'Email address', 'email'), sensitive: true }];
  const suggestions = buildSuggestions(fields, scan);
  assert.equal(suggestions[0]?.sensitive, true);
  assert.equal(suggestions[0]?.value, 'arun@example.com');
});

test('AI matching rejects unknown keys and option mismatches', async () => {
  const scan = [
    scanField(0, 'Favourite colour of your pet', 'unknown'),
    scanField(1, 'Academic programme', 'unknown', ['ECE', 'Mechanical']),
  ];
  const suggestions = buildSuggestions(fields, scan);
  const outcome = await augmentAmbiguousWithAi(fields, scan, suggestions, async () => ({
    text: JSON.stringify({
      matches: [
        { index: 0, key: 'unknown.key' },
        { index: 1, key: 'education.degree' },
      ],
    }),
  }));
  assert.equal(outcome.matched, 0);
  assert.equal(outcome.suggestions[0]?.value, '');
  assert.equal(outcome.suggestions[1]?.value, '', 'degree has no matching option');
});

test('AI matching is not requested when every field already has a deterministic match', async () => {
  const scan = [scanField(0, 'Email address', 'email')];
  const suggestions = buildSuggestions(fields, scan);
  let called = false;
  const outcome = await augmentAmbiguousWithAi(fields, scan, suggestions, async () => {
    called = true;
    return { text: '{}' };
  });
  assert.equal(called, false);
  assert.equal(outcome.matched, 0);
});


test('long-answer generation is disabled when the setting is off', async () => {
  const vault = [
    ...fields,
    {
      id: 'val_degree',
      key: 'education.degree',
      label: 'Degree',
      value: 'B.Tech Computer Science',
      category: 'education' as const,
      source: { documentId: 'doc_1', documentName: 'degree.pdf' },
      confidence: 90,
      verificationStatus: 'user_verified' as const,
    },
  ];
  const scan = [scanField(0, 'Describe your academic background', 'longAnswer')];
  const enabled = buildSuggestions(vault, scan, { allowLongAnswers: true });
  assert.ok(enabled[0]?.value.includes('B.Tech'));
  const disabled = buildSuggestions(vault, scan, { allowLongAnswers: false });
  assert.equal(disabled[0]?.value, '');
  assert.equal(disabled[0]?.confidence, 0);
});
