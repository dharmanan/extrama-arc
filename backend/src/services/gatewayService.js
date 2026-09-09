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
// fields are bytes32 here even though the REST payload carries them as plain
// 20 byte addresses, because Gateway also serves non EVM chains.
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
// address differs per chain. Only domains whose testnet USDC address is
// published in Circle's current EVM unified balance quickstart are listed, so
// an unlisted source domain fails closed instead of being guessed. Solana
// (domain 5) is deliberately absent: it is not EVM and does not use this
// EIP-712 signing path.
const SOURCE_USDC_BY_DOMAIN = new Map([
  [0, '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'],
  [1, '0x5425890298aed601595a70ab815c96711a31bc65'],
  [6, '0x036CbD53842c5426634e7929541eC2318f3dCF7e'],
  [13, '0x0BA304580ee7c9a980CF72e55f5Ed2E9fd30Bc51'],
]);

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
    };
  });

  const totalRaw = balances
    .reduce((total, item) => total + BigInt(item.balanceRaw), 0n)
    .toString();

  return {
    token: TOKEN,
    depositor: normalizedDepositor,
    totalRaw,
    totalUsdc: ethers.formatUnits(BigInt(totalRaw), 6),
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

  // Plain 20 byte addresses: this is the REST payload shape.
  const spec = {
    version: TRANSFER_SPEC_VERSION,
    sourceDomain,
    destinationDomain: ARC_GATEWAY_DOMAIN,
    sourceContract: GATEWAY_WALLET_CONTRACT,
    destinationContract: GATEWAY_MINTER_CONTRACT,
    sourceToken: ethers.getAddress(SOURCE_USDC_BY_DOMAIN.get(sourceDomain)),
    destinationToken: ethers.getAddress(ARC_TESTNET_USDC_ADDRESS),
    sourceDepositor: wallet,
    destinationRecipient: wallet,
    sourceSigner: wallet,
    // Circle's forwarding service submits the destination mint, so the wallet
    // never needs gas on Arc. Leaving this open lets the forwarder call it.
    destinationCaller: ZERO_ADDRESS,
    value: valueRaw,
    salt,
    hookData: '0x',
  };

  const burnIntent = { maxBlockHeight, maxFee: maxFeeRaw, spec };

  // Signing shape: identical values, address fields widened to bytes32.
  const message = {
    maxBlockHeight,
    maxFee: maxFeeRaw,
    spec: {
      ...spec,
      sourceContract: toBytes32(spec.sourceContract),
      destinationContract: toBytes32(spec.destinationContract),
      sourceToken: toBytes32(spec.sourceToken),
      destinationToken: toBytes32(spec.destinationToken),
      sourceDepositor: toBytes32(spec.sourceDepositor),
      destinationRecipient: toBytes32(spec.destinationRecipient),
      sourceSigner: toBytes32(spec.sourceSigner),
      destinationCaller: toBytes32(spec.destinationCaller),
    },
  };

  return {
    burnIntent,
    typedData: {
      domain: BURN_INTENT_EIP712_DOMAIN,
      types: BURN_INTENT_EIP712_TYPES,
      primaryType: 'BurnIntent',
      message,
    },
    // The digest the Circle wallet is asked to sign. Recovering this address
    // from the returned signature proves the session wallet signed this exact
    // intent before anything is submitted to Gateway.
    digest: ethers.TypedDataEncoder.hash(
      BURN_INTENT_EIP712_DOMAIN,
      BURN_INTENT_EIP712_TYPES,
      message,
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
  readUnifiedUsdcBalance,
  recoverBurnIntentSigner,
};
