declare module 'mammoth/mammoth.browser.js' {
  export interface MammothResult {
    value: string;
    messages: Array<{ type: string; message: string }>;
  }

  export interface MammothBrowserModule {
    extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<MammothResult>;
  }

  const mammoth: MammothBrowserModule;
  export default mammoth;
  export function extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<MammothResult>;
}
