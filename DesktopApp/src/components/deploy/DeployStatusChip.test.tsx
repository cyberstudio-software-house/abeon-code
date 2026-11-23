import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

import { useStore } from '../../store';
import { makeView } from '../../test-helpers/deploy';
import { DeployStatusChip } from './DeployStatusChip';

describe('DeployStatusChip', () => {
  beforeEach(() => {
    useStore.setState({ trackings: [], tabs: [] });
  });

  it('renders nothing without a tracking of the project', () => {
    useStore.setState({ trackings: [makeView({}, [2])] });
    const { container } = render(<DeployStatusChip projectId={1} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps the label in the title in the compact variant', () => {
    useStore.setState({ trackings: [makeView({ state: 'building' })] });
    render(<DeployStatusChip projectId={1} />);
    const chip = screen.getByRole('button', { name: /Budowanie/ });
    expect(chip).toHaveAttribute('title', 'api: Budowanie');
    expect(chip).not.toHaveTextContent('Budowanie');
  });

  it('shows the label in full when asked', () => {
    useStore.setState({ trackings: [makeView({ state: 'building' })] });
    render(<DeployStatusChip projectId={1} showLabel />);
    expect(screen.getByRole('button')).toHaveTextContent('Budowanie');
  });

  it('shows +1 with two trackings', () => {
    useStore.setState({
      trackings: [
        makeView({ id: 1, repoPath: '/a', state: 'building' }),
        makeView({ id: 2, repoPath: '/b', state: 'succeeded' }),
      ],
    });
    render(<DeployStatusChip projectId={1} />);
    expect(screen.getByRole('button')).toHaveTextContent('+1');
  });

  it('shows no +N with one tracking', () => {
    useStore.setState({ trackings: [makeView({ state: 'building' })] });
    render(<DeployStatusChip projectId={1} />);
    expect(screen.getByRole('button')).not.toHaveTextContent('+');
  });

  it('draws a paused tracking as a filled accent pill', () => {
    useStore.setState({ trackings: [makeView({ state: 'paused' })] });
    render(<DeployStatusChip projectId={1} showLabel />);
    const chip = screen.getByRole('button');
    expect(chip).toHaveClass('bg-accent');
    expect(chip).toHaveClass('text-accent-fg');
    expect(chip).toHaveTextContent('Pipeline czeka na Ciebie');
  });

  it('opens the details dialog on click', () => {
    useStore.setState({ trackings: [makeView({ state: 'building' })] });
    render(<DeployStatusChip projectId={1} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes the dialog when the last tracking disappears', () => {
    useStore.setState({ trackings: [makeView({ state: 'failed' })] });
    render(<DeployStatusChip projectId={1} />);
    fireEvent.click(screen.getByRole('button'));
    act(() => { useStore.setState({ trackings: [] }); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
