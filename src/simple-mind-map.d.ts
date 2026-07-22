// simple-mind-map 的 npm 包未附带可解析的类型声明,这里做最小声明(仅只读预览用)
declare module 'simple-mind-map' {
  export default class MindMap {
    constructor(options: Record<string, unknown>)
    view?: { fit: () => void }
    destroy(): void
  }
}
