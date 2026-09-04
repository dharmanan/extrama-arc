import Link from "next/link";
import styles from "./home.module.css";

const assets = [
  { name: "BTC", src: "/brands/bitcoin.svg", tone: "bitcoin" },
  { name: "ETH", src: "/brands/ethereum.png", tone: "ethereum" },
  { name: "SOL", src: "/brands/solana.svg", tone: "solana" },
  { name: "HYPE", src: "/brands/hyperliquid.svg", tone: "hyperliquid" },
] as const;

export default function Home() {
  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <header className={styles.header}>
          <Link className={styles.brand} href="/" aria-label="EXTREMA home">
            <span aria-hidden="true">✦</span>
            EXTREMA
          </Link>

          <nav className={styles.nav} aria-label="Main navigation">
            <Link className={styles.active} href="/">Play</Link>
            <Link href="/results/184">Leaderboard</Link>
            <a href="#how">How it works</a>
          </nav>

          <Link className={styles.wallet} href="/wallet">Connect Wallet</Link>
        </header>

        <div className={styles.copy}>
          <h1>
            Small<br />
            Predictions.<br />
            Real Rewards.
          </h1>

          <p className={styles.body}>
            Predict the next high or low of BTC, ETH, SOL or HYPE. 1 USDC entry.
            Onchain. Transparent. For everyone.
          </p>

          <Link className={styles.cta} href="/pools">
            Start Predicting
            <span aria-hidden="true">→</span>
          </Link>
        </div>

        <div className={styles.assets} aria-label="Supported assets">
          {assets.map((asset) => (
            <Link className={styles.asset} href="/pools" key={asset.name}>
              <span className={`${styles.assetIcon} ${styles[asset.tone]}`}>
                <img src={asset.src} alt="" />
              </span>
              <small>{asset.name}</small>
            </Link>
          ))}
        </div>

        <p className={styles.manifesto} aria-hidden="true">
          SAME<br />
          MARKETS.<br />
          BIGGER<br />
          STORIES.
        </p>

        <div className={styles.rail} aria-hidden="true">
          <span>PREDICT</span>
          <span>EXPLORE</span>
          <span>COMPETE</span>
          <span>OWN</span>
        </div>

        <dl className={styles.stats}>
          <div><dt>24</dt><dd>Active Pools</dd></div>
          <div><dt>12,438</dt><dd>Players</dd></div>
          <div><dt>$12,438</dt><dd>Total Pool Volume</dd></div>
        </dl>

        <p className={styles.trust}>
          Built on <b>✦ Arc</b>
          <i aria-hidden="true" />
          Powered by <b className={styles.usdc}>◎ USDC</b>
        </p>
      </section>
    </main>
  );
}
