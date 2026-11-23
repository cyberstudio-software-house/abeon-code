import { toast } from 'sonner';
import { openUrl } from '@tauri-apps/plugin-opener';

export async function openPipeline(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch {
    toast.error('Nie udało się otworzyć pipeline’u');
  }
}
