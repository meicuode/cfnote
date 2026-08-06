import { useState, useRef, useEffect } from 'react'
import { useApi } from '../hooks/useApi'
import { highlightParts } from '../lib/searchSnippets'
import type { SearchHit, SearchResponse } from '../types'

interface Props {
  token: string
  onClose: () => void
  onOpenArticle: (id: number, snippet?: string) => void
}

export default function SearchPanel({ token, onClose, onOpenArticle }: Props) {
  const api = useApi(token)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<SearchHit[]>([])
  const [terms, setTerms] = useState<string[]>([])
  const [searched, setSearched] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const handleSearch = async () => {
    if (!query.trim()) return
    setLoading(true)
    setResults([])

    const res = await api.post<SearchResponse>('/search', { query: query.trim() })
    if (res.ok && res.data) {
      setResults(res.data.results || [])
      setTerms(res.data.terms || [])
    }
    setSearched(true)
    setLoading(false)
  }

  const scorePercent = (score: number) => Math.round(score * 100)

  // 命中的词标黄。走 React 元素而不是 dangerouslySetInnerHTML——
  // 片段是任意正文,仓库里没有 HTML 消毒库(与评论正文同一条规矩)
  const renderSnippet = (text: string, hit: boolean) =>
    hit
      ? highlightParts(text, terms).map((p, i) =>
          p.hit
            ? <mark key={i} className="bg-amber-200 text-gray-900 rounded-sm px-0.5">{p.text}</mark>
            : <span key={i}>{p.text}</span>)
      : text

  const firstSemantic = results.findIndex((r) => r.tier === 'semantic')
  const exactCount = firstSemantic < 0 ? results.length : firstSemantic

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[70vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="p-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setSearched(false) }}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="输入关键词或自然语言搜索..."
              className="flex-1 text-base outline-none bg-transparent placeholder:text-gray-400"
            />
          </div>
          <p className="text-xs text-gray-400 mt-2 ml-7">
            含关键词的排在前面，意思相近的排在后面；不消耗 AI 额度
          </p>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading && (
            <div className="text-center py-8">
              <div className="inline-block w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-gray-500 mt-2">搜索中...</p>
            </div>
          )}

          {!loading && results.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                搜索结果 ({results.length})
              </h3>
              <div className="space-y-2">
                {results.map((r, i) => (
                  <div key={`${r.article_id}-${i}`}>
                    {/* 分层的分界线。不画的话边界处看着像排序坏了——最后一条精确命中
                        可能明显不如第一条语义命中,而人看不出为什么它在上面 */}
                    {i === firstSemantic && firstSemantic > 0 && (
                      <div className="flex items-center gap-2 my-3">
                        <div className="flex-1 h-px bg-gray-200" />
                        <span className="text-[11px] text-gray-400 shrink-0">以下为语义相关（不含搜索词）</span>
                        <div className="flex-1 h-px bg-gray-200" />
                      </div>
                    )}
                    <div className="bg-gray-50 rounded-xl p-3">
                      <div className="flex items-center justify-between mb-1 gap-2">
                        <span className="font-medium text-sm text-gray-900 truncate">
                          {r.tier === 'exact' ? renderSnippet(r.article_title, true) : r.article_title}
                        </span>
                        <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${
                          r.tier === 'exact' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'
                        }`}>
                          {r.tier === 'exact' ? '精确' : `${scorePercent(r.score)}%`}
                        </span>
                      </div>
                      <p className="text-xs text-gray-400 mb-1.5">{r.notebook_name}</p>

                      {/* 每段各自可点:定位机器(ArticleEditor)收的就是一段任意文本,
                          于是同一篇的几处命中各自是一个跳转落点 */}
                      <div className="space-y-1">
                        {r.snippets.map((s, j) => (
                          <button
                            key={j}
                            onClick={() => onOpenArticle(r.article_id, s.text)}
                            className="w-full text-left text-xs text-gray-600 hover:bg-white rounded-lg px-2 py-1.5 transition-colors flex items-start gap-1.5"
                          >
                            {s.kind === 'semantic' && (
                              <span className="shrink-0 text-[10px] text-gray-400 border border-gray-200 rounded px-1 mt-px">语义</span>
                            )}
                            <span className="line-clamp-2">{renderSnippet(s.text, s.kind === 'exact')}</span>
                          </button>
                        ))}
                        {r.snippets.length === 0 && (
                          <button
                            onClick={() => onOpenArticle(r.article_id)}
                            className="w-full text-left text-xs text-gray-400 hover:bg-white rounded-lg px-2 py-1.5 transition-colors"
                          >
                            标题命中，正文无匹配
                          </button>
                        )}
                        {r.more > 0 && (
                          <p className="text-[11px] text-gray-400 px-2">另有 {r.more} 处匹配</p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {exactCount === 0 && (
                <p className="text-[11px] text-gray-400 text-center mt-3">
                  没有文章包含这些词，以上是意思相近的结果
                </p>
              )}
            </div>
          )}

          {!loading && searched && results.length === 0 && (
            <div className="text-center py-8 text-gray-400">
              <p className="text-sm">未找到相关内容</p>
            </div>
          )}

          {!loading && !searched && (
            <div className="text-center py-8 text-gray-400">
              <p className="text-sm">输入关键词或自然语言开始搜索</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
