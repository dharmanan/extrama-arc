"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { getPoolBySlug, tickets as seedTickets } from "./lib/data";
import type {
  ClaimResult,
  DemoWallet,
  EnterPredictionResult,
  PredictionEntry,
  Ticket,
} from "./lib/domain";

type DemoState = {
  wallet: DemoWallet;
  tickets: Ticket[];
  entries: PredictionEntry[];
  createWallet: () => void;
  connectExistingWallet: () => void;
  lockWallet: () => void;
  fundWallet: (amount?: number) => void;
  enterPrediction: (poolSlug: string, prediction: number) => EnterPredictionResult;
  claimTicket: (ticketId: number) => ClaimResult;
  isPredictionTaken: (poolSlug: string, prediction: number) => boolean;
  hasEnteredPool: (poolSlug: string) => boolean;
  getTicketForPool: (poolSlug: string) => Ticket | undefined;
  resetDemo: () => void;
};

type PersistedDemo = {
  wallet: DemoWallet;
  tickets: Ticket[];
  entries: PredictionEntry[];
  nextTicketId: number;
};

const STORAGE_KEY = "extrema-demo-state-v1";

const sampleAddress = "0x3aF00000000000000000000000000000000092E1";

const initialWallet: DemoWallet = {
  status: "disconnected",
  mode: null,
  address: null,
  balanceUsdc: 0,
};

const seedEntries: PredictionEntry[] = [
  {
    ticketId: 1842,
    roundId: 184,
    poolSlug: "eth-weekly-low",
    wallet: sampleAddress,
    prediction: 2085,
    enteredAt: "2026-09-06T18:42:00Z",
  },
  {
    ticketId: 1921,
    roundId: 184,
    poolSlug: "eth-weekly-low",
    wallet: "0x9cD0000000000000000000000000000000008A21",
    prediction: 2090,
    enteredAt: "2026-09-06T18:49:00Z",
  },
  {
    ticketId: 1902,
    roundId: 184,
    poolSlug: "eth-weekly-low",
    wallet: "0x4ef0000000000000000000000000000000007D2c",
    prediction: 2078,
    enteredAt: "2026-09-06T18:51:00Z",
  },
];

function getInitialState(): PersistedDemo {
  return {
    wallet: initialWallet,
    tickets: seedTickets,
    entries: seedEntries,
    nextTicketId: 2001,
  };
}

const DemoContext = createContext<DemoState | null>(null);

export function DemoStateProvider({ children }: { children: React.ReactNode }) {
  const initial = getInitialState();
  const [wallet, setWallet] = useState<DemoWallet>(initial.wallet);
  const [tickets, setTickets] = useState<Ticket[]>(initial.tickets);
  const [entries, setEntries] = useState<PredictionEntry[]>(initial.entries);
  const [nextTicketId, setNextTicketId] = useState(initial.nextTicketId);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as PersistedDemo;
        setWallet(parsed.wallet);
        setTickets(parsed.tickets);
        setEntries(parsed.entries);
        setNextTicketId(parsed.nextTicketId);
      }
    } catch {
      window.localStorage.removeItem(STORAGE_KEY);
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const persisted: PersistedDemo = { wallet, tickets, entries, nextTicketId };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
  }, [hydrated, wallet, tickets, entries, nextTicketId]);

  function createWallet() {
    setWallet({
      status: "ready",
      mode: "extrema",
      address: sampleAddress,
      balanceUsdc: 12.4,
    });
  }

  function connectExistingWallet() {
    setWallet({
      status: "ready",
      mode: "external",
      address: sampleAddress,
      balanceUsdc: 12.4,
    });
  }

  function lockWallet() {
    setWallet((current) => ({ ...current, status: "disconnected" }));
  }

  function fundWallet(amount = 10) {
    setWallet((current) => {
      if (!current.address) return current;
      return { ...current, status: "ready", balanceUsdc: Number((current.balanceUsdc + amount).toFixed(6)) };
    });
  }

  function isPredictionTaken(poolSlug: string, prediction: number) {
    return entries.some(
      (entry) => entry.poolSlug === poolSlug && Number(entry.prediction.toFixed(2)) === Number(prediction.toFixed(2)),
    );
  }

  function hasEnteredPool(poolSlug: string) {
    if (!wallet.address) return false;
    return entries.some(
      (entry) => entry.poolSlug === poolSlug && entry.wallet.toLowerCase() === wallet.address?.toLowerCase(),
    );
  }

  function getTicketForPool(poolSlug: string) {
    return tickets.find((ticket) => ticket.poolSlug === poolSlug);
  }

  function enterPrediction(poolSlug: string, prediction: number): EnterPredictionResult {
    const pool = getPoolBySlug(poolSlug);
    if (!pool) return { ok: false, message: "Pool not found." };
    if (wallet.status !== "ready" || !wallet.address) {
      return { ok: false, message: "Create or connect a wallet first." };
    }
    if (pool.status !== "ENTRY_OPEN") {
      return { ok: false, message: "Entries for this pool are closed." };
    }
    if (!Number.isFinite(prediction)) {
      return { ok: false, message: "Enter a valid numeric prediction." };
    }
    const normalized = Number(prediction.toFixed(2));
    if (normalized < pool.predictionMin || normalized > pool.predictionMax) {
      return {
        ok: false,
        message: `Prediction must be between ${pool.predictionMin.toFixed(2)} and ${pool.predictionMax.toFixed(2)}.`,
      };
    }
    if (hasEnteredPool(poolSlug)) {
      return { ok: false, message: "This wallet already entered this pool." };
    }
    if (isPredictionTaken(poolSlug, normalized)) {
      return { ok: false, message: "That exact price is already taken. Choose another price." };
    }
    if (wallet.balanceUsdc < 1) {
      return { ok: false, message: "Insufficient balance. You need exactly 1 USDC to enter." };
    }

    const ticketId = nextTicketId;
    const enteredAt = new Date().toISOString();

    const entry: PredictionEntry = {
      ticketId,
      roundId: pool.roundId,
      poolSlug,
      wallet: wallet.address,
      prediction: normalized,
      enteredAt,
    };

    const ticket: Ticket = {
      tokenId: ticketId,
      roundId: pool.roundId,
      poolSlug,
      asset: pool.asset,
      cadence: pool.cadence,
      direction: pool.direction,
      prediction: normalized,
      entryUsdc: 1,
      status: "Live",
      claimableUsdc: 0,
      enteredAt,
    };

    setEntries((current) => [...current, entry]);
    setTickets((current) => [ticket, ...current]);
    setNextTicketId((value) => value + 1);
    setWallet((current) => ({
      ...current,
      balanceUsdc: Number((current.balanceUsdc - 1).toFixed(6)),
    }));

    return { ok: true, ticketId, message: `Prediction accepted. Ticket #${ticketId} created.` };
  }

  function claimTicket(ticketId: number): ClaimResult {
    if (wallet.status !== "ready" || !wallet.address) {
      return { ok: false, message: "Unlock your wallet before claiming." };
    }

    const ticket = tickets.find((item) => item.tokenId === ticketId);
    if (!ticket) return { ok: false, message: "Ticket not found." };
    if (ticket.claimableUsdc <= 0) {
      return { ok: false, message: ticket.status === "Claimed" ? "Reward already claimed." : "This ticket has no claimable reward." };
    }

    const amount = ticket.claimableUsdc;
    setTickets((current) =>
      current.map((item) =>
        item.tokenId === ticketId ? { ...item, status: "Claimed", claimableUsdc: 0 } : item,
      ),
    );
    setWallet((current) => ({
      ...current,
      balanceUsdc: Number((current.balanceUsdc + amount).toFixed(6)),
    }));

    return { ok: true, amountUsdc: amount, message: `${amount} USDC claimed.` };
  }

  function resetDemo() {
    const reset = getInitialState();
    setWallet(reset.wallet);
    setTickets(reset.tickets);
    setEntries(reset.entries);
    setNextTicketId(reset.nextTicketId);
    window.localStorage.removeItem(STORAGE_KEY);
  }

  const value = useMemo<DemoState>(
    () => ({
      wallet,
      tickets,
      entries,
      createWallet,
      connectExistingWallet,
      lockWallet,
      fundWallet,
      enterPrediction,
      claimTicket,
      isPredictionTaken,
      hasEnteredPool,
      getTicketForPool,
      resetDemo,
    }),
    [wallet, tickets, entries],
  );

  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
}

export function useDemoState() {
  const value = useContext(DemoContext);
  if (!value) throw new Error("useDemoState must be used inside DemoStateProvider");
  return value;
}

export function shortAddress(address: string | null) {
  if (!address) return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
