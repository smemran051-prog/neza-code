(function() {
  let lastSentCode = "";
  let candidateCode = "";
  let stableTicks = 0;
  function getLatestCode() {
    const codes = document.querySelectorAll("pre code, pre");
    if (!codes || codes.length === 0) return "";
    const last = codes[codes.length - 1];
    return String(last.innerText || last.textContent || "").trim();
  }
  setTimeout(() => { lastSentCode = getLatestCode(); }, 1200);
  setInterval(() => {
    const code = getLatestCode();
    if (!code || !code.includes('"action"') || code === lastSentCode) {
      stableTicks = 0;
      return;
    }
    if (code !== candidateCode) {
      candidateCode = code;
      stableTicks = 1;
      return;
    }
    stableTicks++;
    if (stableTicks >= 2) {
      lastSentCode = code;
      stableTicks = 0;
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          type: "JARVIS_AUTO_JSON",
          payload: { rawText: code, source: location.href }
        });
      }
    }
  }, 700);
})();