'use strict';

const crypto = require('node:crypto');
const { ethers } = require('ethers');

// Canonical Arc Testnet USDC, mirrored from arcService rather than imported:
// arcService loads the backend config, and this module must stay usable without
// database or secret environment variables. verify-gateway-service asserts the
// two constants remain identical.
const ARC_TESTNET_USDC_ADDRESS = '0x3600000000000000000000000000000000000000';

const GATEWAY_API_URL = 'https://gateway-api-testnet.circle.com';
const TOKEN = 'USDC';

// Gateway identifies each chain by a CCTP domain, not by chain id. Arc Testnet
// is domain 26. Confirmed against the live GET /v1/info response on 2026-09-09,
// which lists ARC / Testnet / domain 26 with both a wallet and a minter
// contract, so Arc is usable as a Gateway transfer destination.
const ARC_GATEWAY_DOMAIN = 26;

// Same addresses on every supported EVM testnet domain, per GET /v1/info.
const GATEWAY_WALLET_CONTRACT = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9';
const GATEWAY_MINTER_CONTRACT = '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B';

// EIP-712 definition of a burn intent, copied field for field from Circle's
// current EVM unified balance quickstart. The domain deliberately carries only
// a name and a version: a burn intent is chain agnostic, which is why one Arc
// EOA signature can spend a balance held on any source domain. Address shaped
// fields are bytes32 because Gateway also serves non EVM chains, and the
// quickstart submits the signed message itself as the burn intent, so the
// submitted and signed shapes are one and the same.
const BURN_INTENT_EIP712_DOMAIN = { name: 'GatewayWallet', version: '1' };

const BURN_INTENT_EIP712_TYPES = {
  TransferSpec: [
    { name: 'version', type: 'uint32' },
    { name: 'sourceDomain', type: 'uint32' },
    { name: 'destinationDomain', type: 'uint32' },
    { name: 'sourceContract', type: 'bytes32' },
    { name: 'destinationContract', type: 'bytes32' },
    { name: 'sourceToken', type: 'bytes32' },
    { name: 'destinationToken', type: 'bytes32' },
    { name: 'sourceDepositor', type: 'bytes32' },
    { name: 'destinationRecipient', type: 'bytes32' },
    { name: 'sourceSigner', type: 'bytes32' },
    { name: 'destinationCaller', type: 'bytes32' },
    { name: 'value', type: 'uint256' },
    { name: 'salt', type: 'bytes32' },
    { name: 'hookData', type: 'bytes' },
  ],
  BurnIntent: [
    { name: 'maxBlockHeight', type: 'uint256' },
    { name: 'maxFee', type: 'uint256' },
    { name: 'spec', type: 'TransferSpec' },
  ],
};

const TRANSFER_SPEC_VERSION = 1;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// A burn intent must name the USDC contract on the source chain, and that
// address differs per chain. Every EVM testnet domain that Circle Gateway
// currently supports is listed, with the token address taken from Circle's
// published USDC contract addresses page as the single source of truth.
//
// Two Gateway domains are deliberately absent:
//   - Solana (5) is not EVM and does not use this EIP-712 signing path.
//   - Arc (26) is the destination of this flow; see buildArcFundingBurnIntent.
//
// An unlisted domain fails closed rather than being guessed. Adding one
// requires its address from official Circle documentation, never inference.
const SOURCE_USDC_BY_DOMAIN = new Map([
  [0, '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'], // Ethereum Sepolia
  [1, '0x5425890298aed601595a70AB815c96711a31Bc65'], // Avalanche Fuji
  [2, '0x5fd84259d66Cd46123540766Be93DFE6D43130D7'], // OP Sepolia
  [3, '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d'], // Arbitrum Sepolia
  [6, '0x036CbD53842c5426634e7929541eC2318f3dCF7e'], // Base Sepolia
  [7, '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582'], // Polygon PoS Amoy
  [10, '0x31d0220469e10c4E71834a79b1f276d740d3768F'], // Unichain Sepolia
  // Domain 13 is "Sonic / Testnet" per Gateway's supported blockchains page and
  // per live /v1/info. Circle's USDC page also lists a separate "Sonic Blaze
  // Testnet" (0xA4879Fed...), which is a different network and must not be used
  // here. Checksum validation cannot catch this class of mistake.
  [13, '0x0BA304580ee7c9a980CF72e55f5Ed2E9fd30Bc51'], // Sonic Testnet
  [14, '0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88'], // World Chain Sepolia
  [16, '0x4fCF1784B31630811181f670Aea7A7bEF803eaED'], // Sei Testnet
  [19, '0x2B3370eE501B4a559b57D449569354196457D8Ab'], // HyperEVM Testnet
]);

/**
 * Whether a unified balance held on this domain can actually be spent to Arc
 * through the EIP-712 path in this module. readUnifiedUsdcBalance reports every
 * domain Gateway knows about, including Solana and Arc itself, so execution
 * must never assume that a reported balance is transferable.
 */
function isTransferableSourceDomain(domain) {
  return SOURCE_USDC_BY_DOMAIN.has(domain);
}

async function readUnifiedUsdcBalance(depositor, fetchImpl = fetch) {
  if (!ethers.isAddress(depositor)) {
    throw new Error('gateway_depositor_invalid');
  }

  const normalizedDepositor = ethers.getAddress(depositor);

  let response;
  try {
    response = await fetchImpl(`${GATEWAY_API_URL}/v1/balances`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: TOKEN,
        sources: [{ depositor: normalizedDepositor }],
      }),
    });
  } catch {
    throw new Error('gateway_service_unavailable');
  }

  if (!response.ok) {
    throw new Error('gateway_service_unavailable');
  }

  const body = await response.json();

  if (
    body?.token !== TOKEN ||
    !Array.isArray(body?.balances)
  ) {
    throw new Error('gateway_response_invalid');
  }

  const balances = body.balances.map((item) => {
    if (
      !Number.isInteger(item?.domain) ||
      typeof item?.depositor !== 'string' ||
      typeof item?.balance !== 'string' ||
      !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(item.balance)
    ) {
      throw new Error('gateway_response_invalid');
    }

    let balanceRaw;
    try {
      balanceRaw = ethers.parseUnits(item.balance, 6).toString();
    } catch {
      throw new Error('gateway_response_invalid');
    }

    return {
      domain: item.domain,
      depositor: item.depositor,
      balance: item.balance,
      balanceRaw,
      // Gateway reports every domain it knows about, including Solana and Arc
      // itself. Only a domain this module can actually build a burn intent for
      // is spendable to Arc, so the distinction is carried in the data rather
      // than left for a caller to rediscover.
      transferable: isTransferableSourceDomain(item.domain),
    };
  });

  const sumRaw = (items) => items
    .reduce((total, item) => total + BigInt(item.balanceRaw), 0n)
    .toString();

  const totalRaw = sumRaw(balances);
  const transferableTotalRaw = sumRaw(balances.filter((item) => item.transferable));

  return {
    token: TOKEN,
    depositor: normalizedDepositor,
    totalRaw,
    totalUsdc: ethers.formatUnits(BigInt(totalRaw), 6),
    transferableTotalRaw,
    transferableTotalUsdc: ethers.formatUnits(BigInt(transferableTotalRaw), 6),
    balances,
  };
}

function toBytes32(address) {
  return ethers.zeroPadValue(ethers.getAddress(address), 32);
}

function assertPositiveIntegerString(value, errorName) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new Error(errorName);
  }
  return value;
}

/**
 * Builds the burn intent that moves part of a unified balance to Arc Testnet.
 *
 * Every destination field is pinned rather than accepted from the caller: the
 * destination is always Arc, always canonical Arc USDC, and always the wallet
 * that the authenticated session already owns. A browser can therefore never
 * redirect a signed burn intent to another chain, another token or another
 * recipient, which is the only part of this payload that can lose funds.
 *
 * There is exactly one burn intent shape. Circle's quickstart submits the
 * signed EIP-712 message itself to /v1/transfer, so the returned `burnIntent`
 * and `typedData.message` are the same frozen object: what gets signed is
 * byte for byte what gets submitted, and the two cannot drift apart.
 *
 * `maxFeeRaw` and `maxBlockHeight` are validated inputs, not values this module
 * may invent. They must come from POST /v1/estimate?enableForwarder=true, whose
 * response supplies the maxFee and maxBlockHeight for the intent. A caller must
 * never pass browser supplied figures straight through.
 */
function buildArcFundingBurnIntent({
  walletAddress,
  sourceDomain,
  valueRaw,
  maxFeeRaw,
  maxBlockHeight,
  salt = ethers.hexlify(crypto.randomBytes(32)),
}) {
  if (!ethers.isAddress(walletAddress)) {
    throw new Error('gateway_wallet_invalid');
  }
  if (!Number.isInteger(sourceDomain) || sourceDomain < 0) {
    throw new Error('gateway_source_domain_invalid');
  }
  if (sourceDomain === ARC_GATEWAY_DOMAIN) {
    // Burning an Arc balance to mint back onto Arc costs a fee and delivers
    // nothing, so it is rejected rather than silently offered to the user.
    throw new Error('gateway_source_domain_is_destination');
  }
  if (!SOURCE_USDC_BY_DOMAIN.has(sourceDomain)) {
    throw new Error('gateway_source_domain_unsupported');
  }

  assertPositiveIntegerString(valueRaw, 'gateway_value_invalid');
  assertPositiveIntegerString(maxBlockHeight, 'gateway_max_block_height_invalid');

  if (typeof maxFeeRaw !== 'string' || !/^\d+$/.test(maxFeeRaw)) {
    throw new Error('gateway_max_fee_invalid');
  }
  if (BigInt(maxFeeRaw) >= BigInt(valueRaw)) {
    throw new Error('gateway_max_fee_exceeds_value');
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) {
    throw new Error('gateway_salt_invalid');
  }

  const wallet = ethers.getAddress(walletAddress);

  // The canonical Gateway spec. Address shaped fields are bytes32 throughout,
  // which is both what the EIP-712 types declare and what is submitted.
  const spec = Object.freeze({
    version: TRANSFER_SPEC_VERSION,
    sourceDomain,
    destinationDomain: ARC_GATEWAY_DOMAIN,
    sourceContract: toBytes32(GATEWAY_WALLET_CONTRACT),
    destinationContract: toBytes32(GATEWAY_MINTER_CONTRACT),
    sourceToken: toBytes32(SOURCE_USDC_BY_DOMAIN.get(sourceDomain)),
    destinationToken: toBytes32(ARC_TESTNET_USDC_ADDRESS),
    sourceDepositor: toBytes32(wallet),
    destinationRecipient: toBytes32(wallet),
    sourceSigner: toBytes32(wallet),
    // Zero means any caller may present the attestation on Arc, which includes
    // Circle's forwarder. It does not by itself enable forwarding: that is
    // requested separately with ?enableForwarder=true on estimate and transfer.
    destinationCaller: toBytes32(ZERO_ADDRESS),
    value: valueRaw,
    salt,
    hookData: '0x',
  });

  const burnIntent = Object.freeze({ maxBlockHeight, maxFee: maxFeeRaw, spec });

  return {
    burnIntent,
    typedData: {
      domain: BURN_INTENT_EIP712_DOMAIN,
      types: BURN_INTENT_EIP712_TYPES,
      primaryType: 'BurnIntent',
      // Same object, not a copy: the signed message is the submitted intent.
      message: burnIntent,
    },
    // The digest the Circle wallet is asked to sign. Recovering this address
    // from the returned signature proves the session wallet signed this exact
    // intent before anything is submitted to Gateway.
    digest: ethers.TypedDataEncoder.hash(
      BURN_INTENT_EIP712_DOMAIN,
      BURN_INTENT_EIP712_TYPES,
      burnIntent,
    ),
  };
}

/**
 * Confirms a signature really came from the session wallet for this exact
 * intent. Gateway would reject a bad signature anyway, but checking locally
 * keeps a malformed or swapped signature from ever being submitted.
 */
function recoverBurnIntentSigner(typedData, signature) {
  try {
    return ethers.verifyTypedData(
      typedData.domain,
      typedData.types,
      typedData.message,
      signature,
    );
  } catch {
    throw new Error('gateway_signature_invalid');
  }
}

module.exports = {
  ARC_GATEWAY_DOMAIN,
  BURN_INTENT_EIP712_DOMAIN,
  BURN_INTENT_EIP712_TYPES,
  GATEWAY_API_URL,
  GATEWAY_MINTER_CONTRACT,
  GATEWAY_WALLET_CONTRACT,
  SOURCE_USDC_BY_DOMAIN,
  buildArcFundingBurnIntent,
  isTransferableSourceDomain,
  readUnifiedUsdcBalance,
  recoverBurnIntentSigner,
};
