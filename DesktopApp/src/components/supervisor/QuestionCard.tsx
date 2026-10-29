import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { tauri } from '../../lib/tauri';
import { formatTauriError } from '../../lib/errors';
import type { MenuQuestion, QuestionCardView } from '../../types';

const formatCountdown = (remainingMs: number) => {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
};

const reportFailure = (message: string) => (error: unknown) => {
  toast.error(`${message}: ${formatTauriError(error)}`);
};

const buttonClass = 'px-2.5 py-1 border border-border text-[12px] text-fg-secondary hover:text-fg rounded-md disabled:opacity-50 disabled:pointer-events-none';
const primaryButtonClass = 'px-2.5 py-1 bg-accent text-white text-[12px] rounded-md disabled:opacity-50 disabled:pointer-events-none';
const optionClass = (selected: boolean) =>
  `px-2.5 py-1 border rounded-md text-[12px] ${selected ? 'border-accent bg-accent/15 text-fg' : 'border-border text-fg-secondary hover:text-fg'}`;

function Footer({ card }: { card: QuestionCardView }) {
  const [now, setNow] = useState(() => Date.now());
  const counting = card.phase === 'grace' && card.deadlineMs !== null;

  useEffect(() => {
    if (!counting) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [counting]);

  if (card.phase === 'paused') return <span>Wstrzymane — pracujesz w tej sesji</span>;
  if (card.phase === 'withSupervisor') return <span>Agent analizuje pytanie…</span>;
  if (card.deadlineMs === null) return <span />;
  return <span className="tabular-nums">Agent odpowie za {formatCountdown(card.deadlineMs - now)}</span>;
}

function QuestionBlock({
  question,
  selected,
  freeText,
  onSelect,
  onFreeText,
}: {
  question: MenuQuestion;
  selected: string[];
  freeText: string;
  onSelect: (option: string) => void;
  onFreeText: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      {question.header && <div className="text-[10.5px] uppercase tracking-wide text-muted">{question.header}</div>}
      <div className="text-[13px] text-fg">{question.question}</div>
      <div className="flex flex-wrap gap-1.5">
        {question.options.map(option =>
          question.multiSelect ? (
            <label key={option} className={`${optionClass(selected.includes(option))} flex items-center gap-1.5 cursor-pointer`}>
              <input
                type="checkbox"
                checked={selected.includes(option)}
                onChange={() => onSelect(option)}
                aria-label={option}
              />
              <span>{option}</span>
            </label>
          ) : (
            <button
              key={option}
              type="button"
              aria-pressed={selected.includes(option)}
              onClick={() => onSelect(option)}
              className={optionClass(selected.includes(option))}
            >
              {option}
            </button>
          ),
        )}
      </div>
      <input
        type="text"
        value={freeText}
        onChange={e => onFreeText(e.target.value)}
        placeholder="Inna odpowiedź"
        className="w-full bg-bg-elev-2 border border-border rounded-md px-2 py-1 text-[12px] text-fg placeholder:text-muted"
      />
    </div>
  );
}

export function QuestionCard({ card, visible = true, onDone }: {
  card: QuestionCardView;
  visible?: boolean;
  onDone?: () => void;
}) {
  const [selections, setSelections] = useState<Record<number, string[]>>({});
  const [freeTexts, setFreeTexts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);

  const select = (index: number, question: MenuQuestion, option: string) => {
    setSelections(prev => {
      const current = prev[index] ?? [];
      if (!question.multiSelect) return { ...prev, [index]: [option] };
      const next = current.includes(option) ? current.filter(o => o !== option) : [...current, option];
      return { ...prev, [index]: next };
    });
  };

  const answerFor = (index: number, question: MenuQuestion): string => {
    const free = (freeTexts[index] ?? '').trim();
    if (free) return free;
    const chosen = selections[index] ?? [];
    return question.options.filter(o => chosen.includes(o)).join(', ');
  };

  const complete = card.questions.every((q, i) => answerFor(i, q) !== '');

  const send = () => {
    const answers: Record<string, string> = {};
    card.questions.forEach((q, i) => {
      answers[q.question] = answerFor(i, q);
    });
    setBusy(true);
    void tauri
      .supervisorAnswerCard(card.questionId, answers)
      .then(() => onDone?.())
      .catch(reportFailure('Nie udało się wysłać odpowiedzi'))
      .finally(() => setBusy(false));
  };

  const release = () => {
    setBusy(true);
    void tauri
      .supervisorReleaseCard(card.questionId)
      .then(() => onDone?.())
      .catch(reportFailure('Nie udało się oddać pytania użytkownikowi'))
      .finally(() => setBusy(false));
  };

  return (
    <div
      role="group"
      aria-label="Pytanie agenta"
      className={`absolute top-0 inset-x-0 z-20 max-h-[60%] overflow-y-auto border-b border-border bg-bg shadow-lg p-3 space-y-3 ${visible ? '' : 'invisible pointer-events-none'}`}
    >
      {card.questions.map((question, index) => (
        <QuestionBlock
          key={index}
          question={question}
          selected={selections[index] ?? []}
          freeText={freeTexts[index] ?? ''}
          onSelect={option => select(index, question, option)}
          onFreeText={value => setFreeTexts(prev => ({ ...prev, [index]: value }))}
        />
      ))}
      <div className="flex items-center justify-between gap-3 text-[12px] text-muted">
        <Footer card={card} />
        <div className="flex items-center gap-2">
          <button type="button" onClick={release} disabled={busy} className={buttonClass}>
            Odpowiem w terminalu
          </button>
          <button type="button" onClick={send} disabled={busy || !complete} className={primaryButtonClass}>
            Wyślij
          </button>
        </div>
      </div>
    </div>
  );
}
