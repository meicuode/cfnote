import { useEffect, useState } from 'react'

interface Props {
  title: string
  message?: string
  confirmText?: string
  /** 确认按钮与图标配色:red=危险(默认,删除类),amber=谨慎操作(如设为私有),emerald=正向操作 */
  variant?: 'red' | 'amber' | 'emerald'
  /**
   * 非空 = 必须原样打出这段文字才能确认(P16.3)。
   * 只留给「量大到误点代价很高」的那几次——用滥了人会养成盲目打字的习惯,
   * 那比没有这道闸更糟,因为它还顺带稀释了真正该停下的那几处。
   */
  typeToConfirm?: string
  onConfirm: () => void
  onCancel: () => void
}

const VARIANTS = {
  red: { icon: 'bg-red-50 text-red-500', btn: 'bg-red-500 hover:bg-red-600' },
  amber: { icon: 'bg-amber-50 text-amber-500', btn: 'bg-amber-500 hover:bg-amber-600' },
  emerald: { icon: 'bg-emerald-50 text-emerald-500', btn: 'bg-emerald-500 hover:bg-emerald-600' },
} as const

// 主题化确认弹窗(替代原生 confirm):Esc 取消,Enter 确认
export default function ConfirmDialog({ title, message, confirmText = '删除', variant = 'red', typeToConfirm, onConfirm, onCancel }: Props) {
  const v = VARIANTS[variant]
  const [typed, setTyped] = useState('')
  // 要求打字时,没打对就不算「已就绪」——Enter 与按钮都走这一个判断,不能各写一份
  const armed = !typeToConfirm || typed.trim() === typeToConfirm

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCancel() }
      // Enter 也要过 armed:否则打字确认形同虚设(输入框里回车就提交了)
      if (e.key === 'Enter' && armed) onConfirm()
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [onCancel, onConfirm, armed])

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center" onClick={(e) => { e.stopPropagation(); onCancel() }}>
      <div className="absolute inset-0 bg-black/40" />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-sm p-5 mx-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3">
          <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${v.icon}`}>
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
            {message && <p className="text-xs text-gray-500 mt-1 leading-relaxed">{message}</p>}
          </div>
        </div>
        {typeToConfirm && (
          <div className="mt-3">
            <label className="block text-xs text-gray-600 mb-1">
              这一次数量较大。请输入 <b className="text-gray-900">{typeToConfirm}</b> 以确认
            </label>
            <input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-400 focus:border-transparent"
            />
          </div>
        )}
        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onCancel}
            className="px-3.5 py-1.5 text-sm rounded-lg text-gray-600 hover:bg-gray-100 transition-colors"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            disabled={!armed}
            className={`px-3.5 py-1.5 text-sm rounded-lg text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${v.btn}`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
