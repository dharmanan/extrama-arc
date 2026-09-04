import Link from "next/link";
import { AssetBadge, Footer, Header, Mountain } from "./components";
import { assets } from "./lib/mock-data";

export default function Home() {
  return <main className="home-shell"><section className="hero-panel"><Header inverse variant="home" /><div className="hero-copy"><p className="eyebrow">REAL PRICES. REAL PREDICTIONS.</p><h1>Small<br />Predictions.<br />Real Rewards.</h1><p>Predict the next high or low of BTC, ETH, SOL or HYPE. 1 USDC entry. Onchain. Transparent. For everyone.</p><Link className="button light" href="/pools">Start Predicting <b>→</b></Link></div><div className="hero-assets">{Object.keys(assets).map((asset) => <div key={asset}><AssetBadge asset={asset as keyof typeof assets} /><small>{asset}</small></div>)}</div><Mountain dark /><aside className="hero-aside">SAME<br />MARKETS.<br />BIGGER<br />STORIES.</aside><aside className="hero-rail"><span>Predict</span><span>Explore</span><span>Compete</span><span>Own</span></aside><div className="hero-stats"><div><b>24</b><small>Active Pools</small></div><div><b>12,438</b><small>Players</small></div><div><b>$12,438</b><small>Total Volume</small></div></div><Footer /></section></main>;
}
