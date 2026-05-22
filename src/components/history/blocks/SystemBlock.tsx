export function SystemBlock({ subtype, message }: { subtype: string; message: string }) {
  return (
    <div className="my-1 text-[10px] text-muted text-center opacity-70">
      ⚙ {subtype} · {message}
    </div>
  );
}
