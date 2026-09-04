/** Assistant reasoning disclosure, independent of Tool-call presentation. */
import { useEffect, useRef, useState } from 'react'
import { DisclosureRow, IconThinkOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { useThrottledVisualUpdate } from './use-throttled-visual-update.ts'
import a11yCss from './accessibility.module.css'
import css from './ReasoningRow.module.css'

const REASONING_CONTROL_TAGS = [
  '<think>', '</think>', '<thinking>', '</thinking>', '<analysis>', '</analysis>',
] as const

/** Remove provider control delimiters without changing the durable reasoning block. */
function visibleReasoning(text: string): string {
  let visible = text.replace(/<\/?(?:think|thinking|analysis)>/gi, '')
  const suffixStart = visible.lastIndexOf('<')
  if (suffixStart < 0) return visible
  const suffix = visible.slice(suffixStart).toLowerCase()
  return REASONING_CONTROL_TAGS.some(tag => tag.startsWith(suffix))
    ? visible.slice(0, suffixStart)
    : visible
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

function latestLine(text: string): string {
  const visible = text.trimEnd()
  const newline = visible.lastIndexOf('\n')
  return newline === -1 ? visible : visible.slice(newline + 1)
}

/**
 * Render one assistant reasoning block as the Think disclosure row.
 * @param props.text - complete or streaming reasoning text.
 * @param props.running - whether this block is the streaming tail.
 * @param props.t - conversation locale seat for the running status.
 * @returns the reasoning disclosure.
 */
export function ReasoningRow({ text, running, t }: { text: string; running: boolean; t: ChatViewSlotProps['t'] }) {
  const [expanded, setExpanded] = useState(false)
  const summaryRef = useRef<HTMLSpanElement>(null)
  const visibleText = visibleReasoning(text)
  const summary = running ? latestLine(visibleText) : firstLine(visibleText)
  const scheduleSummaryScroll = useThrottledVisualUpdate(() => {
    const element = summaryRef.current
    if (element === null) return
    element.scrollLeft = running ? element.scrollWidth - element.clientWidth : 0
  })
  useEffect(() => {
    scheduleSummaryScroll()
  }, [running, scheduleSummaryScroll, summary])

  return (
    <div className={css.root} data-variant="think" data-state={running ? 'running' : 'ok'}>
      {running && <span className={a11yCss.visuallyHidden}>{t('row.running')}</span>}
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={<IconThinkOutline14 size={14} />}
        title={t('message.think')}
        open={expanded}
        expandable
        expandOnRowClick
        onToggle={() => { setExpanded(value => !value) }}
        collapsedContent={(
          <>
            <span className={css.separator} aria-hidden />
            <span ref={summaryRef} className={css.summary} data-follow-end={running || undefined}>{summary}</span>
          </>
        )}
      >
        <div className={css.thinkBody}>{visibleText}</div>
      </DisclosureRow>
    </div>
  )
}
