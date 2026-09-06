import { ProductHeader } from "../product-components";

const players = [
  { rank: 1, wallet: "0x7a8...3f1e", wins: 8, podiums: 15, earned: 8420 },
  { rank: 2, wallet: "0x9cD...8A21", wins: 6, podiums: 13, earned: 6210 },
  { rank: 3, wallet: "0x4ef...7D2c", wins: 5, podiums: 11, earned: 4890 },
  { rank: 4, wallet: "0x3aF...92E1", wins: 4, podiums: 9, earned: 3640 },
];

export default function LeaderboardPage() {
  return (
    <main className="wf-page">
      <ProductHeader />
      <section className="wf-main">
        <p>GLOBAL RANKINGS</p>
        <h1>Leaderboard</h1>
        <p>Wireframe ranking surface. Final scoring and visual treatment will be designed later.</p>
        <table className="wf-table wf-section">
          <thead><tr><th>Rank</th><th>Wallet</th><th>Wins</th><th>Podiums</th><th>USDC earned</th></tr></thead>
          <tbody>{players.map((player) => <tr key={player.wallet}><td>#{player.rank}</td><td>{player.wallet}</td><td>{player.wins}</td><td>{player.podiums}</td><td>{player.earned}</td></tr>)}</tbody>
        </table>
      </section>
    </main>
  );
}
