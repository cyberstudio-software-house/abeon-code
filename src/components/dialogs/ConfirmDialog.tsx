type Props = { title: string; message: string; onConfirm: () => void; onCancel: () => void };
export function ConfirmDialog({ title, message, onConfirm, onCancel }: Props) {
  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50">
      <div className="bg-bg-elev border border-border p-5 w-[400px]">
        <h2 className="text-[14px] font-semibold mb-2">{title}</h2>
        <p className="text-[13px] text-fg-secondary mb-4">{message}</p>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 border border-border text-[12px] text-fg-secondary hover:text-fg">Anuluj</button>
          <button onClick={onConfirm} className="px-3 py-1.5 bg-danger text-white text-[12px]">Zamknij</button>
        </div>
      </div>
    </div>
  );
}
