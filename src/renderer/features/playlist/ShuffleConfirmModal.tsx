import { Modal } from '@renderer/components/ui/Modal'

/**
 * 「打乱顺序」二次确认弹窗
 */

export interface ShuffleConfirmModalProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    /** 问句（带列表名，避免在「我喜欢」页误以为是别处的顺序） */
    question: string
    onConfirm: () => void
}

export function ShuffleConfirmModal({ open, onOpenChange, question, onConfirm }: ShuffleConfirmModalProps) {
    return (
        <Modal
            open={open}
            onOpenChange={onOpenChange}
            title="打乱歌单"
            className="shuffle-confirm-modal"
            contentStyle={{ width: 400 }}
        >
            <p className="shuffle-confirm-text">{question}</p>
            <p className="shuffle-confirm-hint">
                只改写歌单歌曲列表的顺序，不影响正在播放的队列；打乱后无法撤销。
            </p>
            <div className="shuffle-confirm-footer">
                <button
                    className="shuffle-confirm-cancel"
                    type="button"
                    onClick={() => onOpenChange(false)}
                >
                    取消
                </button>
                <button
                    className="shuffle-confirm-ok"
                    type="button"
                    onClick={() => {
                        onOpenChange(false)
                        onConfirm()
                    }}
                >
                    打乱
                </button>
            </div>
        </Modal>
    )
}
