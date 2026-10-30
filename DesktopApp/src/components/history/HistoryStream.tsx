import { useMemo, type ReactNode, type RefObject } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import type { HistoryBlock, Provider } from '../../types';
import { PROVIDER_LABEL } from '../../lib/providers';
import { UserBubble } from './blocks/UserBubble';
import { AssistantBubble } from './blocks/AssistantBubble';
import { ThinkingBlock } from './blocks/ThinkingBlock';
import { ToolUseBlock } from './blocks/ToolUseBlock';
import { ToolResultBlock } from './blocks/ToolResultBlock';
import { AttachmentBlock } from './blocks/AttachmentBlock';
import { SystemBlock } from './blocks/SystemBlock';

type Props = {
  blocks: HistoryBlock[];
  onLoadMore?: () => void;
  hasMore: boolean;
  header?: ReactNode;
  matchedIndices?: Set<number>;
  activeBlockIndex?: number;
  virtuosoRef?: RefObject<VirtuosoHandle | null>;
  provider?: Provider;
};

function render(b: HistoryBlock, providerLabel: string, done: boolean) {
  switch (b.kind) {
    case 'userText':          return <UserBubble text={b.text} timestamp={b.timestamp} />;
    case 'assistantText':     return <AssistantBubble text={b.text} timestamp={b.timestamp} providerLabel={providerLabel} />;
    case 'assistantThinking': return <ThinkingBlock text={b.text} />;
    case 'toolUse':           return <ToolUseBlock name={b.name} inputSummary={b.input_summary} rawInput={b.raw_input} done={done} />;
    case 'toolResult':        return <ToolResultBlock content={b.content} isError={b.is_error} />;
    case 'attachment':        return <AttachmentBlock kind={b.attachmentKind} name={b.name} />;
    case 'system':            return <SystemBlock subtype={b.subtype} message={b.message} />;
  }
}

export function HistoryStream({
  blocks, onLoadMore, hasMore, header, matchedIndices, activeBlockIndex = -1, virtuosoRef, provider = 'claude',
}: Props) {
  const providerLabel = PROVIDER_LABEL[provider];
  const components = useMemo(() => ({
    Header: () => <div className="pt-6">{header}</div>,
    Footer: () => <div className="h-7" />,
  }), [header]);
  return (
    <Virtuoso
      ref={virtuosoRef}
      data={blocks}
      initialTopMostItemIndex={blocks.length > 0 ? blocks.length - 1 : 0}
      itemContent={(index, b) => {
        const isActive = index === activeBlockIndex;
        const isMatch = matchedIndices?.has(index) ?? false;
        const highlight = isActive
          ? 'ring-2 ring-accent rounded-md'
          : isMatch
            ? 'bg-accent/10 rounded-md'
            : '';
        return (
          <div className="px-7">
            <div className={`mx-auto max-w-[780px] ${highlight}`}>
              {render(b, providerLabel, index < blocks.length - 1)}
            </div>
          </div>
        );
      }}
      startReached={() => { if (hasMore && onLoadMore) onLoadMore(); }}
      followOutput="auto"
      className="flex-1"
      components={components}
    />
  );
}
