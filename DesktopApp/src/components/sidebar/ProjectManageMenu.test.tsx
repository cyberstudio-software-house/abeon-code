import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProjectManageMenu } from './ProjectManageMenu';

describe('ProjectManageMenu', () => {
  it('renders edit and delete items', () => {
    render(<ProjectManageMenu onEdit={() => {}} onDelete={() => {}} onClose={() => {}} />);
    expect(screen.getByText('Edytuj')).toBeInTheDocument();
    expect(screen.getByText('Usuń')).toBeInTheDocument();
  });

  it('fires onEdit then onClose when Edytuj is clicked', () => {
    const onEdit = vi.fn(); const onClose = vi.fn();
    render(<ProjectManageMenu onEdit={onEdit} onDelete={() => {}} onClose={onClose} />);
    fireEvent.click(screen.getByText('Edytuj'));
    expect(onEdit).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('fires onDelete then onClose when Usuń is clicked', () => {
    const onDelete = vi.fn(); const onClose = vi.fn();
    render(<ProjectManageMenu onEdit={() => {}} onDelete={onDelete} onClose={onClose} />);
    fireEvent.click(screen.getByText('Usuń'));
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
