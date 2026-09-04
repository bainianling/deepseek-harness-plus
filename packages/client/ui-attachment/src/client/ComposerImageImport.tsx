import { useCallback, useRef } from 'react'
import type { ChangeEvent } from 'react'
import { IconPaperclipOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComposerAttachmentsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './ComposerImageImport.module.css'

/** Image-file picker rendered beside the command launcher in the composer toolbar. */
export function ComposerImageImport({ canAcceptDrop, onAddImages, t }: ComposerAttachmentsProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const openPicker = useCallback(() => { fileInputRef.current?.click() }, [])
  const onPickImages = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
    const files = [...(event.currentTarget.files ?? [])]
    event.currentTarget.value = ''
    if (files.length > 0 && canAcceptDrop) onAddImages(files)
  }, [canAcceptDrop, onAddImages])

  return (
    <>
      <input
        ref={fileInputRef}
        className={css.fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        tabIndex={-1}
        aria-hidden
        onChange={onPickImages}
      />
      <button
        type="button"
        className={css.button}
        aria-label={t('image.import')}
        title={t('image.import')}
        disabled={!canAcceptDrop}
        onClick={openPicker}
      >
        <IconPaperclipOutline16 size={14} />
      </button>
    </>
  )
}
