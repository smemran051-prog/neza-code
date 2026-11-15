'use strict';

/**
 * Tool: ast_decompiler_llm_pipeline
 *
 * Master Reverse-Reconstruction, AST Structural Analyzer & LLM Code Modification Pipeline
 *
 * Sub-Engines Included:
 *   1. DecompilerHooks:
 *      - Native Node.js Electron `.asar` archive parser & extractor (no external CLI needed).
 *      - Standalone `.exe` / wrapper payload carver (extracts embedded HTML, JS, JSON manifests).
 *      - External unpacker bridge (`7z`, `npx asar`, `pyinstxtractor`, `apktool` if available).
 *   2. ASTParserEngine:
 *      - Lexical & brace-balanced structural parser for JavaScript, HTML (<script>), and Python.
 *      - Pinpoints WebRTC/Camera resolution hooks (`getUserMedia`, width/height/frameRate),
 *        Barcode/QR scanner loops (`Html5Qrcode`, `Quagga`, `ZXing`, `jsQR`, `canvas`),
 *        DOM event bindings, and function/class boundaries.
 *      - Native JS syntax validator using `new vm.Script()`.
 *   3. LLMCodeGenPipeline:
 *      - Reads active AI credentials from `01_CONFIG/settings.json`.
 *      - Feeds extracted source + AST metadata + user modification instructions to the LLM.
 *      - Validates generated code syntax, writes upgraded files to `modified_build/`, and
 *        generates a one-click portable launcher (`run_portable_app.bat`).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = process.env.JARVIS_ROOT || path.resolve(__dirname, '..', '..');
const CONFIG_DIR = path.join(ROOT, '01_CONFIG');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const WORK_RECON_DIR = path.join(ROOT, 'work', 'reconstructed_apps');

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', '.idea', '.vscode',
]);

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function sanitizeName(raw) {
  return String(raw || 'target_app')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '') || 'target_app';
}

// ===========================================================================
// ENGINE 1: DECOMPILER & UNPACKER HOOKS (ASAR, EXE CARVER, DIRECTORY CLONER)
// ===========================================================================

/**
 * Native Electron .asar Archive Unpacker
 * Parses Pickle-framed UInt32LE headers and extracts all embedded source files.
 */
function unpackAsarArchiveNative(asarPath, outputDir) {
  const extractedFiles = [];
  const buf = fs.readFileSync(asarPath);

  if (buf.length < 16) {
    throw new Error(`Invalid or corrupted .asar file (too small): ${asarPath}`);
  }

  // Electron ASAR Pickle header layout:
  // Offset 4: UInt32LE header_size_aligned
  // Offset 12: UInt32LE header_string_length
  // Offset 16: UTF-8 JSON string of length header_string_length
  const headerSizeAligned = buf.readUInt32LE(4);
  const jsonLen = buf.readUInt32LE(12);
  const jsonStart = 16;
  const jsonEnd = jsonStart + jsonLen;

  if (jsonEnd > buf.length) {
    throw new Error('ASAR header JSON length exceeds file buffer size.');
  }

  const headerJsonStr = buf.slice(jsonStart, jsonEnd).toString('utf8');
  const headerTree = JSON.parse(headerJsonStr);
  const payloadBaseOffset = 8 + headerSizeAligned;

  function walkAsarTree(node, currentRelPath) {
    if (!node || typeof node !== 'object') return;

    if (node.files && typeof node.files === 'object') {
      const targetDir = path.join(outputDir, currentRelPath);
      fs.mkdirSync(targetDir, { recursive: true });
      for (const [childName, childNode] of Object.entries(node.files)) {
        if (IGNORED_DIRS.has(childName)) continue;
        walkAsarTree(childNode, path.join(currentRelPath, childName));
      }
      return;
    }

    // Leaf file node
    if (node.offset !== undefined && node.size !== undefined) {
      const fileOffset = payloadBaseOffset + Number(node.offset);
      const fileSize = Number(node.size);

      // Skip huge binary blobs (> 15 MB) during source reconstruction
      if (fileSize > 15 * 1024 * 1024 || fileOffset + fileSize > buf.length) return;

      const destPath = path.join(outputDir, currentRelPath);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const fileSlice = buf.slice(fileOffset, fileOffset + fileSize);
      fs.writeFileSync(destPath, fileSlice);
      extractedFiles.push(destPath);
    }
  }

  walkAsarTree(headerTree, '');
  return extractedFiles;
}

/**
 * Binary Payload Carver for Packaged Single-File .exe Wrappers (NW.js / pkg / WebView wrappers)
 * Scans binary buffer for embedded HTML documents, package.json manifests, and JS blocks.
 */
function carvePayloadsFromBinaryExe(exePath, outputDir) {
  const carvedFiles = [];
  const stat = fs.statSync(exePath);
  // Read up to 65 MB safely into memory (covers 45 MB packaged apps easily)
  const maxRead = Math.min(stat.size, 65 * 1024 * 1024);
  const fd = fs.openSync(exePath, 'r');
  const buf = Buffer.allocUnsafe(maxRead);
  fs.readSync(fd, buf, 0, maxRead, 0);
  fs.closeSync(fd);

  fs.mkdirSync(outputDir, { recursive: true });
  const latinStr = buf.toString('latin1');

  // 1. Carve embedded HTML documents (<!DOCTYPE html> or <html ... </html>)
  const htmlRegex = /(?:<!DOCTYPE\s+html[^>]*>\s*)?<html[\s\S]{150,250000}?<\/html>/gi;
  let htmlIdx = 0;
  for (const match of latinStr.matchAll(htmlRegex)) {
    const rawHtml = Buffer.from(match[0], 'latin1').toString('utf8');
    // Filter out noisy binary false positives
    if (rawHtml.includes('<body') || rawHtml.includes('<script') || rawHtml.includes('<div')) {
      htmlIdx++;
      const outName = htmlIdx === 1 ? 'index_carved.html' : `page_carved_${htmlIdx}.html`;
      const outPath = path.join(outputDir, outName);
      fs.writeFileSync(outPath, rawHtml, 'utf8');
      carvedFiles.push(outPath);
    }
    if (htmlIdx >= 10) break;
  }

  // 2. Carve embedded package.json manifests
  const pkgRegex = /\{\s*"name"\s*:\s*"[^"]{1,80}"[\s\S]{20,4000}?"(?:main|dependencies|scripts)"[\s\S]{10,4000}?\}/g;
  let pkgIdx = 0;
  for (const match of latinStr.matchAll(pkgRegex)) {
    try {
      const candidate = Buffer.from(match[0], 'latin1').toString('utf8');
      const parsed = JSON.parse(candidate);
      if (parsed && parsed.name) {
        pkgIdx++;
        const outName = pkgIdx === 1 ? 'package.json' : `package_carved_${pkgIdx}.json`;
        const outPath = path.join(outputDir, outName);
        fs.writeFileSync(outPath, JSON.stringify(parsed, null, 2), 'utf8');
        carvedFiles.push(outPath);
      }
    } catch (_) {}
    if (pkgIdx >= 5) break;
  }

  // 3. Carve standalone JS logic blocks containing Camera / Barcode / DOM / Electron hooks
  const jsHookRegex = /(?:function\s+[a-zA-Z0-9_]+\s*\([^)]*\)\s*\{|const\s+[a-zA-Z0-9_]+\s*=)[\s\S]{120,60000}?(?:getUserMedia|Html5Qrcode|Quagga|ZXing|barcode|qrcode|ipcRenderer|BrowserWindow|addEventListener)[\s\S]{80,30000}?\n\}/g;
  let jsIdx = 0;
  for (const match of latinStr.matchAll(jsHookRegex)) {
    const rawJs = Buffer.from(match[0], 'latin1').toString('utf8');
    // Ensure mostly printable ASCII/UTF-8 text
    const nonPrintable = (rawJs.match(/[\x00-\x08\x0E-\x1F]/g) || []).length;
    if (nonPrintable < rawJs.length * 0.02) {
      jsIdx++;
      const outPath = path.join(outputDir, `carved_logic_${jsIdx}.js`);
      fs.writeFileSync(outPath, rawJs, 'utf8');
      carvedFiles.push(outPath);
    }
    if (jsIdx >= 12) break;
  }

  return carvedFiles;
}

/**
 * Copy Source Directory Cleanly for Inspection & Reconstruction
 */
function copySourceDirectory(srcDir, destDir, maxFiles = 250) {
  const copied = [];

  function walk(currSrc, currDest) {
    if (copied.length >= maxFiles) return;
    let entries = [];
    try { entries = fs.readdirSync(currSrc, { withFileTypes: true }); } catch (_) { return; }

    for (const ent of entries) {
      if (copied.length >= maxFiles) break;
      const fullSrc = path.join(currSrc, ent.name);
      const fullDest = path.join(currDest, ent.name);

      if (ent.isDirectory()) {
        if (IGNORED_DIRS.has(ent.name)) continue;
        walk(fullSrc, fullDest);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        // If directory contains an app.asar file, unpack it automatically!
        if (ent.name.toLowerCase().endsWith('.asar')) {
          try {
            const unpacked = unpackAsarArchiveNative(fullSrc, path.join(destDir, 'asar_unpacked'));
            copied.push(...unpacked);
          } catch (_) {}
          continue;
        }
        const allowedExts = new Set([
          '.js', '.mjs', '.cjs', '.ts', '.html', '.htm', '.css', '.json', '.py', '.ps1', '.bat', '.cmd', '.md',
        ]);
        if (allowedExts.has(ext)) {
          try {
            const st = fs.statSync(fullSrc);
            if (st.size <= 5 * 1024 * 1024) {
              fs.mkdirSync(currDest, { recursive: true });
              fs.copyFileSync(fullSrc, fullDest);
              copied.push(fullDest);
            }
          } catch (_) {}
        }
      }
    }
  }

  walk(srcDir, destDir);
  return copied;
}

/**
 * Master Decompiler Orchestrator
 */
function runDecompilerHooks(targetPath, extractDir) {
  fs.mkdirSync(extractDir, { recursive: true });
  const st = fs.statSync(targetPath);
  const report = {
    targetPath,
    extractDir,
    methodUsed: '',
    extractedFiles: [],
    notes: [],
  };

  if (st.isDirectory()) {
    // Check if it's an installed Electron app folder with resources/app.asar
    const possibleAsar = path.join(targetPath, 'resources', 'app.asar');
    const possibleAppFolder = path.join(targetPath, 'resources', 'app');

    if (fs.existsSync(possibleAsar)) {
      report.methodUsed = 'electron_resources_asar_unpacker';
      report.extractedFiles = unpackAsarArchiveNative(possibleAsar, extractDir);
      report.notes.push(`Unpacked Electron archive: ${possibleAsar}`);
    } else if (fs.existsSync(possibleAppFolder)) {
      report.methodUsed = 'electron_resources_app_copy';
      report.extractedFiles = copySourceDirectory(possibleAppFolder, extractDir);
      report.notes.push(`Copied Electron resources/app source directory.`);
    } else {
      report.methodUsed = 'source_directory_clone';
      report.extractedFiles = copySourceDirectory(targetPath, extractDir);
      report.notes.push(`Cloned source files from directory.`);
    }
    return report;
  }

  // Single file target (.asar, .exe, .apk, .js, .html, .py)
  const ext = path.extname(targetPath).toLowerCase();

  if (ext === '.asar') {
    report.methodUsed = 'native_asar_unpacker';
    report.extractedFiles = unpackAsarArchiveNative(targetPath, extractDir);
    return report;
  }

  if (ext === '.exe' || ext === '.apk') {
    // 1. Check if sibling resources/app.asar exists next to the .exe
    const siblingAsar = path.join(path.dirname(targetPath), 'resources', 'app.asar');
    if (fs.existsSync(siblingAsar)) {
      report.methodUsed = 'sibling_electron_asar_unpacker';
      report.extractedFiles = unpackAsarArchiveNative(siblingAsar, extractDir);
      report.notes.push(`Detected sibling resources/app.asar next to ${path.basename(targetPath)}.`);
      return report;
    }

    // 2. Try 7-Zip CLI extraction if 7z is installed (great for NSIS, SFX, APK archives)
    try {
      execFileSync('7z', ['x', targetPath, `-o${extractDir}`, '-y'], {
        timeout: 20000,
        windowsHide: true,
        stdio: 'ignore',
      });
      const unpackedWalk = copySourceDirectory(extractDir, extractDir);
      if (unpackedWalk.length > 0) {
        report.methodUsed = '7zip_archive_unpacker';
        report.extractedFiles = unpackedWalk;
        return report;
      }
    } catch (_) {
      report.notes.push('7z CLI not present or binary is not a standard SFX archive; falling back to native payload carver.');
    }

    // 3. Run Native Binary Payload Carver (extracts embedded HTML, JS, package.json from 45MB .exe)
    report.methodUsed = 'native_binary_payload_carver';
    report.extractedFiles = carvePayloadsFromBinaryExe(targetPath, extractDir);
    report.notes.push(`Carved ${report.extractedFiles.length} embedded source payloads directly from binary ${path.basename(targetPath)}.`);
    return report;
  }

  // Standard standalone script (.js, .html, .py)
  report.methodUsed = 'direct_source_file_copy';
  const destFile = path.join(extractDir, path.basename(targetPath));
  fs.copyFileSync(targetPath, destFile);
  report.extractedFiles = [destFile];
  return report;
}

// ===========================================================================
// ENGINE 2: STRUCTURAL AST PARSER & HARDWARE/UI HOOK ANALYZER
// ===========================================================================

function validateJsSyntax(codeStr, filename = 'check.js') {
  try {
    // Strip ES module import/export keywords lightly for vm.Script syntax validation
    const normalized = codeStr
      .replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?/gm, '')
      .replace(/^\s*export\s+default\s+/gm, '')
      .replace(/^\s*export\s+(?=(?:async\s+)?function|class|const|let|var)/gm, '');
    new vm.Script(normalized, { filename });
    return { valid: true, error: null };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

function parseCodeBlockToAST(content, relFilePath) {
  const lines = content.split(/\r?\n/);
  const ext = path.extname(relFilePath).toLowerCase();

  const astNode = {
    file: relFilePath,
    extension: ext,
    totalLines: lines.length,
    syntaxValid: true,
    syntaxError: null,
    imports: [],
    functions: [],
    classes: [],
    cameraAndMediaHooks: [],
    barcodeScannerHooks: [],
    uiAndDomHooks: [],
  };

  if (['.js', '.mjs', '.cjs'].includes(ext)) {
    const check = validateJsSyntax(content, relFilePath);
    astNode.syntaxValid = check.valid;
    astNode.syntaxError = check.error;
  }

  // 1. Extract Imports / Requires / Script tags
  for (const m of content.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)|import\s+[\s\S]*?from\s+['"]([^'"]+)['"]|<script[^>]+src=['"]([^'"]+)['"]/gi)) {
    astNode.imports.push(m[1] || m[2] || m[3]);
  }

  // 2. Pinpoint Camera / Resolution / WebRTC Hooks (crucial for upgrading camera resolution!)
  const camPatterns = [
    { type: 'WebRTC_getUserMedia', re: /navigator\.mediaDevices\.getUserMedia\s*\([\s\S]{1,500}?\)/g },
    { type: 'Video_Resolution_Constraints', re: /(?:width|height|frameRate|facingMode)\s*:\s*(?:\{[^}]{1,150}\}|[0-9]+|['"][^'"]+['"])/g },
    { type: 'Html5Qrcode_Config', re: /\b(?:fps|qrbox|aspectRatio|videoConstraints)\s*:\s*[^\n,}]+/g },
  ];
  for (const pat of camPatterns) {
    for (const m of content.matchAll(pat.re)) {
      const lineNum = content.slice(0, m.index).split(/\r?\n/).length;
      astNode.cameraAndMediaHooks.push({
        type: pat.type,
        line: lineNum,
        snippet: m[0].trim().slice(0, 250),
      });
    }
  }

  // 3. Pinpoint Barcode / QR Scanner Engine Hooks
  const scannerPatterns = [
    { type: 'Html5Qrcode_Engine', re: /\b(?:Html5Qrcode|Html5QrcodeScanner)\b[\s\S]{1,350}?(?:;|\n)/g },
    { type: 'QuaggaJS_Engine', re: /\bQuagga\.(?:init|onDetected|start)\b[\s\S]{1,350}?(?:;|\n)/g },
    { type: 'ZXing_jsQR_BarcodeDetector', re: /\b(?:BrowserMultiFormatReader|BarcodeDetector|jsQR)\b[\s\S]{1,300}?(?:;|\n)/g },
    { type: 'Canvas_Frame_Capture', re: /\.drawImage\s*\([^)]+\)|\.getImageData\s*\([^)]+\)/g },
  ];
  for (const pat of scannerPatterns) {
    for (const m of content.matchAll(pat.re)) {
      const lineNum = content.slice(0, m.index).split(/\r?\n/).length;
      astNode.barcodeScannerHooks.push({
        type: pat.type,
        line: lineNum,
        snippet: m[0].trim().slice(0, 250),
      });
    }
  }

  // 4. Pinpoint UI, Styling & DOM Event Listeners
  for (const m of content.matchAll(/(?:document\.getElementById|document\.querySelector)\(\s*['"]([^'"]+)['"]\s*\)|addEventListener\(\s*['"]([^'"]+)['"]/g)) {
    const lineNum = content.slice(0, m.index).split(/\r?\n/).length;
    astNode.uiAndDomHooks.push({
      line: lineNum,
      selectorOrEvent: m[1] || m[2],
      expression: m[0],
    });
    if (astNode.uiAndDomHooks.length >= 35) break;
  }

  // 5. Brace-Balanced Function & Class Boundary AST Extractor
  const fnSignatureRe = /^(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*\(([^)]*)\)\s*\{|^\s*(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*\{|^\s*([a-zA-Z0-9_$]+)\s*\(([^)]*)\)\s*\{/;
  const classSignatureRe = /^(?:export\s+)?class\s+([a-zA-Z0-9_$]+)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const clsMatch = line.match(classSignatureRe);
    if (clsMatch) {
      astNode.classes.push({ name: clsMatch[1], startLine: i + 1 });
    }

    const fnMatch = line.match(fnSignatureRe);
    if (!fnMatch) continue;

    const fnName = fnMatch[1] || fnMatch[3] || fnMatch[5];
    const fnParams = fnMatch[2] || fnMatch[4] || fnMatch[6] || '';
    if (['if', 'for', 'while', 'switch', 'catch', 'function'].includes(fnName)) continue;

    let braceDepth = 0;
    let opened = false;
    let endIdx = i;
    const bodyLines = [];

    for (let j = i; j < Math.min(lines.length, i + 180); j++) {
      const cur = lines[j];
      bodyLines.push(cur);
      for (const ch of cur) {
        if (ch === '{') { braceDepth++; opened = true; }
        else if (ch === '}') braceDepth--;
      }
      if (opened && braceDepth <= 0) {
        endIdx = j;
        break;
      }
    }

    astNode.functions.push({
      name: fnName,
      params: fnParams.trim(),
      startLine: i + 1,
      endLine: endIdx + 1,
      lineCount: endIdx - i + 1,
      code: bodyLines.join('\n'),
    });

    if (astNode.functions.length >= 40) break;
  }

  return astNode;
}

function buildProjectASTMap(extractedFiles, baseExtractDir) {
  const astMap = {
    totalFilesParsed: 0,
    files: [],
    summary: {
      totalFunctions: 0,
      totalCameraHooks: 0,
      totalBarcodeHooks: 0,
      totalUiHooks: 0,
    },
  };

  for (const filePath of extractedFiles) {
    const ext = path.extname(filePath).toLowerCase();
    if (!['.js', '.mjs', '.cjs', '.html', '.htm', '.py'].includes(ext)) continue;

    let content = '';
    try { content = fs.readFileSync(filePath, 'utf8'); } catch (_) { continue; }

    const relPath = path.relative(baseExtractDir, filePath) || path.basename(filePath);
    const node = parseCodeBlockToAST(content, relPath);

    astMap.files.push(node);
    astMap.totalFilesParsed++;
    astMap.summary.totalFunctions += node.functions.length;
    astMap.summary.totalCameraHooks += node.cameraAndMediaHooks.length;
    astMap.summary.totalBarcodeHooks += node.barcodeScannerHooks.length;
    astMap.summary.totalUiHooks += node.uiAndDomHooks.length;
  }

  return astMap;
}

// ===========================================================================
// ENGINE 3: LLM CODE GENERATION, MODIFICATION & PORTABLE APP REBUILDER
// ===========================================================================

function getActiveAiProvider() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return null;
    const json = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const providers = json.ai_providers || {};
    for (const name of ['groq', 'gemini', 'deepseek', 'openrouter', 'cerebras']) {
      const cfg = providers[name];
      if (cfg && typeof cfg.key === 'string' && cfg.key.length > 8 && cfg.model && cfg.baseURL) {
        return { name, ...cfg };
      }
    }
  } catch (_) {}
  return null;
}

function callLLMProvider(cfg, systemPrompt, userPrompt) {
  return new Promise((resolve) => {
    try {
      const u = new URL(`${cfg.baseURL.replace(/\/+$/, '')}/chat/completions`);
      const payload = JSON.stringify({
        model: cfg.model,
        temperature: 0.15,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });

      const req = https.request({
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.key}`,
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 45000,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const content = parsed?.choices?.[0]?.message?.content || null;
            resolve({ ok: Boolean(content), content, rawError: parsed?.error?.message || null });
          } catch (e) {
            resolve({ ok: false, content: null, rawError: e.message });
          }
        });
      });

      req.on('error', (e) => resolve({ ok: false, content: null, rawError: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, content: null, rawError: 'LLM request timed out' }); });
      req.write(payload);
      req.end();
    } catch (e) {
      resolve({ ok: false, content: null, rawError: e.message });
    }
  });
}

function extractCleanCodeFromMarkdown(llmText) {
  if (!llmText) return '';
  const fenceMatch = llmText.match(/```(?:html|javascript|js|python|css|json)?\s*\r?\n([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    return fenceMatch[1].trim();
  }
  return llmText.trim();
}

async function runLLMCodeModificationPipeline(extractDir, modifiedDir, astMap, modificationPrompt) {
  fs.mkdirSync(modifiedDir, { recursive: true });
  // First copy all extracted files to modifiedDir so untouched assets remain intact
  copySourceDirectory(extractDir, modifiedDir);

  const aiCfg = getActiveAiProvider();
  if (!aiCfg) {
    return {
      ok: false,
      reason: 'No active AI API key found in 01_CONFIG/settings.json.',
      modifiedFiles: [],
    };
  }

  // Pick the primary code/UI files to upgrade (up to top 4 primary files)
  const candidateFiles = astMap.files
    .filter((f) => ['.html', '.htm', '.js'].includes(f.extension))
    .sort((a, b) => (b.cameraAndMediaHooks.length + b.barcodeScannerHooks.length + b.functions.length) -
                    (a.cameraAndMediaHooks.length + a.barcodeScannerHooks.length + a.functions.length))
    .slice(0, 4);

  const modifiedResults = [];

  const systemPrompt = [
    'You are a Principal Full-Stack JavaScript, Electron & Computer Vision Engineer.',
    'Your job is to upgrade and modify the provided application source file according to the user instructions.',
    'STRICT ENGINEERING RULES:',
    '1. Output ONLY the complete, working, upgraded file inside a single code block. NEVER use placeholders like "// rest of code unchanged" or "// TODO".',
    '2. If the user asks to improve camera resolution or barcode/QR scanning speed:',
    '   - Upgrade WebRTC video constraints to HD/FHD (`width: { ideal: 1920 }, height: { ideal: 1080 }, focusMode: "continuous", frameRate: { ideal: 30 }`).',
    '   - Optimize scanner FPS, canvas `willReadFrequently: true`, and debounce duplicate scans cleanly.',
    '   - Clear stale media streams and memory buffers properly so the app never slows down over time.',
    '3. Preserve all existing working features while seamlessly integrating requested UI/font changes and new functions.',
  ].join('\n');

  for (const astFile of candidateFiles) {
    const srcFilePath = path.join(extractDir, astFile.file);
    const destFilePath = path.join(modifiedDir, astFile.file);
    if (!fs.existsSync(srcFilePath)) continue;

    const originalCode = fs.readFileSync(srcFilePath, 'utf8');
    if (originalCode.length > 55000) continue; // Skip massive minified vendor bundles

    const astContextNote = JSON.stringify({
      file: astFile.file,
      detectedFunctions: astFile.functions.map((fn) => `${fn.name}(${fn.params}) [Lines ${fn.startLine}-${fn.endLine}]`),
      cameraHooks: astFile.cameraAndMediaHooks,
      barcodeScannerHooks: astFile.barcodeScannerHooks,
    }, null, 2);

    const userPrompt = [
      `### USER MODIFICATION & UPGRADE INSTRUCTIONS:`,
      modificationPrompt,
      '',
      `### AST STRUCTURAL ANALYSIS OF THIS FILE:`,
      astContextNote,
      '',
      `### ORIGINAL SOURCE FILE (${astFile.file}):`,
      '```',
      originalCode,
      '```',
      '',
      'Return the COMPLETE upgraded file now with zero omissions.',
    ].join('\n');

    let llmRes = await callLLMProvider(aiCfg, systemPrompt, userPrompt);
    if (!llmRes.ok || !llmRes.content) continue;

    let updatedCode = extractCleanCodeFromMarkdown(llmRes.content);

    // If it's a .js file, verify syntax via vm.Script; auto-retry once if syntax error occurs
    if (astFile.extension === '.js') {
      const check1 = validateJsSyntax(updatedCode, astFile.file);
      if (!check1.valid) {
        const retryPrompt = `${userPrompt}\n\nWARNING: Your previous output had a JavaScript SyntaxError: ${check1.error}. Fix the syntax error and output the complete valid JS file.`;
        llmRes = await callLLMProvider(aiCfg, systemPrompt, retryPrompt);
        if (llmRes.ok && llmRes.content) {
          updatedCode = extractCleanCodeFromMarkdown(llmRes.content);
        }
      }
    }

    if (updatedCode && updatedCode.length > 40) {
      fs.mkdirSync(path.dirname(destFilePath), { recursive: true });
      fs.writeFileSync(destFilePath, updatedCode, 'utf8');
      modifiedResults.push({
        file: astFile.file,
        savedTo: destFilePath,
        originalSize: originalCode.length,
        newSize: updatedCode.length,
      });
    }
  }

  // Generate a 100% Portable Zero-Install Launcher in modifiedDir
  const launcherBatPath = path.join(modifiedDir, 'RUN_PORTABLE_APP.bat');
  const hasPackageJson = fs.existsSync(path.join(modifiedDir, 'package.json'));
  const htmlEntry = fs.readdirSync(modifiedDir).find((f) => f.toLowerCase().endsWith('.html')) || 'index.html';

  const batContent = [
    '@echo off',
    'title JARVIS Reconstructed Portable App',
    'cd /d "%~dp0"',
    hasPackageJson
      ? 'if exist "node_modules\\electron\\dist\\electron.exe" ( start "" "node_modules\\electron\\dist\\electron.exe" . ) else ( npx electron . || start "" "' + htmlEntry + '" )'
      : `start "" "${htmlEntry}"`,
  ].join('\r\n');

  fs.writeFileSync(launcherBatPath, batContent, 'utf8');

  return {
    ok: true,
    providerUsed: aiCfg.name,
    modifiedFiles: modifiedResults,
    portableLauncher: launcherBatPath,
  };
}

// ===========================================================================
// EXPORTED JARVIS TOOL CONTRACT
// ===========================================================================

module.exports = {
  name: 'ast_decompiler_llm_pipeline',
  description: 'A0. Master AST Parser, Binary/EXE/APK/ASAR Decompiler Hook, and LLM Code Generation Pipeline for extracting, cloning, modifying, and rebuilding applications.',
  tags: [
    'ast', 'ast parser', 'decompiler', 'decompile exe', 'decompile apk', 'asar extract',
    'llm pipeline', 'clone app', 'modify app', 'reverse engineer', 'rebuild', 'barcode scanner',
  ],
  risk: 'RISKY',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['extract_and_decompile', 'parse_ast', 'modify_and_rebuild', 'full_clone_pipeline'],
        description: 'Pipeline mode: extract_and_decompile, parse_ast, modify_and_rebuild, or full_clone_pipeline.',
      },
      target_path: {
        type: 'string',
        description: 'Path to the target .exe, .asar, .apk, script, or project directory.',
      },
      modification_prompt: {
        type: 'string',
        description: 'Detailed instructions for cloning/modifying the app (e.g., "Upgrade camera resolution to 1080p HD, speed up QR scan loop, change UI font, add export button").',
      },
      output_app_name: {
        type: 'string',
        description: 'Optional custom name for the reconstructed output folder under work/reconstructed_apps/.',
      },
    },
    required: ['action', 'target_path'],
  },

  async execute(args, ctx) {
    const action = String(args?.action || 'full_clone_pipeline').trim();
    const rawTarget = String(args?.target_path || '').trim();
    if (!rawTarget) return { error: 'target_path is required.' };

    const resolvedTarget = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(ROOT, rawTarget);
    if (!fs.existsSync(resolvedTarget)) {
      return { error: `Target path not found: ${resolvedTarget}` };
    }

    const appName = sanitizeName(args?.output_app_name || path.basename(resolvedTarget));
    const appBaseWorkDir = path.join(WORK_RECON_DIR, appName);
    const extractDir = path.join(appBaseWorkDir, '1_extracted_source');
    const modifiedDir = path.join(appBaseWorkDir, '2_modified_portable_build');
    const astReportPath = path.join(appBaseWorkDir, `${appName}_AST_MAP.json`);

    fs.mkdirSync(appBaseWorkDir, { recursive: true });

    // STEP 1: Decompile / Extract Source
    const decompileReport = runDecompilerHooks(resolvedTarget, extractDir);

    if (action === 'extract_and_decompile') {
      return {
        success: true,
        action,
        method_used: decompileReport.methodUsed,
        extracted_to: extractDir,
        extracted_files_count: decompileReport.extractedFiles.length,
        extracted_files: decompileReport.extractedFiles.slice(0, 40),
        notes: decompileReport.notes,
      };
    }

    // STEP 2: Parse AST & Detect Camera / Barcode / UI Hooks
    const astMap = buildProjectASTMap(decompileReport.extractedFiles, extractDir);
    fs.writeFileSync(astReportPath, JSON.stringify(astMap, null, 2), 'utf8');

    if (action === 'parse_ast') {
      return {
        success: true,
        action,
        ast_map_saved_to: astReportPath,
        summary: astMap.summary,
        detected_files: astMap.files.map((f) => ({
          file: f.file,
          lines: f.totalLines,
          syntaxValid: f.syntaxValid,
          functions: f.functions.map((fn) => fn.name),
          cameraHooksCount: f.cameraAndMediaHooks.length,
          barcodeHooksCount: f.barcodeScannerHooks.length,
        })),
      };
    }

    // STEP 3: LLM Code Modification & Portable Rebuild (`modify_and_rebuild` or `full_clone_pipeline`)
    const modPrompt = String(
      args?.modification_prompt ||
      'Optimize performance, upgrade camera video constraints to 1080p high resolution, fix any memory leaks or slow barcode/QR scanning loops, and modernize the UI.'
    ).trim();

    const llmBuildResult = await runLLMCodeModificationPipeline(
      extractDir,
      modifiedDir,
      astMap,
      modPrompt
    );

    if (ctx && typeof ctx.audit === 'function') {
      ctx.audit('info', 'ast_decompiler_llm_pipeline_completed', {
        target: resolvedTarget,
        action,
        extracted_count: decompileReport.extractedFiles.length,
        modified_count: llmBuildResult.modifiedFiles?.length || 0,
      });
    }

    return {
      success: true,
      action,
      app_workspace: appBaseWorkDir,
      decompilation: {
        method: decompileReport.methodUsed,
        extracted_source_dir: extractDir,
        files_extracted: decompileReport.extractedFiles.length,
      },
      ast_analysis: {
        ast_json_file: astReportPath,
        summary: astMap.summary,
      },
      llm_reconstruction: llmBuildResult,
      next_step_guide: `তোমার অ্যাপের এক্সট্র্যাক্ট করা সোর্স কোড '${extractDir}' ফোল্ডারে এবং আপগ্রেডেড পোর্টেবল ভার্সন '${modifiedDir}' ফোল্ডারে তৈরি হয়ে গেছে!`,
    };
  },
};