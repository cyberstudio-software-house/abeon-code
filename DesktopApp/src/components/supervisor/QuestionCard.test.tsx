import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { QuestionCard } from './QuestionCard';
import { tauri } from '../../lib/tauri';
import { toast } from 'sonner';
import type { QuestionCardView } from '../../types';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const singleQuestion = {
  question: 'Which color do you prefer?',
  header: 'Color',
  options: ['Red', 'Green', 'Blue'],
  multiSelect: false,
};

const multiQuestion = {
  question: 'Which fruits?',
  header: null,
  options: ['Apple', 'Banana', 'Cherry'],
  multiSelect: true,
};

const card = (over: Partial<QuestionCardView> = {}): QuestionCardView => ({
  questionId: 'q1',
  sessionId: 's1',
  questions: [singleQuestion],
  phase: 'grace',
  deadlineMs: null,
  ...over,
});

describe('QuestionCard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(toast.error).mockClear();
    vi.spyOn(tauri, 'supervisorAnswerCard').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'supervisorReleaseCard').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends the picked option keyed by the question text', () => {
    render(<QuestionCard card={card()} />);
    expect(screen.getByRole('button', { name: 'Wyślij' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Green' }));
    fireEvent.click(screen.getByRole('button', { name: 'Wyślij' }));
    expect(tauri.supervisorAnswerCard).toHaveBeenCalledWith('q1', { 'Which color do you prefer?': 'Green' });
  });

  it('shows the header and the question', () => {
    render(<QuestionCard card={card()} />);
    expect(screen.getByText('Color')).toBeInTheDocument();
    expect(screen.getByText('Which color do you prefer?')).toBeInTheDocument();
  });

  it('counts down to the deadline in the grace phase', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    render(<QuestionCard card={card({ deadlineMs: 1_000_000 + 42_000 })} />);
    expect(screen.getByText('Agent odpowie za 0:42')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByText('Agent odpowie za 0:40')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText('Agent odpowie za 0:00')).toBeInTheDocument();
  });

  it('formats minutes in the countdown', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    render(<QuestionCard card={card({ deadlineMs: 1_000_000 + 65_000 })} />);
    expect(screen.getByText('Agent odpowie za 1:05')).toBeInTheDocument();
  });

  it('shows the pinned text when paused', () => {
    render(<QuestionCard card={card({ phase: 'paused' })} />);
    expect(screen.getByText('Wstrzymane — pracujesz w tej sesji')).toBeInTheDocument();
  });

  it('shows that the agent is analysing', () => {
    render(<QuestionCard card={card({ phase: 'withSupervisor' })} />);
    expect(screen.getByText('Agent analizuje pytanie…')).toBeInTheDocument();
  });

  it('joins multi-select labels in option order', () => {
    render(<QuestionCard card={card({ questions: [multiQuestion] })} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Cherry' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Apple' }));
    fireEvent.click(screen.getByRole('button', { name: 'Wyślij' }));
    expect(tauri.supervisorAnswerCard).toHaveBeenCalledWith('q1', { 'Which fruits?': 'Apple, Cherry' });
  });

  it('prefers free text over the selection', () => {
    render(<QuestionCard card={card()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Green' }));
    fireEvent.change(screen.getByPlaceholderText('Inna odpowiedź'), { target: { value: 'Purple' } });
    fireEvent.click(screen.getByRole('button', { name: 'Wyślij' }));
    expect(tauri.supervisorAnswerCard).toHaveBeenCalledWith('q1', { 'Which color do you prefer?': 'Purple' });
  });

  it('requires every question to be answered', () => {
    render(<QuestionCard card={card({ questions: [singleQuestion, multiQuestion] })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Red' }));
    expect(screen.getByRole('button', { name: 'Wyślij' })).toBeDisabled();
    fireEvent.change(screen.getAllByPlaceholderText('Inna odpowiedź')[1], { target: { value: 'None' } });
    expect(screen.getByRole('button', { name: 'Wyślij' })).toBeEnabled();
  });

  it('releases the menu to the terminal', () => {
    render(<QuestionCard card={card()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Odpowiem w terminalu' }));
    expect(tauri.supervisorReleaseCard).toHaveBeenCalledWith('q1');
  });

  it('disables both buttons while a request is in flight', () => {
    vi.spyOn(tauri, 'supervisorReleaseCard').mockReturnValue(new Promise(() => {}));
    render(<QuestionCard card={card()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Green' }));
    fireEvent.click(screen.getByRole('button', { name: 'Odpowiem w terminalu' }));
    expect(screen.getByRole('button', { name: 'Odpowiem w terminalu' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Wyślij' })).toBeDisabled();
  });

  it('reports a failed send with a toast and re-enables the buttons', async () => {
    vi.spyOn(tauri, 'supervisorAnswerCard').mockRejectedValue('boom');
    render(<QuestionCard card={card()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Green' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Wyślij' }));
    });
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Nie udało się wysłać odpowiedzi'));
    expect(screen.getByRole('button', { name: 'Wyślij' })).toBeEnabled();
  });

  it('hands the keyboard back after a successful send or release', async () => {
    const onDone = vi.fn();
    const { unmount } = render(<QuestionCard card={card()} onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: 'Green' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Wyślij' }));
    });
    expect(onDone).toHaveBeenCalledTimes(1);
    unmount();
    render(<QuestionCard card={card()} onDone={onDone} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Odpowiem w terminalu' }));
    });
    expect(onDone).toHaveBeenCalledTimes(2);
  });

  it('keeps the keyboard on the card when the request fails', async () => {
    vi.spyOn(tauri, 'supervisorReleaseCard').mockRejectedValue('boom');
    const onDone = vi.fn();
    render(<QuestionCard card={card()} onDone={onDone} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Odpowiem w terminalu' }));
    });
    expect(onDone).not.toHaveBeenCalled();
  });

  it('does not take keyboard focus on mount', () => {
    render(<QuestionCard card={card()} />);
    expect(document.body).toHaveFocus();
  });
});
