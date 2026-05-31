jest.mock('@/src/lib/api', () => ({ claimPairing: jest.fn(async () => ({ phoneToken: 'pt_1', deviceId: 'dev_1' })) }));
import { claimScannedCode } from '@/src/lib/pairing';
import { claimPairing } from '@/src/lib/api';

beforeEach(() => jest.clearAllMocks());

test('extracts the code from an abeoncloud:// QR payload and claims it', async () => {
  const onPaired = jest.fn();
  const claimed = await claimScannedCode('abeoncloud://pair?code=ABCD-1234', onPaired);
  expect(claimed).toBe(true);
  expect(claimPairing).toHaveBeenCalledWith('ABCD-1234');
  expect(onPaired).toHaveBeenCalledWith({ phoneToken: 'pt_1', deviceId: 'dev_1' });
});

test('accepts a bare code payload too', async () => {
  const onPaired = jest.fn();
  await claimScannedCode('WXYZ-9999', onPaired);
  expect(claimPairing).toHaveBeenCalledWith('WXYZ-9999');
});

test('ignores an unrelated QR payload', async () => {
  const onPaired = jest.fn();
  const claimed = await claimScannedCode('https://example.com', onPaired);
  expect(claimed).toBe(false);
  expect(claimPairing).not.toHaveBeenCalled();
  expect(onPaired).not.toHaveBeenCalled();
});
