const express = require('express');
const cors = require('cors');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { v4: uuidv4 } = require('uuid');
const { XMLParser } = require('fast-xml-parser');

const execFileAsync = promisify(execFile);

// qpdf exits 3 (not 0) when it succeeded but had to work around something minor
// (e.g. repairing a slightly malformed xref table) — that's not a real failure,
// so treat it like success instead of letting execFile reject the whole job.
async function execQpdf(args, opts) {
  try {
    return await execFileAsync('qpdf', args, opts);
  } catch (err) {
    if (err.code === 3) {
      return { stdout: err.stdout || '', stderr: err.stderr || '' };
    }
    throw err;
  }
}

const app = express();
app.set('trust proxy', 1); // behind nginx, needed for correct req.ip in rate limiting

const PORT = process.env.PORT || 3005;
const SESSIONS_DIR = '/tmp/pdf_sessions';
const UPLOADS_DIR = '/tmp/pdf_uploads';
const PROFILES_DIR = '/tmp/pdf_lo_profiles';

const MAX_CONCURRENT_JOBS = 2; // max simultaneous soffice/qpdf processes
const SESSION_TTL_MS = 60 * 60 * 1000; // delete session/upload files after 1h
const JOB_TTL_MS = 30 * 60 * 1000; // forget finished job metadata after 30min
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

for (const dir of [SESSIONS_DIR, UPLOADS_DIR, PROFILES_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use('/sessions', express.static(SESSIONS_DIR));

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 50 * 1024 * 1024 }
});

const uploadMulti = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 100 * 1024 * 1024 }
});

// ---------------------------------------------------------------------------
// Anti-farming rate limits (per IP). Only applied to endpoints that spawn
// LibreOffice/qpdf processes, since those are the costly ones.
// ---------------------------------------------------------------------------

const dailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Limite quotidienne atteinte (20 opérations/jour). Réessayez demain." }
});

const burstLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de requêtes en peu de temps. Merci de patienter quelques minutes." }
});

// ---------------------------------------------------------------------------
// Job queue: caps how many soffice/qpdf processes run at once. Every
// convert/export/merge/extract goes through here instead of running inline,
// so a burst of users gets queued (with a visible position) instead of
// spawning N LibreOffice instances at once and starving the server's RAM.
// ---------------------------------------------------------------------------

const jobs = new Map(); // jobId -> { status, type, result, error, createdAt }
const queue = []; // ordered list of { jobId, taskFn } waiting to run
let activeCount = 0;

function enqueueJob(jobId, type, taskFn) {
  jobs.set(jobId, { status: 'queued', type, createdAt: Date.now() });
  queue.push({ jobId, taskFn });
  processQueue();
}

function processQueue() {
  while (activeCount < MAX_CONCURRENT_JOBS && queue.length > 0) {
    const { jobId, taskFn } = queue.shift();
    const job = jobs.get(jobId);
    if (!job) continue;

    job.status = 'processing';
    activeCount++;

    taskFn()
      .then((result) => {
        job.status = 'done';
        job.result = result;
      })
      .catch((err) => {
        job.status = 'error';
        job.error = err.message || 'Erreur interne';
      })
      .finally(() => {
        activeCount--;
        processQueue();
      });
  }
}

function getQueuePosition(jobId) {
  const idx = queue.findIndex((i) => i.jobId === jobId);
  return idx === -1 ? 0 : idx + 1;
}

app.get('/job/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Tâche introuvable ou expirée' });

  const payload = { status: job.status, type: job.type };
  if (job.status === 'queued') payload.position = getQueuePosition(req.params.id);
  if (job.status === 'error') payload.error = job.error;
  if (job.status === 'done' && job.type === 'convert') payload.result = job.result;
  res.json(payload);
});

app.get('/job/:id/download', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Tâche introuvable ou expirée' });
  if (job.status !== 'done') return res.status(409).json({ error: "Tâche pas encore terminée" });
  if (!job.result || !job.result.filePath || !fs.existsSync(job.result.filePath)) {
    return res.status(404).json({ error: 'Fichier introuvable' });
  }
  res.download(job.result.filePath, job.result.filename, () => {
    // Privacy: once the result has been handed to the browser, there is no
    // reason to keep the source PDF/FODG/SVG around on disk any longer.
    if (job.result.sessionPath) {
      fs.rm(job.result.sessionPath, { recursive: true, force: true }, () => {});
    }
  });
});

// ---------------------------------------------------------------------------
// Cleanup: session/upload dirs and job metadata are never useful beyond an
// hour, so sweep them periodically instead of relying on manual maintenance.
// ---------------------------------------------------------------------------

function cleanupOldFiles() {
  const now = Date.now();
  for (const dir of [SESSIONS_DIR, UPLOADS_DIR, PROFILES_DIR]) {
    fs.readdir(dir, (err, entries) => {
      if (err) return;
      entries.forEach((entry) => {
        const p = path.join(dir, entry);
        fs.stat(p, (statErr, stat) => {
          if (statErr) return;
          if (now - stat.mtimeMs > SESSION_TTL_MS) {
            fs.rm(p, { recursive: true, force: true }, () => {});
          }
        });
      });
    });
  }
  for (const [id, job] of jobs) {
    if (job.status !== 'queued' && job.status !== 'processing' && now - job.createdAt > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}
setInterval(cleanupOldFiles, CLEANUP_INTERVAL_MS);

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    engine: 'LibreOffice Headless + QPDF',
    queue: { active: activeCount, waiting: queue.length }
  });
});

function parseDim(dimStr) {
  if (!dimStr) return 0;
  const match = String(dimStr).match(/^([0-9.]+)([a-z%]+)?$/i);
  if (!match) return parseFloat(dimStr) || 0;
  const val = parseFloat(match[1]);
  const unit = (match[2] || 'cm').toLowerCase();
  if (unit === 'cm') return val * 10;
  if (unit === 'mm') return val;
  if (unit === 'in') return val * 25.4;
  if (unit === 'pt') return val * 0.352778;
  return val;
}

function extractTextFromP(pObj) {
  if (typeof pObj === 'string') return pObj;
  if (typeof pObj === 'number') return String(pObj);
  if (!pObj || typeof pObj !== 'object') return '';

  let res = '';
  if (pObj['#text']) res += pObj['#text'];

  if (pObj['text:span']) {
    const spans = Array.isArray(pObj['text:span']) ? pObj['text:span'] : [pObj['text:span']];
    spans.forEach((s) => {
      res += extractTextFromP(s);
    });
  }
  return res;
}

function replaceXmlText(xml, oldText, newText) {
  if (!oldText) return xml;

  const escapedNew = String(newText)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const targetRaw = String(oldText);
  const targetApos = String(oldText)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&apos;')
    .replace(/"/g, '&quot;');
  const targetNum = String(oldText)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&#39;')
    .replace(/"/g, '&quot;');

  if (xml.includes(targetApos)) {
    return xml.replaceAll(targetApos, escapedNew);
  }
  if (xml.includes(targetNum)) {
    return xml.replaceAll(targetNum, escapedNew);
  }
  if (xml.includes(targetRaw)) {
    return xml.replaceAll(targetRaw, escapedNew);
  }

  const trimmed = oldText.trim();
  const trimmedApos = trimmed
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&apos;')
    .replace(/"/g, '&quot;');

  if (xml.includes(trimmedApos)) {
    return xml.replaceAll(trimmedApos, escapedNew);
  }
  if (xml.includes(trimmed)) {
    return xml.replaceAll(trimmed, escapedNew);
  }

  return xml;
}

// Parses a single-page FODG (LibreOffice Draw XML) into the flat text-element
// list the frontend renders/edits. One PDF page -> one FODG -> one draw:page.
function parseFodgElements(fodgPath, elemIdPrefix) {
  const xmlContent = fs.readFileSync(fodgPath, 'utf8');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    preserveOrder: false
  });
  const jsonObj = parser.parse(xmlContent);

  const doc = jsonObj['office:document'];
  const body = doc ? doc['office:body'] : null;
  const drawing = body ? body['office:drawing'] : null;

  let rawPages = [];
  if (drawing && drawing['draw:page']) {
    rawPages = Array.isArray(drawing['draw:page']) ? drawing['draw:page'] : [drawing['draw:page']];
  }
  const pageObj = rawPages[0] || {};

  const frames = pageObj['draw:frame'];
  const framesArr = Array.isArray(frames) ? frames : (frames ? [frames] : []);

  let elemIdSeq = 1;
  const elements = [];

  framesArr.forEach((frame) => {
    const textBox = frame['draw:text-box'];
    if (textBox) {
      const ps = textBox['text:p'];
      const pArr = Array.isArray(ps) ? ps : (ps ? [ps] : []);

      let fullTextArr = [];
      pArr.forEach((p) => {
        const txt = extractTextFromP(p);
        if (txt) fullTextArr.push(txt);
      });

      const fullText = fullTextArr.join('\n');

      if (fullText.trim().length > 0) {
        elements.push({
          id: `el_${elemIdPrefix}_${elemIdSeq++}`,
          type: 'text',
          xMm: parseDim(frame['@_svg:x']),
          yMm: parseDim(frame['@_svg:y']),
          wMm: parseDim(frame['@_svg:width']),
          hMm: parseDim(frame['@_svg:height']),
          rawX: frame['@_svg:x'],
          rawY: frame['@_svg:y'],
          rawW: frame['@_svg:width'],
          rawH: frame['@_svg:height'],
          text: fullText
        });
      }
    }
  });

  return elements;
}

app.post('/convert', dailyLimiter, burstLimiter, upload.single('pdf'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Aucun fichier PDF fourni' });
  }

  const sessionId = uuidv4();
  const jobId = uuidv4();
  const sessionPath = path.join(SESSIONS_DIR, sessionId);
  const pagesDir = path.join(sessionPath, 'pages');
  fs.mkdirSync(pagesDir, { recursive: true });

  const inputPdfPath = path.join(sessionPath, 'input.pdf');
  fs.renameSync(req.file.path, inputPdfPath);

  enqueueJob(jobId, 'convert', async () => {
    // SVG/FODG export from LibreOffice only ever renders one page's worth of
    // canvas — for a multi-page PDF it silently overlaps every page into the
    // same area. So we split into single-page PDFs first (qpdf) and convert
    // each page on its own, which LibreOffice handles correctly.
    let pageCount = 1;
    try {
      const { stdout } = await execQpdf( ['--show-npages', inputPdfPath], { timeout: 15000 });
      pageCount = parseInt(String(stdout).trim(), 10) || 1;
    } catch (e) {
      console.warn('qpdf --show-npages warning:', e.message);
    }

    const pages = [];

    for (let p = 1; p <= pageCount; p++) {
      const pagePdfPath = path.join(pagesDir, `page-${p}.pdf`);
      if (pageCount > 1) {
        await execQpdf( [inputPdfPath, '--pages', inputPdfPath, String(p), '--', pagePdfPath], { timeout: 30000 });
      } else {
        fs.copyFileSync(inputPdfPath, pagePdfPath);
      }

      const profileDir = path.join(PROFILES_DIR, `${jobId}-${p}`);
      const userInstall = `-env:UserInstallation=file://${profileDir}`;

      await execFileAsync('soffice', ['--headless', userInstall, '--convert-to', 'fodg', pagePdfPath, '--outdir', pagesDir], { timeout: 30000 });

      const fodgPath = path.join(pagesDir, `page-${p}.fodg`);
      if (!fs.existsSync(fodgPath)) {
        throw new Error(`Échec de la conversion LibreOffice FODG (page ${p})`);
      }

      try {
        await execFileAsync('soffice', ['--headless', userInstall, '--convert-to', 'svg', pagePdfPath, '--outdir', pagesDir], { timeout: 30000 });
      } catch (e) {
        console.warn(`soffice SVG warning (page ${p}):`, e.message);
      }

      fs.rm(profileDir, { recursive: true, force: true }, () => {});

      const svgPath = path.join(pagesDir, `page-${p}.svg`);
      const elements = parseFodgElements(fodgPath, p - 1);

      pages.push({
        pageIndex: p - 1,
        pageNumber: p,
        svgUrl: fs.existsSync(svgPath) ? `/pdf-libre-api/sessions/${sessionId}/pages/page-${p}.svg` : null,
        elements
      });
    }

    return {
      sessionId,
      pageCount,
      pages
    };
  });

  res.status(202).json({ jobId, position: getQueuePosition(jobId) });
});

app.post('/export', dailyLimiter, burstLimiter, (req, res) => {
  const { sessionId, pagesModifications } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId requis' });
  }

  const sessionPath = path.join(SESSIONS_DIR, sessionId);
  const pagesDir = path.join(sessionPath, 'pages');

  if (!fs.existsSync(pagesDir)) {
    return res.status(404).json({ error: 'Session non trouvée' });
  }

  const jobId = uuidv4();

  enqueueJob(jobId, 'export', async () => {
    const fodgFiles = fs.readdirSync(pagesDir)
      .filter((f) => /^page-\d+\.fodg$/.test(f))
      .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));

    if (fodgFiles.length === 0) {
      throw new Error('Aucune page trouvée pour cette session');
    }

    const outputPagePdfs = [];

    for (let i = 0; i < fodgFiles.length; i++) {
      const pageNum = i + 1;
      const inputFodg = path.join(pagesDir, `page-${pageNum}.fodg`);
      let xmlContent = fs.readFileSync(inputFodg, 'utf8');

      const pageMods = (pagesModifications && pagesModifications[i]) || {};
      if (pageMods && typeof pageMods === 'object') {
        Object.keys(pageMods).forEach((key) => {
          const item = pageMods[key];
          if (item && item.oldText && item.newText !== undefined) {
            xmlContent = replaceXmlText(xmlContent, item.oldText, item.newText);
          }
        });
      }

      const outputFodg = path.join(pagesDir, `edited-${pageNum}.fodg`);
      fs.writeFileSync(outputFodg, xmlContent, 'utf8');

      const profileDir = path.join(PROFILES_DIR, `${jobId}-export-${pageNum}`);
      const userInstall = `-env:UserInstallation=file://${profileDir}`;
      await execFileAsync('soffice', ['--headless', userInstall, '--convert-to', 'pdf', outputFodg, '--outdir', pagesDir], { timeout: 30000 });
      fs.rm(profileDir, { recursive: true, force: true }, () => {});

      const outputPdf = path.join(pagesDir, `edited-${pageNum}.pdf`);
      if (!fs.existsSync(outputPdf)) {
        throw new Error(`Échec de la génération du PDF final (page ${pageNum})`);
      }
      outputPagePdfs.push(outputPdf);
    }

    let finalPdf;
    if (outputPagePdfs.length === 1) {
      finalPdf = outputPagePdfs[0];
    } else {
      finalPdf = path.join(sessionPath, 'merged-export.pdf');
      await execQpdf( ['--empty', '--pages', ...outputPagePdfs, '--', finalPdf], { timeout: 60000 });
    }

    return { filePath: finalPdf, filename: 'document-edite.pdf', sessionPath };
  });

  res.status(202).json({ jobId, position: getQueuePosition(jobId) });
});

// PDF Merge Endpoint (Using QPDF)
app.post('/merge', dailyLimiter, burstLimiter, uploadMulti.array('pdfs', 20), (req, res) => {
  if (!req.files || req.files.length < 2) {
    return res.status(400).json({ error: 'Au moins 2 fichiers PDF sont requis pour la fusion.' });
  }

  const sessionId = uuidv4();
  const jobId = uuidv4();
  const sessionPath = path.join(SESSIONS_DIR, sessionId);
  fs.mkdirSync(sessionPath, { recursive: true });

  const inputPaths = req.files.map((file, idx) => {
    const p = path.join(sessionPath, `input_${idx}.pdf`);
    fs.renameSync(file.path, p);
    return p;
  });

  const outputPdf = path.join(sessionPath, 'merged.pdf');

  enqueueJob(jobId, 'merge', async () => {
    await execQpdf( ['--empty', '--pages', ...inputPaths, '--', outputPdf], { timeout: 60000 });
    if (!fs.existsSync(outputPdf)) throw new Error('Échec de la fusion');
    return { filePath: outputPdf, filename: 'document-fusionne.pdf', sessionPath };
  });

  res.status(202).json({ jobId, position: getQueuePosition(jobId) });
});

// PDF Extract Pages Endpoint (Using QPDF)
app.post('/extract', dailyLimiter, burstLimiter, upload.single('pdf'), (req, res) => {
  const { pageRange } = req.body;
  if (!req.file || !pageRange) {
    return res.status(400).json({ error: 'Fichier PDF et sélection de pages requis.' });
  }

  const sessionId = uuidv4();
  const jobId = uuidv4();
  const sessionPath = path.join(SESSIONS_DIR, sessionId);
  fs.mkdirSync(sessionPath, { recursive: true });

  const inputPdf = path.join(sessionPath, 'input.pdf');
  fs.renameSync(req.file.path, inputPdf);

  const outputPdf = path.join(sessionPath, 'extracted.pdf');
  const cleanRange = String(pageRange).replace(/[^0-9,-z]/gi, '');

  enqueueJob(jobId, 'extract', async () => {
    await execQpdf( [inputPdf, '--pages', inputPdf, cleanRange, '--', outputPdf], { timeout: 30000 });
    if (!fs.existsSync(outputPdf)) throw new Error("Échec de l'extraction");
    return { filePath: outputPdf, filename: 'pages-extraites.pdf', sessionPath };
  });

  res.status(202).json({ jobId, position: getQueuePosition(jobId) });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`PDF Libre API running on http://127.0.0.1:${PORT}`);
});
