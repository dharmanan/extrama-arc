"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { assetConfigs } from "./lib/asset-config";
import type { Asset } from "./lib/domain";
import { shortAddress, useWalletSession } from "./wallet-session";
import { backendApi } from "./lib/backend-api";
import { useCopy, useLocale } from "./i18n";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";

function formatHeaderUsdc(value: string, locale: "en" | "tr") {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;

  return new Intl.NumberFormat(locale === "tr" ? "tr-TR" : "en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numeric);
}

export function ProductHeader({ variant = "solid" }: { variant?: "solid" | "overlay" }) {
  const { status, address } = useWalletSession();
  const { locale, setLocale } = useLocale();
  const t = useCopy();
  const [onchainUsdc, setOnchainUsdc] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [walletConnectRequested, setWalletConnectRequested] = useState(false);
  const { openConnectModal } = useConnectModal();
  const { address: wagmiAddress, isConnected: wagmiConnected, chain } = useAccount();
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;

    if (status !== "ready" || !address) {
      setOnchainUsdc(null);
      return;
    }

    backendApi.wallet.chainState()
      .then((state) => {
        if (!cancelled) setOnchainUsdc(state.usdc.balanceFormatted);
      })
      .catch(() => {
        if (!cancelled) setOnchainUsdc(null);
      });

    return () => {
      cancelled = true;
    };
  }, [status, address]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const connected = status === "ready" && Boolean(address);

  useEffect(() => {
    if (
      walletConnectRequested &&
      !connected &&
      wagmiConnected &&
      wagmiAddress
    ) {
      setWalletConnectRequested(false);
      router.push("/wallet");
    }
  }, [
    walletConnectRequested,
    connected,
    wagmiConnected,
    wagmiAddress,
    router,
  ]);

  return (
    <header className={`ex-header${variant === "overlay" ? " ex-header--overlay" : ""}`}>
      <div className="ex-header__inner">
        <Link href="/" className="ex-brand">EXTREMA</Link>

        <nav className="ex-nav" aria-label="Primary navigation">
          <Link href="/pools">{t.pools}</Link><Link href="/marketplace">{t.marketplace}</Link><Link href="/leaderboard">{t.leaderboard}</Link><Link href="/archive">{t.archive}</Link><Link href="/how-it-works">{t.howItWorks}</Link><Link href="/tickets">{t.myTickets}</Link>
        </nav>

        <div className="ex-header__aside">
          <div className="ex-lang" aria-label="Language">
            <button
              data-active={locale === "en"}
              type="button"
              onClick={() => setLocale("en")}
            >
              EN
            </button>
            <button
              data-active={locale === "tr"}
              type="button"
              onClick={() => setLocale("tr")}
            >
              TR
            </button>
          </div>

          {connected && address ? (
            <Link href="/wallet" className="ex-wallet">
              <span className="ex-wallet__dot" aria-hidden="true" />
              <span className="ex-num">{shortAddress(address)}</span>
              {onchainUsdc !== null && (
                <span className="ex-num ex-wallet__balance">
                  · {formatHeaderUsdc(onchainUsdc, locale)} USDC
                </span>
              )}
            </Link>
          ) : wagmiConnected && wagmiAddress ? (
            <Link href="/wallet" className="ex-wallet">
              <span className="ex-wallet__long">
                {shortAddress(wagmiAddress)}
                {chain?.name ? ` · ${chain.name}` : ""}
              </span>
              <span className="ex-wallet__short">{shortAddress(wagmiAddress)}</span>
            </Link>
          ) : (
            <button
              type="button"
              className="ex-wallet"
              onClick={() => {
                setWalletConnectRequested(true);
                openConnectModal?.();
              }}
              disabled={!openConnectModal}
            >
              <span className="ex-wallet__long">Connect wallet</span>
              <span className="ex-wallet__short">{t.walletShort}</span>
            </button>
          )}
        </div>

        <button type="button" className="ex-menu-toggle" aria-expanded={menuOpen} aria-controls="mobile-product-menu" aria-label={menuOpen ? t.closeNavigation : t.openNavigation} onClick={() => setMenuOpen((open) => !open)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={menuOpen ? "M5 5L19 19M19 5L5 19" : "M3 6H21M3 12H21M3 18H21"} /></svg>
        </button>
      </div>
      <div id="mobile-product-menu" className="ex-mobile-menu" data-open={menuOpen} hidden={!menuOpen}>
        <nav aria-label="Mobile navigation">
          <Link href="/pools" onClick={() => setMenuOpen(false)}>{t.pools}</Link><Link href="/marketplace" onClick={() => setMenuOpen(false)}>{t.marketplace}</Link><Link href="/leaderboard" onClick={() => setMenuOpen(false)}>{t.leaderboard}</Link><Link href="/archive" onClick={() => setMenuOpen(false)}>{t.archive}</Link><Link href="/how-it-works" onClick={() => setMenuOpen(false)}>{t.howItWorks}</Link><Link href="/tickets" onClick={() => setMenuOpen(false)}>{t.myTickets}</Link>
        </nav>
        <div className="ex-mobile-menu__utility"><div className="ex-lang" aria-label="Language"><button data-active={locale === "en"} type="button" onClick={() => setLocale("en")}>EN</button><button data-active={locale === "tr"} type="button" onClick={() => setLocale("tr")}>TR</button></div>{connected && address ? <Link href="/wallet" className="ex-wallet" onClick={() => setMenuOpen(false)}><span className="ex-wallet__dot" aria-hidden="true" /><span className="ex-num">{shortAddress(address)}</span>{onchainUsdc !== null && <span className="ex-num ex-wallet__balance">· {formatHeaderUsdc(onchainUsdc, locale)} USDC</span>}</Link> : wagmiConnected && wagmiAddress ? <Link href="/wallet" className="ex-wallet" onClick={() => setMenuOpen(false)}><span>Continue · {shortAddress(wagmiAddress)}</span></Link> : <button type="button" className="ex-wallet" disabled={!openConnectModal} onClick={() => { setMenuOpen(false); setWalletConnectRequested(true); openConnectModal?.(); }}><span>Connect wallet</span></button>}</div>
      </div>
    </header>
  );
}

export function AssetMark({ asset }: { asset: Asset }) {
  const item = assetConfigs[asset];
  return (
    <span className="wf-asset-mark">
      <img src={item.brandSrc} alt="" />
      <span>{asset}</span>
    </span>
  );
}
