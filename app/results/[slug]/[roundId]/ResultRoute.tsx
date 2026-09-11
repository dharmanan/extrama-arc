"use client";

import { useEffect, useState } from "react";
import { ProductHeader } from "../../../product-components";
import { backendApi } from "../../../lib/backend-api";
import { useCopy } from "../../../i18n";
import { useCachedResult, writeCachedResult } from "../../../lib/result-cache";
import { useResultSnapshot } from "../../../lib/result-snapshot";
import { ResultClient, type LiveResult } from "./ResultClient";

type Refresh =
  | { status: "loading" }
  | { status: "ok"; result: LiveResult }
  | { status: "not_found" }
  | { status: "failed" };

function ResultLoadingState() {
  const t = useCopy();
  return (
    <main className="ex-pools ex-result" aria-busy="true">
      <ProductHeader />
      <div className="ex-shell">
        <section className="ex-result-loading" role="status">
          <p className="ex-eyebrow">{t.result.loadingEyebrow}</p>
          <h1 className="ex-display ex-display--lg">{t.result.loadingTitle}</h1>
          <p className="ex-result-loading__body">{t.result.loadingBody}</p>
          <span className="ex-result-loading__line" aria-hidden="true" />
        </section>
      </div>
    </main>
  );
}

function ResultLoadFailed({ onRetry }: { onRetry: () => void }) {
  const t = useCopy();
  return (
    <main className="ex-pools ex-result">
      <ProductHeader />
      <div className="ex-shell">
        <section className="ex-result-loading" role="alert">
          <p className="ex-eyebrow">{t.result.loadingEyebrow}</p>
          <h1 className="ex-display ex-display--lg">{t.result.loadFailedTitle}</h1>
          <p className="ex-result-loading__body">{t.result.loadFailedBody}</p>
          <div><button type="button" className="ex-btn ex-btn--ghost" onClick={onRetry}>{t.result.retry}</button></div>
        </section>
      </div>
    </main>
  );
}

// What to show before the authoritative result arrives: the newest result this
// tab already knows (a full result it opened before, or the Archive snapshot
// saved when the reader clicked through), otherwise the loading state. Used
// by the route itself and by its loading boundary, and never fetches.
export function KnownResultOrLoading({
  slug,
  roundId,
  refreshing = true,
  refreshFailed = false,
  onRetry,
}: {
  slug: string;
  roundId: number;
  refreshing?: boolean;
  refreshFailed?: boolean;
  onRetry?: () => void;
}) {
  const cached = useCachedResult(slug, roundId);
  const snapshot = useResultSnapshot(slug, roundId);

  const preferSnapshot = snapshot !== null && (cached === null || snapshot.archiveReadAt > cached.cachedAt);
  if (preferSnapshot) {
    return <ResultClient result={null} snapshot={snapshot} refreshing={refreshing} refreshFailed={refreshFailed} />;
  }
  if (cached) {
    return <ResultClient result={cached.result} refreshing={refreshing} refreshFailed={refreshFailed} />;
  }
  if (refreshFailed) return <ResultLoadFailed onRetry={onRetry ?? (() => window.location.reload())} />;
  return <ResultLoadingState />;
}

// The authoritative result is read on the client after the page renders, so a
// historical result the tab already knows appears immediately and a slow Arc
// read never blocks navigation. A fresh result always replaces what is shown
// and updates the tab's result cache; a failed read keeps the known result.
export function ResultRoute({ slug, roundId }: { slug: string; roundId: number }) {
  const [refresh, setRefresh] = useState<Refresh>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // The read starts only after the page has committed, and is cancelled on
    // unmount so leaving the page frees its browser connection at once.
    const controller = new AbortController();

    backendApi.rounds.result<LiveResult>(slug, roundId, { signal: controller.signal })
      .then((result) => {
        if (cancelled) return;
        if (result?.pool?.slug !== slug || result?.round?.roundId !== roundId) {
          setRefresh({ status: "failed" });
          return;
        }
        writeCachedResult(result);
        setRefresh({ status: "ok", result });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const message = cause instanceof Error ? cause.message : "";
        setRefresh({
          status: message === "round_result_not_found" || message === "round_result_not_supported"
            ? "not_found"
            : "failed",
        });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [slug, roundId, attempt]);

  if (refresh.status === "ok") return <ResultClient result={refresh.result} />;
  if (refresh.status === "not_found") return <ResultClient result={null} />;

  return (
    <KnownResultOrLoading
      slug={slug}
      roundId={roundId}
      refreshing={refresh.status === "loading"}
      refreshFailed={refresh.status === "failed"}
      onRetry={() => {
        setRefresh({ status: "loading" });
        setAttempt((value) => value + 1);
      }}
    />
  );
}
