"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AssetMark, ProductHeader } from "../product-components";
import { useLocale } from "../i18n";
import {
  backendApi,
  isAuthSessionError,
  type OwnedTicket,
  type OwnedTicketsResponse,
  type RefundExecutionMode,
  type ClaimExecutionMode,
} from "../lib/backend-api";
import { humanRoundStatus } from "../lib/display";
import {
  authenticatePasskey,
  confirmClaimWithPasskey,
  confirmExternalClaimReceipt,
  confirmExternalRefundReceipt,
  confirmRefundWithPasskey,
  confirmTicketTransferWithPasskey,
} from "../lib/passkey-client";
import {
  getOwnerChainId,
  sendOwnerTransaction,
  waitForOwnerTransactionReceipt,
} from "../lib/owner-wallet";
import { useAccount } from "wagmi";

function titleCase(value: string) {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

function formatPrediction(value: string, locale: "en" | "tr") {
  return new Intl.NumberFormat(locale === "tr" ? "tr-TR" : "en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value));
}

function ticketState(ticket: OwnedTicket, locale: "en" | "tr") {
  if (ticket.isClaimed) return locale === "tr" ? "Ödül alındı" : "Reward claimed";
  if (ticket.isRefunded) return locale === "tr" ? "İade alındı" : "Refunded";
  if (ticket.roundStatus === "SETTLED" && ticket.placement > 0) {
    return (locale === "tr" ? "Kazanan · #" : "Winner · #") + ticket.placement;
  }
  return humanRoundStatus(ticket.roundStatus, locale);
}

function ticketKey(ticket: OwnedTicket) {
  return `${ticket.ticketAddress}:${ticket.tokenId}`;
}

function isRefundEligible(ticket: OwnedTicket) {
  return ticket.roundStatus === "CANCELLED" && !ticket.isRefunded;
}

function isClaimEligible(ticket: OwnedTicket) {
  return (
    ticket.roundStatus === "SETTLED" &&
    ticket.placement > 0 &&
    !ticket.isClaimed &&
    BigInt(ticket.claimableRaw) > BigInt(0)
  );
}

const ARC_TESTNET_CHAIN_ID = 5042002;

export default function TicketsPage() {
  const { locale } = useLocale();
  const { address: ownerAddress, isConnected } = useAccount();
  const [state, setState] = useState<OwnedTicketsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const [authBusy, setAuthBusy] = useState("");
  const [transferTicketKey, setTransferTicketKey] = useState<string | null>(null);
  const [transferAddress, setTransferAddress] = useState("");
  const [transferBusy, setTransferBusy] = useState("");
  const [transferSuccess, setTransferSuccess] = useState<{
    destinationAddress: string;
    explorerUrl: string;
  } | null>(null);
  const [refundTicketKey, setRefundTicketKey] = useState<string | null>(null);
  const [refundBusy, setRefundBusy] = useState("");
  const [refundStatusText, setRefundStatusText] = useState("");
  const [refundSuccess, setRefundSuccess] = useState<{
    executionMode: RefundExecutionMode;
    explorerUrl: string;
  } | null>(null);

  const [claimTicketKey, setClaimTicketKey] = useState<string | null>(null);
  const [claimBusy, setClaimBusy] = useState("");
  const [claimStatusText, setClaimStatusText] = useState("");
  const [claimSuccess, setClaimSuccess] = useState<{
    executionMode: ClaimExecutionMode;
    explorerUrl: string;
    amountRaw: string;
  } | null>(null);

  const loadTickets = useCallback(async () => {
    setLoading(true);
    try {
      const result = await backendApi.wallet.tickets();
      setState(result);
      setError("");
      setAuthRequired(false);
    } catch (cause) {
      setState(null);
      if (isAuthSessionError(cause)) {
        setAuthRequired(true);
        setError("");
      } else {
        setAuthRequired(false);
        setError(cause instanceof Error ? cause.message : "Unable to load tickets.");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTickets();
  }, [loadTickets]);

  async function handleAuthenticate() {
    if (!ownerAddress) return;

    setAuthBusy("Authenticating with passkey...");
    setError("");
    try {
      await authenticatePasskey(ownerAddress);
      await loadTickets();
    } catch (cause) {
      if (isAuthSessionError(cause)) {
        setAuthRequired(true);
        setError("");
      } else {
        setError(cause instanceof Error ? cause.message : "Passkey authentication failed.");
      }
    } finally {
      setAuthBusy("");
    }
  }

  function openTransfer(ticket: OwnedTicket) {
    setTransferTicketKey(ticketKey(ticket));
    setTransferAddress(ownerAddress ?? "");
    setTransferSuccess(null);
    setError("");
  }

  function cancelTransfer() {
    setTransferTicketKey(null);
    setTransferAddress("");
    setTransferBusy("");
  }

  async function handleTransfer(ticket: OwnedTicket) {
    const destinationAddress = transferAddress.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(destinationAddress)) {
      setError("Enter a valid recipient wallet address.");
      return;
    }

    if (
      state?.backendWallet.wallet.address &&
      destinationAddress.toLowerCase() === state.backendWallet.wallet.address.toLowerCase()
    ) {
      setError("The recipient already owns this NFT.");
      return;
    }

    const key = ticketKey(ticket);
    setTransferBusy(key);
    setError("");

    try {
      const result = await confirmTicketTransferWithPasskey({
        ticketAddress: ticket.ticketAddress,
        tokenId: ticket.tokenId,
        destinationAddress,
      });

      setTransferSuccess({
        destinationAddress: result.destinationAddress,
        explorerUrl: result.explorerUrl,
      });
      setTransferTicketKey(null);
      setTransferAddress("");
      await loadTickets();
    } catch (cause) {
      if (isAuthSessionError(cause)) {
        setAuthRequired(true);
        setError("");
      } else {
        setError(cause instanceof Error ? cause.message : "NFT transfer failed.");
      }
    } finally {
      setTransferBusy("");
    }
  }

  function openRefund(ticket: OwnedTicket) {
    setRefundTicketKey(ticketKey(ticket));
    setRefundSuccess(null);
    setError("");
  }

  function cancelRefund() {
    setRefundTicketKey(null);
    setRefundBusy("");
    setRefundStatusText("");
  }

  async function handleRefund(ticket: OwnedTicket) {
    const key = ticketKey(ticket);
    setRefundBusy(key);
    setError("");
    setRefundStatusText("Confirming with passkey...");

    try {
      const outcome = await confirmRefundWithPasskey({
        poolAddress: ticket.poolAddress,
        ticketAddress: ticket.ticketAddress,
        tokenId: ticket.tokenId,
        roundId: ticket.roundId,
      });

      if (outcome.executionMode === "BACKEND_WALLET") {
        setRefundSuccess({
          executionMode: "BACKEND_WALLET",
          explorerUrl: outcome.result.explorerUrl,
        });
      } else {
        if (
          !isConnected ||
          !ownerAddress ||
          ownerAddress.toLowerCase() !== outcome.currentOwner.toLowerCase()
        ) {
          throw new Error(
            `Connect wallet ${outcome.currentOwner} in your browser wallet to complete this refund.`,
          );
        }

        const chainIdHex = await getOwnerChainId();
        if (parseInt(chainIdHex, 16) !== ARC_TESTNET_CHAIN_ID) {
          throw new Error("Switch your connected wallet to Arc Testnet (chain 5042002).");
        }

        setRefundStatusText("Waiting for wallet transaction...");
        const txHash = await sendOwnerTransaction({
          to: outcome.transactionRequest.to,
          data: outcome.transactionRequest.data,
          value: outcome.transactionRequest.value,
          from: outcome.transactionRequest.from,
        });

        setRefundStatusText("Waiting for transaction confirmation...");
        await waitForOwnerTransactionReceipt(txHash);

        setRefundStatusText("Verifying refund receipt...");
        const result = await confirmExternalRefundReceipt(outcome.actionId, txHash);

        setRefundSuccess({
          executionMode: "EXTERNAL_OWNER",
          explorerUrl: result.explorerUrl,
        });
      }

      setRefundTicketKey(null);
      await loadTickets();
    } catch (cause) {
      if (isAuthSessionError(cause)) {
        setAuthRequired(true);
        setError("");
      } else {
        setError(cause instanceof Error ? cause.message : "Refund failed.");
      }
    } finally {
      setRefundBusy("");
      setRefundStatusText("");
    }
  }


  function openClaim(ticket: OwnedTicket) {
    setClaimTicketKey(ticketKey(ticket));
    setClaimSuccess(null);
    setError("");
  }

  function cancelClaim() {
    setClaimTicketKey(null);
    setClaimBusy("");
    setClaimStatusText("");
  }

  async function handleClaim(ticket: OwnedTicket) {
    const key = ticketKey(ticket);
    setClaimBusy(key);
    setError("");
    setClaimStatusText("Confirming with passkey...");

    try {
      const outcome = await confirmClaimWithPasskey({
        poolAddress: ticket.poolAddress,
        ticketAddress: ticket.ticketAddress,
        tokenId: ticket.tokenId,
        roundId: ticket.roundId,
      });

      if (outcome.executionMode === "BACKEND_WALLET") {
        setClaimSuccess({
          executionMode: "BACKEND_WALLET",
          explorerUrl: outcome.result.explorerUrl,
          amountRaw: outcome.result.amountRaw,
        });
      } else {
        if (
          !isConnected ||
          !ownerAddress ||
          ownerAddress.toLowerCase() !== outcome.currentOwner.toLowerCase()
        ) {
          throw new Error(
            `Connect wallet ${outcome.currentOwner} in your browser wallet to complete this reward claim.`,
          );
        }

        const chainIdHex = await getOwnerChainId();
        if (parseInt(chainIdHex, 16) !== ARC_TESTNET_CHAIN_ID) {
          throw new Error("Switch your connected wallet to Arc Testnet (chain 5042002).");
        }

        setClaimStatusText("Waiting for wallet transaction...");
        const txHash = await sendOwnerTransaction({
          to: outcome.transactionRequest.to,
          data: outcome.transactionRequest.data,
          value: outcome.transactionRequest.value,
          from: outcome.transactionRequest.from,
        });

        setClaimStatusText("Waiting for transaction confirmation...");
        await waitForOwnerTransactionReceipt(txHash);

        setClaimStatusText("Verifying reward receipt...");
        const result = await confirmExternalClaimReceipt(outcome.actionId, txHash);

        setClaimSuccess({
          executionMode: "EXTERNAL_OWNER",
          explorerUrl: result.explorerUrl,
          amountRaw: result.amountRaw,
        });
      }

      setClaimTicketKey(null);
      await loadTickets();
    } catch (cause) {
      if (isAuthSessionError(cause)) {
        setAuthRequired(true);
        setError("");
      } else {
        setError(cause instanceof Error ? cause.message : "Reward claim failed.");
      }
    } finally {
      setClaimBusy("");
      setClaimStatusText("");
    }
  }

  function renderTicketCard(ticket: OwnedTicket, options: { showTransfer: boolean }) {
    const key = ticketKey(ticket);
    const transferOpen = transferTicketKey === key;
    const refundOpen = refundTicketKey === key;
    const refundEligible = isRefundEligible(ticket);
    const claimOpen = claimTicketKey === key;
    const claimEligible = isClaimEligible(ticket);

    return (
      <article className="ex-ticket" key={key} data-direction={ticket.direction}>
        <header className="ex-ticket__head">
          <div className="ex-ticket__identity">
            <AssetMark asset={ticket.asset} />
            <div>
              <h3>{ticket.asset} · {titleCase(ticket.cadence)} {titleCase(ticket.direction)}</h3>
              <p className="ex-num">Ticket #{ticket.tokenId} · Round #{ticket.roundId} · Entry #{ticket.entrySequence}</p>
            </div>
          </div>
          <span className="ex-ticket__status">{ticketState(ticket, locale)}</span>
        </header>

        <div className="ex-ticket__body">
          <div className="ex-ticket__prediction">
            <span>{locale === "tr" ? "TAHMİN" : "PREDICTION"}</span>
            <strong className="ex-num">{formatPrediction(ticket.predictionPrice, locale)}</strong>
            <small>1 USDC {locale === "tr" ? "katılım" : "entry"}</small>
          </div>

          <dl className="ex-ticket__meta">
            <div><dt>{locale === "tr" ? "DURUM" : "STATE"}</dt><dd>{ticketState(ticket, locale)}</dd></div>
            <div><dt>{locale === "tr" ? "SAHİP" : "OWNER"}</dt><dd className="ex-num">{ticket.owner.slice(0, 6)}…{ticket.owner.slice(-4)}</dd></div>
            <div>
              <dt>{locale === "tr" ? "HAK" : "CLAIM RIGHT"}</dt>
              <dd className="ex-num">
                {Number(ticket.claimableUsdc) > 0 && !ticket.isClaimed
                  ? ticket.claimableUsdc + " USDC"
                  : refundEligible
                    ? "1 USDC"
                    : "—"}
              </dd>
            </div>
          </dl>
        </div>

        <div className="ex-ticket__actions">
          <Link href={"/rounds/" + ticket.slug}>{locale === "tr" ? "Turu aç" : "View round"} →</Link>
          <a href={ticket.explorerUrl} target="_blank" rel="noreferrer">{locale === "tr" ? "NFT'yi doğrula" : "Verify NFT"} →</a>
          {options.showTransfer && (
            <button type="button" onClick={() => openTransfer(ticket)} disabled={Boolean(transferBusy) || Boolean(refundBusy) || Boolean(claimBusy)}>
              {locale === "tr" ? "NFT'yi aktar" : "Transfer NFT"} →
            </button>
          )}
          {refundEligible && (
            <button type="button" onClick={() => openRefund(ticket)} disabled={Boolean(transferBusy) || Boolean(refundBusy)}>
              {locale === "tr" ? "İadeyi al" : "Claim refund"} →
            </button>
          )}
          {claimEligible && (
            <button type="button" onClick={() => openClaim(ticket)} disabled={Boolean(transferBusy) || Boolean(refundBusy) || Boolean(claimBusy)}>
              {locale === "tr" ? "Ödülü al" : "Claim reward"} →
            </button>
          )}
        </div>

        {transferOpen && (
          <div className="ex-ticket__drawer">
            <p className="ex-eyebrow">{locale === "tr" ? "NFT AKTARIMI" : "NFT TRANSFER"}</p>
            <label className="ex-ticket__field">
              {locale === "tr" ? "Alıcı cüzdan adresi" : "Recipient wallet address"}
              <input value={transferAddress} onChange={(event) => setTransferAddress(event.target.value)} placeholder="0x..." autoComplete="off" spellCheck={false} />
            </label>
            <p>{locale === "tr" ? "NFT aktarımı gelecekteki ödül veya iade hakkını da yeni sahibine geçirir." : "Transferring this NFT also transfers any future claim or refund right."}</p>
            <div className="ex-ticket__drawer-actions">
              <button type="button" onClick={() => void handleTransfer(ticket)} disabled={Boolean(transferBusy)}>
                {transferBusy === key ? "Confirming transfer..." : locale === "tr" ? "Aktarımı onayla" : "Confirm transfer"}
              </button>
              <button type="button" onClick={cancelTransfer} disabled={Boolean(transferBusy)}>{locale === "tr" ? "Vazgeç" : "Cancel"}</button>
            </div>
          </div>
        )}

        {claimOpen && (
          <div className="ex-ticket__drawer">
            <p className="ex-eyebrow">{locale === "tr" ? "ÖDÜL TALEBİ" : "REWARD CLAIM"}</p>
            <p>
              {locale === "tr" ? "Bu bilet kazanan NFT'dir. Güncel sahibi " : "This ticket is a winning NFT. The current owner "}
              (<code>{ticket.owner}</code>)
              {locale === "tr" ? " " + ticket.claimableUsdc + " USDC ödülü bir kez alabilir." : " can claim " + ticket.claimableUsdc + " USDC once."}
            </p>
            <div className="ex-ticket__drawer-actions">
              <button type="button" onClick={() => void handleClaim(ticket)} disabled={Boolean(claimBusy)}>
                {claimBusy === key ? claimStatusText || "Confirming reward..." : locale === "tr" ? "Ödülü onayla" : "Confirm reward"}
              </button>
              <button type="button" onClick={cancelClaim} disabled={Boolean(claimBusy)}>{locale === "tr" ? "Vazgeç" : "Cancel"}</button>
            </div>
          </div>
        )}

        {refundOpen && (
          <div className="ex-ticket__drawer">
            <p className="ex-eyebrow">{locale === "tr" ? "İADE" : "REFUND"}</p>
            <p>
              {locale === "tr" ? "Bu tur iptal edildi. Güncel NFT sahibi " : "This round was cancelled. The current NFT owner "}
              (<code>{ticket.owner}</code>)
              {locale === "tr" ? " 1 USDC iadeyi bir kez alabilir." : " can claim a 1 USDC refund once."}
            </p>
            <div className="ex-ticket__drawer-actions">
              <button type="button" onClick={() => void handleRefund(ticket)} disabled={Boolean(refundBusy)}>
                {refundBusy === key ? refundStatusText || "Confirming refund..." : locale === "tr" ? "İadeyi onayla" : "Confirm refund"}
              </button>
              <button type="button" onClick={cancelRefund} disabled={Boolean(refundBusy)}>{locale === "tr" ? "Vazgeç" : "Cancel"}</button>
            </div>
          </div>
        )}
      </article>
    );
  }

  return (
    <main className="ex-tickets">
      <ProductHeader />
      <div className="ex-shell">
        <section className="ex-tickets__head">
          <div>
            <p className="ex-eyebrow">{locale === "tr" ? "SAHİPLİK" : "OWNERSHIP"}</p>
            <h1 className="ex-display ex-display--lg">{locale === "tr" ? "NFT biletlerin." : "Your NFT tickets."}</h1>
            <p className="ex-lede">
              {locale === "tr"
                ? "Tahmin, ödül ve iade hakkı bileti takip eder. Burada yalnızca şu anda sahip olduğun gerçek Arc Testnet biletleri görünür."
                : "Prediction, reward, and refund rights follow the ticket. Only NFTs you currently own on Arc Testnet appear here."}
            </p>
          </div>

          <dl className="ex-tickets__summary">
            <div><dt>{locale === "tr" ? "EXTREMA CÜZDANI" : "EXTREMA WALLET"}</dt><dd className="ex-num">{state?.backendWallet.ticketCount ?? "—"}</dd></div>
            <div><dt>{locale === "tr" ? "BAĞLI CÜZDAN" : "CONNECTED WALLET"}</dt><dd className="ex-num">{state?.ownerWallet?.ticketCount ?? 0}</dd></div>
            <div><dt>Arc Testnet</dt><dd className="ex-num">{state?.backendWallet.chain.blockNumber ?? "—"}</dd></div>
          </dl>
        </section>

        {transferSuccess && (
          <section className="ex-ticket-notice">
            <div><p className="ex-eyebrow">{locale === "tr" ? "AKTARIM TAMAMLANDI" : "TRANSFER COMPLETE"}</p><h2 className="ex-display ex-display--md">{locale === "tr" ? "NFT aktarıldı." : "NFT transferred."}</h2></div>
            <p>{locale === "tr" ? "Bilet ve gelecekteki hakları artık " : "The ticket and its future rights now belong to "}<code>{transferSuccess.destinationAddress}</code>.</p>
            <a href={transferSuccess.explorerUrl} target="_blank" rel="noreferrer">{locale === "tr" ? "İşlemi doğrula" : "Verify transaction"} →</a>
          </section>
        )}

        {claimSuccess && (
          <section className="ex-ticket-notice">
            <div>
              <p className="ex-eyebrow">{locale === "tr" ? "ÖDÜL ALINDI" : "REWARD CLAIMED"}</p>
              <h2 className="ex-display ex-display--md">
                {(Number(claimSuccess.amountRaw) / 1_000_000).toLocaleString(locale === "tr" ? "tr-TR" : "en-US", { maximumFractionDigits: 6 })} USDC
              </h2>
            </div>
            <p>{locale === "tr" ? "Ödül biletin güncel sahibine gönderildi." : "The reward was sent to the ticket's current owner."}</p>
            <a href={claimSuccess.explorerUrl} target="_blank" rel="noreferrer">{locale === "tr" ? "İşlemi doğrula" : "Verify transaction"} →</a>
          </section>
        )}

        {refundSuccess && (
          <section className="ex-ticket-notice">
            <div><p className="ex-eyebrow">{locale === "tr" ? "İADE ALINDI" : "REFUND CLAIMED"}</p><h2 className="ex-display ex-display--md">1 USDC</h2></div>
            <p>{locale === "tr" ? "İade biletin güncel sahibine gönderildi." : "The refund was sent to the ticket's current owner."}</p>
            <a href={refundSuccess.explorerUrl} target="_blank" rel="noreferrer">{locale === "tr" ? "İşlemi doğrula" : "Verify transaction"} →</a>
          </section>
        )}

        {loading && (
          <section className="ex-tickets__state">
            <p className="ex-eyebrow">{locale === "tr" ? "ZİNCİR OKUNUYOR" : "READING CHAIN"}</p>
            <p>{locale === "tr" ? "Biletlerin yükleniyor…" : "Loading your onchain tickets…"}</p>
          </section>
        )}

        {!loading && authRequired && (
          <section className="ex-tickets__state">
            <div>
              <p className="ex-eyebrow">{locale === "tr" ? "OTURUM" : "SESSION"}</p>
              <h2 className="ex-display ex-display--md">{locale === "tr" ? "Oturum süresi doldu." : "Session expired."}</h2>
              <p>{locale === "tr" ? "Zincir üstü biletlerini yüklemek için passkey ile doğrula." : "Authenticate with your passkey to load your onchain tickets."}</p>
            </div>
            {isConnected && ownerAddress ? (
              <button className="ex-btn ex-btn--ink" type="button" onClick={handleAuthenticate} disabled={Boolean(authBusy)}>
                {authBusy || (locale === "tr" ? "Passkey ile doğrula" : "Authenticate with passkey")}
              </button>
            ) : (
              <Link className="ex-btn ex-btn--ghost" href="/wallet">{locale === "tr" ? "Sahip cüzdanını bağla" : "Connect owner wallet"}</Link>
            )}
          </section>
        )}

        {!loading && !authRequired && error && (
          <section className="ex-tickets__state" data-tone="error">
            <div><p className="ex-eyebrow">{locale === "tr" ? "İŞLEM KULLANILAMIYOR" : "ACTION UNAVAILABLE"}</p><p>{error}</p></div>
            {state === null && <button className="ex-btn ex-btn--ghost" type="button" onClick={() => void loadTickets()}>{locale === "tr" ? "Tekrar dene" : "Try again"}</button>}
          </section>
        )}

        {!loading && state && state.backendWallet.ticketCount === 0 && (!state.ownerWallet || state.ownerWallet.ticketCount === 0) && (
          <section className="ex-tickets__empty">
            <p className="ex-eyebrow">{locale === "tr" ? "BİLET YOK" : "NO TICKETS"}</p>
            <h2 className="ex-display ex-display--md">{locale === "tr" ? "Henüz sahip olduğun bir tahmin bileti yok." : "No prediction tickets yet."}</h2>
            <p>{locale === "tr" ? "Bir havuza katıldığında NFT bilet burada görünür." : "Your NFT appears here after you enter a pool."}</p>
            <Link href="/pools">{locale === "tr" ? "Havuzlara git" : "Browse pools"} →</Link>
          </section>
        )}

        {!loading && state && state.backendWallet.ticketCount > 0 && (
          <section className="ex-ticket-group">
            <header className="ex-ticket-group__head">
              <div><p className="ex-eyebrow">{locale === "tr" ? "YÖNETİLEN CÜZDAN" : "MANAGED WALLET"}</p><h2 className="ex-display ex-display--md">{state.backendWallet.ticketCount} {locale === "tr" ? "zincir üstü bilet" : state.backendWallet.ticketCount === 1 ? "onchain ticket" : "onchain tickets"}</h2></div>
              <p className="ex-num">Arc Testnet · {state.backendWallet.chain.blockNumber}</p>
            </header>
            <div className="ex-ticket-list">{state.backendWallet.tickets.map((ticket) => renderTicketCard(ticket, { showTransfer: true }))}</div>
          </section>
        )}

        {!loading && state?.ownerWallet && state.ownerWallet.ticketCount > 0 && (
          <section className="ex-ticket-group">
            <header className="ex-ticket-group__head">
              <div><p className="ex-eyebrow">{locale === "tr" ? "BAĞLI CÜZDAN" : "CONNECTED WALLET"}</p><h2 className="ex-display ex-display--md">{locale === "tr" ? "Doğrudan sahip olduğun biletler." : "Tickets held directly."}</h2></div>
              <p className="ex-num">{state.ownerWallet.wallet.address}</p>
            </header>
            <p className="ex-ticket-group__note">{locale === "tr" ? "Bu biletler EXTREMA yönetimli cüzdanında değil, bağlı cüzdanında tutulur. Ödül ve iade işlemleri bağlı cüzdandan gönderilir." : "These NFTs are held by your connected wallet, not the EXTREMA-managed wallet. Reward claims and refunds are sent from the connected wallet."}</p>
            <div className="ex-ticket-list">{state.ownerWallet.tickets.map((ticket) => renderTicketCard(ticket, { showTransfer: false }))}</div>
          </section>
        )}
      </div>
    </main>
  );
}
