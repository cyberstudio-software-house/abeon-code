import type { RemoteCommand } from '@/src/types/RemoteCommand';
import type { RemoteEnvelope } from '@/src/types/RemoteEnvelope';

// Injectable id generator keeps this pure/testable; production passes a uuid.
export function buildEnvelope(command: RemoteCommand, genId: () => string): RemoteEnvelope {
  return { commandId: genId(), command };
}
