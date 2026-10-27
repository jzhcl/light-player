import * as RCheckbox from '@radix-ui/react-checkbox'

export interface CheckboxProps {
    checked: boolean
    onChange: (checked: boolean) => void
    disabled?: boolean
    className?: string
    id?: string
    /** 读屏名称 */
    ariaLabel?: string
}

// 受控复选框：基于 @radix-ui/react-checkbox
export function Checkbox({ checked, onChange, disabled = false, className, id, ariaLabel }: CheckboxProps) {
    return (
        <RCheckbox.Root
            id={id}
            className={`checkbox${className ? ` ${className}` : ''}`}
            checked={checked}
            disabled={disabled}
            aria-label={ariaLabel}
            onCheckedChange={(v) => onChange(v === true)}
        >
            <RCheckbox.Indicator className="checkbox-indicator">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    <path d="M6.5 12 2 7.5l1.4-1.4 3.1 3.1 6.1-6.1L14 4.6z" />
                </svg>
            </RCheckbox.Indicator>
        </RCheckbox.Root>
    )
}
