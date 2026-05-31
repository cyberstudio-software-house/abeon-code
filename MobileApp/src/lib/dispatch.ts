import { buildEnvelope } from '@/src/lib/commands';
import { sendCommand } from '@/src/lib/api';
import type { RemoteCommand } from '@/src/types/RemoteCommand';

function genId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `cmd-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

export async function dispatchCommand(phoneToken: string, command: RemoteCommand): Promise<void> {
  await sendCommand(phoneToken, buildEnvelope(command, genId));
}
