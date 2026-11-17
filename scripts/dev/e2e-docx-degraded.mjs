import { chromium } from 'playwright';
import { strToU8, zipSync } from 'fflate';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const sourceExtension = path.resolve('extension/dist');
const executablePath = process.env.CHROME_PATH;
const passphrase = 'docx-degraded-renderer-passphrase';
const temporaryPaths = [];
let failures = 0;

const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` :: ${String(detail).slice(0, 320)}` : ''}`);
  if (!condition) failures += 1;
};

function buildDocx() {
  const body = Array.from({ length: 30 }, (_, index) => (
    `<w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr><w:t>Degraded renderer paragraph ${index + 1} with deterministic text for local layout.</w:t></w:r></w:p>`
  )).join('');
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`),
  });
}

function message(page, requestId, operation, payload = {}) {
  return page.evaluate(({ request }) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 120_000);
    chrome.runtime.sendMessage(request, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  }), { request: { protocol: 1, requestId, operation, payload } });
}

async function prepareExtension(name, removeFontFaces, removeHarfBuzz) {
  const target = await mkdtemp(path.join(tmpdir(), `ff-${name}-extension-`));
  temporaryPaths.push(target);
  const extension = path.join(target, 'extension');
  await cp(sourceExtension, extension, { recursive: true });
  const fonts = path.join(extension, 'fonts');
  for (const file of await readdir(fonts)) {
    if (removeFontFaces && file.endsWith('.ttf')) await rm(path.join(fonts, file), { force: true });
    if (removeHarfBuzz && file === 'harfbuzz.wasm') await rm(path.join(fonts, file), { force: true });
  }
  return extension;
}

async function runCase(name, extension, expectation) {
  const profile = await mkdtemp(path.join(tmpdir(), `ff-${name}-profile-`));
  temporaryPaths.push(profile);
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        '--no-proxy-server',
        '--no-first-run',
      ],
    });
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/dashboard.html#/setup`, { waitUntil: 'load' });
    await page.waitForSelector('input[placeholder="e.g. Personal applications"]');
    await page.fill('input[placeholder="e.g. Personal applications"]', `${name} vault`);
    await page.locator('input[type=password]').nth(0).fill(passphrase);
    await page.locator('input[type=password]').nth(1).fill(passphrase);
    await page.click('button:has-text("Create encrypted vault")');
    await page.waitForURL(/#\/dashboard$/);
    await page.waitForTimeout(400);

    const imported = await message(page, `${name}_import`, 'IMPORT_DOCUMENT', {
      name: `${name}.docx`,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      dataBase64: Buffer.from(buildDocx()).toString('base64'),
      importId: `${name}_import`,
    });
    check(`${name}: DOCX import succeeds without failing the vault transaction`, imported?.ok === true, imported?.error);
    if (!imported?.ok) return;
    const text = await message(page, `${name}_text`, 'GET_DOCUMENT_TEXT', { documentId: imported.data.document.id });
    const pagination = text?.data?.structure?.pagination;
    check(`${name}: pagination never claims verified physical pages`, pagination?.status !== 'verified_physical', JSON.stringify(pagination?.status));
    if (expectation === 'font-substitution') {
      check(`${name}: degraded font resolution reports renderer-derived pages`, pagination?.status === 'renderer_derived_physical', JSON.stringify(pagination?.status));
      check(`${name}: missing font files produce an explicit font-substitution warning`, (pagination?.warnings ?? []).some((warning) => warning.code === 'DOCX_PAGINATION_FONT_SUBSTITUTION'), JSON.stringify(pagination?.warnings));
      check(`${name}: fallback warning is not fabricated`, !(pagination?.warnings ?? []).some((warning) => warning.code === 'DOCX_PAGINATION_RENDERER_UNAVAILABLE'), JSON.stringify(pagination?.warnings));
    } else {
      const fallback = pagination?.status === 'logical_fallback' || pagination?.status === 'explicit_breaks' || pagination?.status === 'renderer_reported_breaks';
      check(`${name}: missing HarfBuzz either degrades to a renderer warning or preserves the OOXML fallback`, pagination?.status === 'renderer_derived_physical' || fallback, JSON.stringify(pagination?.status));
      check(`${name}: failed renderer path is explicit`, pagination?.status === 'renderer_derived_physical'
        ? (pagination?.warnings ?? []).some((warning) => warning.code === 'DOCX_PAGINATION_FONT_SUBSTITUTION')
        : (pagination?.warnings ?? []).some((warning) => warning.code === 'DOCX_PAGINATION_RENDERER_UNAVAILABLE'), JSON.stringify(pagination?.warnings));
    }
  } finally {
    if (context) await context.close().catch(() => undefined);
  }
}

try {
  const missingFontsExtension = await prepareExtension('missing-fonts', true, false);
  await runCase('missing-fonts', missingFontsExtension, 'font-substitution');
  const missingWasmExtension = await prepareExtension('missing-wasm', false, true);
  await runCase('missing-wasm', missingWasmExtension, 'renderer-fallback');
  console.log(`FAILURES: ${failures}`);
  process.exitCode = failures ? 1 : 0;
} finally {
  for (const target of temporaryPaths) await rm(target, { recursive: true, force: true });
}
