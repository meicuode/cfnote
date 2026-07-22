import { useState, useEffect } from 'react'
import { useApi } from '../hooks/useApi'
import type { Settings, ModelInfo } from '../types'

const MODELS: ModelInfo[] = [
  { id: '@cf/meta/llama-3.1-8b-instruct', label: 'Llama 3.1 8B', description: '轻量快速，适合简单问答', type: '通用', cost: '~15 neurons' },
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'Llama 3.3 70B', description: '大模型，综合能力强', type: '通用', cost: '~88 neurons' },
  { id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', label: 'DeepSeek R1 32B', description: '推理能力强，适合复杂分析', type: '推理', cost: '~178 neurons' },
  { id: '@cf/qwen/qwq-32b', label: 'QwQ 32B', description: '推理型，中文表现优秀', type: '推理', cost: '~87 neurons' },
]

interface Props {
  token: string
  onClose: () => void
}

export default function SettingsPanel({ token, onClose }: Props) {
  const api = useApi(token)
  const [selected, setSelected] = useState('')
  const [jinaKey, setJinaKey] = useState('')
  const [showJinaKey, setShowJinaKey] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    (async () => {
      const res = await api.get<Settings>('/settings')
      if (res.ok && res.data) {
        setSelected(res.data.llm_model)
        if (res.data.jina_api_key) setJinaKey(res.data.jina_api_key)
      } else {
        setError(res.error || '加载失败')
      }
      setLoading(false)
    })()
  }, [api])

  const handleSave = async () => {
    setSaving(true)
    setError('')
    const res = await api.put<Settings>('/settings', {
      llm_model: selected,
      ...(jinaKey ? { jina_api_key: jinaKey } : {}),
    })
    if (res.ok) {
      onClose()
    } else {
      setError(res.error || '保存失败')
    }
    setSaving(false)
  }

  const handleExport = async () => {
    setExporting(true)
    setError('')
    try {
      const res = await fetch('/api/export', { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) {
        const j = await res.json().catch(() => null) as any
        throw new Error(j?.error || `导出失败 (${res.status})`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `cfnote-export-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span className="font-semibold text-gray-900">设置</span>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {loading && (
            <div className="text-center py-12">
              <div className="inline-block w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-gray-500 mt-2">加载设置...</p>
            </div>
          )}

          {error && (
            <div className="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{error}</div>
          )}

          {!loading && (
            <>
              <div>
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">AI 模型</h3>
                <div className="space-y-2">
                  {MODELS.map((model) => {
                    const isSelected = selected === model.id
                    return (
                      <button
                        key={model.id}
                        onClick={() => setSelected(model.id)}
                        className={`w-full text-left rounded-xl border-2 p-3 transition-all ${
                          isSelected
                            ? 'border-emerald-500 bg-emerald-50'
                            : 'border-gray-200 hover:border-gray-300 bg-white'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                              isSelected ? 'border-emerald-500' : 'border-gray-300'
                            }`}>
                              {isSelected && <div className="w-2 h-2 rounded-full bg-emerald-500" />}
                            </div>
                            <span className={`font-medium text-sm ${isSelected ? 'text-emerald-700' : 'text-gray-900'}`}>
                              {model.label}
                            </span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                              model.type === '推理'
                                ? 'bg-violet-100 text-violet-600'
                                : 'bg-blue-100 text-blue-600'
                            }`}>
                              {model.type}
                            </span>
                          </div>
                          <span className="text-xs text-gray-400">{model.cost}</span>
                        </div>
                        <p className="text-xs text-gray-500 mt-1 ml-6">{model.description}</p>
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* API Keys */}
              <div>
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">API Keys</h3>
                <div className="space-y-3">
                  <div>
                    <label className="text-xs font-medium text-gray-700 mb-1 block">Jina API Key</label>
                    <div className="relative">
                      <input
                        type={showJinaKey ? 'text' : 'password'}
                        value={jinaKey}
                        onChange={(e) => setJinaKey(e.target.value)}
                        placeholder="jina_..."
                        className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 pr-10 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400 font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => setShowJinaKey(!showJinaKey)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
                      >
                        {showJinaKey ? (
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                          </svg>
                        ) : (
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                          </svg>
                        )}
                      </button>
                    </div>
                    <p className="text-[11px] text-gray-400 mt-1">
                      用于联网搜索和 URL 导入。从 <a href="https://jina.ai" target="_blank" rel="noreferrer" className="text-emerald-600 hover:underline">jina.ai</a> 免费获取。不配置也可使用，但可能受限流影响。
                    </p>
                  </div>
                </div>
              </div>
              {/* 数据备份 */}
              <div>
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">数据备份</h3>
                <button
                  onClick={handleExport}
                  disabled={exporting}
                  className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5 text-left hover:border-emerald-400 hover:bg-emerald-50 disabled:opacity-50 transition-colors flex items-center gap-2"
                >
                  <svg className="w-4 h-4 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  <span className="text-gray-700 font-medium">{exporting ? '导出中...' : '导出全部数据 (JSON)'}</span>
                </button>
                <p className="text-[11px] text-gray-400 mt-1">
                  包含全部笔记本、文章与对话记录，不含 API Key 等敏感配置。建议定期导出保存。
                </p>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        {!loading && (
          <div className="p-4 border-t border-gray-100 flex justify-end">
            <button
              onClick={handleSave}
              disabled={saving || !selected}
              className="px-4 py-2 bg-emerald-500 text-white text-sm font-medium rounded-lg hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
