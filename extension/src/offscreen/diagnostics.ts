/** Test-build-only diagnostics channel; production resolves to diagnostics.prod.ts. */
export function publishOffscreenDiagnostics(port: chrome.runtime.Port | null, diagnostics: unknown): void {
  try {
    port?.postMessage({ type: '__TEST_DIAGNOSTICS', diagnostics: { ...(diagnostics as Record<string, unknown>) } });
  } catch {
    // Diagnostics are best-effort and contain no document content or keys.
  }
}
