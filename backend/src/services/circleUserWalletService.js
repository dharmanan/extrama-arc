'use strict';

const { ethers } = require('ethers');
const config = require('../config');

const ARC_TESTNET = 'ARC-TESTNET';
const EOA = 'EOA';
const ALREADY_INITIALIZED_CODE = 155106;
const PAGE_SIZE = 50;
const MAX_PAGES = 20;
const READINESS_CACHE_MS = 60 * 1000;

function circleErrorCode(error) {
  const candidates = [error?.code, error?.response?.data?.code, error?.body?.code];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
}

function safeCircleError(error) {
  if (error?.message === 'circle_service_not_configured') return error;
  const code = circleErrorCode(error);
  if ([155103, 155104, 155105, 155113, 155718, 155719].includes(code)) {
    return new Error('circle_authentication_invalid');
  }
  if (code === ALREADY_INITIALIZED_CODE) return new Error('circle_user_already_initialized');
  if (code === 155142) return new Error('circle_email_otp_send_limit');
  if (code === 155141) return new Error('circle_email_otp_attempt_limit');
  if (code && code >= 155000 && code < 156000) return new Error('circle_request_rejected');
  if (error?.response?.status === 429) return new Error('circle_rate_limited');
  return new Error('circle_service_unavailable');
}

function assertConfigured(apiKey) {
  if (!apiKey) throw new Error('circle_service_not_configured');
}

function pickArcEoa(wallets) {
  const matching = wallets.filter((wallet) => (
    wallet && wallet.blockchain === ARC_TESTNET && wallet.accountType === EOA &&
    typeof wallet.id === 'string' && ethers.isAddress(wallet.address)
  ));
  if (matching.length > 1) throw new Error('circle_arc_eoa_ambiguous');
  if (!matching.length) return null;
  const wallet = matching[0];
  return {
    id: wallet.id,
    address: ethers.getAddress(wallet.address),
    blockchain: ARC_TESTNET,
    accountType: EOA,
    createdAt: typeof wallet.createDate === 'string' ? wallet.createDate : null,
  };
}

function nextCursor(response) {
  const headers = response?.headers || {};
  const headerCursor = headers['x-next-page-after'] || headers['X-Next-Page-After'];
  const body = response?.data || {};
  const bodyCursor = body.nextPageAfter || body.pageAfter || body.pagination?.nextPageAfter;
  return typeof headerCursor === 'string' && headerCursor
    ? headerCursor
    : typeof bodyCursor === 'string' && bodyCursor ? bodyCursor : null;
}

function matchesContractExecutionTransaction(transaction, { walletId, refId, contractAddress }) {
  const contractMatches =
    transaction?.contractAddress == null ||
    (
      typeof transaction.contractAddress === 'string' &&
      ethers.isAddress(transaction.contractAddress) &&
      ethers.getAddress(transaction.contractAddress).toLowerCase() ===
        ethers.getAddress(contractAddress).toLowerCase()
    );

  return transaction?.walletId === walletId &&
    transaction?.blockchain === ARC_TESTNET &&
    transaction?.refId === refId &&
    contractMatches;
}

function matchesFetchedContractExecutionTransaction(
  transaction,
  { walletId, refId, contractAddress },
) {
  const refMatches =
    transaction?.refId == null ||
    transaction.refId === refId;

  const contractMatches =
    transaction?.contractAddress == null ||
    (
      typeof transaction.contractAddress === 'string' &&
      ethers.isAddress(transaction.contractAddress) &&
      ethers.getAddress(transaction.contractAddress).toLowerCase() ===
        ethers.getAddress(contractAddress).toLowerCase()
    );

  return transaction?.walletId === walletId &&
    transaction?.blockchain === ARC_TESTNET &&
    refMatches &&
    contractMatches;
}

function createCircleUserWalletService({ apiKey = config.CIRCLE_API_KEY, client } = {}) {
  let circleClient = client;
  let readinessVerifiedAt = 0;
  let readinessPromise = null;

  function getClient() {
    assertConfigured(apiKey);
    if (!circleClient) {
      // This module is never imported by a client bundle, so the API key stays server-only.
      const { initiateUserControlledWalletsClient } = require('@circle-fin/user-controlled-wallets');
      circleClient = initiateUserControlledWalletsClient({ apiKey });
    }
    return circleClient;
  }

  function isConfigured() {
    return Boolean(apiKey);
  }

  async function verifyReadiness() {
    if (
      readinessVerifiedAt > 0 &&
      Date.now() - readinessVerifiedAt < READINESS_CACHE_MS
    ) {
      return {
        configured: true,
        reachable: true,
      };
    }

    if (readinessPromise) {
      return readinessPromise;
    }

    readinessPromise = (async () => {
      const activeClient = getClient();

      await activeClient.listUsers({
        pageSize: 1,
      });

      readinessVerifiedAt = Date.now();

      return {
        configured: true,
        reachable: true,
      };
    })();

    try {
      return await readinessPromise;
    } finally {
      readinessPromise = null;
    }
  }

  async function listArcEoa(userToken) {
    assertConfigured(apiKey);
    let pageAfter;
    const wallets = [];
    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const response = await getClient().listWallets({
          userToken, blockchain: ARC_TESTNET, pageAfter, pageSize: PAGE_SIZE,
        });
        wallets.push(...(Array.isArray(response?.data?.wallets) ? response.data.wallets : []));
        const cursor = nextCursor(response);
        if (!cursor) break;
        if (cursor === pageAfter || page === MAX_PAGES - 1) {
          throw new Error('circle_wallet_listing_incomplete');
        }
        pageAfter = cursor;
      }
      return pickArcEoa(wallets);
    } catch (error) {
      if (error?.message?.startsWith('circle_')) throw error;
      throw safeCircleError(error);
    }
  }

  async function createSocialDeviceToken({ deviceId, idempotencyKey }) {
    try {
      const response = await getClient().createDeviceTokenForSocialLogin({ deviceId, idempotencyKey });
      const data = response?.data;
      if (!data?.deviceToken || !data?.deviceEncryptionKey) throw new Error('circle_response_invalid');
      return { deviceToken: data.deviceToken, deviceEncryptionKey: data.deviceEncryptionKey };
    } catch (error) {
      if (error?.message?.startsWith('circle_')) throw error;
      throw safeCircleError(error);
    }
  }

  async function createEmailDeviceToken({ deviceId, email, idempotencyKey }) {
    try {
      const response = await getClient().createDeviceTokenForEmailLogin({ deviceId, email, idempotencyKey });
      const data = response?.data;
      if (!data?.deviceToken || !data?.deviceEncryptionKey || !data?.otpToken) {
        throw new Error('circle_response_invalid');
      }
      return {
        deviceToken: data.deviceToken,
        deviceEncryptionKey: data.deviceEncryptionKey,
        otpToken: data.otpToken,
      };
    } catch (error) {
      if (error?.message?.startsWith('circle_')) throw error;
      throw safeCircleError(error);
    }
  }

  async function initializeArcEoa({ userToken, idempotencyKey }) {
    const existing = await listArcEoa(userToken);
    if (existing) return { status: 'EXISTING', wallet: existing, challengeId: null };
    try {
      const response = await getClient().createUserPinWithWallets({
        userToken, blockchains: [ARC_TESTNET], accountType: EOA, idempotencyKey,
      });
      const challengeId = response?.data?.challengeId;
      if (typeof challengeId !== 'string' || !challengeId) throw new Error('circle_response_invalid');
      return { status: 'CHALLENGE_REQUIRED', wallet: null, challengeId };
    } catch (error) {
      if (circleErrorCode(error) === ALREADY_INITIALIZED_CODE) {
        const wallet = await listArcEoa(userToken);
        if (!wallet) throw new Error('circle_arc_eoa_not_found');
        return { status: 'EXISTING', wallet, challengeId: null };
      }
      if (error?.message?.startsWith('circle_')) throw error;
      throw safeCircleError(error);
    }
  }

  async function createContractExecutionChallenge({
    userToken, walletId, contractAddress, callData, idempotencyKey, refId,
  }) {
    try {
      if (!userToken || !walletId || !ethers.isAddress(contractAddress) ||
        typeof callData !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(callData) ||
        !idempotencyKey || !refId) {
        throw new Error('circle_request_invalid');
      }
      const response = await getClient().createUserTransactionContractExecutionChallenge({
        userToken,
        walletId,
        contractAddress: ethers.getAddress(contractAddress),
        callData,
        fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
        idempotencyKey,
        refId,
      });
      const challengeId = response?.data?.challengeId;
      if (typeof challengeId !== 'string' || !challengeId) throw new Error('circle_response_invalid');
      return { challengeId };
    } catch (error) {
      if (error?.message?.startsWith('circle_')) throw error;

      const upstreamStatus =
        error?.response?.status ??
        error?.status ??
        null;
      const circleCode = circleErrorCode(error);
      const upstreamMessage =
        typeof error?.message === 'string'
          ? error.message.slice(0, 300)
          : null;

      console.error(
        '[circle] contract execution challenge failed',
        JSON.stringify({
          upstreamStatus,
          circleCode,
          upstreamMessage,
          errorName: error?.constructor?.name || null,
        }),
      );

      throw safeCircleError(error);
    }
  }

  async function getContractExecutionChallenge({ userToken, challengeId }) {
    try {
      if (
        !userToken ||
        typeof challengeId !== 'string' ||
        !challengeId
      ) {
        throw new Error('circle_request_invalid');
      }

      const response = await getClient().getUserChallenge({
        userToken,
        challengeId,
      });

      const challenge = response?.data?.challenge;
      if (!challenge) return null;

      if (
        challenge.id !== challengeId ||
        challenge.type !== 'CONTRACT_EXECUTION'
      ) {
        throw new Error('circle_challenge_mismatch');
      }

      const correlationIds = Array.isArray(challenge.correlationIds)
        ? challenge.correlationIds.filter(
            (id) => typeof id === 'string' && id,
          )
        : [];

      if (correlationIds.length > 1) {
        throw new Error('circle_transaction_ambiguous');
      }

      return {
        id: challenge.id,
        status: challenge.status,
        type: challenge.type,
        transactionId: correlationIds[0] || null,
      };
    } catch (error) {
      if (error?.message?.startsWith('circle_')) throw error;

      console.error(
        '[circle] challenge lookup failed',
        JSON.stringify({
          upstreamStatus:
            error?.response?.status ??
            error?.status ??
            null,
          circleCode: circleErrorCode(error),
          upstreamMessage:
            typeof error?.message === 'string'
              ? error.message.slice(0, 300)
              : null,
          errorName: error?.constructor?.name || null,
        }),
      );

      throw safeCircleError(error);
    }
  }

  // Gateway burn intents are EIP-712 signatures, not Arc transactions. The
  // Circle-hosted challenge returns its signature to the browser after user
  // approval; the backend only creates and later checks the challenge state.
  async function createTypedDataChallenge({
    userToken, walletId, typedData, idempotencyKey, memo,
  }) {
    try {
      if (
        !userToken || !walletId || !typedData ||
        typeof idempotencyKey !== 'string' || !idempotencyKey
      ) throw new Error('circle_request_invalid');

      const response = await getClient().signTypedData({
        userToken,
        walletId,
        data: JSON.stringify(typedData),
        memo: typeof memo === 'string' ? memo.slice(0, 512) : undefined,
        xRequestId: idempotencyKey,
      });
      const challengeId = response?.data?.challengeId;
      if (typeof challengeId !== 'string' || !challengeId) {
        throw new Error('circle_response_invalid');
      }
      return { challengeId };
    } catch (error) {
      if (error?.message?.startsWith('circle_')) throw error;
      throw safeCircleError(error);
    }
  }

  async function getTypedDataChallenge({ userToken, challengeId }) {
    try {
      if (!userToken || typeof challengeId !== 'string' || !challengeId) {
        throw new Error('circle_request_invalid');
      }
      const response = await getClient().getUserChallenge({ userToken, challengeId });
      const challenge = response?.data?.challenge;
      if (!challenge) return null;
      if (challenge.id !== challengeId || challenge.type !== 'SIGN_TYPEDDATA') {
        throw new Error('circle_challenge_mismatch');
      }
      return { id: challenge.id, status: challenge.status, type: challenge.type };
    } catch (error) {
      if (error?.message?.startsWith('circle_')) throw error;
      throw safeCircleError(error);
    }
  }

  async function findContractExecutionTransaction({ userToken, walletId, refId, contractAddress }) {
    try {
      // The transaction was just created for this wallet. Query only the
      // newest contract executions instead of walking the user's full history.
      const response = await getClient().listTransactions({
        userToken,
        walletIds: [walletId],
        pageSize: PAGE_SIZE,
        order: 'DESC',
      });

      const matching = (response?.data?.transactions || []).filter((transaction) =>
        matchesContractExecutionTransaction(transaction, { walletId, refId, contractAddress }));

      if (matching.length > 1) throw new Error('circle_transaction_ambiguous');
      return matching[0] || null;
    } catch (error) {
      if (error?.message?.startsWith('circle_')) throw error;

      console.error(
        '[circle] transaction lookup failed',
        JSON.stringify({
          upstreamStatus:
            error?.response?.status ??
            error?.status ??
            null,
          circleCode: circleErrorCode(error),
          upstreamMessage:
            typeof error?.message === 'string'
              ? error.message.slice(0, 300)
              : null,
          errorName: error?.constructor?.name || null,
        }),
      );

      throw safeCircleError(error);
    }
  }

  async function getContractExecutionTransaction({ userToken, id, walletId, refId, contractAddress }) {
    try {
      const response = await getClient().getTransaction({ userToken, id });
      const transaction = response?.data?.transaction;
      if (!transaction) return null;
      if (
        transaction.id !== id ||
        !matchesFetchedContractExecutionTransaction(
          transaction,
          { walletId, refId, contractAddress },
        )
      ) {
        throw new Error('circle_transaction_mismatch');
      }
      return transaction;
    } catch (error) {
      if (error?.message?.startsWith('circle_')) throw error;
      throw safeCircleError(error);
    }
  }

  return {
    configured: Boolean(apiKey),
    isConfigured,
    getClient,
    verifyReadiness,
    createSocialDeviceToken,
    createEmailDeviceToken,
    initializeArcEoa,
    listArcEoa,
    createContractExecutionChallenge,
    getContractExecutionChallenge,
    createTypedDataChallenge,
    getTypedDataChallenge,
    findContractExecutionTransaction,
    getContractExecutionTransaction,
  };
}

const circleUserWalletService = createCircleUserWalletService();

module.exports = {
  ARC_TESTNET,
  EOA,
  ALREADY_INITIALIZED_CODE,
  circleErrorCode,
  safeCircleError,
  pickArcEoa,
  matchesContractExecutionTransaction,
  matchesFetchedContractExecutionTransaction,
  createCircleUserWalletService,
  ...circleUserWalletService,
};
