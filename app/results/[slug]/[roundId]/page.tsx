import { ResultClient } from "./ResultClient";
import { ResultRoute } from "./ResultRoute";

// The page never waits for Arc on the server. It renders at once, a result the
// tab already knows (Archive snapshot or earlier full result) appears
// immediately, and the authoritative result is read on the client.
export default async function LiveResultPage({
  params,
}: {
  params: Promise<{ slug: string; roundId: string }>;
}) {
  const { slug, roundId: roundIdParam } = await params;
  const roundId = Number(roundIdParam);

  if (!Number.isInteger(roundId) || roundId <= 0) {
    return <ResultClient result={null} invalid />;
  }

  return <ResultRoute key={`${slug}:${roundId}`} slug={slug} roundId={roundId} />;
}
