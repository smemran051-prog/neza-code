chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "JARVIS_AUTO_JSON") {
    fetch("http://127.0.0.1:8080/api/auto-json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg.payload || {})
    })
    .then(r => r.json())
    .then(data => sendResponse({ ok: true, data }))
    .catch(err => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});