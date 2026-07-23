export const DEFAULT_DASHBOARD_TIMEOUT_MS = 15000;

export async function fetchDashboardJson(url, { timeoutMs = DEFAULT_DASHBOARD_TIMEOUT_MS, language = "en", fetchImpl = globalThis.fetch, ...options } = {}) {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { cache: "no-store", ...options, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `${response.status} ${response.statusText}`);
      error.payload = payload;
      error.status = response.status;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(language === "zh-CN" ? "请求超时，请确认 Runtime 正常后重试。" : "The request timed out. Check the Runtime and try again.");
      timeoutError.code = "request_timeout";
      throw timeoutError;
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}
