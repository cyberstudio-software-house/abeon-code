import type { ReactNode } from 'react';
import { Virtuoso } from 'react-virtuoso';
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

export function HistoryStream({ blocks, onLoadMore, hasMore, header }: Props) {
  return (
    <Virtuoso
      data={blocks}
      initialTopMostItemIndex={blocks.length > 0 ? blocks.length - 1 : 0}
      itemContent={(_, b) => <div className="px-7">{render(b)}</div>}
      startReached={() => { if (hasMore && onLoadMore) onLoadMore(); }}
      followOutput="auto"
      className="flex-1"
      components={header ? { Header: () => <>{header}</> } : undefined}
    />
  );
}
