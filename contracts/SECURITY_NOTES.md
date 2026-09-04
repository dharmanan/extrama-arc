# EXTREMA Contract Security Notes

Status: pre-deployment review notes.

## Reentrancy

ExtremaPool and ExtremaTreasury set their reentrancy state to entered before any external token/NFT interaction and restore it only after the interaction succeeds.

Pool fund-changing paths also update accounting before external transfer/mint calls. Any external call revert reverts the full transaction and restores prior state.

Foundry may still emit heuristic reentrancy-no-eth warnings for these calls because it does not prove the custom guard across every control-flow path. These warnings must not be treated as ignored: the guard behavior is covered by tests and must remain intact.

## Timestamp usage

Round entry and observation windows intentionally use block.timestamp.

This is product logic, not an accidental timestamp dependency. Deployment/round configuration must use sufficiently large timing buffers so small validator/sequencer timestamp latitude cannot materially alter the economic outcome.

## ERC-721 economic-right model

Each pool has a separate ticket collection. The current NFT owner controls claim/refund rights.

Required behaviors covered by tests include:

- only the paired pool can mint
- unauthorized transfers revert
- approved address transfers work
- operator transfers work
- token approval clears on transfer
- safe transfers reject invalid ERC-721 receivers
- renderer changes require renderer-admin authority
- transfer of a winning/refundable NFT transfers the economic right

## Treasury isolation

Treasury controllers can withdraw only funds already transferred to ExtremaTreasury.

They have no authority to withdraw reserved player escrow from any ExtremaPool.

## Deployment gate

Before Arc Testnet deployment:

1. forge build
2. forge test -vv
3. forge build --sizes
4. review all production-source warnings
5. deploy only after all tests remain green and contract sizes are deployable
