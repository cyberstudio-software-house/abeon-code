import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

import { openUrl } from '@tauri-apps/plugin-opener';
import { useStore } from '../../store';
import { makeView } from '../../test-helpers/deploy';
import { DeployBanner } from './DeployBanner';

describe('DeployBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({ trackings: [] });
  });

  it('is visible for a paused tracking of the active project', () => {
    useStore.setState({ trackings: [makeView({ state: 'paused', runUrl: 'https://ci.example/run/1' })] });
    render(<DeployBanner projectId={1} />);
    expect(screen.getByText('Pipeline czeka na Twoją akceptację')).toBeInTheDocument();
  });

  it('opens the pipeline', () => {
    useStore.setState({ trackings: [makeView({ state: 'paused', runUrl: 'https://ci.example/run/1' })] });
    render(<DeployBanner projectId={1} />);
    fireEvent.click(screen.getByRole('button', { name: 'Otwórz pipeline' }));
    expect(openUrl).toHaveBeenCalledWith('https://ci.example/run/1');
  });

  it('has no button when the run url is unknown', () => {
    useStore.setState({ trackings: [makeView({ state: 'paused' })] });
    render(<DeployBanner projectId={1} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('is hidden for a tracking that is not paused', () => {
    useStore.setState({ trackings: [makeView({ state: 'building' })] });
    const { container } = render(<DeployBanner projectId={1} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is hidden for a paused tracking of another project', () => {
    useStore.setState({ trackings: [makeView({ state: 'paused' }, [2])] });
    const { container } = render(<DeployBanner projectId={1} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is hidden without an active project', () => {
    useStore.setState({ trackings: [makeView({ state: 'paused' })] });
    const { container } = render(<DeployBanner projectId={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
