import Link from "next/link";
import { assets, distribution, ethRound } from "./lib/mock-data";

export function Mark() { return <span className="mark" aria-hidden="true">✦</span>; }

export function Header({ inverse = false, active = "play", variant = "default" }: { inverse?: boolean; active?: "play" | "pools" | "leaderboard"; variant?: "default" | "home" }) {
  return <header className={`header ${inverse ? "inverse" : ""}`}>
    <Link className="brand" href="/"><Mark /> EXTREMA</Link>
    <nav><Link className={active === "play" ? "active" : ""} href="/">Play</Link>{variant !== "home" && <Link className={active === "pools" ? "active" : ""} href="/pools">Pools</Link>}<Link className={active === "leaderboard" ? "active" : ""} href="/results/184">Leaderboard</Link><a href="#how">How it works</a></nav>
    {variant === "home" ? <Link className="connect-wallet" href="/wallet">Connect Wallet</Link> : <Link className="wallet-chip" href="/wallet"><span className="orb">♦</span><span>0x3aF...92E1</span></Link>}
  </header>;
}

export function Mountain({ dark = false }: { dark?: boolean }) {
  return <div className={`mountain ${dark ? "mountain-dark" : ""}`} aria-hidden="true"><i /><b /><em /></div>;
}

export function PriceLine({ violet = false }: { violet?: boolean }) {
  return <svg className={`price-line ${violet ? "violet" : ""}`} viewBox="0 0 420 110" preserveAspectRatio="none" aria-label="Mock market line"><path d="M0 73 L13 58 24 69 34 48 46 62 58 32 72 45 86 66 97 55 110 70 124 62 139 83 151 72 164 80 178 57 190 69 206 50 219 63 233 40 244 61 258 46 272 55 286 37 298 56 313 47 328 65 342 50 355 59 370 39 383 45 397 22 420 33" /><path className="area" d="M0 73 L13 58 24 69 34 48 46 62 58 32 72 45 86 66 97 55 110 70 124 62 139 83 151 72 164 80 178 57 190 69 206 50 219 63 233 40 244 61 258 46 272 55 286 37 298 56 313 47 328 65 342 50 355 59 370 39 383 45 397 22 420 33 V110 H0Z" /></svg>;
}

export function Distribution({ dark = false, official = false }: { dark?: boolean; official?: boolean }) {
  return <div className={`distribution ${dark ? "dark" : ""}`}>
    <div className="bars">{distribution.map((height, i) => <i key={i} style={{ height: `${height / 3.5}%` }} className={i === 19 ? "chosen" : ""} />)}</div>
    <div className="prediction-pin" style={{ left: "57%" }}><span>{official ? "Official low" : "Your prediction"}</span><strong>{official ? ethRound.official : ethRound.prediction}</strong></div>
    <div className="axis"><span>$1,700</span><span>$1,900</span><span>$2,100</span><span>$2,300</span><span>$2,500</span></div>
  </div>;
}

export function AssetBadge({ asset }: { asset: keyof typeof assets }) {
  const item = assets[asset];
  return <span className={`asset-badge asset-${asset.toLowerCase()}`} style={{ background: item.color }} aria-label={`${asset} logo`}>
    {asset === "BTC" && <svg viewBox="0 0 32 32" aria-hidden="true"><text x="16" y="23" textAnchor="middle">₿</text></svg>}
    {asset === "ETH" && <svg viewBox="0 0 32 32" aria-hidden="true"><path className="eth-top" d="m16 2 8.5 14L16 20.7 7.5 16 16 2Z" /><path className="eth-bottom" d="m16 22.3 8.5-4.6L16 30 7.5 17.7l8.5 4.6Z" /></svg>}
    {asset === "SOL" && <svg viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="sol-gradient" x1="0" x2="1"><stop stopColor="#9945ff" /><stop offset=".55" stopColor="#14f1d9" /><stop offset="1" stopColor="#47ff94" /></linearGradient></defs><path fill="url(#sol-gradient)" d="M8 6h18l-4.4 4H3.6L8 6Zm0 8h18l-4.4 4H3.6L8 14Zm0 8h18l-4.4 4H3.6L8 22Z" /></svg>}
    {asset === "HYPE" && <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M7 5h4.5v7.2h9V5H25v22h-4.5v-9.6h-9V27H7V5Z" /><path d="M12.7 13.7h6.6v2.6h-6.6z" fill="#3dbb9c" /></svg>}
  </span>;
}

export function Footer() { return <footer>Built on <b>✦ Arc</b><span /> Powered by <b className="usdc">◎ USDC</b></footer>; }
