// Firefox exposes promise-based browser APIs. Chrome MV3 exposes promise-based
// chrome APIs, while its message callback path remains compatible with older
// Chromium versions. Resolve at call time so test stubs can be installed later.
export function getExtensionApi() {
  const api = globalThis.browser ?? globalThis.chrome;
  if (!api) throw new Error('WebExtension APIs are unavailable.');
  return api;
}

export function usesPromiseMessaging() {
  return Boolean(globalThis.browser);
}

export function sendExtensionMessage(message) {
  const api = getExtensionApi();
  if (usesPromiseMessaging()) return api.runtime.sendMessage(message);
  return new Promise((resolve, reject) => {
    api.runtime.sendMessage(message, response => {
      if (api.runtime.lastError) {
        reject(new Error('Extension messaging failed.'));
      } else {
        resolve(response);
      }
    });
  });
}
