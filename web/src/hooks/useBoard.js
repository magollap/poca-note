import { useCallback, useEffect, useRef, useState } from "react";
import { api, clientId } from "../api";

const cacheKey = (tenant, dashboardId) =>
  `poca-note:board:${tenant.slug}:${dashboardId || "default"}`;

function readCache(tenant, dashboardId) {
  try {
    const raw = localStorage.getItem(cacheKey(tenant, dashboardId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.cards) || !Number.isFinite(parsed.revision)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(tenant, dashboardId, revision, cards, updateIntervalDays) {
  try {
    localStorage.setItem(
      cacheKey(tenant, dashboardId),
      JSON.stringify({
        revision,
        cards,
        updateIntervalDays,
        savedAt: Date.now(),
        tenant: tenant.slug,
        dashboardId,
      })
    );
  } catch {
    // storage can be unavailable or full; server remains the source of truth
  }
}

export function useBoard(tenant, { onConflict, dashboardId = null } = {}) {
  const [cards, setCards] = useState([]);
  const [revision, setRevision] = useState(0);
  const [trashCount, setTrashCount] = useState(0);
  const [statusIntervalDays, setStatusIntervalDays] = useState(3);
  const [meta, setMeta] = useState({
    loading: true,
    syncing: false,
    offline: false,
    cached: false,
    lastSync: 0,
  });

  const cardsRef = useRef([]);
  const revisionRef = useRef(0);
  const trashRef = useRef(0);
  const intervalRef = useRef(3);
  const pendingRef = useRef(0);
  const channelRef = useRef(null);
  const conflictRef = useRef(onConflict);
  conflictRef.current = onConflict;

  const commit = useCallback(
    (nextCards, nextRevision, nextTrash) => {
      cardsRef.current = nextCards;
      revisionRef.current = nextRevision;
      setCards(nextCards);
      setRevision(nextRevision);
      if (nextTrash !== undefined) {
        trashRef.current = nextTrash;
        setTrashCount(nextTrash);
      }
      writeCache(tenant, dashboardId, nextRevision, nextCards, intervalRef.current);
    },
    [tenant, dashboardId]
  );

  const notifyTabs = useCallback((nextRevision) => {
    try {
      channelRef.current?.postMessage({
        type: "revision",
        revision: nextRevision,
        clientId,
      });
    } catch {
      // BroadcastChannel unavailable
    }
  }, []);

  const refresh = useCallback(
    async ({ quiet = false } = {}) => {
      if (pendingRef.current > 0) return;
      if (!quiet) setMeta((current) => ({ ...current, syncing: true }));
      try {
        const query = dashboardId ? `?dashboardId=${encodeURIComponent(dashboardId)}` : "";
        const data = await api(`/api/board${query}`);
        const intervalDays = Number(data.updateIntervalDays) || 3;
        intervalRef.current = intervalDays;
        setStatusIntervalDays(intervalDays);
        commit(data.cards, data.revision, data.trashCount ?? 0);
        setMeta((current) => ({
          ...current,
          loading: false,
          syncing: false,
          offline: false,
          cached: false,
          lastSync: Date.now(),
        }));
      } catch {
        setMeta((current) => ({
          ...current,
          loading: false,
          syncing: false,
          offline: true,
        }));
      }
    },
    [commit]
  );

  useEffect(() => {
    const cached = readCache(tenant, dashboardId);
    if (cached) {
      cardsRef.current = cached.cards;
      revisionRef.current = cached.revision;
      intervalRef.current = Number(cached.updateIntervalDays) || 3;
      setCards(cached.cards);
      setRevision(cached.revision);
      setStatusIntervalDays(intervalRef.current);
      setMeta((current) => ({
        ...current,
        loading: false,
        cached: true,
        lastSync: cached.savedAt || 0,
      }));
    } else {
      cardsRef.current = [];
      setCards([]);
      setMeta((current) => ({ ...current, loading: true }));
    }
    refresh({ quiet: Boolean(cached) });
  }, [tenant.slug, dashboardId, refresh]);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return undefined;
    const channel = new BroadcastChannel(`poca-note:${tenant.slug}`);
    channelRef.current = channel;
    channel.onmessage = (event) => {
      const data = event.data;
      if (
        data?.type === "revision" &&
        data.clientId !== clientId &&
        Number(data.revision) > revisionRef.current
      ) {
        refresh({ quiet: true });
      }
    };
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [tenant.slug, refresh]);

  useEffect(() => {
    if (typeof EventSource === "undefined") return undefined;
    const source = new EventSource("/api/events");
    const onRevision = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (Number(data.revision) > revisionRef.current) refresh({ quiet: true });
        setMeta((current) => ({ ...current, offline: false }));
      } catch {
        // ignore malformed event
      }
    };
    source.addEventListener("ready", onRevision);
    source.addEventListener("revision", onRevision);
    source.onerror = () => {
      setMeta((current) => ({ ...current, offline: true }));
    };
    return () => source.close();
  }, [refresh]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh({ quiet: true });
    };
    const timer = setInterval(onVisible, 45_000);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [refresh]);

  const replaceCard = useCallback((card) => {
    const next = cardsRef.current.filter((item) => item.id !== card.id);
    next.push(card);
    return next;
  }, []);

  const createCard = useCallback(
    async (input) => {
      const body = dashboardId && input && input.dashboardId === undefined ? { ...input, dashboardId } : input;
      const result = await api("/api/cards", { method: "POST", body });
      commit([...cardsRef.current, result.card], result.revision);
      notifyTabs(result.revision);
      return result.card;
    },
    [commit, notifyTabs, dashboardId]
  );

  const updateCard = useCallback(
    async (id, patch) => {
      const previous = cardsRef.current.find((card) => card.id === id);
      if (!previous) return null;
      commit(replaceCard({ ...previous, ...patch }), revisionRef.current);
      try {
        const result = await api(`/api/cards/${id}`, {
          method: "PATCH",
          body: { ...patch, version: previous.version },
        });
        commit(replaceCard(result.card), result.revision);
        notifyTabs(result.revision);
        return result.card;
      } catch (error) {
        if (error.status === 409 && error.data?.card) {
          commit(
            replaceCard(error.data.card),
            Number(error.data.revision) || revisionRef.current
          );
          conflictRef.current?.(error);
          return { conflict: true, card: error.data.card };
        }
        commit(replaceCard(previous), revisionRef.current);
        throw error;
      }
    },
    [commit, notifyTabs, replaceCard]
  );

  const moveCard = useCallback(
    (id, column, position) => updateCard(id, { column, position }),
    [updateCard]
  );

  const deleteCard = useCallback(
    async (id) => {
      const previous = cardsRef.current.find((card) => card.id === id);
      if (!previous) return null;
      commit(
        cardsRef.current.filter((card) => card.id !== id),
        revisionRef.current,
        trashRef.current + 1
      );
      try {
        const result = await api(`/api/cards/${id}`, { method: "DELETE" });
        commit(
          cardsRef.current.filter((card) => card.id !== id),
          result.revision,
          trashRef.current
        );
        notifyTabs(result.revision);
        return previous;
      } catch (error) {
        commit([...cardsRef.current, previous], revisionRef.current, Math.max(0, trashRef.current - 1));
        throw error;
      }
    },
    [commit, notifyTabs]
  );

  const restoreCard = useCallback(
    async (id) => {
      const result = await api(`/api/cards/${id}/restore`, { method: "POST" });
      commit([...cardsRef.current.filter((card) => card.id !== id), result.card], result.revision, Math.max(0, trashRef.current - 1));
      notifyTabs(result.revision);
      return result.card;
    },
    [commit, notifyTabs]
  );

  const purgeCard = useCallback(
    async (id) => {
      const result = await api(`/api/cards/${id}/purge`, { method: "DELETE" });
      commit(cardsRef.current, result.revision, Math.max(0, trashRef.current - 1));
      notifyTabs(result.revision);
      return result;
    },
    [commit, notifyTabs]
  );

  const emptyTrash = useCallback(async () => {
    const result = await api("/api/trash", { method: "DELETE" });
    commit(cardsRef.current, result.revision, 0);
    notifyTabs(result.revision);
    return result;
  }, [commit, notifyTabs]);

  const loadTrash = useCallback(async () => {
    const data = await api("/api/trash");
    setTrashCount(data.cards.length);
    return data.cards;
  }, []);

  const addChecklist = useCallback(
    async (cardId, text) => {
      const result = await api(`/api/cards/${cardId}/checklist`, {
        method: "POST",
        body: { text },
      });
      commit(replaceCard(result.card), result.revision);
      notifyTabs(result.revision);
      return result.card;
    },
    [commit, notifyTabs, replaceCard]
  );

  const patchChecklist = useCallback(
    async (itemId, patch) => {
      const result = await api(`/api/checklist/${itemId}`, { method: "PATCH", body: patch });
      commit(replaceCard(result.card), result.revision);
      notifyTabs(result.revision);
      return result.card;
    },
    [commit, notifyTabs, replaceCard]
  );

  const deleteChecklist = useCallback(
    async (itemId) => {
      const result = await api(`/api/checklist/${itemId}`, { method: "DELETE" });
      commit(replaceCard(result.card), result.revision);
      notifyTabs(result.revision);
      return result.card;
    },
    [commit, notifyTabs, replaceCard]
  );

  const addCardUpdate = useCallback(
    async (cardId, body) => {
      const result = await api(`/api/cards/${cardId}/updates`, {
        method: "POST",
        body: { body },
      });
      commit(replaceCard(result.card), result.revision);
      notifyTabs(result.revision);
      return result.card;
    },
    [commit, notifyTabs, replaceCard]
  );

  const addChecklistUpdate = useCallback(
    async (itemId, body) => {
      const result = await api(`/api/checklist/${itemId}/updates`, {
        method: "POST",
        body: { body },
      });
      commit(replaceCard(result.card), result.revision);
      notifyTabs(result.revision);
      return result.card;
    },
    [commit, notifyTabs, replaceCard]
  );

  return {
    cards,
    revision,
    trashCount,
    statusIntervalDays,
    meta,
    refresh,
    createCard,
    updateCard,
    moveCard,
    deleteCard,
    restoreCard,
    purgeCard,
    emptyTrash,
    loadTrash,
    addChecklist,
    patchChecklist,
    deleteChecklist,
    addCardUpdate,
    addChecklistUpdate,
  };
}
