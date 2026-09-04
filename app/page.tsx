import Link from "next/link";
import styles from "./home.module.css";

const assets = [
  { name: "BTC", label: "Bitcoin", src: "/brands/bitcoin.svg", tone: "bitcoin" },
  { name: "ETH", label: "Ethereum", src: "/brands/ethereum.png", tone: "ethereum" },
  { name: "SOL", label: "Solana", src: "/brands/solana.svg", tone: "solana" },
  { name: "HYPE", label: "Hyperliquid", src: "/brands/hyperliquid.svg", tone: "hyperliquid" },
] as const;

export default function Home() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/" aria-label="EXTREMA home">
          <span aria-hidden="true">✦</span>
          EXTREMA
        </Link>

        <nav className={styles.nav} aria-label="Main navigation">
          <Link className={styles.active} href="/">Play</Link>
          <Link href="/pools">Pools</Link>
          <Link href="/results/184">Leaderboard</Link>
          <a href="#how">How it works</a>
        </nav>

        <Link className={styles.wallet} href="/wallet">Connect Wallet</Link>
      </header>

      <section className={styles.hero} aria-labelledby="home-title">
        <div className={styles.mountainLayer} aria-hidden="true" />

        <div className={styles.copy}>
          <p className={styles.eyebrow}>REAL PRICES. REAL PLAYERS.</p>
          <h1 id="home-title">Predict<br />what&apos;s next.</h1>
          <p className={styles.body}>
            1 USDC. Four assets. Daily, weekly or quarterly.<br />
            Closest predictions win the pool.
          </p>
          <Link className={styles.cta} href="/pools">
            Start Playing
            <span aria-hidden="true">→</span>
          </Link>
        </div>

        <div className={styles.assetField} aria-label="Prediction assets">
          {assets.map((asset) => (
            <Link
              className={`${styles.assetPane} ${styles[asset.tone]}`}
              href="/pools"
              key={asset.name}
              aria-label={`Explore ${asset.label} pools`}
            >
              <span className={styles.assetLogo}>
                <img src={asset.src} alt="" />
              </span>
              <span className={styles.assetMeta}>
                <b>{asset.name}</b>
                <small>{asset.label}</small>
              </span>
            </Link>
          ))}
        </div>

        <dl className={styles.stats}>
          <div><dt>24</dt><dd>Active Pools</dd></div>
          <div><dt>12,438</dt><dd>Players</dd></div>
          <div><dt>$12,438</dt><dd>Total Volume</dd></div>
        </dl>

        <p className={styles.trust}>
          Built on <b>✦ Arc</b>
          <i aria-hidden="true" />
          Powered by <b className={styles.usdc}>◎ USDC</b>
        </p>

        <p className={styles.note} aria-hidden="true">
          Different<br />outlooks.<br />
          <span>A brighter<br />tomorrow.</span>
        </p>
      </section>
    </main>
  );
}
