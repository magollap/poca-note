export class ApiError extends Error {
  constructor(status, data) {
    super(data?.message || `Request failed with HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.data = data || {};
  }
}

export const clientId =
  typeof sessionStorage !== "undefined"
    ? sessionStorage.getItem("poca-note:client-id") ||
      (() => {
        const id = crypto.randomUUID ? crypto.randomUUID() : `client-${Math.random().toString(36).slice(2)}`;
        sessionStorage.setItem("poca-note:client-id", id);
        return id;
      })()
    : "server";

export async function api(path, { method = "GET", body, headers = {}, signal } = {}) {
  const requestHeaders = { ...headers, "x-client-id": clientId };
  if (body !== undefined) requestHeaders["content-type"] = "application/json";
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: requestHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }

  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/api/auth/login")) {
      window.dispatchEvent(new CustomEvent("poca:unauthorized"));
    }
    throw new ApiError(response.status, data);
  }
  return data;
}
