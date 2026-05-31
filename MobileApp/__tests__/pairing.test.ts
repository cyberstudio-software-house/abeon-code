jest.mock('@/src/lib/api', () => ({ claimPairing: jest.fn(async () => ({ phoneToken: 'pt_1', deviceId: 'dev_1' })) }));
import { claimScannedCode } from '@/src/lib/pairing';
import { claimPairing } from '@/src/lib/api';

beforeEach(() => jest.clearAllMocks());

test('extracts the code from an abeoncloud:// QR payload and claims it', async () => {
  const onPaired = jest.fn();
  const claimed = await claimScannedCode('abeoncloud://pair?code=4C85Z7VK', onPaired);
  expect(claimed).toBe(true);
  expect(claimPairing).toHaveBeenCalledWith('4C85Z7VK');
  expect(onPaired).toHaveBeenCalledWith({ phoneToken: 'pt_1', deviceId: 'dev_1' });
});

test('accepts a bare code payload too (the desktop QR encodes the bare code)', async () => {
  const onPaired = jest.fn();
  await claimScannedCode('NSGENABU', onPaired);
  expect(claimPairing).toHaveBeenCalledWith('NSGENABU');
});

test('rejects a wrong-length / dashed payload', async () => {
  const onPaired = jest.fn();
  const claimed = await claimScannedCode('ABCD-1234', onPaired);
  expect(claimed).toBe(false);
  expect(claimPairing).not.toHaveBeenCalled();
});

test('ignores an unrelated QR payload', async () => {
  const onPaired = jest.fn();
  const claimed = await claimScannedCode('https://example.com', onPaired);
  expect(claimed).toBe(false);
  expect(claimPairing).not.toHaveBeenCalled();
  expect(onPaired).not.toHaveBeenCalled();
});
