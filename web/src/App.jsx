import { useCallback, useEffect, useState } from "react";
import { LayoutGrid } from "lucide-react";
import BoardPage from "./components/BoardPage";
import LandingPage from "./components/LandingPage";
import LoginPage from "./components/LoginPage";
import ReportsPage from "./components/ReportsPage";
import SkillsPage from "./components/SkillsPage";
import { api } from "./api";

const KNOWN_PATHS = new Set(["/", "/board", "/skills", "/reports", "/login"]);

function normalizePath(pathname) {
  if (pathname === "" || pathname === "/") return "/";
  if (KNOWN_PATHS.has(pathname)) return pathname;
  return "/board";
}

function pathOf(route) {
  return String(route || "").split("?")[0] || "/board";
}

function currentRoute() {
  return `${normalizePath(window.location.pathname)}${window.location.search || ""}`;
}

/** Sessions carry the signed-in user's role alongside the workspace. */
function withRole(tenant, user) {
  if (!tenant) return tenant;
  return {
    ...tenant,
    role: user?.role || tenant.role || "editor",
    user: user || null,
  };
}

export default function App() {
  const [tenant, setTenant] = useState(undefined);
  const [route, setRoute] = useState(currentRoute);

  const navigate = useCallback((path, { replace = false } = {}) => {
    const next = String(path || "/board").startsWith("/") ? String(path) : `/${path}`;
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history[replace ? "replaceState" : "pushState"]({}, "", next);
    }
    setRoute(next);
    window.scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    let active = true;
    api("/api/auth/me")
      .then((data) => {
        if (!active) return;
        setTenant(withRole(data.tenant, data.user));
        if (pathOf(currentRoute()) === "/login") {
          navigate("/board", { replace: true });
        }
      })
      .catch(() => {
        if (active) setTenant(null);
      });
    return () => {
      active = false;
    };
  }, [navigate]);

  useEffect(() => {
    const onPopState = () => setRoute(currentRoute());
    const onUnauthorized = () => {
      setTenant(null);
      navigate("/login", { replace: true });
    };
    window.addEventListener("popstate", onPopState);
    window.addEventListener("poca:unauthorized", onUnauthorized);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("poca:unauthorized", onUnauthorized);
    };
  }, [navigate]);

  useEffect(() => {
    if (tenant === undefined) return;
    const path = pathOf(route);
    if (tenant && path === "/") {
      navigate("/board", { replace: true });
    } else if (!tenant && path !== "/login" && path !== "/") {
      navigate("/login", { replace: true });
    } else if (tenant && path === "/login") {
      navigate("/board", { replace: true });
    }
  }, [tenant, route, navigate]);

  const handleLogin = useCallback(
    (loggedInTenant, nextPath, user) => {
      setTenant(withRole(loggedInTenant, user));
      navigate(nextPath && pathOf(nextPath) !== "/login" ? nextPath : "/board", { replace: true });
    },
    [navigate]
  );

  const handleLogout = useCallback(async () => {
    try {
      await api("/api/auth/logout", { method: "POST", body: {} });
    } catch {
      // clear locally even if the session already expired
    }
    setTenant(null);
    navigate("/login", { replace: true });
  }, [navigate]);

  if (tenant === undefined) {
    return (
      <div className="splash">
        <div className="splash-inner">
          <span className="brand-mark" aria-hidden="true">
            <LayoutGrid size={19} />
          </span>
          <div className="spinner" />
          <span>Opening poca-note…</span>
        </div>
      </div>
    );
  }

  const path = pathOf(route);

  if (!tenant) {
    if (path === "/" || path === "") {
      return <LandingPage navigate={navigate} />;
    }
    const nextPath = new URLSearchParams(window.location.search).get("next") || "/board";
    return <LoginPage onLogin={handleLogin} nextPath={nextPath} />;
  }

  if (path === "/login") {
    return <BoardPage tenant={tenant} navigate={navigate} onLogout={handleLogout} route={route} />;
  }

  if (path === "/skills") {
    return (
      <SkillsPage tenant={tenant} navigate={navigate} onLogout={handleLogout} route={route} />
    );
  }

  if (path === "/reports") {
    return (
      <ReportsPage tenant={tenant} navigate={navigate} onLogout={handleLogout} route={route} />
    );
  }

  return <BoardPage tenant={tenant} navigate={navigate} onLogout={handleLogout} route={route} />;
}
