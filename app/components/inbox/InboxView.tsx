import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLoaderData, useNavigation, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { ConversationList } from "./ConversationList";
import { TranscriptPanel } from "./TranscriptPanel";
import { CustomerSidebar } from "./CustomerSidebar";
import { EmptyState } from "./EmptyState";
import { ThreePanelSkeleton } from "./ThreePanelSkeleton";
import { getConversationStatus } from "~/lib/inbox-shared";
import type { InboxActionResult, InboxLoaderData } from "~/lib/inbox.server";

type ConvItem = InboxLoaderData["conversations"][number];

interface InboxViewProps {
  /** "panel" = embedded app-shell view (notifications, full-screen launcher).
   *  "full" = the <s-app-window> overlay opened from the panel view. */
  variant: "panel" | "full";
}

export function InboxView({ variant }: InboxViewProps) {
  const loaderData = useLoaderData<InboxLoaderData>();
  const shopify = useAppBridge();
  const {
    conversations,
    totalCount, purchasedCount, inCartCount, escalatedCount, liveCount,
    page, hasMore,
    search, dateRange, statusTab,
    currencyCode, storeHandle,
    quickReplies,
    thumbsUp, thumbsDown,
  } = loaderData;

  const [searchParams, setSearchParams] = useSearchParams();
  const navigation = useNavigation();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [activeTab, setActiveTab] = useState(statusTab ?? "pending");

  const [notifPermission, setNotifPermission] = useState<NotificationPermission>(
    typeof window !== "undefined" && "Notification" in window ? Notification.permission : "denied",
  );

  const pauseFetcher = useFetcher<InboxActionResult>();

  const rateFetcher = useFetcher<InboxActionResult>();
  const [ratingOverrides, setRatingOverrides] = useState<Record<number, "up" | "down" | undefined>>({});
  function rateMessage(conversationId: string, messageTimestamp: number, rating: "up" | "down" | undefined) {
    setRatingOverrides((prev) => ({ ...prev, [messageTimestamp]: rating }));
    rateFetcher.submit(
      { intent: "rate-message", conversationId, messageTimestamp: String(messageTimestamp), rating: rating ?? "" },
      { method: "POST" },
    );
  }

  useEffect(() => {
    const error = (rateFetcher.data as { error?: string } | undefined)?.error;
    if (rateFetcher.state === "idle" && error) {
      shopify.toast.show(error, { isError: true });
    }
  }, [rateFetcher.state, rateFetcher.data, shopify]);

  // SSE real-time: track last update time and hold merged updates
  const [lastSeen, setLastSeen] = useState(() => new Date().toISOString());
  const [realtimeConvs, setRealtimeConvs] = useState<ConvItem[]>([]);
  const [otherViewers, setOtherViewers] = useState(0);
  // ponytail: sseKey increments to restart the SSE effect on error/reconnect (lastSeen alone can't do this — it's excluded from deps)
  const [sseKey, setSseKey] = useState(0);
  // ponytail: local state drives instant selection — no loader round-trip on click
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(loaderData.selected?.id ?? null);

  const allConversations = useMemo<ConvItem[]>(() => {
    if (realtimeConvs.length === 0) return conversations;
    const map = new Map(conversations.map((c) => [c.id, c]));
    for (const c of realtimeConvs) {
      map.set(c.id, { ...map.get(c.id), ...c } as ConvItem);
    }
    return Array.from(map.values()).sort((a, b) => {
      if (a.escalated !== b.escalated) return a.escalated ? -1 : 1;
      return new Date(b.lastMessageAt as unknown as string).getTime() -
             new Date(a.lastMessageAt as unknown as string).getTime();
    });
  }, [conversations, realtimeConvs]);

  const selected = useMemo(
    () => allConversations.find((c) => c.id === localSelectedId) ?? loaderData.selected ?? null,
    [allConversations, localSelectedId, loaderData.selected],
  );

  const selectedId = selected?.id ?? null;

  const isAiPaused = pauseFetcher.formData
    ? pauseFetcher.formData.get("pause") === "true"
    : selected?.aiPaused ?? false;
  const selectedStatus = selected ? getConversationStatus(selected) : null;

  useEffect(() => {
    if (variant !== "panel") return;
    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().then(setNotifPermission).catch(() => {});
    }
  }, [variant]);

  useEffect(() => {
    const params = new URLSearchParams({ since: lastSeen });
    if (selectedId) params.set("conv", selectedId);
    const es = new EventSource(`/api/events?${params.toString()}`);

    es.addEventListener("update", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { conversations: ConvItem[]; ts: string };
        setLastSeen(data.ts);
        setRealtimeConvs((prev) => {
          const map = new Map(prev.map((c) => [c.id, c]));
          for (const c of data.conversations) {
            map.set(c.id, { ...map.get(c.id), ...c } as ConvItem);
          }
          return Array.from(map.values()).sort((a, b) => {
            if (a.escalated !== b.escalated) return a.escalated ? -1 : 1;
            return new Date(b.lastMessageAt as unknown as string).getTime() -
                   new Date(a.lastMessageAt as unknown as string).getTime();
          });
        });

        // Browser notification + audio ping when tab is not focused (panel view only)
        if (
          variant === "panel" &&
          typeof document !== "undefined" &&
          document.visibilityState === "hidden" &&
          data.conversations.length > 0
        ) {
          if ("Notification" in window && Notification.permission === "granted") {
            const newest = data.conversations[0];
            const body = newest.firstUserMessage
              ? newest.firstUserMessage.slice(0, 100)
              : "New message received";
            const notif = new Notification("NeonPing — New message", {
              body,
              icon: "/favicon.ico",
              tag: `conv-${newest.id}`, // dedupes — same conv won't double-notify
              silent: false,
            });
            setTimeout(() => notif.close(), 5000);
            notif.onclick = () => {
              window.focus();
              notif.close();
              selectConversation(newest.id);
            };
          }

          try {
            const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
            const ctx = new AudioCtx();
            const oscillator = ctx.createOscillator();
            const gain = ctx.createGain();
            oscillator.connect(gain);
            gain.connect(ctx.destination);
            oscillator.type = "sine";
            oscillator.frequency.setValueAtTime(880, ctx.currentTime);
            gain.gain.setValueAtTime(0.1, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
            oscillator.start(ctx.currentTime);
            oscillator.stop(ctx.currentTime + 0.3);
          } catch { /* Web Audio not available — silent fail */ }
        }
      } catch { /* ignore parse errors */ }
    });

    es.addEventListener("presence", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { conv_id: string; viewer_count: number };
        if (data.conv_id === selectedId) {
          setOtherViewers(Math.max(0, data.viewer_count - 1));
        }
      } catch { /* ignore */ }
    });

    es.addEventListener("reconnect", () => {
      es.close();
      setTimeout(() => setSseKey((k) => k + 1), 1000);
    });

    es.onerror = () => {
      es.close();
      setTimeout(() => setSseKey((k) => k + 1), 5000);
    };

    return () => es.close();
  // lastSeen excluded: update events must not cause reconnects (would loop). sseKey triggers reconnects only on error/server-reconnect.
  }, [selectedId, sseKey, variant]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync search input when URL param changes (e.g. after filter reset)
  useEffect(() => {
    if (searchInputRef.current) searchInputRef.current.value = search;
  }, [search]);

  // Selecting a conversation only changes the `id` param — the list itself doesn't need to
  // reload, so we scope the loading state to the transcript/sidebar instead of blanking the
  // whole three-panel layout on every click (that read as a full page refresh to merchants).
  const isConversationSwitchOnly = (() => {
    if (navigation.state !== "loading" || !navigation.location) return false;
    const nextParams = new URLSearchParams(navigation.location.search);
    const stableKeys = ["channel", "dateRange", "statusTab", "search", "page"];
    const filtersUnchanged = stableKeys.every((k) => (nextParams.get(k) ?? "") === (searchParams.get(k) ?? ""));
    const idChanged = (nextParams.get("id") ?? "") !== (searchParams.get("id") ?? "");
    return filtersUnchanged && idChanged;
  })();
  const isRouteLoading = navigation.state === "loading" && !isConversationSwitchOnly;

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    next.set(key, value);
    next.set("page", "1");
    next.delete("id");
    setSearchParams(next);
  }

  function selectConversation(id: string) {
    setLocalSelectedId(id);
    setOtherViewers(0);
    const next = new URLSearchParams(searchParams);
    next.set("id", id);
    setSearchParams(next, { replace: true });
  }

  function nextPage() {
    const next = new URLSearchParams(searchParams);
    next.set("page", String(page + 1));
    setSearchParams(next);
  }

  function handleSearch(value: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const next = new URLSearchParams(searchParams);
      if (value.trim()) next.set("search", value.trim());
      else next.delete("search");
      next.set("page", "1");
      next.delete("id");
      setSearchParams(next);
    }, 400);
  }

  const requestNotifPermission = async () => {
    if ("Notification" in window) {
      const result = await Notification.requestPermission();
      setNotifPermission(result);
    }
  };

  function pauseToggle(pause: boolean) {
    if (!selected) return;
    pauseFetcher.submit(
      { intent: "pause-ai", conversationId: selected.id, pause: pause ? "true" : "false" },
      { method: "POST" },
    );
  }

  if (isRouteLoading) {
    return <ThreePanelSkeleton fullHeight={variant === "full"} />;
  }

  return (
    <div style={{ display: "flex", height: variant === "full" ? "100vh" : "calc(100vh - 120px)", minHeight: "600px" }}>
      <ConversationList
        conversations={allConversations}
        selectedId={localSelectedId}
        onSelect={selectConversation}
        totalCount={totalCount}
        purchasedCount={purchasedCount}
        inCartCount={inCartCount}
        escalatedCount={escalatedCount}
        liveCount={liveCount}
        thumbsUp={thumbsUp}
        thumbsDown={thumbsDown}
        search={search}
        onSearchChange={handleSearch}
        searchInputRef={searchInputRef}
        activeTab={activeTab}
        onTabChange={(tab) => { setActiveTab(tab); setFilter("statusTab", tab); }}
        dateRange={dateRange}
        onDateRangeChange={(v) => setFilter("dateRange", v)}
        hasMore={hasMore}
        onLoadMore={nextPage}
        notifPermission={variant === "panel" ? notifPermission : undefined}
        onRequestNotifPermission={variant === "panel" ? requestNotifPermission : undefined}
        onOpenFullScreen={
          variant === "panel"
            ? () => (document.getElementById("inbox-win") as unknown as { show(): void })?.show()
            : undefined
        }
      />

      {!selected ? (
        <>
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "var(--spacing-xl) var(--spacing-lg)", background: "var(--color-surface)", borderRight: "1px solid var(--color-border)" }}>
            <EmptyState heading="Select a conversation" subtext="Choose a conversation from the list to view the transcript and reply." />
          </div>
          <CustomerSidebar selected={null} storeHandle={storeHandle} currencyCode={currencyCode} />
        </>
      ) : (
        <>
          <TranscriptPanel
            selected={selected}
            selectedStatus={selectedStatus!}
            isAiPaused={isAiPaused}
            otherViewers={otherViewers}
            quickReplies={quickReplies as string[]}
            currencyCode={currencyCode}
            ratingOverrides={ratingOverrides}
            onRateMessage={rateMessage}
            onPauseToggle={pauseToggle}
            pauseFetcherState={pauseFetcher.state}
            dimmed={isConversationSwitchOnly}
          />
          <CustomerSidebar
            selected={selected}
            storeHandle={storeHandle}
            currencyCode={currencyCode}
            dimmed={isConversationSwitchOnly}
          />
        </>
      )}
    </div>
  );
}
