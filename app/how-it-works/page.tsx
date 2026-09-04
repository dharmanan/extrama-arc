import { ProductHeader } from "../product-components";

const steps = [
  ["1", "Choose a pool", "Pick BTC, ETH, SOL or HYPE. Choose High or Low and Daily, Weekly or Quarterly."],
  ["2", "Enter one number", "Every entry costs exactly 1 USDC and every exact prediction price can only be taken once in that pool."],
  ["3", "Receive NFT ticket", "The ticket records your round and prediction and becomes the claim credential if you win."],
  ["4", "Round resolves", "After the observation period, EXTREMA resolves the official High or Low from the locked Binance Mark Price source."],
  ["5", "Top 3 win", "54% goes to first, 22.5% to second, 13.5% to third, and 10% to treasury."],
  ["6", "Claim with NFT", "The current owner of a winning ticket claims the corresponding USDC reward."],
];

export default function HowItWorksPage() {
  return (
    <main className="wf-page">
      <ProductHeader />
      <section className="wf-main">
        <p>PRODUCT FLOW</p>
        <h1>How EXTREMA works</h1>
        <div className="wf-grid-3 wf-section">
          {steps.map(([number, title, body]) => (
            <article className="wf-card" key={number}>
              <small>STEP {number}</small>
              <h2>{title}</h2>
              <p>{body}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
