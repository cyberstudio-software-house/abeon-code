import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Segmented, SettingsRow, SettingsSection, Stepper, Switch } from './controls';

describe('Segmented', () => {
  const options = [
    { value: 'a', label: 'Alfa' },
    { value: 'b', label: 'Beta' },
  ];

  it('marks only the active option as pressed and reports a change', () => {
    const onChange = vi.fn();
    render(
      <>
        <span id="seg-label">Wybór</span>
        <Segmented value="a" options={options} onChange={onChange} labelledBy="seg-label" />
      </>,
    );
    expect(screen.getByRole('group', { name: 'Wybór' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Alfa' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Beta' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Beta' }));

    expect(onChange).toHaveBeenCalledWith('b');
  });
});

describe('Switch', () => {
  it('exposes role switch with aria-checked and toggles', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <>
        <span id="sw-label">Włącz</span>
        <Switch checked={false} onChange={onChange} labelledBy="sw-label" />
      </>,
    );
    const control = screen.getByRole('switch', { name: 'Włącz' });
    expect(control).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(true);

    rerender(
      <>
        <span id="sw-label">Włącz</span>
        <Switch checked onChange={onChange} labelledBy="sw-label" />
      </>,
    );
    expect(screen.getByRole('switch', { name: 'Włącz' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('switch', { name: 'Włącz' }));
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('ignores clicks while disabled', () => {
    const onChange = vi.fn();
    render(
      <>
        <span id="sw-label">Włącz</span>
        <Switch checked onChange={onChange} labelledBy="sw-label" disabled />
      </>,
    );
    const control = screen.getByRole('switch', { name: 'Włącz' });
    expect(control).toBeDisabled();
    fireEvent.click(control);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Stepper', () => {
  const renderStepper = (value: number, onChange = vi.fn()) => {
    render(
      <>
        <span id="st-label">Rozmiar</span>
        <Stepper
          value={value}
          min={10}
          max={12}
          unit="px"
          onChange={onChange}
          labelledBy="st-label"
          decreaseLabel="Zmniejsz"
          increaseLabel="Zwiększ"
        />
      </>,
    );
    return onChange;
  };

  it('steps by one inside the range', () => {
    const onChange = renderStepper(11);
    expect(screen.getByText('11 px')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Zwiększ' }));
    expect(onChange).toHaveBeenLastCalledWith(12);
    fireEvent.click(screen.getByRole('button', { name: 'Zmniejsz' }));
    expect(onChange).toHaveBeenLastCalledWith(10);
  });

  it('disables the decrease button at the minimum and never goes below it', () => {
    const onChange = renderStepper(10);
    const decrease = screen.getByRole('button', { name: 'Zmniejsz' });
    expect(decrease).toBeDisabled();
    fireEvent.click(decrease);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Zwiększ' })).toBeEnabled();
  });

  it('disables the increase button at the maximum and never goes above it', () => {
    const onChange = renderStepper(12);
    const increase = screen.getByRole('button', { name: 'Zwiększ' });
    expect(increase).toBeDisabled();
    fireEvent.click(increase);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Zmniejsz' })).toBeEnabled();
  });

  it('clamps an out-of-range value to the bound on the next step', () => {
    const onChange = renderStepper(20);
    expect(screen.getByRole('button', { name: 'Zwiększ' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Zmniejsz' }));
    expect(onChange).toHaveBeenCalledWith(12);
  });
});

describe('SettingsRow and SettingsSection', () => {
  it('marks the label and the description for search', () => {
    const { container } = render(
      <SettingsRow label="Etykieta" description="Opis wiersza">
        <span>x</span>
      </SettingsRow>,
    );
    expect(container.querySelector('[data-settings-row-label]')).toHaveTextContent('Etykieta');
    expect(container.querySelector('[data-settings-row-description]')).toHaveTextContent('Opis wiersza');
  });

  it('omits the description marker when there is no description', () => {
    const { container } = render(
      <SettingsRow label="Etykieta"><span>x</span></SettingsRow>,
    );
    expect(container.querySelector('[data-settings-row-description]')).toBeNull();
  });

  it('renders a section description and header action', () => {
    render(
      <SettingsSection label="Sekcja" description="Opis sekcji" action={<button type="button">Akcja</button>}>
        <div>treść</div>
      </SettingsSection>,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Sekcja' })).toBeInTheDocument();
    expect(screen.getByText('Opis sekcji')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Akcja' })).toBeInTheDocument();
  });
});
