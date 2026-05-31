import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { tauri, type PairCode } from '../../lib/tauri';

// Tauri command errors reject with the serialized `AppError` shape `{ code, message }`
// (see src-tauri/src/error.rs). `String(e)` on that object yields "[object Object]",
// so read `code`/`message` and turn the common failures into actionable Polish hints.
function errorText(e: unknown): string {
  const obj = e && typeof e === 'object' ? (e as { code?: unknown; message?: unknown }) : null;
  const code = obj && typeof obj.code === 'string' ? obj.code : '';
  const message = obj && typeof obj.message === 'string' ? obj.message : typeof e === 'string' ? e : '';

  if (code === 'invalid_input' && message.includes('cloudServiceUrl')) {
    return 'Najpierw ustaw adres CloudService w Ustawieniach (sekcja AbeonCloud), potem spróbuj ponownie.';
  }
  if (code === 'other') {
    return `Nie udało się połączyć z CloudService: ${message}. Sprawdź, czy usługa działa pod skonfigurowanym adresem.`;
  }
  return message || 'Nie udało się wygenerować kodu parowania.';
}

export function PairingDialog({ onClose }: { onClose: () => void }) {
  const [pair, setPair] = useState<PairCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function start() {
    setLoading(true);
    setError(null);
    try {
      setPair(await tauri.remotePairStart());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-bg-elev border border-border rounded p-6 w-[360px] flex flex-col items-center gap-4">
        <h2 className="text-[14px] font-semibold">Sparuj telefon</h2>
        {!pair && (
          <button
            onClick={start}
            disabled={loading}
            className="px-4 py-2 bg-fg text-bg text-[12px] font-medium disabled:opacity-50"
          >
            {loading ? 'Generowanie…' : 'Wygeneruj kod parowania'}
          </button>
        )}
        {pair && (
          <>
            <QRCodeSVG value={pair.code} size={180} />
            <div className="text-2xl font-mono tracking-widest">{pair.code}</div>
            <p className="text-[11px] text-muted text-center">
              Zeskanuj kod w aplikacji mobilnej. Kod wygasa za {Math.round(pair.expiresInSecs / 60)} min.
            </p>
          </>
        )}
        {error && <p className="text-[11px] text-red-500">{error}</p>}
        <button onClick={onClose} className="text-[12px] text-muted hover:text-fg transition-colors">
          Zamknij
        </button>
      </div>
    </div>
  );
}
