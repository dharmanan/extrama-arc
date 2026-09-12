'use strict';

// THE canonical EXTREMA Circle Gateway EVM network configuration.
//
// Every chain id, Gateway (CCTP) domain, USDC address, Circle blockchain
// identifier and user facing label for the product's Gateway surface lives
// here and nowhere else. Services, routes and the frontend all consume this
// through gatewayService / the wallet API instead of restating a domain number
// or a token address locally.
//
// This module deliberately imports nothing but ethers: no config, no database,
// no Circle client. It must stay loadable in a deterministic verification
// process that has no environment variables at all.
//
// Sourcing of the values below, none of which may be inferred:
//   - Gateway domains and the GatewayWallet / GatewayMinter addresses come from
//     Circle's live GET /v1/info response.
//   - USDC addresses come from Circle's published USDC contract addresses page.
//   - circleBlockchain identifiers are the exact enum strings shipped in the
//     installed @circle-fin/user-controlled-wallets SDK (10.8.0). They are
//     asserted against the SDK at verification time, never guessed.

const { ethers } = require('ethers');

// Same addresses on every supported EVM domain, per GET /v1/info.
const GATEWAY_WALLET_CONTRACT = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9';
const GATEWAY_MINTER_CONTRACT = '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B';

// `depositSource` marks a chain the product offers as a way to FUND the
// unified balance. `destination` marks a chain the unified balance may be sent
// to. Arc Testnet is a destination only: EXTREMA's own market settlement chain
// is where value is meant to arrive, and the product does not offer an Arc
// source funding card.
//
// `rpcConfigKey` / `rpcFallbackConfigKey` name the backend config entries that
// hold that chain's RPC endpoints. Only deposit sources need chain reads, so
// only they carry them.
const NETWORKS = Object.freeze([
  Object.freeze({
    key: 'ARC_TESTNET',
    label: 'Arc Testnet',
    domain: 26,
    chainId: 5042002,
    usdc: '0x3600000000000000000000000000000000000000',
    circleBlockchain: 'ARC-TESTNET',
    depositSource: false,
    destination: true,
    rpcConfigKey: null,
    rpcFallbackConfigKey: null,
  }),
  Object.freeze({
    key: 'BASE_SEPOLIA',
    label: 'Base Sepolia',
    domain: 6,
    chainId: 84532,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    circleBlockchain: 'BASE-SEPOLIA',
    depositSource: true,
    destination: true,
    rpcConfigKey: 'BASE_SEPOLIA_RPC_URL',
    rpcFallbackConfigKey: 'BASE_SEPOLIA_RPC_FALLBACK_URL',
  }),
  Object.freeze({
    key: 'OP_SEPOLIA',
    label: 'OP Sepolia',
    domain: 2,
    chainId: 11155420,
    usdc: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
    circleBlockchain: 'OP-SEPOLIA',
    depositSource: true,
    destination: true,
    rpcConfigKey: 'OP_SEPOLIA_RPC_URL',
    rpcFallbackConfigKey: 'OP_SEPOLIA_RPC_FALLBACK_URL',
  }),
  Object.freeze({
    key: 'ARBITRUM_SEPOLIA',
    label: 'Arbitrum Sepolia',
    domain: 3,
    chainId: 421614,
    usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    circleBlockchain: 'ARB-SEPOLIA',
    depositSource: true,
    destination: true,
    rpcConfigKey: 'ARBITRUM_SEPOLIA_RPC_URL',
    rpcFallbackConfigKey: 'ARBITRUM_SEPOLIA_RPC_FALLBACK_URL',
  }),
  Object.freeze({
    key: 'ETHEREUM_SEPOLIA',
    label: 'Ethereum Sepolia',
    domain: 0,
    chainId: 11155111,
    usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    circleBlockchain: 'ETH-SEPOLIA',
    depositSource: true,
    destination: true,
    rpcConfigKey: 'ETHEREUM_SEPOLIA_RPC_URL',
    rpcFallbackConfigKey: 'ETHEREUM_SEPOLIA_RPC_FALLBACK_URL',
  }),
]);

const BY_DOMAIN = new Map(NETWORKS.map((network) => [network.domain, network]));
const BY_CHAIN_ID = new Map(NETWORKS.map((network) => [network.chainId, network]));

// Loading this module is itself the check that no address in the table was
// mistyped. A bad checksum is a startup failure, not a runtime surprise during
// a financial action.
for (const network of NETWORKS) {
  ethers.getAddress(network.usdc);
}
ethers.getAddress(GATEWAY_WALLET_CONTRACT);
ethers.getAddress(GATEWAY_MINTER_CONTRACT);

function networkForDomain(domain) {
  return BY_DOMAIN.get(domain) || null;
}

function networkForChainId(chainId) {
  return BY_CHAIN_ID.get(chainId) || null;
}

/**
 * The canonical network for a Gateway transfer DESTINATION, or null.
 *
 * Callers must resolve a destination through this function rather than trusting
 * a browser supplied token or contract address: the domain number is the only
 * thing a client ever sends, and every address the burn intent carries is read
 * from the row this returns.
 */
function destinationForDomain(domain) {
  const network = networkForDomain(domain);
  return network && network.destination ? network : null;
}

/** The canonical network for a source chain deposit card, or null. */
function depositSourceForDomain(domain) {
  const network = networkForDomain(domain);
  return network && network.depositSource ? network : null;
}

const DESTINATION_NETWORKS = Object.freeze(NETWORKS.filter((network) => network.destination));
const DEPOSIT_SOURCE_NETWORKS = Object.freeze(NETWORKS.filter((network) => network.depositSource));

// Automatic EXTREMA transfer planning is deliberately narrower than the full
// low-level Gateway network metadata. These are the only five EVM domains the
// product can currently plan and execute from: Arc is a transfer source even
// though it has no deposit card, while the other four also have source cards.
const TRANSFER_SOURCE_DOMAINS = Object.freeze([26, 6, 2, 3, 0]);
const TRANSFER_SOURCE_NETWORKS = Object.freeze(
  TRANSFER_SOURCE_DOMAINS.map((domain) => BY_DOMAIN.get(domain)).filter(Boolean),
);

/**
 * The presentation payload for the wallet UI: label plus domain, with no token
 * or contract address. The browser needs a stable identity to send back and a
 * name to render, and nothing else.
 */
function publicNetwork(network) {
  return {
    key: network.key,
    label: network.label,
    domain: network.domain,
    chainId: network.chainId,
  };
}

module.exports = {
  GATEWAY_MINTER_CONTRACT,
  GATEWAY_WALLET_CONTRACT,
  NETWORKS,
  DESTINATION_NETWORKS,
  DEPOSIT_SOURCE_NETWORKS,
  TRANSFER_SOURCE_DOMAINS,
  TRANSFER_SOURCE_NETWORKS,
  networkForDomain,
  networkForChainId,
  destinationForDomain,
  depositSourceForDomain,
  publicNetwork,
};
