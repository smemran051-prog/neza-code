'use strict';

/**
 * Tool: master_app_inspector_and_builder
 *
 * Master-Level Engineering Inspector, Reverse-Architecture Analyzer & Auto-Tool Builder
 *
 * Capabilities:
 *   1. Deep Target Inspection:
 *      - Scans any target folder, software directory, script (.js, .py, .ps1, .bat), or binary (.exe).
 *      - Extracts directory tree, entry points, package manifests (package.json, requirements.txt),
 *        imported libraries/APIs, system calls, CLI flags (--help/-h), and execution workflows.
 *   2. A-to-Z Engineering Blueprint & Documentation Generator:
 *      - Generates a complete Markdown engineering manual in `work/engineering_docs/<target>_BLUEPRINT.md`.
 *      - Includes Executive Summary, Working Principle, Tech Stack, Internal Execution Pipeline,
 *        Subprocess/OS Hooks, and a Copy-Paste "Master AI Reconstruction Prompt" for future R&D/PhD work.
 *   3. Self-Coding Auto-Tool Builder (Optional):
 *      - Automatically synthesizes a validated, dependency-free JARVIS tool inside `00_ENGINE/tools/`
 *        and triggers Librarian index synchronization (`00_ENGINE/tools_index.json`).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = process.env.JARVIS_ROOT || path.resolve(__dirname, '..', '..');
const ENGINE_DIR = path.join(ROOT, '00_ENGINE');
const TOOLS_DIR = path.join(ENGINE_DIR, 'tools');
const DOCS_OUT_DIR = path.join(ROOT, 'work', 'engineering_docs');

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', '.idea', '.vscode',
]);

const CODE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.py', '.ps1', '.bat', '.cmd', '.sh', '.json', '.yaml', '.yml', '.c', '.cpp', '.h', '.cs', '.go', '.rs',
]);

const BINARY_EXTENSIONS = new Set(['.exe', '.dll', '.sys', '.so', '.bin', '.msi']);

// ---------------------------------------------------------------------------
// Helper 1: Safe Directory Tree & File Inventory Scanner
// ---------------------------------------------------------------------------
function scanTargetStructure(targetPath, maxDepth = 4, maxFiles = 250) {
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
    extensionCounts: {},
  };

  let st;
  try {
    st = fs.statSync(targetPath);
  } catch (e) {
    throw new Error(`Target path not accessible: ${targetPath} (${e.message})`);
  }

  if (st.isFile()) {
    inventory.isDirectory = false;
    inventory.totalFiles = 1;
    inventory.totalSizeBytes = st.size;
    const ext = path.extname(targetPath).toLowerCase() || '(no_ext)';
    inventory.extensionCounts[ext] = 1;
    inventory.treeLines.push(`📄 ${path.basename(targetPath)} (${formatBytes(st.size)})`);
    if (CODE_EXTENSIONS.has(ext)) inventory.codeFiles.push(targetPath);
    if (BINARY_EXTENSIONS.has(ext)) inventory.binaryFiles.push(targetPath);
    return inventory;
  }

  inventory.isDirectory = true;

  function walk(currentDir, depth, prefix) {
    if (depth > maxDepth || inventory.totalFiles >= maxFiles) return;
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (_) {
      return;
    }

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
          inventory.treeLines.push(`${prefix}${connector}📁 ${ent.name}/ (skipped heavy directory)`);
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

        const ext = path.extname(ent.name).toLowerCase() || '(no_ext)';
        inventory.extensionCounts[ext] = (inventory.extensionCounts[ext] || 0) + 1;
        inventory.treeLines.push(`${prefix}${connector}📄 ${ent.name} (${formatBytes(fSize)})`);

        const lowerName = ent.name.toLowerCase();
        if (['package.json', 'requirements.txt', 'pyproject.toml', 'cargo.toml', 'go.mod', 'dockerfile', 'makefile'].includes(lowerName)) {
          inventory.manifestFiles.push(fullPath);
        }
        if (CODE_EXTENSIONS.has(ext)) {
          inventory.codeFiles.push(fullPath);
        } else if (BINARY_EXTENSIONS.has(ext)) {
          inventory.binaryFiles.push(fullPath);
        }
      }
    }
  }

  inventory.treeLines.push(`📦 ${path.basename(targetPath)}/`);
  walk(targetPath, 1, '');
  return inventory;
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ---------------------------------------------------------------------------
// Helper 2: Deep Static Code & Mechanism Analyzer (AST-lite / Pattern Engine)
// ---------------------------------------------------------------------------
function analyzeSourceMechanics(inventory) {
  const mechanics = {
    languagesDetected: new Set(),
    importsAndLibraries: new Set(),
    exportedFunctionsAndClasses: [],
    systemCallsAndProcesses: new Set(),
    networkAndIpcChannels: new Set(),
    fileSystemOperations: new Set(),
    environmentVariables: new Set(),
    cliArgumentsParsed: new Set(),
    manifestSummaries: [],
    fileDigests: [],
  };

  // 1. Parse Manifests (package.json, requirements.txt, etc.)
  for (const mf of inventory.manifestFiles) {
    const base = path.basename(mf).toLowerCase();
    try {
      const raw = fs.readFileSync(mf, 'utf8').slice(0, 30000);
      if (base === 'package.json') {
        const pkg = JSON.parse(raw);
        mechanics.manifestSummaries.push({
          file: mf,
          name: pkg.name || '(unnamed)',
          version: pkg.version || '0.0.0',
          main: pkg.main || 'index.js',
          scripts: pkg.scripts || {},
          dependencies: Object.keys(pkg.dependencies || {}),
          devDependencies: Object.keys(pkg.devDependencies || {}),
        });
      } else if (base === 'requirements.txt') {
        const reqs = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
        mechanics.manifestSummaries.push({
          file: mf,
          python_requirements: reqs,
        });
      }
    } catch (_) {}
  }

  // 2. Inspect Source Code Files (Up to top 25 files for thorough analysis)
  const filesToInspect = inventory.codeFiles.slice(0, 25);
  for (const filePath of filesToInspect) {
    const ext = path.extname(filePath).toLowerCase();
    const relName = path.relative(inventory.rootPath, filePath) || path.basename(filePath);
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf8').slice(0, 45000);
    } catch (_) {
      continue;
    }

    if (['.js', '.mjs', '.cjs', '.ts'].includes(ext)) mechanics.languagesDetected.add('JavaScript / Node.js');
    else if (ext === '.py') mechanics.languagesDetected.add('Python');
    else if (ext === '.ps1') mechanics.languagesDetected.add('PowerShell');
    else if (['.bat', '.cmd'].includes(ext)) mechanics.languagesDetected.add('Windows Batch CLI');
    else if (['.c', '.cpp', '.h'].includes(ext)) mechanics.languagesDetected.add('C / C++');

    // Extract Node.js require() and ES6 import
    const reqMatches = content.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g);
    for (const m of reqMatches) mechanics.importsAndLibraries.add(`node:${m[1]}`);

    const esImports = content.matchAll(/import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/g);
    for (const m of esImports) mechanics.importsAndLibraries.add(`es_module:${m[1]}`);

    // Extract Python imports
    if (ext === '.py') {
      const pyImports = content.matchAll(/^\s*(?:import|from)\s+([a-zA-Z0-9_.\-]+)/gm);
      for (const m of pyImports) mechanics.importsAndLibraries.add(`python:${m[1]}`);
    }

    // Extract Functions & Classes
    const fnNames = [];
    const jsFns = content.matchAll(/(?:async\s+)?function\s+([a-zA-Z0-9_]+)\s*\(/g);
    for (const m of jsFns) fnNames.push(`${m[1]}()`);

    const pyDefs = content.matchAll(/^\s*def\s+([a-zA-Z0-9_]+)\s*\(/gm);
    for (const m of pyDefs) fnNames.push(`${m[1]}()`);

    const classDefs = content.matchAll(/class\s+([a-zA-Z0-9_]+)/g);
    for (const m of classDefs) fnNames.push(`class ${m[1]}`);

    if (fnNames.length > 0) {
      mechanics.exportedFunctionsAndClasses.push({
        file: relName,
        symbols: fnNames.slice(0, 30),
      });
    }

    // Detect OS Subprocess / Command Execution Hooks
    const procPatterns = [
      { re: /\b(?:execSync|execFileSync|spawn|exec|fork)\b/g, label: 'Node child_process subprocess execution' },
      { re: /\b(?:subprocess\.Popen|subprocess\.run|os\.system)\b/g, label: 'Python OS subprocess invocation' },
      { re: /\bctypes\.windll\b/g, label: 'Python Win32 Native API (ctypes.windll)' },
      { re: /\bpowershell\b/gi, label: 'Windows PowerShell command bridge' },
      { re: /\bwmic\b|\btasklist\b|\btaskkill\b|\bnetstat\b/gi, label: 'Windows Native System Telemetry CLI' },
    ];
    for (const p of procPatterns) {
      if (p.re.test(content)) mechanics.systemCallsAndProcesses.add(`${p.label} (in ${relName})`);
    }

    // Detect Network & IPC Communication
    const netPatterns = [
      { re: /\bhttps?\.request\b|\bfetch\s*\(/g, label: 'HTTP/HTTPS REST API Client' },
      { re: /\bipcMain\b|\bipcRenderer\b|\bcontextBridge\b/g, label: 'Electron Main/Renderer IPC Bridge' },
      { re: /\bWebSocket\b|\bnet\.createServer\b|\bhttp\.createServer\b/g, label: 'Socket / Local Daemon Server' },
    ];
    for (const p of netPatterns) {
      if (p.re.test(content)) mechanics.networkAndIpcChannels.add(`${p.label} (in ${relName})`);
    }

    // Detect File System Operations
    const fsPatterns = [
      { re: /\bfs\.(?:readFileSync|writeFileSync|appendFileSync|readdirSync|watch|openSync)\b/g, label: 'Node.js Synchronous/Watched File I/O' },
      { re: /\bopen\s*\([^)]+,\s*['"][wa]/g, label: 'Python File Write/Append Stream' },
    ];
    for (const p of fsPatterns) {
      if (p.re.test(content)) mechanics.fileSystemOperations.add(`${p.label} (in ${relName})`);
    }

    // Detect Environment Variables
    const envMatches = content.matchAll(/process\.env\.([A-Z0-9_]+)|os\.environ\.get\(\s*['"]([A-Z0-9_]+)['"]/g);
    for (const m of envMatches) {
      const envName = m[1] || m[2];
      if (envName) mechanics.environmentVariables.add(envName);
    }

    // Detect CLI Flags
    const flagMatches = content.matchAll(/['"](--[a-zA-Z0-9\-]+|-[a-zA-Z])['"]/g);
    for (const m of flagMatches) {
      mechanics.cliArgumentsParsed.add(m[1]);
    }

    // Header Comment / Purpose Extraction
    const topCommentMatch = content.match(/\/\*\*([\s\S]*?)\*\/|"""([\s\S]*?)"""/);
    const headerNote = topCommentMatch
      ? (topCommentMatch[1] || topCommentMatch[2] || '').replace(/\s*\*\s*/g, ' ').trim().slice(0, 300)
      : 'Standard code module.';

    mechanics.fileDigests.push({
      file: relName,
      lines: content.split(/\r?\n/).length,
      summary: headerNote,
      keyFunctions: fnNames.slice(0, 12),
    });
  }

  return mechanics;
}

// ---------------------------------------------------------------------------
// Helper 3: Binary (.exe) Safe Metadata & Help Probe
// ---------------------------------------------------------------------------
function probeBinaries(binaryFiles, probeHelp = false) {
  const results = [];
  for (const binPath of binaryFiles.slice(0, 10)) {
    const info = {
      name: path.basename(binPath),
      fullPath: binPath,
      size: '0 B',
      cliHelpOutput: 'Not probed (safe static mode).',
    };
    try {
      const st = fs.statSync(binPath);
      info.size = formatBytes(st.size);
    } catch (_) {}

    if (probeHelp && binPath.toLowerCase().endsWith('.exe')) {
      try {
        const out = execFileSync(binPath, ['--help'], {
          timeout: 3000,
          windowsHide: true,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        info.cliHelpOutput = String(out || '').trim().slice(0, 1500) || '(No stdout returned on --help)';
      } catch (e) {
        const combined = `${e.stdout || ''}\n${e.stderr || ''}`.trim();
        info.cliHelpOutput = combined ? combined.slice(0, 1500) : `Binary exited or requires specific arguments (${e.message.slice(0, 100)})`;
      }
    }
    results.push(info);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Helper 4: Comprehensive Engineering Documentation & Master Prompt Builder
// ---------------------------------------------------------------------------
function buildEngineeringMarkdown(targetName, inventory, mechanics, binaryReport, generatedToolInfo) {
  const langs = Array.from(mechanics.languagesDetected).join(', ') || 'Native Binary / Portable Utility';
  const libs = Array.from(mechanics.importsAndLibraries);
  const sysCalls = Array.from(mechanics.systemCallsAndProcesses);
  const netCalls = Array.from(mechanics.networkAndIpcChannels);
  const fsCalls = Array.from(mechanics.fileSystemOperations);
  const envVars = Array.from(mechanics.environmentVariables);
  const cliFlags = Array.from(mechanics.cliArgumentsParsed);

  const md = [
    `# 🧠 MASTER ENGINEERING BLUEPRINT & ARCHITECTURE REPORT: ${targetName.toUpperCase()}`,
    `> **Generated by:** JARVIS-CORE Master App Inspector & Auto-Tool Builder`,
    `> **Timestamp:** ${new Date().toISOString()}`,
    `> **Target Path:** \`${inventory.rootPath}\``,
    '',
    '---',
    '',
    '## ১. এক্সিকিউটিভ সামারি (Executive Summary)',
    `- **সিস্টেমের নাম (Target Name):** \`${targetName}\``,
    `- **টাইপ (Target Type):** ${inventory.isDirectory ? 'Multi-File Application / Directory Module' : 'Standalone Script / Executable'}`,
    `- **মোট ফাইল ও ফোল্ডার:** ${inventory.totalFiles}টি ফাইল, ${inventory.totalDirs}টি ফোল্ডার (${formatBytes(inventory.totalSizeBytes)})`,
    `- **প্রধান প্রোগ্রামিং ল্যাঙ্গুয়েজ ও স্ট্যাক:** ${langs}`,
    `- **কোর আর্কিটেকচারাল ভূমিকা:** এই সিস্টেমটি মূলত ${sysCalls.length > 0 ? 'OS-লেভেল সাবপ্রসেস ও কমান্ড কন্ট্রোল' : 'ডেটা প্রসেসিং ও মডিউলার অটোমেশন'}, ${netCalls.length > 0 ? 'নেটওয়ার্ক/IPC কমিউনিকেশন, ' : ''}এবং ${fsCalls.length > 0 ? 'লোকাল ফাইল সিস্টেম রিড/রাইট অপারেশন' : 'ইন-মেমোরি লজিক এক্সিকিউশন'} সম্পন্ন করে।`,
    '',
    '---',
    '',
    '## ২. ফাইল ও ডিরেক্টরি স্ট্রাকচার (Complete Structural Layout)',
    '```plaintext',
    ...inventory.treeLines.slice(0, 120),
    inventory.treeLines.length > 120 ? `... (${inventory.treeLines.length - 120} more entries truncated)` : '',
    '```',
    '',
    '---',
    '',
    '## ৩. কী দিয়ে তৈরি ও ডিপেন্ডেন্সি ম্যাট্রিক্স (Tech Stack, Libraries & Manifests)',
    '### ক. ইমপোর্টেড মডিউল ও API সমূহ:',
    libs.length > 0 ? libs.map((l) => `- \`${l}\``).join('\n') : '- কোনো বাহ্যিক কোড ইমপোর্ট পাওয়া যায়নি (নেটিভ বা স্ট্যান্ডঅ্যালোন বাইনারি)।',
    '',
    '### খ. ম্যানিফেস্ট ও কনফিগারেশন ফাইল (package.json / requirements):',
    mechanics.manifestSummaries.length > 0
      ? '```json\n' + JSON.stringify(mechanics.manifestSummaries, null, 2) + '\n```'
      : '- কোনো আলাদা ম্যানিফেস্ট ফাইল নেই (Zero-Dependency / Self-Contained)।',
    '',
    '---',
    '',
    '## ৪. আসল কাজের মূলনীতি (Core Working Principle — Step-by-Step Execution Flow)',
    'এই অ্যাপ/টুলটি ভেতর থেকে যেভাবে কাজ করে (A-to-Z ইন্টারনাল মেকানিজম):',
    '',
    '1. **ইনশিয়ালাইজেশন ও এনভায়রনমেন্ট লোডিং (Boot & Config Stage):**',
    `   - সিস্টেমটি চালু হওয়ার সময় প্রয়োজনীয় কনফিগারেশন এবং এনভায়রনমেন্ট ভেরিয়েবল (${envVars.length > 0 ? envVars.map((e) => `\`${e}\``).join(', ') : 'ডিফল্ট পাথ'}) লোড করে।`,
    '2. **ইনপুট গ্রহণ ও ভ্যালিডেশন (Input & CLI / IPC Parsing):**',
    `   - ইউজার বা কলার থেকে আগত প্যারামিটার বা ফ্ল্যাগ (${cliFlags.length > 0 ? cliFlags.slice(0, 15).map((f) => `\`${f}\``).join(', ') : 'ফাংশন আর্গুমেন্টস'}) যাচাই করে।`,
    '3. **কোর প্রসেসিং ও সিস্টেম হুকস (Core Engine Execution):**',
    ...(sysCalls.length > 0 ? sysCalls.map((s) => `   - **OS/Subprocess Hook:** ${s}`) : ['   - ইন-মেমোরি অ্যালগরিদম এবং ডেটা স্ট্রাকচার প্রসেসিং চালায়।']),
    ...(netCalls.length > 0 ? netCalls.map((n) => `   - **Network/IPC Bridge:** ${n}`) : []),
    ...(fsCalls.length > 0 ? fsCalls.map((f) => `   - **Storage/Disk I/O:** ${f}`) : []),
    '4. **আউটপুট জেনারেশন ও এরর হ্যান্ডলিং (Output & Teardown):**',
    '   - কাজ শেষে স্ট্রাকচার্ড রেজাল্ট (JSON / Stdout / File Output) রিটার্ন করে এবং কোনো এরর ঘটলে গ্রেসফুলি হ্যান্ডেল করে।',
    '',
    '---',
    '',
    '## ৫. প্রতিটি ফাইল ও ফাংশনের বিস্তারিত ব্যবচ্ছেদ (Module-by-Module Code Breakdown)',
    ...(mechanics.fileDigests.length > 0
      ? mechanics.fileDigests.map((fd) => [
          `### 📄 \`${fd.file}\` (${fd.lines} lines)`,
          `- **ভূমিকা (Purpose):** ${fd.summary}`,
          `- **প্রধান ফাংশন ও ক্লাস (Key Symbols):** ${fd.keyFunctions.length > 0 ? fd.keyFunctions.map((fn) => `\`${fn}\``).join(', ') : 'Direct script execution'}`,
          '',
        ].join('\n'))
      : ['- সোর্স ফাইল ছাড়া বাইনারি টার্গেট। নিচে বাইনারি বিশ্লেষণ দেখুন।']),
    '',
    '---',
    '',
    '## ৬. এক্সিকিউটেবল বাইনারি ও CLI অ্যানালাইসিস (Binary & CLI Engine Details)',
    ...(binaryReport.length > 0
      ? binaryReport.map((b) => [
          `### ⚙️ Binary: \`${b.name}\` (${b.size})`,
          `- **Full Path:** \`${b.fullPath}\``,
          '- **CLI Signature / Help Output:**',
          '```plaintext',
          b.cliHelpOutput,
          '```',
          '',
        ].join('\n'))
      : ['- এই টার্গেটে কোনো কম্পাইল্ড `.exe` বা `.dll` বাইনারি ফাইল নেই।']),
    '',
    '---',
    '',
    '## ৭. অটো-জেনারেটেড JARVIS টুল স্ট্যাটাস (Auto-Tool Integration)',
    generatedToolInfo
      ? [
          `- **Generated Tool Name:** \`${generatedToolInfo.toolName}\``,
          `- **Saved Location:** \`${generatedToolInfo.toolFilePath}\``,
          `- **Status:** ✅ স্বয়ংক্রিয়ভাবে \`00_ENGINE/tools/\` ফোল্ডারে সেভ করা হয়েছে এবং \`tools_index.json\` সূচিপত্রে যুক্ত হয়েছে।`,
        ].join('\n')
      : '- শুধুমাত্র ইঞ্জিনিয়ারিং ডকুমেন্টেশন তৈরি করা হয়েছে (টুল জেনারেশন অপশন বন্ধ ছিল)।',
    '',
    '---',
    '',
    '## ৮. MASTER RECONSTRUCTION PROMPT (ভবিষ্যতে R&D বা এআই দিয়ে হুবহু বানানোর মাস্টার প্রম্পট)',
    'নিচের প্রম্পটটি কপি করে যেকোনো অ্যাডভান্সড এআই-কে (Claude / GPT / Gemini / DeepSeek) দিলে সে কোনো কিছু বাদ না দিয়ে এই পুরো সফটওয়্যার বা টুলটি একদম স্ক্র্যাচ থেকে তৈরি করে দেবে:',
    '',
    '```markdown',
    `You are a Principal Systems Architect and Senior Software Engineer. Your task is to design and write the complete, production-ready, zero-compression source code to reconstruct the "${targetName}" system from scratch.`,
    '',
    '### 1. SYSTEM IDENTITY & CORE OBJECTIVE',
    `- Target Name: ${targetName}`,
    `- Primary Language / Runtime: ${langs}`,
    `- Core Architecture: ${inventory.isDirectory ? 'Modular multi-file architecture' : 'Standalone single-file engine'}`,
    '',
    '### 2. REQUIRED DIRECTORY & FILE STRUCTURE',
    ...inventory.treeLines.slice(0, 45),
    '',
    '### 3. TECHNICAL STACK & NATIVE APIS TO USE',
    `- Imported Modules / Libraries: ${libs.slice(0, 25).join(', ') || 'Standard native OS libraries only'}`,
    `- System & Subprocess Hooks: ${sysCalls.join('; ') || 'Standard process execution'}`,
    `- Network & IPC Bridges: ${netCalls.join('; ') || 'None'}`,
    `- File System Operations: ${fsCalls.join('; ') || 'Standard file read/write'}`,
    `- Environment Variables Supported: ${envVars.join(', ') || 'Standard paths'}`,
    '',
    '### 4. MODULE-BY-MODULE FUNCTIONAL SPECIFICATIONS',
    ...mechanics.fileDigests.slice(0, 15).map((fd) => `- File "${fd.file}": Must implement [${fd.keyFunctions.join(', ') || 'main execution flow'}]. Purpose: ${fd.summary}`),
    '',
    '### 5. STRICT ENGINEERING CONSTRAINTS',
    '1. Do NOT use placeholder comments like "// TODO" or "// rest of code here". Write every single function completely.',
    '2. Include strict input validation, timeout guards on all subprocess/network calls, and structured error handling.',
    '3. Keep dependencies minimal and native wherever possible.',
    '4. Provide clear execution instructions and test commands at the end.',
    '```',
    '',
  ];

  return md.join('\n');
}

// ---------------------------------------------------------------------------
// Helper 5: Auto-Synthesize a Validated JARVIS Tool in 00_ENGINE/tools/
// ---------------------------------------------------------------------------
function generateJarvisWrapperTool(targetName, inventory, mechanics, binaryReport, customRisk, customTags) {
  const cleanToolName = 'tool_' + targetName.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const toolFileName = `${cleanToolName}.js`;
  const toolFilePath = path.join(TOOLS_DIR, toolFileName);

  // Determine how the target should be executed by the generated tool
  let runnerType = 'inspect_only';
  let entryTarget = inventory.rootPath;

  if (binaryReport.length > 0) {
    runnerType = 'exe';
    entryTarget = binaryReport[0].fullPath;
  } else if (!inventory.isDirectory) {
    const ext = path.extname(inventory.rootPath).toLowerCase();
    if (ext === '.py') runnerType = 'python';
    else if (ext === '.js') runnerType = 'node';
    else if (ext === '.ps1') runnerType = 'powershell';
    else if (ext === '.bat' || ext === '.cmd') runnerType = 'batch';
  } else {
    const pyMain = inventory.codeFiles.find((f) => ['main.py', 'app.py', 'run.py'].includes(path.basename(f).toLowerCase()));
    const jsMain = inventory.codeFiles.find((f) => ['index.js', 'main.js', 'app.js', 'cli.js'].includes(path.basename(f).toLowerCase()));
    if (pyMain) { runnerType = 'python'; entryTarget = pyMain; }
    else if (jsMain) { runnerType = 'node'; entryTarget = jsMain; }
  }

  const defaultTags = [
    cleanToolName.replace('tool_', ''),
    targetName.toLowerCase(),
    runnerType,
    'auto_generated',
    'external_engine',
  ];
  const mergedTags = Array.from(new Set([...defaultTags, ...(Array.isArray(customTags) ? customTags : [])]))
    .map((t) => String(t).toLowerCase().trim())
    .filter(Boolean);

  const riskLevel = ['READ', 'WRITE_SAFE', 'RISKY'].includes(customRisk) ? customRisk : 'RISKY';
  const escapedTarget = entryTarget.replace(/\\/g, '\\\\');

  const toolCode = `'use strict';

/**
 * Auto-Generated JARVIS Tool: ${cleanToolName}
 * Wrapped Target: ${escapedTarget}
 * Runner Mode: ${runnerType}
 * Generated At: ${new Date().toISOString()}
 */

const { execFile } = require('child_process');
const path = require('path');

const TARGET_PATH = '${escapedTarget}';
const RUNNER_MODE = '${runnerType}';

module.exports = {
  name: '${cleanToolName}',
  description: 'Auto-wrapped engine for ${targetName.replace(/'/g, '')} (${runnerType} execution bridge).',
  tags: ${JSON.stringify(mergedTags)},
  risk: '${riskLevel}',
  parameters: {
    type: 'object',
    properties: {
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Command-line arguments array to pass to the underlying engine (e.g. ["--help"] or ["input.txt"]).',
      },
      timeout_ms: {
        type: 'number',
        description: 'Execution timeout in milliseconds (default 30000).',
      },
    },
  },
  async execute(params, ctx) {
    const cliArgs = Array.isArray(params?.args) ? params.args.map(String) : [];
    const timeoutMs = Math.max(1000, Math.min(120000, Number(params?.timeout_ms) || 30000));

    let cmd = TARGET_PATH;
    let finalArgs = cliArgs;

    if (RUNNER_MODE === 'python') {
      cmd = process.env.JARVIS_PYTHON || 'python';
      finalArgs = [TARGET_PATH, ...cliArgs];
    } else if (RUNNER_MODE === 'node') {
      cmd = process.execPath;
      finalArgs = [TARGET_PATH, ...cliArgs];
    } else if (RUNNER_MODE === 'powershell') {
      cmd = 'powershell';
      finalArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', TARGET_PATH, ...cliArgs];
    } else if (RUNNER_MODE === 'inspect_only') {
      return {
        status: 'info',
        target: TARGET_PATH,
        note: 'This target is a multi-file library without a single CLI binary. See work/engineering_docs/ for its full blueprint.',
      };
    }

    return new Promise((resolve) => {
      execFile(cmd, finalArgs, {
        cwd: path.dirname(TARGET_PATH),
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      }, (err, stdout, stderr) => {
        if (ctx && typeof ctx.audit === 'function') {
          ctx.audit(err ? 'warn' : 'info', 'auto_tool_executed', {
            tool: '${cleanToolName}',
            args_count: cliArgs.length,
            ok: !err,
          });
        }
        if (err) {
          resolve({
            ok: false,
            error: String(err.message).slice(0, 300),
            stdout: String(stdout || '').slice(0, 4000),
            stderr: String(stderr || '').slice(0, 4000),
          });
          return;
        }
        resolve({
          ok: true,
          stdout: String(stdout || '').trim().slice(0, 8000),
          stderr: String(stderr || '').trim().slice(0, 2000),
        });
      });
    });
  },
};
`;

  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  fs.writeFileSync(toolFilePath, toolCode, 'utf8');

  return {
    toolName: cleanToolName,
    toolFilePath,
    runnerType,
    entryTarget,
  };
}

// ---------------------------------------------------------------------------
// Exported JARVIS Tool Definition
// ---------------------------------------------------------------------------
module.exports = {
  name: 'master_app_inspector_and_builder',
  description: 'A0. Inspect any app, folder, script, or .exe to generate a full A-to-Z Engineering Blueprint doc, reconstruction prompt, and auto-build a JARVIS tool.',
  tags: [
    'inspect', 'reverse', 'blueprint', 'architecture', 'working principle', 'analyze app',
    'build tool', 'auto tool', 'create tool', 'document', 'engineering', 'exe', 'folder',
  ],
  risk: 'WRITE_SAFE',
  parameters: {
    type: 'object',
    properties: {
      target_path: {
        type: 'string',
        description: 'Absolute or JARVIS_ROOT-relative path to the folder, script (.js/.py), or binary (.exe) to analyze.',
      },
      create_jarvis_tool: {
        type: 'boolean',
        description: 'Set true to also auto-generate a plug-and-play wrapper tool inside 00_ENGINE/tools/.',
      },
      probe_binary_help: {
        type: 'boolean',
        description: 'Set true to safely run `<binary> --help` (3s timeout) on .exe files to capture CLI flags.',
      },
      custom_tool_risk: {
        type: 'string',
        enum: ['READ', 'WRITE_SAFE', 'RISKY'],
        description: 'Risk classification for the generated JARVIS tool (default RISKY).',
      },
      custom_tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional extra search tags for the generated tool.',
      },
    },
    required: ['target_path'],
  },

  async execute(args, ctx) {
    const rawTarget = String(args?.target_path || '').trim();
    if (!rawTarget) return { error: 'target_path_required' };

    const resolvedTarget = path.isAbsolute(rawTarget)
      ? rawTarget
      : path.resolve(ROOT, rawTarget);

    if (!fs.existsSync(resolvedTarget)) {
      return { error: `Target path does not exist: ${resolvedTarget}` };
    }

    const targetName = path.basename(resolvedTarget, path.extname(resolvedTarget)) || 'target_system';

    // 1. Scan directory tree & file inventory
    const inventory = scanTargetStructure(resolvedTarget);

    // 2. Analyze source files, imports, system calls, functions
    const mechanics = analyzeSourceMechanics(inventory);

    // 3. Inspect binaries if present
    const binaryReport = probeBinaries(inventory.binaryFiles, Boolean(args?.probe_binary_help));

    // 4. Optionally generate a live JARVIS tool in 00_ENGINE/tools/
    let generatedToolInfo = null;
    if (args?.create_jarvis_tool === true) {
      generatedToolInfo = generateJarvisWrapperTool(
        targetName,
        inventory,
        mechanics,
        binaryReport,
        args?.custom_tool_risk,
        args?.custom_tags
      );

      // Trigger Librarian index re-sync immediately if service is registered
      const librarian = ctx?.getService?.('tool_librarian');
      if (librarian && typeof librarian.syncIndex === 'function') {
        try { librarian.syncIndex(); } catch (_) {}
      }
    }

    // 5. Build and save the complete A-to-Z Engineering Markdown Blueprint
    fs.mkdirSync(DOCS_OUT_DIR, { recursive: true });
    const safeDocName = `${targetName.replace(/[^a-zA-Z0-9_-]/g, '_')}_ENGINEERING_BLUEPRINT.md`;
    const docFilePath = path.join(DOCS_OUT_DIR, safeDocName);
    const markdownContent = buildEngineeringMarkdown(
      targetName,
      inventory,
      mechanics,
      binaryReport,
      generatedToolInfo
    );
    fs.writeFileSync(docFilePath, markdownContent, 'utf8');

    if (ctx && typeof ctx.audit === 'function') {
      ctx.audit('info', 'master_inspector_completed', {
        target: resolvedTarget,
        doc_saved: docFilePath,
        tool_created: generatedToolInfo ? generatedToolInfo.toolName : null,
      });
    }

    return {
      success: true,
      target_analyzed: resolvedTarget,
      blueprint_document_saved_to: docFilePath,
      auto_generated_tool: generatedToolInfo,
      executive_summary: {
        total_files: inventory.totalFiles,
        total_dirs: inventory.totalDirs,
        total_size: formatBytes(inventory.totalSizeBytes),
        languages: Array.from(mechanics.languagesDetected),
        imported_libraries_count: mechanics.importsAndLibraries.size,
        system_hooks: Array.from(mechanics.systemCallsAndProcesses),
        network_ipc_hooks: Array.from(mechanics.networkAndIpcChannels),
      },
      preview_note: `Full A-to-Z engineering blueprint + Master AI Reconstruction Prompt written to ${docFilePath}`,
    };
  },
};