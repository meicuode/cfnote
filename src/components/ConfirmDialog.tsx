import { useEffect } from 'react'

interface Props {
  title: string
  message?: string
  confirmText?: string
  onConfirm: () => void
  onCancel: () => void
}

// 主题化确认弹窗(替代原生 confirm):Esc 取消,Enter 确认
export default function ConfirmDialog({ title, message, confirmText = '删除', onConfirm, onCancel }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCancel() }
      if (e.key === 'Enter') onConfirm()
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [onCancel, onConfirm])

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center" onClick={(e) => { e.stopPropagation(); onCancel() }}>
      <div className="absolute inset-0 bg-black/40" />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-sm p-5 mx-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-full bg-red-50 flex items-center justify-center shrink-0">
            <svg className="w-5 h-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
            {message && <p className="text-xs text-gray-500 mt-1 leading-relaxed">{message}</p>}
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onCancel}
            className="px-3.5 py-1.5 text-sm rounded-lg text-gray-600 hover:bg-gray-100 transition-colors"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            className="px-3.5 py-1.5 text-sm rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors"
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
