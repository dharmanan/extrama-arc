'use strict';

const { ethers } = require('ethers');

const GATEWAY_API_URL = 'https://gateway-api-testnet.circle.com';
const TOKEN = 'USDC';

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

module.exports = {
  GATEWAY_API_URL,
  readUnifiedUsdcBalance,
};
