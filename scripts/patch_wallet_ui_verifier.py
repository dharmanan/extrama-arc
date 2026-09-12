from pathlib import Path

path = Path('backend/scripts/verify-gateway-deposit.js')
text = path.read_text()

old = r'''  assert.match(
    fundingMarkup,
    /onChange=\{\(event\) => setGatewayDestinationDomain\(event\.target\.value\)\}/,
  );'''
new = r'''  assert.match(fundingMarkup, /onChange=\{\(event\) => \{/);
  assert.match(fundingMarkup, /setGatewayDestinationDomain\(event\.target\.value\);/);
  assert.match(fundingMarkup, /event\.currentTarget\.blur\(\);/);'''
if old not in text:
    raise SystemExit('destination selector assertion anchor missing')
text = text.replace(old, new, 1)

old = r'''  assert.match(
    depositMarkup,
    /disabled=\{depositBusy \|\| Boolean\(depositRecovery\)\}/,
    'the amount field stays disabled while a durable recovery exists',
  );'''
new = r'''  const amountValueIndex = depositMarkup.indexOf('value={depositAmount}');
  const amountInputEnd = depositMarkup.indexOf('/>', amountValueIndex);
  assert.ok(amountValueIndex > -1 && amountInputEnd > amountValueIndex, 'the funding amount input must exist');
  const amountInputMarkup = depositMarkup.slice(amountValueIndex, amountInputEnd);
  assert.ok(
    amountInputMarkup.includes('Boolean(depositRecovery)'),
    'the amount field stays disabled while a durable recovery exists',
  );'''
if old not in text:
    raise SystemExit('amount recovery assertion anchor missing')
text = text.replace(old, new, 1)

old = '''  const onClickIndex = depositMarkup.indexOf('onClick={() => void handleGatewaySourceDeposit(source.domain)}');
  assert.ok(onClickIndex > -1, 'the deposit button must call handleGatewaySourceDeposit for its own card');'''
new = '''  const onClickIndex = depositMarkup.indexOf('onClick={() => void handleGatewaySourceDeposit(selectedSource.domain)}');
  assert.ok(onClickIndex > -1, 'the deposit button must call handleGatewaySourceDeposit for the selected source');'''
if old not in text:
    raise SystemExit('deposit button assertion anchor missing')
text = text.replace(old, new, 1)

path.write_text(text)
