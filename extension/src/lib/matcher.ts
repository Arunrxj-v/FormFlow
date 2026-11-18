import type { VaultField } from '@shared/types';
import type { MatchSuggestion, ScanFieldPayload } from '@shared/messages';
import {
  generateGroundedAnswer,
  kindToVaultKey,
  matchOption,
} from './classifier';

function recordFromFields(fields: VaultField[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const field of fields) map[field.key] = field.value;
  return map;
}

export function buildSuggestions(
  fields: VaultField[],
  scanFields: ScanFieldPayload[],
  options: { allowLongAnswers?: boolean } = {},
): MatchSuggestion[] {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const record = recordFromFields(fields);

  return scanFields.map((field) => {
    if (field.unsupported) {
      return {
        index: field.index,
        fieldLabel: field.label,
        fieldKind: field.kind,
        value: '',
        confidence: 0,
        method: 'deterministic',
        needsReview: false,
        reason: field.unsupportedReason ?? 'Unsupported field type.',
        sensitive: field.sensitive,
        unsupported: true,
        unsupportedReason: field.unsupportedReason,
      };
    }

    const key = kindToVaultKey[field.kind];
    let item = key ? byKey.get(key) : undefined;
    if (!item && key === 'skills.technical') item = byKey.get('other.skills');

    const generated = field.kind === 'longAnswer' && options.allowLongAnswers !== false
      ? generateGroundedAnswer('longAnswer', record)
      : null;
    let value = item?.value ?? generated ?? '';
    let confidence = item?.confidence ?? (generated ? 72 : 0);
    let needsReview = false;
    let reason = item ? `Matched ${item.label.toLowerCase()} from ${item.source.documentName}.` : generated ? 'Generated from verified vault values.' : 'No matching vault value.';

    if (field.options?.length && item?.value) {
      const matchedOption = matchOption(item.value, field.options, field.kind);
      if (matchedOption) {
        value = matchedOption.match;
        confidence = Math.min(confidence, matchedOption.confidence);
      } else {
        value = '';
        confidence = 0;
        needsReview = true;
        reason = 'The vault value does not match any available option. Choose a value before filling.';
      }
    }

    if (item?.conflicts?.length) needsReview = true;
    if (item?.verificationStatus === 'extracted' && item.sensitive) needsReview = true;

    return {
      index: field.index,
      fieldLabel: field.label,
      fieldKind: field.kind,
      value,
      sourceDocumentId: item?.source.documentId,
      sourceDocumentName: item?.source.documentName,
      sourcePage: item?.sourcePage,
      recordId: item?.id,
      confidence,
      method: generated ? 'contextual' : 'deterministic',
      needsReview,
      reason,
      sensitive: Boolean(item?.sensitive || field.sensitive),
      conflict: Boolean(item?.conflicts?.length),
      alternates: item?.conflicts?.map((conflict) => ({
        value: conflict.value,
        sourceDocumentName: conflict.source.documentName,
        confidence: conflict.confidence,
      })),
      options: field.options,
    } satisfies MatchSuggestion;
  });
}
