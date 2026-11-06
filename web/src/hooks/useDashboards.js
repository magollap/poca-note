import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

export function useDashboards(tenant, { revision } = {}) {
  const [dashboards, setDashboards] = useState([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const data = await api("/api/dashboards");
      setDashboards(data.dashboards || []);
      return data.dashboards || [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    api("/api/dashboards")
      .then((data) => {
        if (active) setDashboards(data.dashboards || []);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [tenant.slug, revision]);

  const create = useCallback(
    async (name, accent = "emerald") => {
      const result = await api("/api/dashboards", { method: "POST", body: { name, accent } });
      await reload();
      return result.dashboard;
    },
    [reload]
  );

  const rename = useCallback(
    async (id, name) => {
      const result = await api(`/api/dashboards/${id}`, { method: "PATCH", body: { name } });
      await reload();
      return result.dashboard;
    },
    [reload]
  );

  const recolor = useCallback(
    async (id, accent) => {
      const result = await api(`/api/dashboards/${id}`, { method: "PATCH", body: { accent } });
      await reload();
      return result.dashboard;
    },
    [reload]
  );

  const remove = useCallback(
    async (id) => {
      const result = await api(`/api/dashboards/${id}`, { method: "DELETE" });
      await reload();
      return result;
    },
    [reload]
  );

  return { dashboards, loading, reload, create, rename, recolor, remove };
}
