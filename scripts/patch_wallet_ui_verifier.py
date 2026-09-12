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
path.write_text(text)
