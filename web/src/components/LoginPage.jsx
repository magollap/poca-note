import { useEffect, useState } from "react";
import { ArrowRight, KeyRound, LayoutGrid, Loader2, UserPlus } from "lucide-react";
import { api } from "../api";

export default function LoginPage({ onLogin, nextPath = "/board" }) {
  const initialMode =
    new URLSearchParams(window.location.search).get("mode") === "create" ? "create" : "signin";
  const [config, setConfig] = useState(null);
  const [mode, setMode] = useState(initialMode);
  const [tenant, setTenant] = useState("");
  const [username, setUsername] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api("/api/auth/config")
      .then((data) => {
        setConfig(data);
        if (data.demo?.slug && initialMode !== "create") setTenant(data.demo.slug);
      })
      .catch(() => setConfig({ demo: null, registrationOpen: false }));
  }, []);

  const registrationOpen = config?.registrationOpen !== false;

  const switchMode = (next) => {
    setMode(next);
    setError("");
    setPassword("");
    if (next === "create") {
      setTenant("");
      setUsername("");
      setWorkspaceName("");
    } else if (config?.demo?.slug) {
      setTenant(config.demo.slug);
      setUsername("");
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const body =
        mode === "create"
          ? {
              tenant: tenant.trim(),
              name: workspaceName.trim() || tenant.trim(),
              username: username.trim() || tenant.trim(),
              password,
            }
          : { tenant: tenant.trim(), username: username.trim(), password };
      const path = mode === "create" ? "/api/auth/register" : "/api/auth/login";
      const data = await api(path, { method: "POST", body });
      onLogin(data.tenant, nextPath, data.user);
    } catch (err) {
      setError(err.message || (mode === "create" ? "Could not create the workspace." : "Could not sign in."));
    } finally {
      setBusy(false);
    }
  };

  const disabled =
    busy ||
    !tenant.trim() ||
    !password ||
    (mode === "create" && (password.length < 8 || !username.trim()));

  return (
    <main className="login-wrap">
      <div className="login-card">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true">
            <LayoutGrid size={19} strokeWidth={2.2} />
          </span>
          <div>
            <h1>
              poca<em style={{ color: "var(--accent)", fontStyle: "normal" }}>·</em>note
            </h1>
            <p>Tenant-authenticated personal Kanban</p>
          </div>
        </div>

        <div className="login-tabs" role="tablist" aria-label="Account actions">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "signin"}
            className={`login-tab${mode === "signin" ? " is-active" : ""}`}
            onClick={() => switchMode("signin")}
          >
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "create"}
            className={`login-tab${mode === "create" ? " is-active" : ""}`}
            onClick={() => switchMode("create")}
            disabled={!registrationOpen}
            title={registrationOpen ? undefined : "Sign-ups are closed on this server"}
          >
            Create workspace
          </button>
        </div>

        <form className="login-form" onSubmit={submit}>
          <div className="field">
            <label htmlFor="tenant">{mode === "create" ? "Workspace address" : "Workspace"}</label>
            <input
              id="tenant"
              className="input"
              value={tenant}
              onChange={(event) => setTenant(event.target.value)}
              placeholder={mode === "create" ? "my-studio" : "your-team"}
              autoComplete={mode === "create" ? "organization" : "username"}
              autoCapitalize="none"
              spellCheck={false}
              required
            />
            {mode === "create" ? (
              <span className="hint">Lowercase letters, numbers, and hyphens. You sign in with this.</span>
            ) : null}
          </div>

          {mode === "create" ? (
            <div className="field">
              <label htmlFor="workspace-name">Workspace name</label>
              <input
                id="workspace-name"
                className="input"
                value={workspaceName}
                onChange={(event) => setWorkspaceName(event.target.value)}
                placeholder="My Studio"
                autoComplete="organization"
              />
            </div>
          ) : null}

          <div className="field">
            <label htmlFor="username">{mode === "create" ? "Your username" : "Username"}</label>
            <input
              id="username"
              className="input"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder={mode === "create" ? "alex" : "leave blank for the workspace owner"}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required={mode === "create"}
            />
            {mode === "signin" ? (
              <span className="hint">Leave blank if you sign in with the workspace owner’s login.</span>
            ) : null}
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              className="input"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
              autoComplete={mode === "create" ? "new-password" : "current-password"}
              minLength={mode === "create" ? 8 : undefined}
              required
            />
            {mode === "create" ? <span className="hint">At least 8 characters.</span> : null}
          </div>

          {error ? <div className="login-error">{error}</div> : null}

          <button className="btn btn-primary" type="submit" disabled={disabled}>
            {busy ? (
              <Loader2 size={15} className="spin" />
            ) : mode === "create" ? (
              <UserPlus size={15} />
            ) : (
              <KeyRound size={15} />
            )}
            {busy
              ? mode === "create"
                ? "Creating workspace…"
                : "Signing in…"
              : mode === "create"
                ? "Create workspace"
                : "Enter workspace"}
            {!busy ? <ArrowRight size={15} /> : null}
          </button>
        </form>

        {config?.demo ? (
          <div className="demo-box">
            <strong style={{ color: "var(--muted)" }}>Demo workspace</strong>
            <br />
            <code>{config.demo.slug}</code> / <code>{config.demo.password}</code>
            <br />
            <button
              type="button"
              className="btn btn-sm"
              style={{ marginTop: 8 }}
              onClick={() => {
                setMode("signin");
                setTenant(config.demo.slug);
                setUsername(config.demo.slug);
                setPassword(config.demo.password);
              }}
            >
              Fill demo credentials
            </button>
          </div>
        ) : null}

        <div className="login-foot">
          <span>Every route is scoped to your workspace.</span>
          <span className="mono">v1.1</span>
        </div>
      </div>
    </main>
  );
}
