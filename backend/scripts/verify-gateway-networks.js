'use strict';

// Deterministic proof for the canonical Gateway network configuration and the
// generic source-chain service.
//
// Nothing here touches a network: every assertion is over the static config
// table, the installed Circle SDK's own enum strings, and locally encoded
// calldata. global.fetch is poisoned so an accidental request fails the run.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgresql://verify:verify@127.0.0.1:1/verify';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.JWT_SECRET ||= 'verify_only_session_secret_not_for_runtime';

let liveNetworkCalls = 0;
global.fetch = async () => {
  liveNetworkCalls += 1;
  throw new Error('live network disabled in deterministic verifier');
};

const gatewayNetworks = require('../src/services/gatewayNetworks');
const gatewayService = require('../src/services/gatewayService');
const gatewaySourceChainService = require('../src/services/gatewaySourceChainService');
const circleUserWalletService = require('../src/services/circleUserWalletService');

// The canonical table, restated here independently so a silent edit to the
// config is a test failure rather than a new truth. Values come from Circle's
// live GET /v1/info (domains, Gateway contracts) and Circle's published USDC
// contract addresses page (tokens).
const EXPECTED = [
  {
    key: 'ARC_TESTNET',
    label: 'Arc Testnet',
    domain: 26,
    chainId: 5042002,
    usdc: '0x3600000000000000000000000000000000000000',
    circleBlockchain: 'ARC-TESTNET',
    depositSource: false,
    destination: true,
  },
  {
    key: 'BASE_SEPOLIA',
    label: 'Base Sepolia',
    domain: 6,
    chainId: 84532,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    circleBlockchain: 'BASE-SEPOLIA',
    depositSource: true,
    destination: true,
  },
  {
    key: 'OP_SEPOLIA',
    label: 'OP Sepolia',
    domain: 2,
    chainId: 11155420,
    usdc: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
    circleBlockchain: 'OP-SEPOLIA',
    depositSource: true,
    destination: true,
  },
  {
    key: 'ARBITRUM_SEPOLIA',
    label: 'Arbitrum Sepolia',
    domain: 3,
    chainId: 421614,
    usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    circleBlockchain: 'ARB-SEPOLIA',
    depositSource: true,
    destination: true,
  },
  {
    key: 'ETHEREUM_SEPOLIA',
    label: 'Ethereum Sepolia',
    domain: 0,
    chainId: 11155111,
    usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    circleBlockchain: 'ETH-SEPOLIA',
    depositSource: true,
    destination: true,
  },
];

const GATEWAY_WALLET = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9';
const GATEWAY_MINTER = '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B';

function verifyCanonicalTable() {
  assert.equal(gatewayNetworks.NETWORKS.length, EXPECTED.length, 'exactly five canonical networks');
  assert.deepEqual(
    gatewayNetworks.TRANSFER_SOURCE_NETWORKS.map((network) => network.domain),
    [26, 6, 2, 3, 0],
    'automatic transfer planning is bounded to the five EXTREMA source domains',
  );
  for (const expected of EXPECTED) {
    const network = gatewayNetworks.networkForDomain(expected.domain);
    assert.ok(network, `domain ${expected.domain} must be configured`);
    assert.equal(network.key, expected.key);
    assert.equal(network.label, expected.label);
    assert.equal(network.chainId, expected.chainId);
    assert.equal(
      ethers.getAddress(network.usdc), ethers.getAddress(expected.usdc),
      `${expected.label} USDC must be the canonical address`,
    );
    assert.equal(network.circleBlockchain, expected.circleBlockchain);
    assert.equal(network.depositSource, expected.depositSource);
    assert.equal(network.destination, expected.destination);
    // Chain id and domain are distinct identifiers and must never be confused.
    assert.notEqual(network.chainId, network.domain);
    assert.equal(gatewayNetworks.networkForChainId(expected.chainId).domain, expected.domain);
  }

  assert.equal(ethers.getAddress(gatewayNetworks.GATEWAY_WALLET_CONTRACT), ethers.getAddress(GATEWAY_WALLET));
  assert.equal(ethers.getAddress(gatewayNetworks.GATEWAY_MINTER_CONTRACT), ethers.getAddress(GATEWAY_MINTER));
  // One canonical table: gatewayService must not carry its own copies.
  assert.equal(gatewayService.GATEWAY_WALLET_CONTRACT, gatewayNetworks.GATEWAY_WALLET_CONTRACT);
  assert.equal(gatewayService.GATEWAY_MINTER_CONTRACT, gatewayNetworks.GATEWAY_MINTER_CONTRACT);
  for (const expected of EXPECTED) {
    assert.equal(
      ethers.getAddress(gatewayService.SOURCE_USDC_BY_DOMAIN.get(expected.domain)),
      ethers.getAddress(expected.usdc),
      `${expected.label} source token must agree with the canonical table`,
    );
  }

  // A browser is handed labels and domains, never addresses. Presenting a
  // token or contract address would invite a client to send one back.
  for (const network of gatewayNetworks.NETWORKS) {
    const shown = gatewayNetworks.publicNetwork(network);
    assert.deepEqual(
      Object.keys(shown).sort(), ['chainId', 'domain', 'key', 'label'],
      'the public network shape exposes no token or contract address',
    );
  }

  console.log('GATEWAY_CANONICAL_NETWORK_CONFIG=PASS');
}

function verifyDestinations() {
  const domains = gatewayNetworks.DESTINATION_NETWORKS.map((network) => network.domain).sort((a, b) => a - b);
  assert.deepEqual(domains, [0, 2, 3, 6, 26], 'five transfer destinations');
  assert.deepEqual(
    gatewayNetworks.DESTINATION_NETWORKS.map((network) => network.label),
    ['Arc Testnet', 'Base Sepolia', 'OP Sepolia', 'Arbitrum Sepolia', 'Ethereum Sepolia'],
  );

  // Every destination resolves its own token from config, and only from config.
  const wallet = ethers.getAddress(`0x${'11'.repeat(20)}`);
  for (const network of gatewayNetworks.DESTINATION_NETWORKS) {
    const spec = gatewayService.buildGatewayTransferSpec({
      walletAddress: wallet,
      sourceDomain: 6,
      destinationDomain: network.domain,
      valueRaw: '1000000',
    });
    assert.equal(spec.destinationDomain, network.domain);
    assert.equal(
      spec.destinationToken.toLowerCase(),
      ethers.zeroPadValue(ethers.getAddress(network.usdc), 32).toLowerCase(),
      `${network.label} destination token comes from canonical config`,
    );
    assert.equal(
      spec.destinationContract.toLowerCase(),
      ethers.zeroPadValue(ethers.getAddress(GATEWAY_MINTER), 32).toLowerCase(),
    );
    // Recipient is always the session wallet.
    assert.equal(
      spec.destinationRecipient.toLowerCase(),
      ethers.zeroPadValue(wallet, 32).toLowerCase(),
    );
    assert.equal(spec.sourceDepositor, spec.destinationRecipient);
    assert.equal(spec.sourceSigner, spec.destinationRecipient);
  }

  // A Gateway domain that exists but that this product does not offer as a
  // destination fails closed rather than being minted on.
  for (const domain of [1, 5, 7, 10, 13, 99]) {
    assert.equal(gatewayNetworks.destinationForDomain(domain), null, `domain ${domain} is not a destination`);
    assert.throws(
      () => gatewayService.buildGatewayTransferSpec({
        walletAddress: wallet, sourceDomain: 6, destinationDomain: domain, valueRaw: '1000000',
      }),
      (error) => error.message === 'gateway_destination_domain_unsupported',
    );
  }

  console.log('GATEWAY_DESTINATION_GENERALIZATION=PASS');
}

function verifySameChainWithdrawal() {
  const wallet = ethers.getAddress(`0x${'22'.repeat(20)}`);
  // Gateway's instant transfer path supports materializing a balance back onto
  // the chain it was deposited on, so matching domains must NOT be rejected.
  for (const domain of [0, 2, 3, 6, 26]) {
    const spec = gatewayService.buildGatewayTransferSpec({
      walletAddress: wallet, sourceDomain: domain, destinationDomain: domain, valueRaw: '1000000',
    });
    assert.equal(spec.sourceDomain, domain);
    assert.equal(spec.destinationDomain, domain);
    assert.equal(spec.sourceToken, spec.destinationToken, 'same chain uses the same token on both sides');
  }
  // The old Arc-specific prohibition must be gone, not merely relocated.
  const arcToArc = gatewayService.buildGatewayTransferSpec({
    walletAddress: wallet, sourceDomain: 26, destinationDomain: 26, valueRaw: '1000000',
  });
  assert.equal(arcToArc.destinationDomain, 26);
  console.log('GATEWAY_SAME_CHAIN_WITHDRAWAL=PASS');
}

function verifyCircleBlockchainIdentifiers() {
  // The Circle blockchain identifiers are never guessed. Each one must appear
  // verbatim in the installed @circle-fin/user-controlled-wallets package, so
  // a typo or an invented name cannot survive this test.
  const sdkRoot = path.join(__dirname, '../node_modules/@circle-fin/user-controlled-wallets');
  const version = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json'), 'utf8')).version;
  const candidates = [
    'dist/user-controlled-wallets.cjs.js',
    'dist/types/clients/user-controlled-wallets.d.ts',
  ].map((relative) => path.join(sdkRoot, relative)).filter((file) => fs.existsSync(file));
  assert.ok(candidates.length, 'the installed Circle SDK must be readable');
  const sdkText = candidates.map((file) => fs.readFileSync(file, 'utf8')).join('\n');

  for (const expected of EXPECTED) {
    assert.ok(
      sdkText.includes(`"${expected.circleBlockchain}"`) ||
      sdkText.includes(`'${expected.circleBlockchain}'`),
      `${expected.circleBlockchain} must be a blockchain identifier the installed SDK ${version} supports`,
    );
  }

  // Only the four funding sources may be prepared as companion wallets. Arc is
  // the session's own wallet and is never "prepared" through this path, and an
  // unknown name never reaches Circle.
  assert.deepEqual(
    [...circleUserWalletService.GATEWAY_SOURCE_BLOCKCHAINS].sort(),
    ['ARB-SEPOLIA', 'BASE-SEPOLIA', 'ETH-SEPOLIA', 'OP-SEPOLIA'],
  );
  for (const rejected of ['ARC-TESTNET', 'ETH', 'MATIC-AMOY', 'AVAX-FUJI', 'not-a-chain', '']) {
    assert.throws(
      () => circleUserWalletService.assertGatewaySourceBlockchain(rejected),
      (error) => error.message === 'circle_source_blockchain_unsupported',
      `${rejected || '(empty)'} must fail closed`,
    );
  }

  console.log(`GATEWAY_CIRCLE_BLOCKCHAIN_IDENTIFIERS=PASS sdk=${version}`);
}

function verifyFourSourceChains() {
  const sources = gatewaySourceChainService.sourceChainExecutionMap();
  assert.deepEqual(
    [...sources.keys()].sort((a, b) => a - b), [0, 2, 3, 6],
    'exactly four Gateway funding sources',
  );
  // Arc is not a product funding card. Gateway may nevertheless report an Arc
  // balance, and the transfer planner treats that EVM source as valid.
  assert.equal(gatewayNetworks.depositSourceForDomain(26), null);
  assert.throws(
    () => gatewaySourceChainService.sourceConfigFor(26),
    (error) => error.message === 'gateway_deposit_source_unsupported',
  );
  for (const domain of [1, 5, 7, 99]) {
    assert.throws(
      () => gatewaySourceChainService.sourceConfigFor(domain),
      (error) => error.message === 'gateway_deposit_source_unsupported',
    );
  }

  const usdcInterface = new ethers.Interface([
    'function approve(address spender,uint256 amount) returns (bool)',
    'function transfer(address to,uint256 amount) returns (bool)',
  ]);
  const gatewayInterface = new ethers.Interface(['function deposit(address token,uint256 value)']);
  const from = ethers.getAddress(`0x${'33'.repeat(20)}`);
  const amountRaw = '2000000';

  for (const [domain, source] of sources) {
    const expected = EXPECTED.find((entry) => entry.domain === domain);
    assert.equal(source.chainId, expected.chainId);
    assert.equal(source.label, expected.label);
    assert.equal(source.circleBlockchain, expected.circleBlockchain);
    assert.equal(ethers.getAddress(source.usdcAddress), ethers.getAddress(expected.usdc));
    assert.equal(ethers.getAddress(source.gatewayWallet), ethers.getAddress(GATEWAY_WALLET));

    // Approve: to the chain's own USDC, spender GatewayWallet, exact amount.
    const approve = source.buildApprove({ from, amountRaw });
    assert.equal(approve.chainId, expected.chainId, `${expected.label} approve must carry its own chain id`);
    assert.equal(ethers.getAddress(approve.to), ethers.getAddress(expected.usdc));
    assert.equal(approve.value, '0x0');
    assert.equal(
      approve.data,
      usdcInterface.encodeFunctionData('approve', [GATEWAY_WALLET, amountRaw]),
    );

    // Deposit: to GatewayWallet, naming the chain's own USDC. A plain ERC-20
    // transfer would move the funds without ever crediting Gateway, so the
    // calldata must never be a transfer.
    const deposit = source.buildDeposit({ from, amountRaw });
    assert.equal(deposit.chainId, expected.chainId, `${expected.label} deposit must carry its own chain id`);
    assert.equal(ethers.getAddress(deposit.to), ethers.getAddress(GATEWAY_WALLET));
    assert.equal(deposit.value, '0x0');
    assert.equal(
      deposit.data,
      gatewayInterface.encodeFunctionData('deposit', [expected.usdc, amountRaw]),
    );
    const transferSelector = usdcInterface.getFunction('transfer').selector;
    assert.notEqual(deposit.data.slice(0, 10), transferSelector, 'deposit is never a plain transfer');
    assert.notEqual(approve.data.slice(0, 10), transferSelector, 'approve is never a plain transfer');

    // A receipt from another chain cannot satisfy this chain's deposit.
    assert.throws(
      () => source.assertTransaction(
        { from, to: deposit.to, value: 0n, data: deposit.data, chainId: 1n },
        deposit,
      ),
      (error) => error.message === 'gateway_deposit_chain_mismatch',
      `${expected.label} must reject a receipt mined on a different chain`,
    );
    // A provider response without chain identity is not evidence that it came
    // from the configured source network.
    assert.throws(
      () => source.assertTransaction(
        { from, to: deposit.to, value: 0n, data: deposit.data },
        deposit,
      ),
      (error) => error.message === 'gateway_deposit_chain_unavailable',
      `${expected.label} must reject a transaction with no chain identity`,
    );
    // And the matching chain id passes.
    source.assertTransaction(
      { from, to: deposit.to, value: 0n, data: deposit.data, chainId: BigInt(expected.chainId) },
      deposit,
    );
  }

  // Every source produces the identical execution shape, which is what keeps
  // the deposit state machine one state machine rather than four.
  const shapes = [...sources.values()].map((source) => Object.keys(source).sort().join(','));
  assert.equal(new Set(shapes).size, 1, 'all four source configs share one shape');

  console.log('GATEWAY_FOUR_SOURCE_CHAINS=PASS');
  const sourceService = fs.readFileSync(
    path.join(__dirname, '../src/services/gatewaySourceChainService.js'),
    'utf8',
  );
  const readTransactionStart = sourceService.indexOf('async function readTransaction(');
  const readTransactionBody = sourceService.slice(readTransactionStart, sourceService.indexOf('\n}', readTransactionStart));
  assert.match(readTransactionBody, /await assertSourceNetwork\(domain, provider\)/);
  console.log('GATEWAY_SOURCE_CHAIN_RECONCILIATION=PASS');
}

function verifyBurnIntentSetTypeString() {
  // Circle's own evm-gateway-contracts source defines these typehash strings.
  // EXTREMA does not sign a BurnIntentSet (see gatewayService), but the
  // definition it records must match Circle's exactly, or the recorded
  // decision would be based on a shape that does not exist.
  const expectedBurnIntent = 'BurnIntent(uint256 maxBlockHeight,uint256 maxFee,TransferSpec spec)'
    + 'TransferSpec(uint32 version,uint32 sourceDomain,uint32 destinationDomain,bytes32 sourceContract,'
    + 'bytes32 destinationContract,bytes32 sourceToken,bytes32 destinationToken,bytes32 sourceDepositor,'
    + 'bytes32 destinationRecipient,bytes32 sourceSigner,bytes32 destinationCaller,uint256 value,'
    + 'bytes32 salt,bytes hookData)';
  const expectedSet = `BurnIntentSet(BurnIntent[] intents)${expectedBurnIntent}`;

  const encoder = new ethers.TypedDataEncoder(gatewayService.BURN_INTENT_EIP712_TYPES);
  assert.equal(encoder.encodeType('BurnIntent'), expectedBurnIntent);

  const setEncoder = new ethers.TypedDataEncoder(gatewayService.BURN_INTENT_SET_EIP712_TYPES);
  assert.equal(setEncoder.encodeType('BurnIntentSet'), expectedSet);

  // Circle caps one transfer request at 16 intents.
  assert.equal(gatewayService.MAX_BURN_INTENTS, 16);

  console.log('GATEWAY_BURN_INTENT_SET_TYPESTRING=PASS');
}

(() => {
  verifyCanonicalTable();
  verifyDestinations();
  verifySameChainWithdrawal();
  verifyCircleBlockchainIdentifiers();
  verifyFourSourceChains();
  verifyBurnIntentSetTypeString();
  assert.equal(liveNetworkCalls, 0);
  console.log('GATEWAY_NETWORKS_LIVE_NETWORK_CALLS=0');
  console.log('GATEWAY_NETWORKS=PASS');
})();
