import { type ReactNode, type RefObject } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import type { HistoryBlock } from '../../types';
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
};

function render(b: HistoryBlock) {
  switch (b.kind) {
    case 'userText':          return <UserBubble text={b.text} />;
    case 'assistantText':     return <AssistantBubble text={b.text} />;
    case 'assistantThinking': return <ThinkingBlock text={b.text} />;
    case 'toolUse':           return <ToolUseBlock name={b.name} inputSummary={b.input_summary} rawInput={b.raw_input} />;
    case 'toolResult':        return <ToolResultBlock content={b.content} isError={b.is_error} />;
    case 'attachment':        return <AttachmentBlock kind={b.attachmentKind} name={b.name} />;
    case 'system':            return <SystemBlock subtype={b.subtype} message={b.message} />;
  }
}

export function HistoryStream({
  blocks, onLoadMore, hasMore, header, matchedIndices, activeBlockIndex = -1, virtuosoRef,
}: Props) {
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
        return <div className={`px-8 ${highlight}`}>{render(b)}</div>;
      }}
      startReached={() => { if (hasMore && onLoadMore) onLoadMore(); }}
      followOutput="auto"
      className="flex-1"
      components={header ? { Header: () => <>{header}</> } : undefined}
    />
  );
}
