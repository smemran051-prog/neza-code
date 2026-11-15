'use strict';

(function () {
  // ---------------- Theme ----------------
  const THEMES = ['dark', 'blue', 'cyber', 'matrix', 'light'];
  const themeSelect = document.getElementById('theme-select');
  if (themeSelect) {
    const savedTheme = localStorage.getItem('jarvis-theme');
    const initialTheme = THEMES.includes(savedTheme) ? savedTheme : 'dark';
    document.body.setAttribute('data-theme', initialTheme);
    themeSelect.value = initialTheme;
    themeSelect.addEventListener('change', () => {
      const t = themeSelect.value;
      if (!THEMES.includes(t)) return;
      document.body.setAttribute('data-theme', t);
      localStorage.setItem('jarvis-theme', t);
    });
  }

  // ---------------- Constants ----------------
  const MAX_TERMINAL = 400;
  const MAX_AUDIT = 400;
  const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

  const RAM_PRESETS = {
    current_8gb: 1024,
    current_16gb: 2048,
    future_32gb: 4096,
    future_64gb: 8192,
  };

  // ---------------- State ----------------
  const state = {
    telemetry: { ram_mb: null, cpu_pct: null },
    status: {
      running: null, stopReason: null, pid: null, mode: null,
      presence: null, idle_ms: null, os_hands_ready: null, modules: null, ts: null
    },
    startedAt: null,
    auditCount: 0,
    terminalCount: 0,
    ramLimitMb: Number(localStorage.getItem('jarvis-ram-limit') || 1024),
  };

  const $ = (id) => document.getElementById(id);
  let currentMode = localStorage.getItem('jarvis-exec-mode') || 'chat';
  let currentTaskSubMode = localStorage.getItem('jarvis-task-submode') || 'assisted';
  let currentMicMode = localStorage.getItem('jarvis-mic-mode') || 'electron';
  let currentSessionId = null;

  function setText(id, v) {
    const el = $(id);
    if (el) el.textContent = (v === null || v === undefined || v === '') ? '—' : String(v);
  }

  function setClass(id, cls) {
    const el = $(id);
    if (el) el.className = 'card-value' + (cls ? ' ' + cls : '');
  }

  function fmtUptime(ms) {
    if (!ms || ms < 0) return null;
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`;
  }

  function fmtIdle(ms) {
    if (ms === null || ms === undefined || !isFinite(ms) || ms < 0) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }

  // ---------------- Render ----------------
  function render() {
    const ramMb = state.telemetry.ram_mb === null ? null : Math.round(state.telemetry.ram_mb);
    setText('card-ram', ramMb);
    setText('card-ram-unit', `MB / ${state.ramLimitMb} MB limit`);
    if (ramMb !== null) {
      setClass('card-ram', ramMb > state.ramLimitMb ? 'danger' : (ramMb > state.ramLimitMb * 0.8 ? 'warning' : ''));
    }

    setText('card-cpu', state.telemetry.cpu_pct === null ? null : state.telemetry.cpu_pct.toFixed(1));

    if (state.status.running === false) { setText('card-kill', 'TRIGGERED'); setClass('card-kill', 'danger'); }
    else if (state.status.running === true) { setText('card-kill', 'ARMED'); setClass('card-kill', 'success'); }
    else { setText('card-kill', null); setClass('card-kill', ''); }

    setText('card-uptime', state.startedAt ? fmtUptime(Date.now() - state.startedAt) : null);
    setText('card-modules', state.status.modules === null ? null : state.status.modules.length);

    if (state.status.os_hands_ready === true) { setText('card-oshands', 'READY'); setClass('card-oshands', 'success'); }
    else if (state.status.os_hands_ready === false) { setText('card-oshands', 'DEAD'); setClass('card-oshands', 'danger'); }
    else { setText('card-oshands', null); setClass('card-oshands', ''); }

    setText('card-audit', state.auditCount);
    setText('card-stop', state.status.stopReason);
    setText('card-pid', state.status.pid);

    const modeBadge = $('mode-badge');
    if (modeBadge) {
      const label = currentMode.toUpperCase() + (currentMode === 'task' ? ` (${currentTaskSubMode.toUpperCase()})` : '');
      modeBadge.textContent = label;
      modeBadge.className = 'mode-badge ' + (currentMode === 'task' ? 'full' : 'semi');
    }

    const presBadge = $('presence-badge');
    const presTxt = $('presence-text');
    if (presBadge && presTxt) {
      const idle = fmtIdle(state.status.idle_ms);
      if (state.status.presence === 'ACTIVE') { presBadge.className = 'presence-badge active'; presTxt.textContent = `ACTIVE (${idle})`; }
      else if (state.status.presence === 'AWAY') { presBadge.className = 'presence-badge away'; presTxt.textContent = `AWAY (${idle})`; }
      else { presBadge.className = 'presence-badge'; presTxt.textContent = 'UNKNOWN'; }
    }

    const badge = $('engine-status');
    const badgeText = $('engine-status-text');
    if (badge && badgeText) {
      if (state.status.running === false) { badge.className = 'status-badge danger'; badgeText.textContent = 'STOPPED' + (state.status.stopReason ? ' · ' + state.status.stopReason : ''); }
      else if (state.status.running === true) { badge.className = 'status-badge success'; badgeText.textContent = 'ONLINE'; }
      else { badge.className = 'status-badge'; badgeText.textContent = 'Connecting…'; }
    }

    setText('hud-ram', ramMb === null ? '—' : `${ramMb} / ${state.ramLimitMb} MB`);
    setText('hud-cpu', state.telemetry.cpu_pct === null ? '—' : state.telemetry.cpu_pct.toFixed(1) + '%');

    const hudKill = $('hud-kill');
    if (hudKill) {
      if (state.status.running === false) { hudKill.textContent = 'TRIGGERED'; hudKill.className = 'v danger'; }
      else if (state.status.running === true) { hudKill.textContent = 'ARMED'; hudKill.className = 'v success'; }
      else { hudKill.textContent = '—'; hudKill.className = 'v'; }
    }

    const hudPres = $('hud-presence');
    if (hudPres) {
      if (state.status.presence === 'ACTIVE') { hudPres.textContent = 'ACTIVE'; hudPres.className = 'v success'; }
      else if (state.status.presence === 'AWAY') { hudPres.textContent = 'AWAY'; hudPres.className = 'v warning'; }
      else { hudPres.textContent = '—'; hudPres.className = 'v'; }
    }

    const hudOh = $('hud-oh');
    if (hudOh) {
      if (state.status.os_hands_ready === true) { hudOh.textContent = 'READY'; hudOh.className = 'v success'; }
      else if (state.status.os_hands_ready === false) { hudOh.textContent = 'DEAD'; hudOh.className = 'v danger'; }
      else { hudOh.textContent = '—'; hudOh.className = 'v'; }
    }
  }

  function appendTerminal(entry) {
    const terminalEl = $('terminal');
    if (!terminalEl) return;
    const line = document.createElement('div');
    const lvl = String(entry.level || 'info').toLowerCase();
    line.className = 'log-line log-' + (['info', 'warn', 'error', 'success'].includes(lvl) ? lvl : 'info');
    const ts = entry.ts ? String(entry.ts).slice(11, 19) : '';
    const dataPart = entry.data ? ' ' + JSON.stringify(entry.data) : '';
    line.textContent = `[${ts}] [${String(entry.level || 'info').toUpperCase()}] ${entry.event || ''}${dataPart}`;
    terminalEl.appendChild(line);
    while (terminalEl.childElementCount > MAX_TERMINAL) terminalEl.removeChild(terminalEl.firstElementChild);
    terminalEl.scrollTop = terminalEl.scrollHeight;
    state.terminalCount++;
    if ($('terminal-count')) $('terminal-count').textContent = state.terminalCount;
  }

  function appendAudit(entry) {
    const auditEl = $('audit');
    if (!auditEl) return;
    const level = String(entry.level || 'info').toLowerCase();
    const safeLevel = level.replace(/[^a-z]/g, '') || 'info';
    const row = document.createElement('div');
    row.className = 'audit-row';
    const ts = document.createElement('span'); ts.className = 'audit-ts'; ts.textContent = entry.ts ? String(entry.ts).slice(11, 19) : '--:--:--';
    const lvl = document.createElement('span'); lvl.className = 'audit-lvl audit-' + safeLevel; lvl.textContent = safeLevel.toUpperCase();
    const ev = document.createElement('span'); ev.className = 'audit-ev'; ev.textContent = entry.event ? String(entry.event) : '';
    const dt = document.createElement('span'); dt.className = 'audit-dt'; dt.textContent = entry.data ? JSON.stringify(entry.data) : '';
    row.append(ts, lvl, ev, dt);
    auditEl.appendChild(row);
    while (auditEl.childElementCount > MAX_AUDIT) auditEl.removeChild(auditEl.firstElementChild);
    auditEl.scrollTop = auditEl.scrollHeight;
    state.auditCount++;
    if ($('audit-count')) $('audit-count').textContent = state.auditCount;
  }

  function addSystemMessage(text) {
    const chatMessages = $('chat-messages');
    if (!chatMessages) return;
    const msg = document.createElement('div');
    msg.className = 'chat-msg ai';
    msg.textContent = String(text);
    chatMessages.appendChild(msg);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function addChatBubble(role, text) {
    const chatMessages = $('chat-messages');
    if (!chatMessages) return;
    const msg = document.createElement('div');
    msg.className = `chat-msg ${role === 'user' ? 'user' : 'ai'}`;
    msg.textContent = String(text);
    chatMessages.appendChild(msg);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // ---------------- Ollama Status Checker ----------------
  async function refreshOllamaBadge() {
    const topBadge = $('ollama-top-badge');
    const topText = $('ollama-top-text');
    const settingsStatus = $('ollama-settings-status');

    if (currentMode === 'offline' || ($('ai-model') && $('ai-model').value === 'ollama')) {
      if (topBadge) topBadge.style.display = 'flex';
    } else if (topBadge) {
      topBadge.style.display = 'none';
    }

    if (!window.jarvis || typeof window.jarvis.checkOllamaStatus !== 'function') return;

    const localUrl = localStorage.getItem('jarvis-ollama-local') || 'http://127.0.0.1:11434';
    const tailscaleUrl = localStorage.getItem('jarvis-ollama-tailscale') || '';
    const preferTailscale = localStorage.getItem('jarvis-ollama-prefer-ts') === 'true';

    try {
      const res = await window.jarvis.checkOllamaStatus({ localUrl, tailscaleUrl, preferTailscale });
      if (res && res.online) {
        if (topBadge && topText) {
          topBadge.className = 'status-badge success';
          topText.textContent = `Ollama: ONLINE (${res.endpointLabel || 'Local'})`;
        }
        if (settingsStatus) {
          settingsStatus.textContent = `✅ Connected to ${res.activeUrl} — Models: ${(res.models || []).join(', ') || 'none pulled yet'}`;
          settingsStatus.style.color = 'var(--success)';
        }
      } else {
        if (topBadge && topText) {
          topBadge.className = 'status-badge danger';
          topText.textContent = 'Ollama: OFFLINE / Not Installed';
        }
        if (settingsStatus) {
          settingsStatus.textContent = `❌ Ollama Offline (${(res && res.error) || 'connection refused'}). Start Ollama or check Tailscale IP.`;
          settingsStatus.style.color = 'var(--danger)';
        }
      }
    } catch (e) {
      if (topBadge && topText) {
        topBadge.className = 'status-badge danger';
        topText.textContent = 'Ollama: OFFLINE';
      }
    }
  }

  if ($('ollama-top-badge')) {
    $('ollama-top-badge').addEventListener('click', refreshOllamaBadge);
  }
  if ($('btn-ping-ollama')) {
    $('btn-ping-ollama').addEventListener('click', () => {
      localStorage.setItem('jarvis-ollama-local', ($('ollama-local-url')?.value || 'http://127.0.0.1:11434').trim());
      localStorage.setItem('jarvis-ollama-tailscale', ($('ollama-tailscale-url')?.value || '').trim());
      localStorage.setItem('jarvis-ollama-prefer-ts', $('ollama-prefer-tailscale')?.checked ? 'true' : 'false');
      refreshOllamaBadge();
    });
  }

  // ---------------- IPC ----------------
  const bridge = window.jarvis;
  
  // গ্লোবাল প্লেব্যাক কনটেক্সট (একবার তৈরি হবে, বার বার নয়)
  let globalPlaybackCtx = null;

  if (bridge) {
    bridge.onTelemetry((payload) => {
      if (!payload) return;
      if (typeof payload.ram_mb === 'number') state.telemetry.ram_mb = payload.ram_mb;
      if (typeof payload.cpu_pct === 'number') state.telemetry.cpu_pct = payload.cpu_pct;
      if (payload.presence !== undefined) state.status.presence = payload.presence;
      if (payload.idle_ms !== undefined) state.status.idle_ms = payload.idle_ms;
      render();
    });

    bridge.onStatus((payload) => {
      if (!payload) return;
      Object.assign(state.status, payload);
      if (payload.ts && !state.startedAt) state.startedAt = Date.parse(payload.ts);
      render();
    });

    bridge.onAudit((entry) => {
      if (!entry) return;
      appendTerminal(entry);
      appendAudit(entry);
    });

    if (bridge.onAIResponse) {
      bridge.onAIResponse((data) => {
        const loader = $('ai-loading');
        if (loader) loader.remove();

        if (data && data.isVoice) {
          const userMsg = document.createElement('div');
          userMsg.className = 'chat-msg user';
          userMsg.textContent = `🎤 ${data.text}`;

          if (data.mode === 'translate') {
            const aiInput = $('ai-input');
            if (aiInput) {
              aiInput.value = data.text;
              autoResizeInput(aiInput);
              aiInput.focus();
            }
          } else {
            $('chat-messages').appendChild(userMsg);
            $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
          }
        } else {
          addSystemMessage((data && data.text) ? data.text : 'No response.');
          if (currentSessionId && window.jarvis.saveMessage && data && data.text) {
            window.jarvis.saveMessage({
              id: currentSessionId,
              message: { role: 'assistant', content: data.text },
              model: 'auto'
            });
          }
        }
      });
    }

    // 👇 জেমিনির অডিও প্লেব্যাক (মাত্র ১টি ভয়েস শোনার ফিক্স) 👇
     // 👇 জেমিনির অডিও প্লেব্যাক (Perfect Queue System) 👇
    if (bridge.onGeminiAudio) {
      let globalPlaybackCtx = null;
      let nextPlayTime = 0; // কিউ টাইমার

      bridge.onGeminiAudio((base64Data) => {
        try {
          if (!globalPlaybackCtx) {
            globalPlaybackCtx = new AudioContext({ sampleRate: 24000 });
          }
          if (globalPlaybackCtx.state === 'suspended') {
            globalPlaybackCtx.resume();
          }

          const binary = atob(base64Data);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          
          const int16Data = new Int16Array(bytes.buffer);
          const float32Data = new Float32Array(int16Data.length);
          
          for (let i = 0; i < int16Data.length; i++) {
            float32Data[i] = int16Data[i] / 32768.0;
          }

          const audioBuffer = globalPlaybackCtx.createBuffer(1, float32Data.length, 24000);
          audioBuffer.copyToChannel(float32Data, 0);

          const source = globalPlaybackCtx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(globalPlaybackCtx.destination);
          
          // 👇 কিউ লজিক: ল্যাপিং বন্ধ করবে এবং উত্তর মাঝপথে কাটবে না 👇
          if (nextPlayTime < globalPlaybackCtx.currentTime) {
              nextPlayTime = globalPlaybackCtx.currentTime;
          }
          source.start(nextPlayTime);
          nextPlayTime += audioBuffer.duration; 

        } catch (err) {
          console.warn("Audio decode error", err);
        }
      });
    }

    bridge.requestStatus();
  }

  // ---------------- Emergency Stop ----------------
  if ($('emergency-stop')) {
    $('emergency-stop').addEventListener('click', () => {
      if (confirm('EMERGENCY STOP\n\nThis halts the engine. Continue?')) {
        if (window.jarvis) window.jarvis.emergencyStop();
      }
    });
  }

  // ---------------- Mic Mode UI Sync ----------------
  function applyMicModeUI() {
    const btnMic = $('btn-mic');
    const winHBadge = $('win-h-badge');
    const langSelect = $('voice-lang-select');
    if (!btnMic) return;

    btnMic.classList.remove('muted');
    if (winHBadge) winHBadge.style.display = currentMicMode === 'win_h' ? 'inline-block' : 'none';
    if (langSelect) langSelect.style.display = currentMicMode === 'electron' ? 'inline-block' : 'none';

    if (currentMicMode === 'gemini_live') {
      btnMic.textContent = '🎙️';
      btnMic.title = 'Gemini Live (Real-time)';
    } else if (currentMicMode === 'muted') {
      btnMic.textContent = '🔇';
      btnMic.title = 'Microphone is Muted / Off in Settings';
      btnMic.classList.add('muted');
    } else if (currentMicMode === 'win_h') {
      btnMic.textContent = '⌨️';
      btnMic.title = 'Click to focus input & use Windows Dictation (Win + H)';
    } else {
      btnMic.textContent = '🎤';
      btnMic.title = 'Electron Voice Input (Right-click for Direct / Translate mode)';
    }
  }

  // ---------------- Settings Modal ----------------
  const settingsModal = $('settings-modal');
  const ramSlider = $('ram-limit-slider');
  const ramSliderVal = $('ram-slider-val');
  const ramPresetSelect = $('ram-preset-select');

  if (ramSlider && ramSliderVal) {
    ramSlider.value = state.ramLimitMb;
    ramSliderVal.textContent = `${state.ramLimitMb} MB`;
    ramSlider.addEventListener('input', () => {
      ramSliderVal.textContent = `${ramSlider.value} MB`;
      if (ramPresetSelect) ramPresetSelect.value = 'custom';
    });
  }

  if (ramPresetSelect && ramSlider && ramSliderVal) {
    const savedPreset = localStorage.getItem('jarvis-ram-preset') || 'current_8gb';
    ramPresetSelect.value = savedPreset;
    ramPresetSelect.addEventListener('change', () => {
      const val = RAM_PRESETS[ramPresetSelect.value];
      if (val) {
        ramSlider.value = val;
        ramSliderVal.textContent = `${val} MB`;
      }
    });
  }

  if ($('btn-test-win-h')) {
    $('btn-test-win-h').addEventListener('click', () => {
      if (settingsModal) settingsModal.style.display = 'none';
      const aiInput = $('ai-input');
      if (aiInput) aiInput.focus();
      addSystemMessage('⌨️ Windows Dictation Ready: With the cursor inside the chat input box below, press the [Windows Key + H] on your keyboard to open Windows Voice Typing.');
    });
  }

  if ($('btn-refresh-models')) {
    $('btn-refresh-models').addEventListener('click', () => {
      if (window.jarvis && window.jarvis.askAI) {
        window.jarvis.askAI({ prompt: '/models refresh', mode: 'chat' });
        if (settingsModal) settingsModal.style.display = 'none';
      }
    });
  }

  if ($('btn-add-ext')) {
    $('btn-add-ext').addEventListener('click', () => {
      const f = ($('ext-file-name')?.value || '').trim();
      if (!f) return alert('Enter an extension filename first.');
      if (window.jarvis && window.jarvis.addExtension) {
        window.jarvis.addExtension(f);
        alert(`Extension "${f}" registered.`);
      }
    });
  }

  if ($('btn-settings') && settingsModal) {
    $('btn-settings').addEventListener('click', () => {
      if ($('mic-mode-select')) $('mic-mode-select').value = currentMicMode;
      if ($('ollama-local-url')) $('ollama-local-url').value = localStorage.getItem('jarvis-ollama-local') || 'http://127.0.0.1:11434';
      if ($('ollama-tailscale-url')) $('ollama-tailscale-url').value = localStorage.getItem('jarvis-ollama-tailscale') || '';
      if ($('ollama-prefer-tailscale')) $('ollama-prefer-tailscale').checked = localStorage.getItem('jarvis-ollama-prefer-ts') === 'true';
      if ($('ai-model-ollama')) $('ai-model-ollama').value = localStorage.getItem('jarvis-model-ollama') || 'llama3.2:latest';
      
      if ($('ai-model-gemini-live')) {
        $('ai-model-gemini-live').value = localStorage.getItem('jarvis-model-gemini-live') || 'models/gemini-3.1-flash-live-preview';
      }

      const providers = ['groq', 'gemini', 'deepseek', 'openrouter', 'cerebras'];
      for (const p of providers) {
        const savedM = localStorage.getItem(`jarvis-model-${p}`);
        if (savedM && $(`ai-model-${p}`)) $(`ai-model-${p}`).value = savedM;
      }

      settingsModal.style.display = 'flex';
      refreshOllamaBadge();
    });

    $('btn-cancel-settings').addEventListener('click', () => settingsModal.style.display = 'none');

    $('btn-save-settings').addEventListener('click', () => {
      const token = $('tg-token')?.value.trim() || '';
      const chatId = $('tg-chat-id')?.value.trim() || '';
      const nightConfig = {
        enabled: $('night-enabled')?.checked || false,
        start_time: $('night-start')?.value || '23:00',
        end_time: $('night-end')?.value || '07:00',
        summary_time: $('night-summary')?.value || '07:05',
      };

      // Mic Config
      if ($('mic-mode-select')) {
        currentMicMode = $('mic-mode-select').value;
        localStorage.setItem('jarvis-mic-mode', currentMicMode);
        applyMicModeUI();
      }

      // RAM & Hardware Config
      if (ramSlider) {
        state.ramLimitMb = Number(ramSlider.value) || 1024;
        localStorage.setItem('jarvis-ram-limit', String(state.ramLimitMb));
      }
      if (ramPresetSelect) {
        localStorage.setItem('jarvis-ram-preset', ramPresetSelect.value);
      }

      // Ollama & Tailscale Config
      const ollamaLocal = ($('ollama-local-url')?.value || 'http://127.0.0.1:11434').trim();
      const ollamaTailscale = ($('ollama-tailscale-url')?.value || '').trim();
      const ollamaPreferTs = $('ollama-prefer-tailscale')?.checked || false;
      const ollamaModel = ($('ai-model-ollama')?.value || 'llama3.2:latest').trim();

      localStorage.setItem('jarvis-ollama-local', ollamaLocal);
      localStorage.setItem('jarvis-ollama-tailscale', ollamaTailscale);
      localStorage.setItem('jarvis-ollama-prefer-ts', ollamaPreferTs ? 'true' : 'false');
      localStorage.setItem('jarvis-model-ollama', ollamaModel);

      // এখানে aiConfig তৈরি হচ্ছে
      const providers = ['groq', 'gemini', 'deepseek', 'openrouter', 'cerebras'];
      const aiConfig = {
        ollama: {
          model: ollamaModel,
          localURL: ollamaLocal,
          tailscaleURL: ollamaTailscale,
          preferTailscale: ollamaPreferTs,
        },
        hardware: {
          ramLimitMb: state.ramLimitMb,
          preset: ramPresetSelect ? ramPresetSelect.value : 'current_8gb',
        },
      };

      for (const p of providers) {
        const keyVal = ($(`ai-key-${p}`)?.value || '').trim();
        const modelVal = ($(`ai-model-${p}`)?.value || '').trim();
        if (modelVal) localStorage.setItem(`jarvis-model-${p}`, modelVal);
        if (keyVal || modelVal) {
          aiConfig[p] = {};
          if (keyVal) aiConfig[p].key = keyVal;
          if (modelVal) aiConfig[p].model = modelVal;
        }
      }

      // aiConfig তৈরি হওয়ার পর liveModel যোগ করুন
      const liveModelSelect = $('ai-model-gemini-live');
      if (liveModelSelect && liveModelSelect.value) {
        if (!aiConfig.gemini) aiConfig.gemini = {};
        aiConfig.gemini.liveModel = liveModelSelect.value;
        localStorage.setItem('jarvis-model-gemini-live', liveModelSelect.value);
      }

      // এখন সেভ করুন
      if (window.jarvis) {
        if (token || chatId) window.jarvis.saveTelegramConfig?.(token, chatId);
        window.jarvis.saveNightConfig?.(nightConfig);
        if (window.jarvis.saveAiConfig) window.jarvis.saveAiConfig(aiConfig);
        settingsModal.style.display = 'none';
        refreshOllamaBadge();
        render();
      }
    });
  }

  // ---------------- Library / Chat Sessions ----------------
  async function refreshLibrary() {
    const listEl = $('session-list');
    if (!listEl || !window.jarvis) return;

    const sessions = await window.jarvis.listSessions();
    listEl.innerHTML = '';

    sessions.forEach(sess => {
      const div = document.createElement('div');
      div.style.cssText = 'display: flex; justify-content: space-between; padding: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; cursor: pointer; transition: 0.2s; align-items: center;';

      div.onclick = async (e) => {
        if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
        const data = await window.jarvis.loadSession(sess.id);
        if (data) {
          currentSessionId = data.id;
          const chatMessages = $('chat-messages');
          chatMessages.innerHTML = '';
          data.messages.forEach(m => addChatBubble(m.role, m.content));
          document.querySelector('[data-view="chat"]').click();
        }
      };

      const title = document.createElement('span');
      title.textContent = sess.name;
      title.style.fontWeight = 'bold';
      title.style.color = 'var(--text)';
      title.style.flex = '1';
      title.style.marginRight = '10px';

      const btnGroup = document.createElement('div');
      btnGroup.style.display = 'flex';
      btnGroup.style.gap = '8px';

      const renameBtn = document.createElement('button');
      renameBtn.textContent = '✏️';
      renameBtn.style.cssText = 'background:none; border:none; color:var(--muted); cursor:pointer; font-size: 16px;';
      renameBtn.onclick = (e) => {
        e.stopPropagation();
        const input = document.createElement('input');
        input.type = 'text';
        input.value = sess.name;
        input.style.cssText = 'flex: 1; padding: 6px; background: var(--bg); color: var(--text); border: 1px solid var(--accent); border-radius: 4px; outline: none; font-family: inherit; font-size: 14px;';
        title.replaceWith(input);
        input.focus();

        const saveName = async () => {
          const newName = input.value.trim();
          if (newName && newName !== sess.name) {
            await window.jarvis.renameSession({ id: sess.id, newName });
          }
          title.textContent = newName || sess.name;
          input.replaceWith(title);
          refreshLibrary();
        };

        input.onblur = saveName;
        input.onkeydown = (ev) => {
          if (ev.key === 'Enter') input.blur();
          if (ev.key === 'Escape') { input.value = sess.name; input.blur(); }
        };
      };

      const delBtn = document.createElement('button');
      delBtn.textContent = '🗑️';
      delBtn.style.cssText = 'background:none; border:none; color:var(--danger); cursor:pointer; font-size: 16px;';
      delBtn.onclick = async (e) => {
        e.stopPropagation();
        if (confirm('Delete this chat?')) {
          await window.jarvis.deleteSession(sess.id);
          if (currentSessionId === sess.id) {
            currentSessionId = null;
            $('chat-messages').innerHTML = '';
          }
          refreshLibrary();
        }
      };

      btnGroup.appendChild(renameBtn);
      btnGroup.appendChild(delBtn);
      div.appendChild(title);
      div.appendChild(btnGroup);
      listEl.appendChild(div);
    });
  }

  if ($('btn-new-chat')) {
    $('btn-new-chat').addEventListener('click', async () => {
      const sess = await window.jarvis.newSession();
      if (sess) {
        currentSessionId = sess.id;
        $('chat-messages').innerHTML = '<div class="chat-msg ai">New Chat started! Ask me anything.</div>';
        refreshLibrary();
        document.querySelector('[data-view="chat"]').click();
      }
    });
  }

  // ---------------- View Switcher ----------------
  const navItems = document.querySelectorAll('.nav-item[data-view]');
  const views = {
    dashboard: $('dashboard-view'),
    chat: $('chat-view'),
    tools: $('tools-view'),
    jobhunter: $('jobhunter-view'),
    memory: $('memory-view')
  };

  navItems.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      navItems.forEach((b) => b.classList.remove('active'));
      e.currentTarget.classList.add('active');
      const viewName = e.currentTarget.dataset.view;
      Object.keys(views).forEach(k => { if (views[k]) views[k].style.display = 'none'; });
      if (views[viewName]) views[viewName].style.display = 'flex';
      if (viewName === 'memory') refreshLibrary();
      if (viewName === 'tools' && window.ToolsLibraryUI) window.ToolsLibraryUI.refresh();
    });
  });

  // ---------------- 4-Mode Execution System & Task Sub-Toggle ----------------
  const modeButtons = document.querySelectorAll('.exec-mode-btn[data-exec-mode]');
  const subToggleGroup = $('task-sub-group');
  const subButtons = document.querySelectorAll('.sub-toggle-btn[data-sub-mode]');

  function syncExecutionModeUI() {
    modeButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.execMode === currentMode);
    });
    if (subToggleGroup) {
      subToggleGroup.style.display = currentMode === 'task' ? 'inline-flex' : 'none';
    }
    subButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.subMode === currentTaskSubMode);
    });
    if (currentMode === 'offline' && $('ai-model')) {
      $('ai-model').value = 'ollama';
    }
    refreshOllamaBadge();
    render();
  }

  modeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      currentMode = btn.dataset.execMode;
      localStorage.setItem('jarvis-exec-mode', currentMode);
      syncExecutionModeUI();
    });
  });

  subButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      currentTaskSubMode = btn.dataset.subMode;
      localStorage.setItem('jarvis-task-submode', currentTaskSubMode);
      syncExecutionModeUI();
    });
  });

  if ($('ai-model')) {
    $('ai-model').addEventListener('change', refreshOllamaBadge);
  }

  // ---------------- Auto-Resizing Multi-Line Textarea ----------------
  const aiInputEl = $('ai-input');
  function autoResizeInput(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(180, Math.max(44, el.scrollHeight)) + 'px';
  }

  if (aiInputEl) {
    aiInputEl.addEventListener('input', () => autoResizeInput(aiInputEl));
    aiInputEl.addEventListener('paste', () => {
      setTimeout(() => autoResizeInput(aiInputEl), 0);
    });
    aiInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendAIMessage();
      }
    });
  }

  // ---------------- AI Chat Dispatch ----------------
  let pendingImages = [];

  function showPastedImage(dataUrl) {
    const chatMessages = $('chat-messages');
    if (!chatMessages) return;
    const wrap = document.createElement('div');
    wrap.className = 'chat-msg user';
    const img = document.createElement('img');
    img.src = dataUrl; img.style.maxWidth = '260px'; img.style.borderRadius = '8px';
    const hint = document.createElement('div');
    hint.textContent = 'Image attached. Type your question and press Send.';
    wrap.append(img, hint);
    chatMessages.appendChild(wrap);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function sendAIMessage() {
    const aiInput = $('ai-input');
    const chatMessages = $('chat-messages');
    const aiModelSelect = $('ai-model');
    if (!aiInput || !chatMessages) return;

    const text = aiInput.value.trim();
    if (!text && pendingImages.length === 0) return;
    if (!(window.jarvis && window.jarvis.askAI)) return addSystemMessage('AI bridge is not available.');

    const selectedProvider = currentMode === 'offline'
      ? 'ollama'
      : (aiModelSelect ? aiModelSelect.value : 'groq');

    if (currentSessionId && window.jarvis.saveMessage) {
      window.jarvis.saveMessage({
        id: currentSessionId,
        message: { role: 'user', content: text || '(image)' },
        model: selectedProvider
      });
    }

    const userMsg = document.createElement('div');
    userMsg.className = 'chat-msg user';
    userMsg.textContent = text || '(image)';
    chatMessages.appendChild(userMsg);

    const images = pendingImages.slice();
    pendingImages = [];
    aiInput.value = '';
    autoResizeInput(aiInput);

    window.jarvis.askAI({
      prompt: text,
      mode: currentMode,
      subMode: currentTaskSubMode,
      model: selectedProvider,
      images,
      ollamaConfig: {
        localURL: localStorage.getItem('jarvis-ollama-local') || 'http://127.0.0.1:11434',
        tailscaleURL: localStorage.getItem('jarvis-ollama-tailscale') || '',
        preferTailscale: localStorage.getItem('jarvis-ollama-prefer-ts') === 'true',
        model: localStorage.getItem('jarvis-model-ollama') || 'llama3.2:latest',
      }
    });

    const loadingMsg = document.createElement('div');
    loadingMsg.className = 'chat-msg ai';
    loadingMsg.textContent = currentMode === 'task' && currentTaskSubMode === 'direct'
      ? '⚡ Executing Direct Order…'
      : 'Thinking...';
    loadingMsg.id = 'ai-loading';
    chatMessages.appendChild(loadingMsg);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  if ($('btn-send-ai')) $('btn-send-ai').addEventListener('click', sendAIMessage);

  if ($('btn-upload-file') && $('ai-file-input')) {
    $('btn-upload-file').addEventListener('click', () => $('ai-file-input').click());
    $('ai-file-input').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      $('ai-file-input').value = '';
      if (file.type.startsWith('image/')) {
        if (file.size > MAX_IMAGE_BYTES) return addSystemMessage('Image too large (max 4MB).');
        const reader = new FileReader();
        reader.onload = () => { pendingImages.push(reader.result); showPastedImage(reader.result); };
        reader.readAsDataURL(file);
      } else {
        const reader = new FileReader();
        reader.onload = () => {
          const content = reader.result;
          const input = $('ai-input');
          input.value += `\n\n--- File: ${file.name} ---\n${content}`;
          autoResizeInput(input);
          addSystemMessage(`Attached text file: ${file.name}`);
        };
        reader.readAsText(file);
      }
    });
  }

  // ---------------- Voice Input (4-Mode Aware + Context Menu) ----------------
  const btnMic = $('btn-mic');
  const voiceLangSelect = $('voice-lang-select');
  let mediaRecorder;
  let audioChunks = [];
  let currentVoiceMode = 'direct';
  let isGeminiRecording = false;

  if (btnMic) {
    btnMic.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const oldMenu = document.getElementById('voice-ctx-menu');
      if (oldMenu) oldMenu.remove();

      const menu = document.createElement('div');
      menu.id = 'voice-ctx-menu';
      const rect = btnMic.getBoundingClientRect();
      menu.style.left = Math.max(10, rect.left - 110) + 'px';
      menu.style.bottom = (window.innerHeight - rect.top + 10) + 'px';

      const opt1 = document.createElement('div');
      opt1.textContent = '🎤 Direct Mode (Auto AI)';
      opt1.style.color = currentVoiceMode === 'direct' ? '#22C55E' : '#F3F4F6';
      opt1.onclick = () => { currentVoiceMode = 'direct'; menu.remove(); addSystemMessage('Voice Mode: Direct (Auto AI)'); };

      const opt2 = document.createElement('div');
      opt2.textContent = '📝 Translate Mode (To Input Box)';
      opt2.style.color = currentVoiceMode === 'translate' ? '#22C55E' : '#F3F4F6';
      opt2.onclick = () => { currentVoiceMode = 'translate'; menu.remove(); addSystemMessage('Voice Mode: Translate (To Input)'); };

      const opt3 = document.createElement('div');
      opt3.textContent = '⌨️ Switch to Windows Dictation (Win+H)';
      opt3.onclick = () => {
        currentMicMode = 'win_h';
        localStorage.setItem('jarvis-mic-mode', 'win_h');
        applyMicModeUI();
        menu.remove();
        if (aiInputEl) aiInputEl.focus();
        addSystemMessage('Switched to Windows Dictation. Press [Win + H] on your keyboard while typing!');
      };

      menu.append(opt1, opt2, opt3);
      document.body.appendChild(menu);

      setTimeout(() => {
        document.addEventListener('click', function closeMenu() {
          const m = document.getElementById('voice-ctx-menu');
          if (m) m.remove();
          document.removeEventListener('click', closeMenu);
        }, { once: true });
      }, 10);
    });

    btnMic.addEventListener('click', async () => {
      if (currentMicMode === 'muted') {
        addSystemMessage('🔇 Microphone is currently set to Muted/Off in ⚙️ Settings.');
        return;
      }

      // Gemini Live Voice Logic
      if (currentMicMode === 'gemini_live') {
        if (isGeminiRecording) {
          isGeminiRecording = false;
          btnMic.classList.remove('listening');
          btnMic.style.background = 'var(--surface)';
          if (window.jarvis && window.jarvis.stopGeminiLive) window.jarvis.stopGeminiLive();
          if (mediaRecorder && mediaRecorder.stop) mediaRecorder.stop();
          return;
        }

        try {
          isGeminiRecording = true;
          if (window.jarvis && window.jarvis.startGeminiLive) window.jarvis.startGeminiLive();
          
          // ইকো ক্যানসেলেশন ও নয়েজ সাপ্রেশন বাধ্যতামূলক
          const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: { 
              echoCancellation: true, 
              noiseSuppression: true,
              autoGainControl: true 
            } 
          });
          
          const audioContext = new AudioContext({ sampleRate: 16000 });
          const source = audioContext.createMediaStreamSource(stream);
          const processor = audioContext.createScriptProcessor(4096, 1, 1);

          processor.onaudioprocess = (e) => {
            if (!isGeminiRecording) return;
            const inputData = e.inputBuffer.getChannelData(0);
            
            const pcm16 = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
              pcm16[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
            }
            let binary = '';
            const bytes = new Uint8Array(pcm16.buffer);
            const len = bytes.byteLength;
            for (let i = 0; i < len; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            const base64 = btoa(binary);
            if (window.jarvis && window.jarvis.sendGeminiAudio) window.jarvis.sendGeminiAudio(base64);
          };

          source.connect(processor);
          const muteNode = audioContext.createGain();
          muteNode.gain.value = 0; // স্পিকার থেকে মাইকের আওয়াজ সম্পূর্ণ মিউট
          processor.connect(muteNode);
          muteNode.connect(audioContext.destination);

          mediaRecorder = { 
            stop: () => { 
              processor.disconnect(); 
              audioContext.close(); 
              stream.getTracks().forEach(t => t.stop()); 
            } 
          };
          
          btnMic.classList.add('listening');
          btnMic.style.background = 'var(--danger)';
          addSystemMessage('🎙️ Gemini Live Connected. Speak naturally.');
        } catch (err) {
          isGeminiRecording = false;
          addSystemMessage('Failed to start Gemini Live: ' + err.message);
        }
        return;
      }

      if (currentMicMode === 'win_h') {
        if (aiInputEl) aiInputEl.focus();
        addSystemMessage('⌨️ Cursor focused in input box! Now press [Win + H] on your keyboard to start Windows native voice dictation.');
        return;
      }

      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        btnMic.classList.remove('listening');
        btnMic.style.background = 'var(--surface)';
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        audioChunks = [];

        mediaRecorder.addEventListener('dataavailable', event => {
          audioChunks.push(event.data);
        });

        mediaRecorder.addEventListener('stop', () => {
          const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
          const reader = new FileReader();
          reader.readAsDataURL(audioBlob);
          reader.onloadend = () => {
            const base64data = reader.result;
            addSystemMessage('🎤 Listening and transcribing...');
            if (window.jarvis && window.jarvis.transcribeAudio) {
              window.jarvis.transcribeAudio({
                audio: base64data,
                mode: currentVoiceMode,
                lang: voiceLangSelect ? voiceLangSelect.value : 'bn'
              });
            }
          };
          stream.getTracks().forEach(track => track.stop());
        });

        mediaRecorder.start();
        btnMic.classList.add('listening');
        btnMic.style.background = 'var(--danger)';
      } catch (err) {
        addSystemMessage('Microphone permission denied or not found. Tip: Switch to Windows Dictation (Win+H) in ⚙️ Settings!');
      }
    });
  }

  // ---------------- HUD Drag & Minimize ----------------
  const hud = $('hud');
  const hudHeader = $('hud-header');
  if (hud && hudHeader) {
    let dragging = false, ox = 0, oy = 0;
    hudHeader.addEventListener('mousedown', (e) => {
      if (e.target === $('hud-min')) return;
      dragging = true;
      const r = hud.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      hud.style.left = Math.max(0, Math.min(window.innerWidth - hud.offsetWidth, e.clientX - ox)) + 'px';
      hud.style.top = Math.max(0, Math.min(window.innerHeight - hud.offsetHeight, e.clientY - oy)) + 'px';
      hud.style.right = 'auto'; hud.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }
  if ($('hud-min')) $('hud-min').addEventListener('click', () => $('hud-body')?.classList.toggle('hidden'));

  // Init
  applyMicModeUI();
  syncExecutionModeUI();
  setInterval(render, 1000);
  render();
})();