import type { Metadata } from "next";
import { ProductHeader } from "../product-components";

export const metadata: Metadata = {
  title: "Terms of Service · EXTREMA",
  description: "Terms for using EXTREMA.",
};

const sectionStyle = {
  borderTop: "1px solid var(--line)",
  paddingTop: "28px",
  marginTop: "36px",
} as const;

const bodyStyle = {
  color: "var(--ink-2)",
  lineHeight: 1.7,
  maxWidth: "72ch",
} as const;

export default function TermsPage() {
  return (
    <main>
      <ProductHeader />

      <article
        className="ex-shell"
        style={{
          maxWidth: "920px",
          paddingBlock: "clamp(52px, 7vw, 96px)",
        }}
      >
        <p className="ex-eyebrow">Legal</p>

        <h1
          className="ex-display ex-display--lg"
          style={{ marginTop: "14px", marginBottom: "24px" }}
        >
          Terms of Service
        </h1>

        <p className="ex-lede">
          These terms govern access to and use of EXTREMA.
        </p>

        <p style={{ ...bodyStyle, marginTop: "18px" }}>
          Effective date: September 9, 2026.
        </p>

        <section style={sectionStyle}>
          <h2 className="ex-display ex-display--md">
            Testnet application
          </h2>

          <p style={bodyStyle}>
            EXTREMA currently operates on Arc Testnet. Testnet tokens,
            balances, predictions, tickets and rewards are provided for
            testing and demonstration purposes and are not represented as
            having real world monetary value.
          </p>
        </section>

        <section style={sectionStyle}>
          <h2 className="ex-display ex-display--md">
            Wallet responsibility
          </h2>

          <p style={bodyStyle}>
            You are responsible for reviewing and approving wallet actions.
            Connecting a wallet or signing an authentication message does not
            itself authorize an onchain transaction. Transactions requiring
            wallet approval remain subject to a separate user action.
          </p>
        </section>

        <section style={sectionStyle}>
          <h2 className="ex-display ex-display--md">
            Circle user controlled wallets
          </h2>

          <p style={bodyStyle}>
            Google access may create or use a Circle User Controlled Wallet.
            EXTREMA does not receive the private key for that wallet.
            Authentication and transaction approval may depend on Circle&apos;s
            infrastructure and availability.
          </p>
        </section>

        <section style={sectionStyle}>
          <h2 className="ex-display ex-display--md">
            Predictions and testnet settlement
          </h2>

          <p style={bodyStyle}>
            EXTREMA may allow users to submit testnet predictions, receive NFT
            tickets and interact with smart contracts deployed on Arc Testnet.
            Results and settlement follow the rules presented by the
            application and the deployed smart contracts.
          </p>
        </section>

        <section style={sectionStyle}>
          <h2 className="ex-display ex-display--md">
            No financial advice
          </h2>

          <p style={bodyStyle}>
            Information presented by EXTREMA is for product testing and
            informational purposes. It is not financial, investment, legal or
            tax advice.
          </p>
        </section>

        <section style={sectionStyle}>
          <h2 className="ex-display ex-display--md">
            Availability
          </h2>

          <p style={bodyStyle}>
            EXTREMA is experimental software. Features may change, fail, become
            unavailable or be removed. Testnet data and integrations may also
            be reset or changed by their respective providers.
          </p>
        </section>

        <section style={sectionStyle}>
          <h2 className="ex-display ex-display--md">
            Acceptable use
          </h2>

          <p style={bodyStyle}>
            You must not attempt to misuse the service, bypass security or rate
            limits, interfere with other users, exploit authentication systems
            or use EXTREMA for unlawful activity.
          </p>
        </section>

        <section style={sectionStyle}>
          <h2 className="ex-display ex-display--md">
            Changes
          </h2>

          <p style={bodyStyle}>
            These terms may be updated as EXTREMA develops or moves beyond its
            current testnet release. Continued use after an updated version is
            published is subject to the updated terms.
          </p>
        </section>
      </article>
    </main>
  );
}
