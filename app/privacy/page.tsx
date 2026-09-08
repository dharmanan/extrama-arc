import type { Metadata } from "next";
import { ProductHeader } from "../product-components";

export const metadata: Metadata = {
  title: "Privacy Policy · EXTREMA",
  description: "Privacy information for EXTREMA.",
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

export default function PrivacyPage() {
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
          Privacy Policy
        </h1>

        <p className="ex-lede">
          This policy explains how EXTREMA handles information when you use
          the application.
        </p>

        <p style={{ ...bodyStyle, marginTop: "18px" }}>
          Effective date: September 9, 2026.
        </p>

        <section style={sectionStyle}>
          <h2 className="ex-display ex-display--md">
            Information used to operate EXTREMA
          </h2>

          <p style={bodyStyle}>
            EXTREMA may process wallet addresses, authentication session
            identifiers, transaction references and technical information
            needed to provide the service, protect sessions, prevent abuse and
            operate Arc Testnet functionality.
          </p>
        </section>

        <section style={sectionStyle}>
          <h2 className="ex-display ex-display--md">
            Google and email authentication
          </h2>

          <p style={bodyStyle}>
            Google and email sign in are provided through Circle&apos;s User
            Controlled Wallet infrastructure. When email sign in is used, the
            submitted email address is sent through EXTREMA&apos;s backend to
            Circle for the purpose of starting the authentication flow.
          </p>

          <p style={bodyStyle}>
            Google authentication uses basic identity information required for
            sign in, including your Google account identity, profile and email
            address.
          </p>
        </section>

        <section style={sectionStyle}>
          <h2 className="ex-display ex-display--md">
            User controlled wallets
          </h2>

          <p style={bodyStyle}>
            Circle User Controlled Wallets remain controlled by the user.
            EXTREMA does not receive or store the private key for a Circle user
            controlled wallet.
          </p>

          <p style={bodyStyle}>
            If you connect an external EVM wallet such as MetaMask or Rabby,
            EXTREMA receives the public wallet address and a signed login
            message used to verify wallet ownership. A login signature does
            not authorize an onchain transaction.
          </p>
        </section>

        <section style={sectionStyle}>
          <h2 className="ex-display ex-display--md">
            Sessions and cookies
          </h2>

          <p style={bodyStyle}>
            EXTREMA uses an authentication session cookie so that the
            application can recognize an authenticated session. Session data
            is used to provide the service and associate the session with the
            correct wallet execution mode.
          </p>
        </section>

        <section style={sectionStyle}>
          <h2 className="ex-display ex-display--md">
            Blockchain information
          </h2>

          <p style={bodyStyle}>
            Blockchain transactions and wallet addresses submitted to Arc
            Testnet are public by design and may remain permanently available
            through blockchain infrastructure and explorers.
          </p>
        </section>

        <section style={sectionStyle}>
          <h2 className="ex-display ex-display--md">
            Third party services
          </h2>

          <p style={bodyStyle}>
            EXTREMA currently relies on third party services including Circle
            for user controlled wallet authentication and Google for optional
            Google sign in. Those services may process information under their
            own privacy policies.
          </p>
        </section>

        <section style={sectionStyle}>
          <h2 className="ex-display ex-display--md">
            Testnet status
          </h2>

          <p style={bodyStyle}>
            EXTREMA is currently an Arc Testnet application. Testnet assets are
            intended for testing and demonstration and should not be treated as
            assets with real world monetary value.
          </p>
        </section>

        <section style={sectionStyle}>
          <h2 className="ex-display ex-display--md">
            Changes to this policy
          </h2>

          <p style={bodyStyle}>
            This policy may be updated as EXTREMA&apos;s authentication,
            infrastructure or public release status changes. The effective date
            above will be updated when material changes are made.
          </p>
        </section>
      </article>
    </main>
  );
}
