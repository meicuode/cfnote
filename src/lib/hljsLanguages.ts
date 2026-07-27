// 代码高亮的补充语言(P11.7)
//
// renderEnhance 用的是 highlight.js/lib/common —— 只注册 36 种语言,
// 遇到 ```powershell 这类会打印 "Could not find the language 'powershell'" 警告且不高亮。
// 包里实际有 192 种,但全量引入会把高亮块从 ~54KB gz 撑到 200KB+ gz(博客访客也要背),
// 所以这里精选一批常用的,**用到哪种才拉哪种**(每个语言模块 1~5KB gz)。
//
// 值必须写成字面量 import(),Vite 才能静态分析并切出独立 chunk;
// 用模板字符串拼 node_modules 路径不可靠,不采用。
// 需要更多语言时,在下表加一行即可(名字取 highlight.js/lib/languages/ 下的文件名)。

export const EXTRA_LANGS: Record<string, () => Promise<any>> = {
  powershell: () => import('highlight.js/lib/languages/powershell'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  nginx: () => import('highlight.js/lib/languages/nginx'),
  apache: () => import('highlight.js/lib/languages/apache'),
  dos: () => import('highlight.js/lib/languages/dos'),
  http: () => import('highlight.js/lib/languages/http'),
  properties: () => import('highlight.js/lib/languages/properties'),
  scala: () => import('highlight.js/lib/languages/scala'),
  dart: () => import('highlight.js/lib/languages/dart'),
  elixir: () => import('highlight.js/lib/languages/elixir'),
  erlang: () => import('highlight.js/lib/languages/erlang'),
  haskell: () => import('highlight.js/lib/languages/haskell'),
  clojure: () => import('highlight.js/lib/languages/clojure'),
  groovy: () => import('highlight.js/lib/languages/groovy'),
  gradle: () => import('highlight.js/lib/languages/gradle'),
  matlab: () => import('highlight.js/lib/languages/matlab'),
  julia: () => import('highlight.js/lib/languages/julia'),
  latex: () => import('highlight.js/lib/languages/latex'),
  vim: () => import('highlight.js/lib/languages/vim'),
  awk: () => import('highlight.js/lib/languages/awk'),
  protobuf: () => import('highlight.js/lib/languages/protobuf'),
  cmake: () => import('highlight.js/lib/languages/cmake'),
  pgsql: () => import('highlight.js/lib/languages/pgsql'),
  fortran: () => import('highlight.js/lib/languages/fortran'),
  fsharp: () => import('highlight.js/lib/languages/fsharp'),
  delphi: () => import('highlight.js/lib/languages/delphi'),
  nim: () => import('highlight.js/lib/languages/nim'),
  tcl: () => import('highlight.js/lib/languages/tcl'),
  gherkin: () => import('highlight.js/lib/languages/gherkin'),
  coffeescript: () => import('highlight.js/lib/languages/coffeescript'),
  x86asm: () => import('highlight.js/lib/languages/x86asm'),
}

/** 常见写法 → EXTRA_LANGS 的键(highlight.js 自带别名只对已注册语言生效,这里得自己归一) */
const ALIASES: Record<string, string> = {
  ps: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
  posh: 'powershell',
  docker: 'dockerfile',
  bat: 'dos',
  cmd: 'dos',
  batch: 'dos',
  tex: 'latex',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  clj: 'clojure',
  fs: 'fsharp',
  pas: 'delphi',
  pascal: 'delphi',
  m: 'matlab',
  jl: 'julia',
  proto: 'protobuf',
  postgres: 'pgsql',
  postgresql: 'pgsql',
  psql: 'pgsql',
  f90: 'fortran',
  asm: 'x86asm',
  nasm: 'x86asm',
  coffee: 'coffeescript',
  feature: 'gherkin',
  conf: 'nginx',
  vimscript: 'vim',
  gvim: 'vim',
}

/**
 * 把代码块上写的语言名归一到 EXTRA_LANGS 的键;不在补充表里则返回 null
 * (调用方据此决定「懒加载注册」还是「降级为自动检测」)。
 */
export function resolveLangAlias(name: string): string | null {
  const key = (name || '').trim().toLowerCase()
  if (!key) return null
  if (key in EXTRA_LANGS) return key
  const aliased = ALIASES[key]
  return aliased && aliased in EXTRA_LANGS ? aliased : null
}
