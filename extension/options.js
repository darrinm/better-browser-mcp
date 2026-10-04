const textarea = document.getElementById("patterns");
const status = document.getElementById("status");

chrome.storage.local.get("blockedUrlPatterns").then(({ blockedUrlPatterns }) => {
  textarea.value = (blockedUrlPatterns || []).join("\n");
});

chrome.storage.managed.get("blockedUrlPatterns").then(({ blockedUrlPatterns }) => {
  if (!blockedUrlPatterns || !blockedUrlPatterns.length) return;
  document.getElementById("managed").textContent = blockedUrlPatterns.join("\n");
  document.getElementById("managed-section").hidden = false;
}).catch(() => {});

document.getElementById("save").addEventListener("click", async () => {
  const patterns = textarea.value.split("\n").map((s) => s.trim()).filter(Boolean);
  await chrome.storage.local.set({ blockedUrlPatterns: patterns });
  status.textContent = "Saved";
  setTimeout(() => (status.textContent = ""), 1500);
});
