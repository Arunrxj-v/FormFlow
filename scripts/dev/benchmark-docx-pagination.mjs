import { chromium } from 'playwright';
import { strToU8, zipSync } from 'fflate';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const execFileAsync = promisify(execFile);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const extensionPath = path.join(root, 'extension', 'dist');
const tempDir = await mkdtemp(path.join(tmpdir(), 'ff-docx-benchmark-'));
const executablePath = process.env.CHROME_PATH;
const external = ['fs', 'url', 'path', 'fs/promises', 'node:fs', 'node:url', 'node:path', 'node:fs/promises'];

function paragraphXml(text, options = {}) {
  const font = options.font ?? 'Calibri';
  const size = options.size ?? 11;
  const bold = options.bold ? '<w:b/>' : '';
  return `<w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/>${bold}<w:sz w:val="${size * 2}"/><w:szCs w:val="${size * 2}"/></w:rPr><w:t xml:space="preserve">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</w:t></w:r></w:p>`;
}

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
  'base64',
);

function inlinePictureXml(relationshipId, index) {
  return `<w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="1828800" cy="1371600"/><wp:docPr id="${index}" name="image${index}" descr="Benchmark image"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${index}" name="image${index}.png" descr="Benchmark image"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="1371600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
}

function mixedRunsParagraphXml(runs) {
  const xml = runs.map((run) => `<w:r><w:rPr><w:rFonts w:ascii="${run.font}" w:hAnsi="${run.font}"/><w:sz w:val="${run.size * 2}"/><w:szCs w:val="${run.size * 2}"/>${run.bold ? '<w:b/>' : ''}${run.italic ? '<w:i/>' : ''}</w:rPr><w:t xml:space="preserve">${run.text}</w:t></w:r>`).join('');
  return `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>${xml}</w:p>`;
}

function buildMixedFontDocx(count) {
  const body = Array.from({ length: count }, () => mixedRunsParagraphXml([
    { text: 'Calibri segment ', font: 'Calibri', size: 11 },
    { text: 'Arial segment ', font: 'Arial', size: 10, bold: true },
    { text: 'Times deterministic text.', font: 'Times New Roman', size: 13, italic: true },
  ])).join('');
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`),
  });
}

function buildNestedTableDocx(rows) {
  const inner = (row) => `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc>${paragraphXml(`Inner ${row}A`, { size: 9 })}</w:tc><w:tc>${paragraphXml(`Inner ${row}B`, { size: 9 })}</w:tc></w:tr></w:tbl>`;
  const body = Array.from({ length: rows }, (_, row) => `<w:tr><w:tc>${paragraphXml(`Outer ${row + 1}.1`, { size: 9 })}${inner(row + 1)}</w:tc><w:tc>${paragraphXml(`Outer ${row + 1}.2`, { size: 9 })}</w:tc></w:tr>`).join('');
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl>${body}</w:tbl><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`),
  });
}

function buildImageDocx(count) {
  const body = Array.from({ length: count }, (_, index) => `<w:p><w:r>${inlinePictureXml(`rIdImg${index + 1}`, index + 1)}</w:r></w:p>`).join('');
  const relationships = Array.from({ length: count }, (_, index) => `<Relationship Id="rIdImg${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${index + 1}.png"/>`).join('');
  const media = Object.fromEntries(Array.from({ length: count }, (_, index) => [`word/media/image${index + 1}.png`, PNG_1X1]));
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/_rels/document.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`),
    ...media,
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`),
  });
}

function buildHeaderFooterInheritedDocx(paragraphs) {
  const body = Array.from({ length: paragraphs }, (_, index) => paragraphXml(`Inherited header body paragraph ${index + 1}`)).join('');
  const header = `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:p><w:r>${inlinePictureXml('rIdHeaderImage', 1)}</w:r></w:p></w:hdr>`;
  const footer = `<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:p><w:r>${inlinePictureXml('rIdFooterImage', 2)}</w:r></w:p></w:ftr>`;
  const section = (extra = '') => `<w:sectPr>${extra}<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>`;
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/_rels/document.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>'),
    'word/_rels/header1.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdHeaderImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/header.png"/></Relationships>'),
    'word/_rels/footer1.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdFooterImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/footer.png"/></Relationships>'),
    'word/header1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${header}`),
    'word/footer1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${footer}`),
    'word/media/header.png': PNG_1X1,
    'word/media/footer.png': PNG_1X1,
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}${section('<w:headerReference w:type="default" r:id="rIdHeader"/><w:footerReference w:type="default" r:id="rIdFooter"/>')}<w:p><w:r><w:t>Inherited section</w:t></w:r></w:p>${section()}</w:body></w:document>`),
  });
}

function buildDocx({ paragraphs, tableRows = 0, tableColumns = 3 }) {
  const body = [];
  for (const paragraph of paragraphs) body.push(paragraphXml(paragraph.text, paragraph));
  if (tableRows > 0) {
    const rows = Array.from({ length: tableRows }, (_, row) => (
      `<w:tr>${Array.from({ length: tableColumns }, (_, column) => `<w:tc>${paragraphXml(`Row ${row + 1} column ${column + 1}`, { size: 10 })}</w:tc>`).join('')}</w:tr>`
    )).join('');
    body.push(`<w:tbl><w:tblGrid>${Array.from({ length: tableColumns }, () => '<w:gridCol w:w="3000"/>').join('')}</w:tblGrid>${rows}</w:tbl>`);
  }
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(documentXml),
  });
}

async function directoryBytes(directory) {
  let bytes = 0;
  let files = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await directoryBytes(target);
      bytes += nested.bytes;
      files += nested.files;
    } else if (entry.isFile()) {
      bytes += (await stat(target)).size;
      files += 1;
    }
  }
  return { bytes, files };
}

async function bundleWorker() {
  await build({
    entryPoints: [path.join(root, 'scripts', 'dev', 'docx-layout-benchmark-worker.ts')],
    outfile: path.join(tempDir, 'worker.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome109',
    minify: true,
    sourcemap: false,
    logLevel: 'silent',
    alias: { '@shared': path.join(root, 'shared') },
    external,
  });
}

function contentTypes(extensions) {
  return {
    '.js': 'text/javascript',
    '.html': 'text/html',
    '.wasm': 'application/wasm',
    '.ttf': 'font/ttf',
    '.json': 'application/json',
  }[extensions] ?? 'application/octet-stream';
}

async function startServer() {
  const worker = await readFile(path.join(tempDir, 'worker.js'));
  const fontRoot = path.join(extensionPath, 'fonts');
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<!doctype html><html><body>docx layout benchmark</body></html>');
        return;
      }
      if (url.pathname === '/worker.js') {
        response.writeHead(200, { 'content-type': 'text/javascript' });
        response.end(worker);
        return;
      }
      if (url.pathname.startsWith('/fonts/')) {
        const name = path.basename(url.pathname);
        if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
          response.writeHead(404);
          response.end();
          return;
        }
        const data = await readFile(path.join(fontRoot, name));
        response.writeHead(200, { 'content-type': contentTypes(path.extname(name)) });
        response.end(data);
        return;
      }
      response.writeHead(404);
      response.end();
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

async function newBenchmarkWorker(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const started = performance.now();
    const worker = new Worker('/worker.js', { type: 'module' });
    const timer = setTimeout(() => resolve({ startupMs: performance.now() - started, error: 'worker ready timeout' }), 15_000);
    const onMessage = (event) => {
      if (event.data?.type !== 'ready' && event.data?.type !== 'fatal') return;
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      if (event.data.type === 'fatal') {
        resolve({ startupMs: performance.now() - started, error: `${event.data.message ?? 'fatal'}\n${event.data.stack ?? ''}` });
        return;
      }
      window.__docxBenchmarkWorker = worker;
      resolve({ startupMs: performance.now() - started, readyHeap: event.data.heapUsed });
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', (event) => {
      clearTimeout(timer);
      resolve({ startupMs: performance.now() - started, error: event.message || event.error?.message || 'worker error' });
    }, { once: true });
  }));
}

async function runBenchmark(page, id, bytes, cancelAfterMs) {
  return page.evaluate(({ id: requestId, values, cancelAfter }) => new Promise((resolve) => {
    const worker = window.__docxBenchmarkWorker;
    const timer = setTimeout(() => resolve({ id: requestId, timeout: true }), 120_000);
    const onMessage = (event) => {
      if (event.data?.id !== requestId) return;
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      resolve(event.data);
    };
    worker.addEventListener('message', onMessage);
    const buffer = Uint8Array.from(values).buffer;
    worker.postMessage({ id: requestId, bytes: buffer, ...(cancelAfter ? { cancelAfterMs: cancelAfter } : {}) }, [buffer]);
  }), { id, values: Array.from(bytes), cancelAfter: cancelAfterMs });
}

async function terminateWorker(page) {
  await page.evaluate(() => window.__docxBenchmarkWorker?.terminate());
}

async function processTreeRss(rootPid) {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,rss='], { maxBuffer: 8 * 1024 * 1024 });
  const entries = stdout.trim().split('\n').map((line) => {
    const [pid, parent, rss] = line.trim().split(/\s+/).map(Number);
    return { pid, parent, rss };
  }).filter((entry) => Number.isFinite(entry.pid) && Number.isFinite(entry.parent) && Number.isFinite(entry.rss));
  const children = new Map();
  for (const entry of entries) {
    const list = children.get(entry.parent) ?? [];
    list.push(entry);
    children.set(entry.parent, list);
  }
  let total = 0;
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    const entry = entries.find((candidate) => candidate.pid === pid);
    if (entry) total += entry.rss;
    for (const child of children.get(pid) ?? []) stack.push(child.pid);
  }
  return total * 1024;
}

async function measureRun(rootPid, run) {
  const baseline = await processTreeRss(rootPid);
  let peak = baseline;
  let polling = true;
  const poll = (async () => {
    while (polling) {
      peak = Math.max(peak, await processTreeRss(rootPid));
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  })();
  try {
    const result = await run();
    return { result, baseline, peak };
  } finally {
    polling = false;
    await poll;
  }
}

const corpus = [
  {
    name: 'paragraphs-120',
    bytes: buildDocx({ paragraphs: Array.from({ length: 120 }, (_, index) => ({ text: `Paragraph ${index + 1} — deterministic text for pagination measurement.` })) }),
  },
  {
    name: 'paragraphs-500',
    bytes: buildDocx({ paragraphs: Array.from({ length: 500 }, (_, index) => ({ text: `Paragraph ${index + 1} — deterministic text for pagination measurement.` })) }),
  },
  {
    name: 'paragraphs-1000',
    bytes: buildDocx({ paragraphs: Array.from({ length: 1_000 }, (_, index) => ({ text: `Paragraph ${index + 1} — deterministic text for pagination measurement.` })) }),
  },
  {
    name: 'paragraphs-1200',
    bytes: buildDocx({ paragraphs: Array.from({ length: 1_200 }, (_, index) => ({ text: `Paragraph ${index + 1} — deterministic text for pagination measurement.` })) }),
  },
  {
    name: 'paragraphs-5000',
    bytes: buildDocx({ paragraphs: Array.from({ length: 5_000 }, (_, index) => ({ text: `Paragraph ${index + 1} — deterministic text for pagination measurement.` })) }),
  },
  {
    name: 'table-500-rows',
    bytes: buildDocx({
      paragraphs: [{ text: 'Table benchmark introduction' }],
      tableRows: 500,
    }),
  },
  {
    name: 'mixed-fonts-500',
    bytes: buildDocx({
      paragraphs: Array.from({ length: 500 }, (_, index) => ({
        text: `Mixed paragraph ${index + 1} with local font measurement text.`,
        font: index % 3 === 0 ? 'Calibri' : index % 3 === 1 ? 'Arial' : 'Times New Roman',
        size: index % 4 === 0 ? 14 : 11,
      })),
    }),
  },
  {
    name: 'mixed-fonts-5000',
    bytes: buildMixedFontDocx(5_000),
  },
  {
    name: 'nested-table-500-rows',
    bytes: buildNestedTableDocx(500),
  },
  {
    name: 'images-200',
    bytes: buildImageDocx(200),
  },
  {
    name: 'header-footer-inherited-500',
    bytes: buildHeaderFooterInheritedDocx(500),
  },
];

let context;
let browser;
let browserServer;
let server;
try {
  await bundleWorker();
  const served = await startServer();
  server = served.server;
  browserServer = await chromium.launchServer({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ['--js-flags=--expose-gc', '--enable-precise-memory-info', '--no-proxy-server', '--no-first-run'],
  });
  const browserPid = browserServer.process()?.pid;
  browser = await chromium.connect(browserServer.wsEndpoint());
  context = await browser.newContext();
  const page = await context.newPage();
  page.on('crash', () => console.error('BENCHMARK_PAGE_CRASHED'));
  page.on('console', (message) => {
    if (message.type() === 'error') console.error('BENCHMARK_CONSOLE', message.text().slice(0, 500));
  });
  await page.goto(`http://127.0.0.1:${served.port}/`, { waitUntil: 'load' });
  const results = [];

  for (const item of corpus) {
    const startup = await newBenchmarkWorker(page);
    console.log('BENCHMARK_STARTUP', item.name, JSON.stringify(startup));
    if (startup.error) throw new Error(`Benchmark worker failed for ${item.name}: ${startup.error}`);
    const measured = await measureRun(browserPid, () => runBenchmark(page, `bench_${item.name}`, item.bytes));
    const result = measured.result;
    const coldMemory = { rssBaseline: measured.baseline, rssPeak: measured.peak };
    if (item.name === 'paragraphs-120') {
      const warmMeasured = await measureRun(browserPid, () => runBenchmark(page, `bench_${item.name}_warm`, item.bytes));
      results.push({
        name: item.name,
        sizeBytes: item.bytes.byteLength,
        startup,
        ...result,
        ...coldMemory,
        warm: warmMeasured.result,
        warmRssBaseline: warmMeasured.baseline,
        warmRssPeak: warmMeasured.peak,
      });
    } else {
      results.push({ name: item.name, sizeBytes: item.bytes.byteLength, startup, ...result, ...coldMemory });
    }
    await terminateWorker(page);
  }

  const cancelStartup = await newBenchmarkWorker(page);
  const cancelMeasured = await measureRun(browserPid, () => runBenchmark(page, 'bench_cancel', corpus.find((item) => item.name === 'paragraphs-1200').bytes, 5));
  const cancelResult = cancelMeasured.result;
  await terminateWorker(page);
  results.push({
    name: 'cancel-paragraphs-1200',
    startup: cancelStartup,
    cancel: cancelResult,
    rssBaseline: cancelMeasured.baseline,
    rssPeak: cancelMeasured.peak,
  });

  const extensionBytes = await directoryBytes(extensionPath);
  const fontBytes = await directoryBytes(path.join(extensionPath, 'fonts'));
  const workerBytes = (await stat(path.join(extensionPath, 'document-parser.worker.js'))).size;
  const offscreenBytes = (await stat(path.join(extensionPath, 'offscreen-parser.js'))).size;
  const backgroundBytes = (await stat(path.join(extensionPath, 'background.js'))).size;
  const wasmBytes = (await stat(path.join(extensionPath, 'fonts', 'harfbuzz.wasm'))).size;
  const ttfBytes = await Promise.all(
    (await readdir(path.join(extensionPath, 'fonts')))
      .filter((name) => name.endsWith('.ttf'))
      .map(async (name) => (await stat(path.join(extensionPath, 'fonts', name))).size),
  );
  const fontAssetBytes = ttfBytes.reduce((sum, value) => sum + value, 0);

  const lines = [];
  lines.push('# Phase 4.1.4.2 DOCX pagination fidelity and image performance');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('Environment: Apple Silicon macOS, Chromium launched by Playwright, dedicated module worker, packaged Carlito/Liberation fonts and HarfBuzz WASM served locally.');
  lines.push('');
  lines.push('## Bundle and asset size');
  lines.push('');
  lines.push('| Asset | Size |');
  lines.push('| --- | ---: |');
  lines.push(`| Extension dist (${extensionBytes.files} files) | ${(extensionBytes.bytes / 1024 / 1024).toFixed(2)} MB |`);
  lines.push(`| Parser worker bundle | ${(workerBytes / 1024 / 1024).toFixed(2)} MB |`);
  lines.push(`| Offscreen document bundle | ${(offscreenBytes / 1024 / 1024).toFixed(2)} MB |`);
  lines.push(`| Background service worker bundle | ${(backgroundBytes / 1024 / 1024).toFixed(2)} MB |`);
  lines.push(`| HarfBuzz WASM | ${(wasmBytes / 1024).toFixed(0)} KB |`);
  lines.push(`| Packaged TTF faces | ${(fontAssetBytes / 1024 / 1024).toFixed(2)} MB |`);
  lines.push(`| Font/WASM directory total | ${(fontBytes.bytes / 1024 / 1024).toFixed(2)} MB |`);
  lines.push('');
  lines.push('## Layout runtime');
  lines.push('');
  lines.push('| Case | Worker startup | Cold parse | Font resolution | Renderer layout | Geometry/image mapping | Total pagination | Warm total | Pages | Mapped blocks | Fragment entries | Browser RSS baseline | Browser RSS peak | RSS delta | Serialized pagination |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  const ms = (value) => value === undefined || value === null ? '—' : `${Math.round(value)} ms`;
  const mb = (value) => value === null || value === undefined ? '—' : `${(value / 1024 / 1024).toFixed(1)} MB`;
  for (const result of results) {
    if (result.cancel) {
      lines.push(`| ${result.name} | ${ms(result.startup.startupMs)} | — | — | — | — | — | — | — | — | — | ${mb(result.rssBaseline)} | ${mb(result.rssPeak)} | ${mb(result.rssPeak - result.rssBaseline)} | — |`);
      continue;
    }
    lines.push(`| ${result.name} | ${ms(result.startup.startupMs)} | ${ms(result.parseMs)} | ${ms(result.fontResolutionMs)} | ${ms(result.rendererLayoutMs)} | ${ms(result.mappingMs)} | ${ms(result.layoutMs)} | ${result.warm ? ms(result.warm.layoutMs) : '—'} | ${result.pageCount} | ${result.blockPageCount} | ${result.fragmentPageCount} | ${mb(result.rssBaseline)} | ${mb(result.rssPeak)} | ${mb(result.rssPeak - result.rssBaseline)} | ${(result.serializedChars / 1024).toFixed(0)} KB |`);
  }
  lines.push('');
  lines.push('## Image placement metadata');
  lines.push('');
  lines.push('| Case | Image blocks | Physical-page appearances | Image metadata | Total structure |');
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  for (const result of results) {
    if (result.cancel) continue;
    if (!result.imageBlocks && !result.imageAppearances) continue;
    lines.push(`| ${result.name} | ${result.imageBlocks ?? 0} | ${result.imageAppearances ?? 0} | ${((result.imageMetadataChars ?? 0) / 1024).toFixed(1)} KB | ${(result.structureChars / 1024).toFixed(0)} KB |`);
  }
  lines.push('');
  lines.push('Inherited header/footer images remain one source block per part; only their `appearances` array grows with the page count. Image bytes are never included in `DocumentStructure`.');
  lines.push('');
  lines.push('## Cancellation');
  lines.push('');
  lines.push(`- Cancellation was issued 5 ms after layout started on the 1,200-paragraph document.`);
  lines.push(`- Result: ${cancelResult.cancelled ? 'CANCELLED' : JSON.stringify(cancelResult)}.`);
  lines.push(`- No pagination result was returned for the cancelled run.`);
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- Times include only parsing and pagination in the worker, not encryption or IndexedDB storage.');
  lines.push('- “Font resolution” includes packaged/embedded font admission and the local hash-verified normalized-metric configuration. “Renderer layout” is the renderer page pass. “Geometry/image mapping” includes line/cell/column/image/font-report mapping.');
  lines.push('- Table normalization runs before the renderer when the parsed structure contains tables. It is layout-only, bounded, and not persisted; timings include its unzip/patch/zip cost inside the pagination total.');
  lines.push('- Image metadata includes table-cell parents, nested depth, captions, header/footer source/inheritance, and physical-page appearances. Image bytes are never included.');
  lines.push('- RSS is the sum of the Chromium browser process tree sampled every 25 ms; baseline is measured after the worker is ready and before the document is sent. It includes worker, renderer, GPU, and browser overhead, so the delta is a directional whole-process cost, not an isolated heap number.');
  lines.push('- Detailed line/cell geometry is bounded by a 300,000-character budget. The 5,000-paragraph case retains all 5,000 top-level page mappings but truncates detailed line geometry.');
  lines.push('- The warm run reuses the worker and the engine’s process-wide shaping caches.');
  lines.push('- The parser worker bundle contains the full DOCX parser, Mammoth, PDF.js and OCR imports already present before this phase; the font-backed layout engine adds the renderer and HarfBuzz code.');
  lines.push('');
  await writeFile(path.join(root, 'docs', 'PHASE_4_1_4_PERFORMANCE.md'), `${lines.join('\n')}\n`, 'utf8');
  console.log(JSON.stringify({ extensionBytes, workerBytes, offscreenBytes, backgroundBytes, wasmBytes, fontAssetBytes, results, cancelResult }, null, 2).slice(0, 12_000));
  console.log('REPORT docs/PHASE_4_1_4_PERFORMANCE.md');
  if (!cancelResult.cancelled) process.exitCode = 1;
} finally {
  if (context) await context.close().catch(() => undefined);
  if (browser) await browser.close().catch(() => undefined);
  if (browserServer) await browserServer.close().catch(() => undefined);
  server?.close();
  await rm(tempDir, { recursive: true, force: true });
}
