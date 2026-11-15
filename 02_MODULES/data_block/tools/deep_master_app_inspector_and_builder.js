'use strict';

/**
 * Tool: master_app_inspector_and_builder (v2.0 — PhD & Higher-Engineering Study Edition)
 *
 * Upgraded Capabilities:
 *   1. Real Code Snippet Extraction:
 *      - Extracts actual function/class source code blocks from every file (not just function names).
 *   2. Line-by-Line Bangla Engineering Commentary:
 *      - Explains in detailed Bangla WHAT each code block does, HOW it interacts with the OS/Kernel,
 *        and WHY it is architected that way (ideal for higher-degree engineering study & R&D).
 *   3. Built-in AI Professor Deep-Dive (Automatic):
 *      - Uses your configured AI provider (Groq/Gemini/DeepSeek) to write an in-depth Bangla
 *        Systems Engineering Lecture Note on the target's actual source code.
 *   4. Master Reconstruction Prompt + Auto-Tool Synthesis (Enabled by default for external targets).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const ROOT = process.env.JARVIS_ROOT || path.resolve(__dirname, '..', '..');
const ENGINE_DIR = path.join(ROOT, '00_ENGINE');
const CONFIG_DIR = path.join(ROOT, '01_CONFIG');
const TOOLS_DIR = path.join(ENGINE_DIR, 'tools');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const DOCS_OUT_DIR = path.join(ROOT, 'work', 'engineering_docs');

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', '.idea', '.vscode',
]);

const CODE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.py', '.ps1', '.bat', '.cmd', '.sh', '.c', '.cpp', '.h', '.cs', '.go', '.rs',
]);

const BINARY_EXTENSIONS = new Set(['.exe', '.dll', '.sys', '.so', '.bin', '.msi']);

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ---------------------------------------------------------------------------
// 1. Directory & File Inventory Scanner
// ---------------------------------------------------------------------------
function scanTargetStructure(targetPath, maxDepth = 4, maxFiles = 200) {
  const inventory = {
    rootPath: targetPath,
    isDirectory: false,
    totalFiles: 0,
    totalDirs: 0,
    totalSizeBytes: 0,
    treeLines: [],
    codeFiles: [],
    binaryFiles: [],
    manifestFiles: [],
  };

  const st = fs.statSync(targetPath);
  if (st.isFile()) {
    inventory.isDirectory = false;
    inventory.totalFiles = 1;
    inventory.totalSizeBytes = st.size;
    const ext = path.extname(targetPath).toLowerCase();
    inventory.treeLines.push(`📄 ${path.basename(targetPath)} (${formatBytes(st.size)})`);
    if (CODE_EXTENSIONS.has(ext)) inventory.codeFiles.push(targetPath);
    if (BINARY_EXTENSIONS.has(ext)) inventory.binaryFiles.push(targetPath);
    return inventory;
  }

  inventory.isDirectory = true;

  function walk(currentDir, depth, prefix) {
    if (depth > maxDepth || inventory.totalFiles >= maxFiles) return;
    let entries = [];
    try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); } catch (_) { return; }

    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (let i = 0; i < entries.length; i++) {
      if (inventory.totalFiles >= maxFiles) break;
      const ent = entries[i];
      const isLast = i === entries.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const fullPath = path.join(currentDir, ent.name);

      if (ent.isDirectory()) {
        if (IGNORED_DIRS.has(ent.name)) {
          inventory.treeLines.push(`${prefix}${connector}📁 ${ent.name}/ (skipped)`);
          continue;
        }
        inventory.totalDirs++;
        inventory.treeLines.push(`${prefix}${connector}📁 ${ent.name}/`);
        walk(fullPath, depth + 1, prefix + (isLast ? '    ' : '│   '));
      } else if (ent.isFile()) {
        inventory.totalFiles++;
        let fSize = 0;
        try { fSize = fs.statSync(fullPath).size; } catch (_) {}
        inventory.totalSizeBytes += fSize;

        const ext = path.extname(ent.name).toLowerCase();
        inventory.treeLines.push(`${prefix}${connector}📄 ${ent.name} (${formatBytes(fSize)})`);

        if (['package.json', 'requirements.txt', 'extensions.json'].includes(ent.name.toLowerCase())) {
          inventory.manifestFiles.push(fullPath);
        }
        if (CODE_EXTENSIONS.has(ext)) inventory.codeFiles.push(fullPath);
        else if (BINARY_EXTENSIONS.has(ext)) inventory.binaryFiles.push(fullPath);
      }
    }
  }

  inventory.treeLines.push(`📦 ${path.basename(targetPath)}/`);
  walk(targetPath, 1, '');
  return inventory;
}

// ---------------------------------------------------------------------------
// 2. Real Code Block & Function Extractor + Bangla Technical Explainer
// ---------------------------------------------------------------------------
function explainCodeMechanicsInBangla(codeSnippet, fnName) {
  const notes = [];

  if (/spawn\(|execSync\(|execFile\(|execFileSync\(|subprocess\./.test(codeSnippet)) {
    notes.push('🔹 **OS Subprocess & Process Control:** এই কোড ব্লকটি সরাসরি অপারেটিং সিস্টেমের কার্নেলে নতুন চাইল্ড প্রসেস (Child Process) তৈরি করছে এবং কমান্ড-লাইন বা এক্সটার্নাল বাইনারির সাথে `stdin/stdout` পাইপলাইনের মাধ্যমে ডেটা আদান-প্রদান করছে।');
  }
  if (/ipcMain\.|ipcRenderer\.|webContents\.send/.test(codeSnippet)) {
    notes.push('🔹 **Inter-Process Communication (IPC Bridge):** এখানে ইলেকট্রনের মেইন প্রসেস (Backend Node.js) এবং রেন্ডারার প্রসেসের (Frontend UI) মধ্যে অ্যাসিঙ্ক্রোনাস ইভেন্ট-ড্রিভেন মেসেজ পাসিং ঘটছে।');
  }
  if (/https\.request|https\.get|fetch\(|URL\(/.test(codeSnippet)) {
    notes.push('🔹 **Network Socket & TLS/HTTPS Layer:** এই অংশটি রিমোট সার্ভার বা AI API এন্ডপয়েন্টের সাথে এনক্রিপ্টেড HTTPS/TLS কানেকশন স্থাপন করে JSON পে-লোড আদান-প্রদান করছে।');
  }
  if (/fs\.readFileSync|fs\.writeFileSync|fs\.openSync|fs\.watch|readdirSync/.test(codeSnippet)) {
    notes.push('🔹 **File System I/O & Disk Persistence:** এই কোডটি সরাসরি লোকাল স্টোরেজ বা হার্ডডিস্কের ফাইল সিস্টেমে রিড/রাইট অথবা ডিরেক্টরি মনিটরিং (`fs.watch`) করছে।');
  }
  if (/ctypes\.windll|user32|kernel32|SetCursorPos|SendInput/.test(codeSnippet)) {
    notes.push('🔹 **Win32 C-API Kernel Hooking:** এটি কোনো থার্ড-পার্টি লাইব্রেরি ছাড়াই সরাসরি Windows OS-এর নিচতলার `user32.dll` বা `kernel32.dll` C-API মেমোরি স্ট্রাকচারে হার্ডওয়্যার ইনপুট/হুক পাঠাচ্ছে।');
  }
  if (/Promise\.race|new Promise|async\s+function|await\s+/.test(codeSnippet)) {
    notes.push('🔹 **Asynchronous Concurrency & Event Loop:** মেইন থ্রেড যেন ব্লক বা ফ্রিজ না হয়ে যায়, সেজন্য এখানে নন-ব্লকিং প্রমিস (Non-blocking Promise/Async-Await) এবং টাইমআউট গার্ড ব্যবহার করা হয়েছে।');
  }
  if (/try\s*\{[\s\S]*?catch\s*\(/.test(codeSnippet)) {
    notes.push('🔹 **Fault-Tolerance & Fail-Safe Architecture:** রানটাইম ক্র্যাশ ঠেকাতে এখানে ডিফেন্সিভ এরর হ্যান্ডলিং (`try/catch`) এবং ফলব্যাক মেকানিজম বসানো হয়েছে।');
  }
  if (/crypto\.|mask\(|SENSITIVE_KEYS|FORBIDDEN/.test(codeSnippet)) {
    notes.push('🔹 **Security Boundary & Data Sanitization:** সিস্টেমের নিরাপত্তা নিশ্চিত করতে এখানে ডেটা মাস্কিং, পাথ ভ্যালিডেশন বা ক্রিপ্টোগ্রাফিক আইডি জেনারেশন করা হয়েছে।');
  }

  if (notes.length === 0) {
    notes.push(`🔹 **Core Logic & State Manipulation:** \`${fnName}\` অংশটি সিস্টেমের ইন্টারনাল ডেটা স্ট্রাকচার ভ্যালিডেশন, স্টেট আপডেট এবং মডিউলার লজিক নিয়ন্ত্রণ করছে।`);
  }

  return notes.join('\n');
}

function extractFunctionsWithCode(content, ext) {
  const lines = content.split(/\r?\n/);
  const extracted = [];

  if (['.js', '.mjs', '.cjs', '.ts'].includes(ext)) {
    // Match top-level or key functions, classes, and module.exports methods
    const sigRegex = /^(?:async\s+)?function\s+([a-zA-Z0-9_]+)\s*\([^)]*\)\s*\{|^class\s+([a-zA-Z0-9_]+)\s*\{|^\s*([a-zA-Z0-9_]+)\s*\([^)]*\)\s*\{/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(sigRegex);
      if (!m) continue;

      const symbolName = m[1] || m[2] || m[3] || 'anonymous_block';
      if (['if', 'for', 'while', 'switch', 'catch'].includes(symbolName)) continue;

      // Capture balanced braces up to 45 lines so the user sees the real working code
      let braceCount = 0;
      let started = false;
      const snippetLines = [];

      for (let j = i; j < Math.min(lines.length, i + 45); j++) {
        const cur = lines[j];
        snippetLines.push(cur);
        for (const ch of cur) {
          if (ch === '{') { braceCount++; started = true; }
          else if (ch === '}') braceCount--;
        }
        if (started && braceCount <= 0) {
          i = j;
          break;
        }
      }

      const codeBlock = snippetLines.join('\n');
      extracted.push({
        name: symbolName,
        lang: 'javascript',
        code: codeBlock,
        banglaExplanation: explainCodeMechanicsInBangla(codeBlock, symbolName),
      });

      if (extracted.length >= 12) break; // Keep top 12 core blocks per file
    }
  } else if (ext === '.py') {
    const pyRegex = /^(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\(|^class\s+([a-zA-Z0-9_]+)/;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(pyRegex);
      if (!m) continue;
      const symbolName = m[1] || m[2];
      const snippetLines = [lines[i]];
      for (let j = i + 1; j < Math.min(lines.length, i + 40); j++) {
        if (/^(?:def |class |if __name__)/.test(lines[j])) break;
        snippetLines.push(lines[j]);
      }
      const codeBlock = snippetLines.join('\n').trimEnd();
      extracted.push({
        name: symbolName,
        lang: 'python',
        code: codeBlock,
        banglaExplanation: explainCodeMechanicsInBangla(codeBlock, symbolName),
      });
      if (extracted.length >= 12) break;
    }
  }

  // Fallback if file is a compact module.exports object or script without named functions
  if (extracted.length === 0 && content.trim().length > 0) {
    const sample = lines.slice(0, 50).join('\n');
    extracted.push({
      name: 'module_entry_point',
      lang: ext === '.py' ? 'python' : 'javascript',
      code: sample,
      banglaExplanation: explainCodeMechanicsInBangla(sample, 'module_entry_point'),
    });
  }

  return extracted;
}

function analyzeSourceMechanics(inventory) {
  const mechanics = {
    languagesDetected: new Set(),
    importsAndLibraries: new Set(),
    systemCallsAndProcesses: new Set(),
    networkAndIpcChannels: new Set(),
    fileSystemOperations: new Set(),
    environmentVariables: new Set(),
    fileStudies: [],
  };

  for (const filePath of inventory.codeFiles.slice(0, 20)) {
    const ext = path.extname(filePath).toLowerCase();
    const relName = path.relative(inventory.rootPath, filePath) || path.basename(filePath);
    let content = '';
    try { content = fs.readFileSync(filePath, 'utf8').slice(0, 60000); } catch (_) { continue; }

    if (['.js', '.mjs', '.cjs', '.ts'].includes(ext)) mechanics.languagesDetected.add('JavaScript (Node.js / Electron)');
    else if (ext === '.py') mechanics.languagesDetected.add('Python 3');
    else if (ext === '.ps1') mechanics.languagesDetected.add('PowerShell');

    // Imports
    for (const m of content.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      mechanics.importsAndLibraries.add(`require('${m[1]}')`);
    }
    for (const m of content.matchAll(/^\s*(?:import|from)\s+([a-zA-Z0-9_.\-]+)/gm)) {
      mechanics.importsAndLibraries.add(`import ${m[1]}`);
    }

    // System / IPC / FS hooks
    if (/\b(?:execSync|execFileSync|spawn|exec|subprocess)\b/.test(content)) {
      mechanics.systemCallsAndProcesses.add(`${relName}: OS Subprocess Spawning & CLI Piping`);
    }
    if (/\bctypes\.windll\b/.test(content)) {
      mechanics.systemCallsAndProcesses.add(`${relName}: Win32 Native C-Types Hardware/OS Hook`);
    }
    if (/\b(?:ipcMain|ipcRenderer|contextBridge)\b/.test(content)) {
      mechanics.networkAndIpcChannels.add(`${relName}: Electron Main-Renderer IPC Channel`);
    }
    if (/\bhttps?\.(?:request|get)\b/.test(content)) {
      mechanics.networkAndIpcChannels.add(`${relName}: HTTPS REST Client Socket`);
    }
    if (/\bfs\.(?:readFileSync|writeFileSync|openSync|watch)\b/.test(content)) {
      mechanics.fileSystemOperations.add(`${relName}: Direct Disk I/O & File Watcher`);
    }

    for (const m of content.matchAll(/process\.env\.([A-Z0-9_]+)|os\.environ\.get\(\s*['"]([A-Z0-9_]+)['"]/g)) {
      mechanics.environmentVariables.add(m[1] || m[2]);
    }

    const topCommentMatch = content.match(/\/\*\*([\s\S]*?)\*\/|"""([\s\S]*?)"""/);
    const headerNote = topCommentMatch
      ? (topCommentMatch[1] || topCommentMatch[2] || '').replace(/\s*\*\s*/g, ' ').trim().slice(0, 400)
      : 'Core execution script.';

    const codeBlocks = extractFunctionsWithCode(content, ext);

    mechanics.fileStudies.push({
      file: relName,
      lines: content.split(/\r?\n/).length,
      summary: headerNote,
      codeBlocks,
      rawPreview: content.slice(0, 2500),
    });
  }

  return mechanics;
}

// ---------------------------------------------------------------------------
// 3. AI-Powered Bangla Engineering Professor Synthesis (Uses Active AI Key)
// ---------------------------------------------------------------------------
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

function askAiForBanglaEngineeringLecture(targetName, mechanics) {
  const cfg = getActiveAiProvider();
  if (!cfg || mechanics.fileStudies.length === 0) {
    return Promise.resolve(null);
  }

  const condensedCodeDigest = mechanics.fileStudies.slice(0, 8).map((fsItem) => {
    const blocksText = fsItem.codeBlocks.slice(0, 4).map((b) => `// Function: ${b.name}\n${b.code}`).join('\n\n');
    return `=== FILE: ${fsItem.file} (${fsItem.lines} lines) ===\n${blocksText}`;
  }).join('\n\n');

  const prompt = [
    `তুমি একজন Computer Science & Systems Engineering এর সিনিয়র প্রফেসর।`,
    `নিচে "${targetName}" প্রজেক্টের আসল সোর্স কোডের মূল অংশগুলো দেওয়া হলো।`,
    `একজন হায়ার-ডিগ্রি ইঞ্জিনিয়ারিং স্টুডেন্ট যাতে এই কোড দেখে পুরো সিস্টেমের আর্কিটেকচার এবং প্রতিটি অংশের কাজ গভীরভাবে শিখতে পারে, সেজন্য পরিষ্কার বাংলায় (প্রয়োজনীয় টেকনিক্যাল টার্ম ইংরেজিতে রেখে) একটি বিস্তারিত "ইঞ্জিনিয়ারিং লেকচার ও কোড পোস্টমর্টেম" লেখো:`,
    `১. পুরো সিস্টেমটির ডেটা-ফ্লো এবং আর্কিটেকচারাল ডিজাইন প্যাটান (যেমন Event-Driven, Microkernel, IPC Bridge, Fail-Closed Logging ইত্যাদি) কীভাবে কাজ করছে?`,
    `২. প্রতিটি ফাইলের প্রধান কোড এবং ফাংশনগুলো কেন এভাবে লেখা হয়েছে এবং সেগুলো মেমোরি, সিপিইউ ও অপারেটিং সিস্টেমের সাথে কীভাবে ইন্টারঅ্যাক্ট করছে?`,
    `৩. এই কোডবেস থেকে একজন সফটওয়্যার আর্কিটেক্টের শেখার মতো ৩-৪টি অ্যাডভান্সড ইঞ্জিনিয়ারিং টেকনিক কী কী?`,
    '',
    condensedCodeDigest.slice(0, 14000),
  ].join('\n');

  return new Promise((resolve) => {
    try {
      const u = new URL(`${cfg.baseURL.replace(/\/+$/, '')}/chat/completions`);
      const body = JSON.stringify({
        model: cfg.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: 'You are a Principal Systems Engineering Professor writing a comprehensive Bangla textbook guide on real source code.' },
          { role: 'user', content: prompt },
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
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 22000,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve(parsed?.choices?.[0]?.message?.content || null);
          } catch (_) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(body);
      req.end();
    } catch (_) {
      resolve(null);
    }
  });
}

// ---------------------------------------------------------------------------
// 4. Build Complete Textbook-Grade Engineering Markdown Document
// ---------------------------------------------------------------------------
function buildEngineeringMarkdown(targetName, inventory, mechanics, aiBanglaLecture, generatedToolInfo) {
  const langs = Array.from(mechanics.languagesDetected).join(', ') || 'Native Binary / Script';
  const libs = Array.from(mechanics.importsAndLibraries);
  const sysCalls = Array.from(mechanics.systemCallsAndProcesses);
  const netCalls = Array.from(mechanics.networkAndIpcChannels);
  const fsCalls = Array.from(mechanics.fileSystemOperations);
  const envVars = Array.from(mechanics.environmentVariables);

  const fileStudySections = mechanics.fileStudies.map((fItem, idx) => {
    const blocksMd = fItem.codeBlocks.map((b, bIdx) => [
      `#### 📌 কোড ব্লক ${idx + 1}.${bIdx + 1}: \`${b.name}\``,
      '```' + b.lang,
      b.code,
      '```',
      '**🔍 এই কোডটুকুর ইঞ্জিনিয়ারিং ব্যবচ্ছেদ (Working Mechanism in Bangla):**',
      b.banglaExplanation,
      '',
    ].join('\n')).join('\n');

    return [
      `### 📂 ফাইল ${idx + 1}: \`${fItem.file}\` (মোট লাইন: ${fItem.lines})`,
      `- **ফাইলের মূল উদ্দেশ্য (Module Role):** ${fItem.summary}`,
      '',
      blocksMd,
      '---',
    ].join('\n');
  });

  return [
    `# 🎓 MASTER ENGINEERING TEXTBOOK & CODE POSTMORTEM: ${targetName.toUpperCase()}`,
    `> **Generated by:** JARVIS-CORE Master App Inspector v2.0 (Higher-Engineering Study Edition)`,
    `> **Timestamp:** ${new Date().toISOString()}`,
    `> **Analyzed Target:** \`${inventory.rootPath}\``,
    '',
    '---',
    '',
    '## ১. এক্সিকিউটিভ সামারি ও সিস্টেম ওভারভিউ (System Overview)',
    `- **প্রজেক্ট/সিস্টেমের নাম:** \`${targetName}\``,
    `- **মোট ফাইল ও ফোল্ডার:** ${inventory.totalFiles}টি ফাইল, ${inventory.totalDirs}টি ফোল্ডার (মোট সাইজ: ${formatBytes(inventory.totalSizeBytes)})`,
    `- **প্রোগ্রামিং ল্যাঙ্গুয়েজ ও রানটাইম:** ${langs}`,
    `- **সিস্টেম মেকানিজম:** এই সফটওয়্যারটি ${sysCalls.length} ধরনের OS সাবপ্রসেস/কার্নেল হুক, ${netCalls.length} ধরনের নেটওয়ার্ক/IPC চ্যানেল এবং ${fsCalls.length} ধরনের ডিস্ক I/O মডিউল ব্যবহার করে কাজ করে।`,
    '',
    '---',
    '',
    '## ২. ফোল্ডার ও ফাইল আর্কিটেকচার ট্রি (Directory Tree)',
    '```plaintext',
    ...inventory.treeLines.slice(0, 120),
    '```',
    '',
    '---',
    '',
    '## ৩. ব্যবহৃত লাইব্রেরি, কার্নেল হুক ও API ম্যাট্রিক্স (Tech Stack & OS Hooks)',
    '### ক. ইমপোর্ট করা মডিউল ও ডিপেন্ডেন্সি:',
    libs.length > 0 ? libs.map((l) => `- \`${l}\``).join('\n') : '- কোনো বাহ্যিক লাইব্রেরি নেই।',
    '',
    '### খ. অপারেটিং সিস্টেম ও প্রসেস কন্ট্রোল হুকস:',
    sysCalls.length > 0 ? sysCalls.map((s) => `- ⚙️ ${s}`).join('\n') : '- স্ট্যান্ডার্ড ইন-মেমোরি প্রসেসিং।',
    '',
    '### গ. নেটওয়ার্ক ও ইন্টার-প্রসেস কমিউনিকেশন (IPC):',
    netCalls.length > 0 ? netCalls.map((n) => `- 🌐 ${n}`).join('\n') : '- কোনো নেটওয়ার্ক/IPC ব্যবহৃত হয়নি।',
    '',
    '### ঘ. ফাইল সিস্টেম ও স্টোরেজ অপারেশন:',
    fsCalls.length > 0 ? fsCalls.map((f) => `- 💾 ${f}`).join('\n') : '- কোনো ডিস্ক রাইট অপারেশন নেই।',
    '',
    '---',
    '',
    '## ৪. প্রফেসর-লেভেল আর্কিটেকচার ও ইঞ্জিনিয়ারিং লেকচার নোট (AI Deep-Dive in Bangla)',
    aiBanglaLecture
      ? aiBanglaLecture
      : '_নোট: অফলাইন স্ট্যাটিক মোডে জেনারেট করা হয়েছে। নিচে প্রতিটি ফাইলের আসল কোড ব্লক এবং বাংলা ব্যবচ্ছেদ দেওয়া হলো।_',
    '',
    '---',
    '',
    '## ৫. ফাইল-বাই-ফাইল আসল কোড এবং বাংলায় ইঞ্জিনিয়ারিং ব্যবচ্ছেদ (Actual Code & Line-by-Line Study)',
    'এখানে প্রতিটি ফাইলের ভেতরের **আসল সোর্স কোড (Actual Code Snippets)** তুলে ধরা হয়েছে এবং কোন কোড দিয়ে কী কাজ হচ্ছে তা বাংলায় ব্যাখ্যা করা হয়েছে:',
    '',
    ...(fileStudySections.length > 0 ? fileStudySections : ['_এই টার্গেটে কোনো সোর্স কোড ফাইল পাওয়া যায়নি।_']),
    '',
    '## ৬. অটো-জেনারেটেড JARVIS টুল স্ট্যাটাস (Auto-Tool Integration)',
    generatedToolInfo
      ? [
          `- **তৈরি হওয়া টুলের নাম:** \`${generatedToolInfo.toolName}\``,
          `- **ফাইলের লোকেশন:** \`${generatedToolInfo.toolFilePath}\``,
          `- **স্ট্যাটাস:** ✅ স্বয়ংক্রিয়ভাবে \`00_ENGINE/tools/\` ফোল্ডারে সেভ করা হয়েছে এবং \`tools_index.json\`-এ যুক্ত হয়েছে!`,
        ].join('\n')
      : '- টার্গেটটি নিজেই JARVIS-এর কোর ইঞ্জিন ফোল্ডার হওয়ায় ডুপ্লিকেট র‍্যাপার টুল তৈরি স্কিপ করা হয়েছে (অন্য যেকোনো অ্যাপ বা স্ক্রিপ্টের ক্ষেত্রে এটি স্বয়ংক্রিয়ভাবে টুল বানিয়ে দেবে)।',
    '',
    '---',
    '',
    '## ৭. MASTER RECONSTRUCTION PROMPT (হুবহু এই সিস্টেমটি স্ক্র্যাচ থেকে বানানোর মাস্টার প্রম্পট)',
    'নিচের প্রম্পটটি কপি করে যেকোনো এআই-কে দিলে সে এই পুরো আর্কিটেকচার এবং প্রতিটি ফাংশন হুবহু কোড করে দেবে:',
    '',
    '```markdown',
    `Act as a Principal Systems Architect. Reconstruct the complete, production-ready source code for "${targetName}" (${langs}) with zero compression or placeholders.`,
    '',
    '### 1. DIRECTORY STRUCTURE',
    ...inventory.treeLines.slice(0, 40),
    '',
    '### 2. REQUIRED MODULES, APIS & OS HOOKS',
    `- Libraries: ${libs.slice(0, 30).join(', ')}`,
    `- OS Subprocess Hooks: ${sysCalls.join('; ')}`,
    `- IPC/Network Bridges: ${netCalls.join('; ')}`,
    `- Environment Variables: ${envVars.join(', ')}`,
    '',
    '### 3. EXACT FILE-BY-FILE FUNCTION SIGNATURES & RESPONSIBILITIES',
    ...mechanics.fileStudies.map((fsItem) => (
      `- File "${fsItem.file}" (${fsItem.lines} lines): Must implement [${fsItem.codeBlocks.map((b) => b.name).join(', ')}]. Role: ${fsItem.summary}`
    )),
    '',
    '### 4. ENGINEERING RULES',
    '- Write complete, runnable files with strict input validation, fail-closed audit logging, and subprocess timeouts.',
    '```',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 5. Auto-Tool Synthesizer (Default ON for non-core targets)
// ---------------------------------------------------------------------------
function generateJarvisWrapperTool(targetName, inventory) {
  const cleanToolName = 'tool_' + targetName.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const toolFilePath = path.join(TOOLS_DIR, `${cleanToolName}.js`);

  let runnerType = 'node';
  let entryTarget = inventory.rootPath;

  if (inventory.binaryFiles.length > 0) {
    runnerType = 'exe';
    entryTarget = inventory.binaryFiles[0];
  } else if (!inventory.isDirectory) {
    const ext = path.extname(inventory.rootPath).toLowerCase();
    if (ext === '.py') runnerType = 'python';
    else if (ext === '.ps1') runnerType = 'powershell';
  } else {
    const pyMain = inventory.codeFiles.find((f) => ['main.py', 'app.py', 'run.py'].includes(path.basename(f).toLowerCase()));
    const jsMain = inventory.codeFiles.find((f) => ['index.js', 'main.js', 'app.js', 'cli.js'].includes(path.basename(f).toLowerCase()));
    if (pyMain) { runnerType = 'python'; entryTarget = pyMain; }
    else if (jsMain) { runnerType = 'node'; entryTarget = jsMain; }
  }

  const escapedTarget = entryTarget.replace(/\\/g, '\\\\');
  const code = `'use strict';

const { execFile } = require('child_process');
const path = require('path');

const TARGET_PATH = '${escapedTarget}';
const RUNNER_MODE = '${runnerType}';

module.exports = {
  name: '${cleanToolName}',
  description: 'Auto-generated execution bridge for ${targetName.replace(/'/g, '')} (${runnerType}).',
  tags: ['${cleanToolName.replace('tool_', '')}', '${targetName.toLowerCase()}', '${runnerType}', 'auto_tool'],
  risk: 'RISKY',
  parameters: {
    type: 'object',
    properties: {
      args: { type: 'array', items: { type: 'string' }, description: 'CLI arguments to pass to the tool.' },
    },
  },
  async execute(params) {
    const cliArgs = Array.isArray(params?.args) ? params.args.map(String) : [];
    let cmd = TARGET_PATH;
    let finalArgs = cliArgs;
    if (RUNNER_MODE === 'python') { cmd = process.env.JARVIS_PYTHON || 'python'; finalArgs = [TARGET_PATH, ...cliArgs]; }
    else if (RUNNER_MODE === 'node') { cmd = process.execPath; finalArgs = [TARGET_PATH, ...cliArgs]; }
    else if (RUNNER_MODE === 'powershell') { cmd = 'powershell'; finalArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', TARGET_PATH, ...cliArgs]; }

    return new Promise((resolve) => {
      execFile(cmd, finalArgs, { cwd: path.dirname(TARGET_PATH), timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, error: String(err.message), stdout: String(stdout || ''), stderr: String(stderr || '') });
        resolve({ ok: true, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
      });
    });
  },
};
`;

  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  fs.writeFileSync(toolFilePath, code, 'utf8');
  return { toolName: cleanToolName, toolFilePath };
}

// ---------------------------------------------------------------------------
// Exported Tool Contract
// ---------------------------------------------------------------------------
module.exports = {
  name: 'deep_master_app_inspector_and_builder',
  description: 'A0. Deep code analysis, extracting real source code blocks with line-by-line Bangla engineering breakdowns and PhD study manuals.',
  tags: ['deep inspect', 'deep analysis', 'code study', 'bangla lecture', 'extract code', 'breakdown'],
  risk: 'WRITE_SAFE',
  parameters: {
    type: 'object',
    properties: {
      target_path: {
        type: 'string',
        description: 'Path to the folder, script, or binary to analyze (e.g. "00_ENGINE" or "bin/my_tool.py").',
      },
      create_jarvis_tool: {
        type: 'boolean',
        description: 'Set true to auto-generate a JARVIS wrapper tool in 00_ENGINE/tools/ (default true for external apps).',
      },
    },
    required: ['target_path'],
  },

  async execute(args, ctx) {
    const rawTarget = String(args?.target_path || '').trim();
    if (!rawTarget) return { error: 'target_path_required' };

    const resolvedTarget = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(ROOT, rawTarget);
    if (!fs.existsSync(resolvedTarget)) {
      return { error: `Target path does not exist: ${resolvedTarget}` };
    }

    const targetName = path.basename(resolvedTarget, path.extname(resolvedTarget)) || 'target_system';
    const inventory = scanTargetStructure(resolvedTarget);
    const mechanics = analyzeSourceMechanics(inventory);

    // Ask AI to write a Professor-level Bangla Engineering Lecture on the extracted code
    const aiBanglaLecture = await askAiForBanglaEngineeringLecture(targetName, mechanics);

    // Auto-create tool unless it's 00_ENGINE itself (or explicitly set to false)
    const isCoreEngineDir = path.resolve(resolvedTarget).toLowerCase() === path.resolve(ENGINE_DIR).toLowerCase();
    const shouldCreateTool = args?.create_jarvis_tool === true || (args?.create_jarvis_tool !== false && !isCoreEngineDir);

    let generatedToolInfo = null;
    if (shouldCreateTool) {
      generatedToolInfo = generateJarvisWrapperTool(targetName, inventory);
      const librarian = ctx?.getService?.('tool_librarian');
      if (librarian && typeof librarian.syncIndex === 'function') {
        try { librarian.syncIndex(); } catch (_) {}
      }
    }

    fs.mkdirSync(DOCS_OUT_DIR, { recursive: true });
    const safeDocName = `${targetName.replace(/[^a-zA-Z0-9_-]/g, '_')}_ENGINEERING_BLUEPRINT.md`;
    const docFilePath = path.join(DOCS_OUT_DIR, safeDocName);

    const markdown = buildEngineeringMarkdown(
      targetName,
      inventory,
      mechanics,
      aiBanglaLecture,
      generatedToolInfo
    );
    fs.writeFileSync(docFilePath, markdown, 'utf8');

    return {
      success: true,
      target_analyzed: resolvedTarget,
      study_manual_saved_to: docFilePath,
      files_with_extracted_code_blocks: mechanics.fileStudies.length,
      ai_bangla_lecture_included: Boolean(aiBanglaLecture),
      auto_generated_tool: generatedToolInfo,
      message: `সম্পূর্ণ কোড ব্লক এবং বাংলা ইঞ্জিনিয়ারিং ব্যাখ্যাসহ মাস্টার ডকুমেন্ট সেভ হয়েছে: ${docFilePath}`,
    };
  },
};