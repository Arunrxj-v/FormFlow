import { FIELD_BY_KEY } from '@shared/field-catalog';

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function normalizeEmail(value: string): string {
  return collapseWhitespace(value).toLowerCase();
}

export function normalizePhone(value: string): string {
  return value.replace(/[^\d+]/g, '').replace(/^\+?0+/, '+');
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(value.trim());
}

export function isValidPhone(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

export function normalizeDate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const direct = Date.parse(trimmed);
  if (!Number.isNaN(direct)) return new Date(direct).toISOString().slice(0, 10);

  const dayFirst = trimmed.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (dayFirst) {
    const day = Number(dayFirst[1]);
    const month = Number(dayFirst[2]);
    const year = Number(dayFirst[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const named = trimmed.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  if (named) {
    const month = monthNames.indexOf(named[2].slice(0, 3).toLowerCase()) + 1;
    if (month > 0) return `${named[3]}-${String(month).padStart(2, '0')}-${String(Number(named[1])).padStart(2, '0')}`;
  }

  return null;
}

export function normalizeValue(key: string, value: string): string {
  const definition = FIELD_BY_KEY[key];
  const trimmed = collapseWhitespace(value);
  switch (definition?.valueHint) {
    case 'email':
      return normalizeEmail(trimmed);
    case 'phone':
      return normalizePhone(trimmed);
    case 'date':
      return normalizeDate(trimmed) ?? trimmed.toLowerCase();
    case 'number':
      return trimmed.replace(/,/g, '').replace(/\s*(cgpa|gpa|%|percent)$/i, '').trim();
    default:
      return trimmed.toLowerCase();
  }
}

export function validateValueForKey(key: string, value: string): { ok: boolean; reason?: string } {
  const definition = FIELD_BY_KEY[key];
  if (!definition) return { ok: false, reason: `Unknown field key: ${key}` };
  if (!value.trim()) return { ok: false, reason: 'Value is empty.' };
  if (value.length > 2000) return { ok: false, reason: 'Value is longer than the supported limit.' };
  if (definition.valueHint === 'email' && !isValidEmail(value)) return { ok: false, reason: 'Value is not a valid email address.' };
  if (definition.valueHint === 'phone' && !isValidPhone(value)) return { ok: false, reason: 'Value is not a valid phone number.' };
  if (definition.valueHint === 'date' && !normalizeDate(value)) return { ok: false, reason: 'Value is not a recognised date.' };
  if (key === 'contact.website' && !/^https?:\/\//i.test(value) && !/^[\w-]+\.[a-z]{2,}/i.test(value)) {
    return { ok: false, reason: 'Value is not a valid website address.' };
  }
  return { ok: true };
}

export function valueAppearsInSource(value: string, sourceText: string): boolean {
  const normalizedSource = sourceText.toLowerCase().replace(/\s+/g, ' ');
  const normalizedValue = value.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalizedValue) return false;
  if (normalizedSource.includes(normalizedValue)) return true;
  if (FIELD_BY_KEY.contact?.label) {
    // Dates may appear in a different written form; compare digits too.
    const digits = normalizedValue.replace(/\D/g, '');
    if (digits.length >= 4 && /\d/.test(normalizedSource) && normalizedSource.replace(/\D/g, '').includes(digits)) return true;
  }
  return false;
}

export function maskValue(value: string): string {
  if (value.length <= 4) return '••••';
  return `${value.slice(0, 2)}••••${value.slice(-2)}`;
}
