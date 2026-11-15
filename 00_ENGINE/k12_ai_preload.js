'use strict';
const { ipcRenderer } = require('electron');
try { require('./kernel_10_webview_preload.js'); } catch (_) {}
(function __K12_PRELOAD_RUNTIME__(ipcRenderer) {
  if (window.__K12_PRELOAD_ACTIVE__) return;
  window.__K12_PRELOAD_ACTIVE__ = true;

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && window.getComputedStyle(el).visibility !== 'hidden';
  }

  function findInputBox() {
    const selectors = [
      'rich-textarea div.ql-editor[contenteditable="true"]',
      'rich-textarea div[contenteditable="true"]',
      'div.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"][aria-label*="prompt" i]',
      'div[contenteditable="true"][aria-label*="Ask" i]',
      'div[contenteditable="true"][data-testid="chat-input"]',
      '#prompt-textarea',
      'div.ProseMirror[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'fieldset div[contenteditable="true"]',
      'textarea[data-id="root"]',
      'textarea',
      'div[contenteditable="true"]',
    ];
    for (const sel of selectors) {
      try {
        const nodes = document.querySelectorAll(sel);
        for (let i = nodes.length - 1; i >= 0; i--) {
          if (isVisible(nodes[i])) return nodes[i];
        }
        if (nodes.length > 0) return nodes[nodes.length - 1];
      } catch (_) {}
    }
    return null;
  }

  function findSendButton() {
    const selectors = [
      'button.send-button',
      '.send-button-container button',
      'button[aria-label*="Send" i]',
      'button[mattooltip*="Send" i]',
      'button[data-testid="send-button"]',
      'button[aria-label*="Submit" i]',
      'button.submit',
      'button[type="submit"]',
    ];
    for (const sel of selectors) {
      try {
        const nodes = document.querySelectorAll(sel);
        for (let i = nodes.length - 1; i >= 0; i--) {
          const btn = nodes[i];
          if (isVisible(btn) && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
            return btn;
          }
        }
      } catch (_) {}
    }
    return null;
  }

  function cleanText(raw) {
    return String(raw || '')
      .replace(/⚡\s*Send to Jarvis/gi, '')
      .replace(/⚡\s*Relay/gi, '')
      .replace(/⚡\s*Apply/gi, '')
      .replace(/^JSON\s*\n/i, '')
      .trim();
  }

  function readLatestOutput() {
    const msgSelectors = [
      'model-response message-content',
      'message-content',
      '[data-test-id="model-response"]',
      '.model-response-text',
      '[data-message-author-role="assistant"]',
      '[data-testid="chat-message-content"]',
      'div.font-claude-message',
      'div.ds-markdown',
      'div.markdown',
    ];

    let msgNodes = [];
    for (const sel of msgSelectors) {
      try {
        const found = document.querySelectorAll(sel);
        if (found && found.length > 0) {
          msgNodes = Array.from(found);
          break;
        }
      } catch (_) {}
    }

    const codeNodes = Array.from(document.querySelectorAll('pre code, pre'));
    const lastMsg = msgNodes.length > 0 ? msgNodes[msgNodes.length - 1] : null;
    const lastCode = codeNodes.length > 0 ? codeNodes[codeNodes.length - 1] : null;

    const msgText = lastMsg ? cleanText(lastMsg.innerText || lastMsg.textContent) : '';
    const codeText = lastCode ? cleanText(lastCode.innerText || lastCode.textContent) : '';

    let isStreaming = false;
    const stopSelectors = [
      'button[aria-label*="Stop" i]',
      'button[data-testid="stop-button"]',
      '[data-is-streaming="true"]',
      '.streaming-indicator',
    ];
    for (const sSel of stopSelectors) {
      try {
        const stopEl = document.querySelector(sSel);
        if (stopEl && isVisible(stopEl)) {
          isStreaming = true;
          break;
        }
      } catch (_) {}
    }

    return {
      msgCount: msgNodes.length,
      msgText,
      codeCount: codeNodes.length,
      codeText,
      isStreaming,
    };
  }

  let baselineDone = false;
  let lastEmittedKey = '';
  let candidateKey = '';
  let candidateSnap = null;
  let lastMutationTs = 0;

  function makeKey(snap) {
    const primary = snap.codeText && snap.codeText.includes('"action"') ? snap.codeText : snap.msgText;
    return (
      snap.codeCount +
      ':' +
      snap.msgCount +
      ':' +
      primary.length +
      ':' +
      primary.slice(0, 80) +
      ':' +
      primary.slice(-80)
    );
  }

  setTimeout(() => {
    try {
      const snap = readLatestOutput();
      lastEmittedKey = makeKey(snap);
      baselineDone = true;
      ipcRenderer.send('k12:preload-ready', { url: location.href, title: document.title });
    } catch (_) {
      baselineDone = true;
    }
  }, 1200);

  // Local DOM inspection inside Preload (zero executeJavaScript, zero did-stop-loading listeners!)
  setInterval(() => {
    if (!baselineDone) return;
    try {
      const snap = readLatestOutput();
      const hasJsonCode = snap.codeText && snap.codeText.includes('"action"');
      const hasMsg = snap.msgText && snap.msgText.length > 0;
      if (!hasJsonCode && !hasMsg) return;

      const key = makeKey(snap);
      if (key === lastEmittedKey) return;

      if (key !== candidateKey) {
        candidateKey = key;
        candidateSnap = snap;
        lastMutationTs = Date.now();
        return;
      }

      const stableMs = Date.now() - lastMutationTs;
      const ready =
        (hasJsonCode && !snap.isStreaming && stableMs >= 650) ||
        (hasJsonCode && stableMs >= 1400) ||
        (!snap.isStreaming && stableMs >= 1400) ||
        stableMs >= 3800;

      if (ready && candidateSnap) {
        lastEmittedKey = key;
        ipcRenderer.send('k12:ai-output-ready', {
          codeText: candidateSnap.codeText,
          msgText: candidateSnap.msgText,
          codeCount: candidateSnap.codeCount,
          msgCount: candidateSnap.msgCount,
          url: location.href,
        });
      }
    } catch (_) {}
  }, 450);

  // Receive prompt from JARVIS Chat Box via pure IPC (k12:inject-prompt)
  ipcRenderer.on('k12:inject-prompt', (_ev, payload) => {
    try {
      const text = String((payload && payload.text) || '').trim();
      const requestId = payload && payload.requestId;
      if (!text) return;

      const snapBefore = readLatestOutput();
      lastEmittedKey = makeKey(snapBefore);

      const input = findInputBox();
      if (!input) {
        ipcRenderer.send('k12:inject-status', { requestId, ok: false, error: 'input_not_found' });
        return;
      }

      input.focus();
      if (input.isContentEditable || input.getAttribute('contenteditable') === 'true') {
        try {
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(input);
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('delete', false, null);
        } catch (_) {}

        let ok = false;
        try {
          ok = document.execCommand('insertText', false, text);
        } catch (_) {}

        if (!ok || !String(input.textContent || '').trim()) {
          input.textContent = text;
        }

        try {
          input.dispatchEvent(
            new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text })
          );
          input.dispatchEvent(
            new InputEvent('input', { bubbles: true, cancelable: false, inputType: 'insertText', data: text })
          );
        } catch (_) {
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      } else {
        try {
          const proto =
            input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(input, text);
        } catch (_) {
          input.value = text;
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }

      setTimeout(() => {
        const btn = findSendButton();
        if (btn) {
          try {
            btn.click();
          } catch (_) {}
          ipcRenderer.send('k12:inject-status', { requestId, ok: true, clicked: true });
        } else {
          ipcRenderer.send('k12:inject-status', { requestId, ok: true, clicked: false, needNativeEnter: true });
        }
      }, 180);
    } catch (e) {
      ipcRenderer.send('k12:inject-status', {
        requestId: payload && payload.requestId,
        ok: false,
        error: String(e.message || e),
      });
    }
  });
})(ipcRenderer);
