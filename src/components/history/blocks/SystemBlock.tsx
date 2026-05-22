export function SystemBlock({ subtype, message }: { subtype: string; message: string }) {
  return (
    <div className="my-1 ml-14 text-[10px] text-muted opacity-70">
      {subtype} · {message}
    </div>
  );
}
