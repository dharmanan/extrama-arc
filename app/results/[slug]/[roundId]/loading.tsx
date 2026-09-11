"use client";

import { useParams } from "next/navigation";
import { KnownResultOrLoading } from "./ResultRoute";

// Shown the moment a result route is requested. A result this tab already
// knows (an Archive snapshot or a full result opened before) renders at once
// under a thin progress line; otherwise an intentional loading state appears.
// No placeholder values are ever drawn, and nothing is fetched here.
export default function ResultLoading() {
  const params = useParams<{ slug: string; roundId: string }>();
  const slug = typeof params?.slug === "string" ? params.slug : "";
  const roundId = Number(params?.roundId);
  return <KnownResultOrLoading slug={slug} roundId={roundId} />;
}
