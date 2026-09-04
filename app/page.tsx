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
        <Link className={styles.brand} href="/" aria-label="EXTREMA ana sayfa"><span aria-hidden="true">✦</span> EXTREMA</Link>
        <nav className={styles.nav} aria-label="Ana navigasyon">
          <Link className={styles.active} href="/">Play</Link>
          <Link href="/pools">Pools</Link>
          <Link href="/results/184">Leaderboard</Link>
          <a href="#how">How it works</a>
        </nav>
        <Link className={styles.wallet} href="/wallet">Connect Wallet</Link>
      </header>

      <section className={styles.hero} aria-labelledby="home-title">
        <div className={styles.copy}>
          <p className={styles.eyebrow}>REAL PRICES. REAL PREDICTIONS.</p>
          <h1 id="home-title">Small Predictions.<br />Real Rewards.</h1>
          <p className={styles.body}>Predict the next high or low of BTC, ETH, SOL or HYPE. 1 USDC entry. Onchain. Transparent. For everyone.</p>
          <Link className={styles.cta} href="/pools">Start Predicting <span aria-hidden="true">→</span></Link>
          <dl className={styles.stats}>
            <div><dt>24</dt><dd>Active Pools</dd></div>
            <div><dt>12,438</dt><dd>Players</dd></div>
            <div><dt>$12,438</dt><dd>Total Pool Volume</dd></div>
          </dl>
          <p className={styles.trust}>Built on <b>✦ Arc</b><i /> Powered by <b>◎ USDC</b></p>
        </div>

        <div className={styles.visual} aria-label="Dört aktif varlık">
          <div className={styles.visualShade} />
          <p className={styles.manifesto}>SAME<br />MARKETS.<br />BIGGER<br />STORIES.</p>
          <div className={styles.panes}>
            {assets.map((asset, index) => (
              <article className={`${styles.pane} ${styles[asset.tone]}`} key={asset.name}>
                <span className={styles.paneIndex}>0{index + 1}</span>
                <div className={styles.logoWrap}><img src={asset.src} alt={`${asset.label} logo`} /></div>
                <div className={styles.paneMeta}><b>{asset.name}</b><small>{asset.label}</small></div>
              </article>
            ))}
          </div>
          <div className={styles.rail}><span>Predict</span><span>Explore</span><span>Compete</span><span>Own</span></div>
        </div>
      </section>
    </main>
  );
}
