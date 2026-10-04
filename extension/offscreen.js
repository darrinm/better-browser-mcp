// Offscreen document: service-worker keepalive.
//
// Offscreen documents are not subject to MV3's ~30s service-worker idle kill,
// so a message every 20s resets the SW's idle timer and keeps the bridge
// WebSocket connected even when Chrome throttles background work.
setInterval(() => {
  chrome.runtime.sendMessage({ keepalive: true }).catch(() => {});
}, 20000);
