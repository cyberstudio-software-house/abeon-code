import { render, fireEvent } from '@testing-library/react';
import { PermissionPrompt } from '@/src/components/PermissionPrompt';

describe('PermissionPrompt', () => {
  it('renders the tool label and fires all three callbacks', () => {
    const onApprove = jest.fn();
    const onApproveAlways = jest.fn();
    const onDeny = jest.fn();
    const { getByText } = render(
      <PermissionPrompt
        toolLabel="Bash · rm -rf /tmp/x"
        onApprove={onApprove}
        onApproveAlways={onApproveAlways}
        onDeny={onDeny}
      />,
    );
    getByText('Claude chce użyć: Bash · rm -rf /tmp/x');
    fireEvent.click(getByText('Zatwierdź'));
    fireEvent.click(getByText('Zatwierdź i nie pytaj'));
    fireEvent.click(getByText('Odrzuć'));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApproveAlways).toHaveBeenCalledTimes(1);
    expect(onDeny).toHaveBeenCalledTimes(1);
  });
});
