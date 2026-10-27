import { useState } from 'react'
import * as RSelect from '@radix-ui/react-select'
import { isBlurDismiss } from '@renderer/lib/overlay'

export interface SelectOption<T extends string> {
    value: T
    label: string
}

interface SelectProps<T extends string> {
    value: T
    options: SelectOption<T>[]
    onChange: (value: T) => void
    /** 触发器（非 Portal）上的附加类，用于触发器级样式。 */
    className?: string
    /** 展开面板（Portal 到 body）上的附加类，用作【场景钩子】<select>--<场景> */
    contentClassName?: string
    title?: string
    /** 禁用：不可展开、不可改值 */
    disabled?: boolean
}

// 受控下拉选择器：基于 @radix-ui/react-select
export function Select<T extends string>({ value, options, onChange, className, contentClassName, title, disabled }: SelectProps<T>) {
    const [open, setOpen] = useState(false)

    return (
        <RSelect.Root
            value={value}
            open={open}
            disabled={disabled}
            onOpenChange={(next) => {
                if (!next && isBlurDismiss()) return
                setOpen(next)
            }}
            onValueChange={(v) => onChange(v as T)}
        >
            <RSelect.Trigger
                className={`select-trigger${className ? ` ${className}` : ''}`}
                title={title}
                aria-label={title}
            >
                <RSelect.Value />
                <RSelect.Icon className="select-caret">
                    <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                    >
                        <polyline points="6 9 12 15 18 9" />
                    </svg>
                </RSelect.Icon>
            </RSelect.Trigger>
            <RSelect.Portal>
                <RSelect.Content
                    className={`select-content${contentClassName ? ` ${contentClassName}` : ''}`}
                    position="popper"
                    sideOffset={4}
                    collisionPadding={12}
                >
                    <div className="select-inner">
                        <RSelect.Viewport className="select-viewport">
                            {options.map((o) => (
                                <RSelect.Item key={o.value} value={o.value} className="select-option">
                                    <RSelect.ItemText>{o.label}</RSelect.ItemText>
                                    <RSelect.ItemIndicator className="select-item-indicator">
                                        <svg
                                            width="14"
                                            height="14"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth={2}
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            aria-hidden="true"
                                        >
                                            <polyline points="20 6 9 17 4 12" />
                                        </svg>
                                    </RSelect.ItemIndicator>
                                </RSelect.Item>
                            ))}
                        </RSelect.Viewport>
                    </div>
                </RSelect.Content>
            </RSelect.Portal>
        </RSelect.Root>
    )
}
